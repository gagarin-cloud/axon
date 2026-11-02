import pgvector from "pgvector";
import type postgres from "postgres";
import { AxonError } from "../core/errors.js";
import type { Tx } from "../db/client.js";
import { keyStillBound, rotatedError } from "./bindings.js";
import { type ContentCodec, openContent, PLAINTEXT } from "./codec.js";
import type {
  DuplicatePair,
  Filters,
  LinkExport,
  LinkRef,
  Memory,
  MemoryContent,
  MemoryPatch,
  Neighbour,
  NewMemory,
  Project,
  ProjectStats,
  ProjectSummary,
  ReviewFindings,
  ReviewSection,
  ReviewSectionId,
  ReviewThresholds,
  SearchHit,
  WalkStep,
} from "./types.js";
import { REVIEW_SECTIONS } from "./types.js";

/** RRF constant (Cormack et al.); 60 is the conventional default. */
const RRF_K = 60;
/** Candidates each retrieval lane contributes before fusion. */
const LANE_LIMIT = 40;
/** Hebbian reinforcement per traversal, and the ceiling a link's weight can reach. */
const LINK_BUMP = 0.25;
const LINK_MAX_WEIGHT = 5;

/**
 * pgvector-backed storage. Everything is addressed by project id + per-project `seq`; internal
 * bigint ids never leave this class. Memory text is written through the codec (plaintext or
 * encrypted) and read back whichever mode wrote the row.
 */
export class PgStore {
  private readonly vecCast: postgres.PendingQuery<postgres.Row[]>;

  constructor(
    private readonly sql: Tx,
    private readonly dim: number,
    private readonly codec: ContentCodec = PLAINTEXT,
    private readonly inTransaction = false,
  ) {
    this.vecCast = sql.unsafe(`::vector(${dim})`);
  }

  /** Runs `fn` in a transaction with a store bound to it (joins the current one if already inside). */
  transaction<T>(fn: (store: PgStore) => Promise<T>): Promise<T> {
    if (this.inTransaction) return fn(this);
    return (this.sql as postgres.Sql).begin((tx) => fn(new PgStore(tx, this.dim, this.codec, true))) as Promise<T>;
  }

  /** Round-trips `SELECT 1`; rejects with code PING_TIMEOUT if the database does not answer in `timeoutMs`. */
  async ping(timeoutMs: number): Promise<void> {
    const query = this.sql`SELECT 1`;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        // Cancel so a hung probe does not hold a pooled connection while the next one queues behind it.
        query.cancel();
        reject(Object.assign(new Error("database did not answer in time"), { code: "PING_TIMEOUT" }));
      }, timeoutMs);
    });
    try {
      await Promise.race([query, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  // ── projects ────────────────────────────────────────────────────────────

  async getProject(slug: string): Promise<Project | null> {
    const [row] = await this.sql<Project[]>`SELECT id, slug FROM projects WHERE slug = ${slug}`;
    return row ?? null;
  }

  /** Creates the project if needed. The upsert row-locks it until the transaction ends. */
  async ensureProject(slug: string): Promise<Project> {
    const [row] = await this.sql<Project[]>`
      INSERT INTO projects (slug) VALUES (${slug})
      ON CONFLICT (slug) DO UPDATE SET slug = EXCLUDED.slug
      RETURNING id, slug`;
    return row as Project;
  }

  /**
   * Row-locks an existing project until the transaction ends, as `ensureProject`'s upsert does, so
   * writers that claim keys in one project queue behind each other.
   */
  async lockProject(projectId: string): Promise<void> {
    await this.sql`SELECT 1 FROM projects WHERE id = ${projectId} FOR UPDATE`;
  }

  listProjects(): Promise<ProjectSummary[]> {
    return this.sql<ProjectSummary[]>`
      SELECT p.slug,
             count(m.id) FILTER (WHERE m.status = 'active')::int AS active,
             count(m.id)::int AS total,
             (SELECT count(*)::int FROM memory_links l WHERE l.project_id = p.id) AS links,
             max(m.updated_at) AS updated_at
      FROM projects p LEFT JOIN memories m ON m.project_id = p.id
      GROUP BY p.id
      ORDER BY max(m.updated_at) DESC NULLS LAST, p.slug`;
  }

  /** Deletes the project with its memories and links (cascade). Returns what was removed, or null if absent. */
  async deleteProject(slug: string): Promise<{ memories: number; links: number } | null> {
    // The counts read the statement's snapshot, i.e. the rows as they were before the delete.
    const [row] = await this.sql<{ memories: number; links: number }[]>`
      WITH gone AS (DELETE FROM projects WHERE slug = ${slug} RETURNING id)
      SELECT (SELECT count(*)::int FROM memories m WHERE m.project_id = gone.id) AS memories,
             (SELECT count(*)::int FROM memory_links l WHERE l.project_id = gone.id) AS links
      FROM gone`;
    return row ?? null;
  }

  async stats(projectId: string): Promise<ProjectStats> {
    const kinds = await this.sql<{ kind: string; n: number }[]>`
      SELECT kind, count(*)::int AS n FROM memories
      WHERE project_id = ${projectId} AND status = 'active' GROUP BY kind ORDER BY n DESC`;
    const tags = await this.sql<{ tag: string; count: number }[]>`
      SELECT t AS tag, count(*)::int AS count FROM memories, unnest(tags) t
      WHERE project_id = ${projectId} AND status = 'active'
      GROUP BY t ORDER BY count DESC, t LIMIT 40`;
    const [links] = await this.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM memory_links WHERE project_id = ${projectId}`;
    // Any status: archiving or superseding is a write too.
    const [last] = await this.sql<{ at: Date | null }[]>`
      SELECT max(updated_at) AS at FROM memories WHERE project_id = ${projectId}`;
    return {
      kinds: Object.fromEntries(kinds.map((k) => [k.kind, k.n])),
      tags,
      links: links?.n ?? 0,
      lastWrite: last?.at ?? null,
    };
  }

  async countActive(projectId: string): Promise<number> {
    const [row] = await this.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM memories WHERE project_id = ${projectId} AND status = 'active'`;
    return row?.n ?? 0;
  }

  // ── memories ────────────────────────────────────────────────────────────

  async insertMemory(projectId: string, m: NewMemory, embedding: number[], tokens: number): Promise<number> {
    const [{ seq } = { seq: 0 }] = await this.sql<{ seq: number }[]>`
      UPDATE projects SET next_seq = next_seq + 1 WHERE id = ${projectId} RETURNING next_seq - 1 AS seq`;
    const c = this.codec.seal(projectId, m);
    const res = await this.sql`
      INSERT INTO memories (project_id, seq, kind, title, body, tags, paths, pinned, importance, source, key, encrypted, tokens,
                            embedding, status, created_at, updated_at, confirmed_at, disputed_at)
      SELECT ${projectId}, ${seq}, ${m.kind}, ${c.title}, ${c.body}, ${m.tags}, ${m.paths}, ${m.pinned},
             ${m.importance}, ${c.source}, ${m.key}, ${c.encrypted}, ${tokens}, ${pgvector.toSql(embedding)}${this.vecCast},
             ${m.status ?? "active"}, coalesce(${m.createdAt ?? null}::timestamptz, now()),
             coalesce(${m.updatedAt ?? null}::timestamptz, now()),
             coalesce(${m.confirmedAt ?? m.createdAt ?? null}::timestamptz, now()), ${m.disputedAt ?? null}::timestamptz
      WHERE ${this.keyStillBound()}`;
    if (res.count === 0) throw rotatedError();
    return seq;
  }

  /**
   * Applies `patch`. `content`, when given, rewrites title, body and source together in the store's
   * current mode (so editing a memory also encrypts or decrypts it).
   */
  async updateMemory(
    projectId: string,
    seq: number,
    patch: MemoryPatch,
    content?: MemoryContent,
    reembed?: { embedding: number[]; tokens: number },
  ): Promise<void> {
    // Unset fields are left out (postgres.js refuses undefined); the connection's camel transform
    // turns the remaining keys into column names.
    const set = Object.fromEntries(
      Object.entries({ ...patch, ...(content && this.codec.seal(projectId, content)), updatedAt: new Date() }).filter(
        ([, v]) => v !== undefined,
      ),
    );
    const res = await this.sql`
      UPDATE memories SET ${this.sql(set)}
      ${reembed ? this.sql`, embedding = ${pgvector.toSql(reembed.embedding)}${this.vecCast}, tokens = ${reembed.tokens}` : this.sql``}
      WHERE project_id = ${projectId} AND seq = ${seq} AND ${content ? this.keyStillBound() : this.sql`true`}`;
    if (res.count === 0) {
      if (content && !(await this.keyIsBound())) throw rotatedError();
      throw new AxonError("not_found", `#${seq} not found`);
    }
  }

  /** Fetches memories by seq, in the requested order; missing seqs are skipped. */
  async getMemories(projectId: string, seqs: number[]): Promise<Memory[]> {
    if (seqs.length === 0) return [];
    const rows = (
      await this.sql<Memory[]>`
      ${this.selectMemory(projectId)} AND m.seq = ANY(${seqs}::int[])`
    ).map((m) => this.openMemory(projectId, m));
    const bySeq = new Map(rows.map((r) => [r.seq, r]));
    return seqs.flatMap((s) => bySeq.get(s) ?? []);
  }

  /** The active memory holding each key, as key → seq; keys nobody holds are absent. */
  async keyHolders(projectId: string, keys: string[]): Promise<Map<string, number>> {
    if (keys.length === 0) return new Map();
    const rows = await this.sql<{ key: string; seq: number }[]>`
      SELECT key, seq FROM memories
      WHERE project_id = ${projectId} AND status = 'active' AND key = ANY(${keys}::text[])`;
    return new Map(rows.map((r) => [r.key, r.seq]));
  }

  /** Every memory of the project (or only the active ones) in seq order, for export. */
  async allMemories(projectId: string, activeOnly: boolean): Promise<Memory[]> {
    const rows = await this.sql<Memory[]>`
      ${this.selectMemory(projectId)} ${activeOnly ? this.sql`AND m.status = 'active'` : this.sql``}
      ORDER BY m.seq`;
    return rows.map((m) => this.openMemory(projectId, m));
  }

  /** Points each `[seq, successor]` pair's memory at its successor, without moving links or touching status. */
  async setSupersededBy(projectId: string, pairs: [number, number][]): Promise<void> {
    if (pairs.length === 0) return;
    await this.sql`
      UPDATE memories o SET superseded_by = n.id
      FROM unnest(${pairs.map((p) => p[0])}::int[], ${pairs.map((p) => p[1])}::int[]) AS p(old_seq, new_seq)
      JOIN memories n ON n.project_id = ${projectId} AND n.seq = p.new_seq
      WHERE o.project_id = ${projectId} AND o.seq = p.old_seq`;
  }

  /** Active memories in rough priority order — the candidate pool for briefings and query-less browsing. */
  async browse(projectId: string, filters: Filters, limit: number): Promise<Memory[]> {
    const rows = await this.sql<Memory[]>`
      ${this.selectMemory(projectId)} AND m.status = 'active' ${this.filterSql(filters)}
      ORDER BY m.pinned DESC, m.importance DESC, m.updated_at DESC
      LIMIT ${limit}`;
    return rows.map((m) => this.openMemory(projectId, m));
  }

  /** Memories of any status changed since `since`, latest change first — a briefing's "Recent". */
  async changedSince(projectId: string, since: Date, limit: number): Promise<Memory[]> {
    const rows = await this.sql<Memory[]>`
      ${this.selectMemory(projectId)} AND m.updated_at >= ${since}
      ORDER BY m.updated_at DESC, m.seq DESC
      LIMIT ${limit}`;
    return rows.map((m) => this.openMemory(projectId, m));
  }

  /** Records that memories were read (feeds ranking). */
  async touch(projectId: string, seqs: number[]): Promise<void> {
    if (seqs.length === 0) return;
    await this.sql`
      UPDATE memories SET access_count = access_count + 1, last_accessed_at = now()
      WHERE project_id = ${projectId} AND seq = ANY(${seqs}::int[])`;
  }

  /** Returns the seqs from `seqs` that do not exist in the project. */
  async missing(projectId: string, seqs: number[]): Promise<number[]> {
    if (seqs.length === 0) return [];
    const rows = await this.sql<{ seq: number }[]>`
      SELECT seq FROM memories WHERE project_id = ${projectId} AND seq = ANY(${seqs}::int[])`;
    const found = new Set(rows.map((r) => r.seq));
    return [...new Set(seqs)].filter((s) => !found.has(s));
  }

  async supersede(projectId: string, oldSeq: number, newSeq: number): Promise<void> {
    await this.sql`
      UPDATE memories o SET status = 'superseded', superseded_by = n.id, updated_at = now()
      FROM memories n
      WHERE o.project_id = ${projectId} AND o.seq = ${oldSeq}
        AND n.project_id = ${projectId} AND n.seq = ${newSeq}`;
    // The successor inherits the predecessor's associations.
    await this.sql`
      INSERT INTO memory_links (project_id, a_id, b_id, note, weight, last_traversed_at)
      SELECT ${projectId}, least(n.id, e.dst), greatest(n.id, e.dst), e.note, e.weight, e.last_traversed_at
      FROM memories o
      JOIN memories n ON n.project_id = o.project_id AND n.seq = ${newSeq}
      JOIN memory_edges e ON e.src = o.id
      WHERE o.project_id = ${projectId} AND o.seq = ${oldSeq} AND e.dst <> n.id
      ON CONFLICT (a_id, b_id) DO NOTHING`;
  }

  // ── retrieval ───────────────────────────────────────────────────────────

  /** Nearest active memories by cosine similarity (used for duplicate detection and link suggestions). */
  async nearest(projectId: string, embedding: number[], limit: number, excludeSeq?: number): Promise<Neighbour[]> {
    const rows = await this.withIterativeScan(
      (sql) => sql<(Neighbour & { encrypted: boolean })[]>`
      SELECT seq, kind, title, encrypted, 1 - (embedding${this.vecCast} <=> ${pgvector.toSql(embedding)}${this.vecCast}) AS similarity
      FROM memories
      WHERE project_id = ${projectId} AND status = 'active' AND embedding IS NOT NULL
        ${excludeSeq === undefined ? sql`` : sql`AND seq <> ${excludeSeq}`}
      ORDER BY embedding${this.vecCast} <=> ${pgvector.toSql(embedding)}${this.vecCast}
      LIMIT ${limit}`,
    );
    return rows.map(({ encrypted, ...n }) => ({
      ...n,
      title: this.codec.open(projectId, "title", n.title, encrypted),
    }));
  }

  /**
   * Hybrid retrieval: a vector lane and a keyword lane (exact identifiers, file names), fused with
   * reciprocal rank fusion. Vector-only hits below `minSimilarity` are dropped.
   */
  search(
    projectId: string,
    q: { embedding: number[]; text: string; filters: Filters; limit: number; minSimilarity: number },
  ): Promise<SearchHit[]> {
    const vec = pgvector.toSql(q.embedding);
    return this.withIterativeScan(
      (sql) => sql<SearchHit[]>`
      WITH vec AS (
        SELECT id, 1 - dist AS similarity, row_number() OVER (ORDER BY dist) AS r
        FROM (
          SELECT m.id, m.embedding${this.vecCast} <=> ${vec}${this.vecCast} AS dist
          FROM memories m
          WHERE m.project_id = ${projectId} AND m.status = 'active' AND m.embedding IS NOT NULL ${this.filterSql(q.filters)}
          ORDER BY m.embedding${this.vecCast} <=> ${vec}${this.vecCast}
          LIMIT ${LANE_LIMIT}
        ) v
      ),
      kw AS (
        SELECT id, row_number() OVER (ORDER BY rank DESC, id) AS r
        FROM (
          SELECT m.id, ts_rank_cd(m.fts, query) AS rank
          FROM memories m, websearch_to_tsquery('simple', ${q.text}) query
          WHERE m.project_id = ${projectId} AND m.status = 'active' AND m.fts @@ query ${this.filterSql(q.filters)}
          ORDER BY rank DESC
          LIMIT ${LANE_LIMIT}
        ) k
      )
      SELECT m.seq,
             coalesce(1.0 / (${RRF_K} + vec.r), 0) + coalesce(1.0 / (${RRF_K} + kw.r), 0) AS score,
             vec.similarity,
             kw.id IS NOT NULL AS keyword
      FROM vec FULL JOIN kw USING (id)
      JOIN memories m ON m.id = coalesce(vec.id, kw.id)
      WHERE kw.id IS NOT NULL OR vec.similarity >= ${q.minSimilarity}
      ORDER BY score DESC, m.seq DESC
      LIMIT ${q.limit}`,
    );
  }

  // ── links ───────────────────────────────────────────────────────────────

  /** Links `seq` to each of `to`. Returns how many links were new. Callers validate self-links and existence. */
  async link(projectId: string, seq: number, to: number[], note: string | null): Promise<number> {
    const rows = await this.sql<{ inserted: boolean }[]>`
      INSERT INTO memory_links (project_id, a_id, b_id, note)
      SELECT ${projectId}, least(s.id, t.id), greatest(s.id, t.id), ${note}
      FROM memories s JOIN memories t ON t.project_id = s.project_id AND t.seq = ANY(${to}::int[])
      WHERE s.project_id = ${projectId} AND s.seq = ${seq}
      ON CONFLICT (a_id, b_id) DO UPDATE SET note = coalesce(EXCLUDED.note, memory_links.note)
      RETURNING (xmax = 0) AS inserted`;
    return rows.filter((r) => r.inserted).length;
  }

  async unlink(projectId: string, seq: number, to: number[]): Promise<number> {
    const res = await this.sql`
      DELETE FROM memory_links l
      USING memories s, memories t
      WHERE s.project_id = ${projectId} AND s.seq = ${seq}
        AND t.project_id = ${projectId} AND t.seq = ANY(${to}::int[])
        AND l.a_id = least(s.id, t.id) AND l.b_id = greatest(s.id, t.id)`;
    return res.count;
  }

  /** Total links (to memories of any status) per seq — for enforcing the per-memory cap. */
  async linkCounts(projectId: string, seqs: number[]): Promise<Map<number, number>> {
    const rows = await this.sql<{ seq: number; n: number }[]>`
      SELECT m.seq, count(e.dst)::int AS n
      FROM memories m LEFT JOIN memory_edges e ON e.src = m.id
      WHERE m.project_id = ${projectId} AND m.seq = ANY(${seqs}::int[])
      GROUP BY m.seq`;
    return new Map(rows.map((r) => [r.seq, r.n]));
  }

  /** Strongest active neighbours of each memory, for rendering link footers. */
  async neighbours(projectId: string, seqs: number[], perMemory: number): Promise<Map<number, LinkRef[]>> {
    const out = new Map<number, LinkRef[]>();
    if (seqs.length === 0) return out;
    const rows = await this.sql<(LinkRef & { src: number; encrypted: boolean })[]>`
      SELECT src, seq, title, encrypted, strength, note FROM (
        SELECT m.seq AS src, o.seq, o.title, o.encrypted, e.note,
               axon_link_strength(e.weight, e.last_traversed_at, e.created_at) AS strength,
               row_number() OVER (
                 PARTITION BY m.id
                 ORDER BY axon_link_strength(e.weight, e.last_traversed_at, e.created_at) DESC, o.seq DESC
               ) AS rn
        FROM memories m
        JOIN memory_edges e ON e.src = m.id
        JOIN memories o ON o.id = e.dst
        WHERE m.project_id = ${projectId} AND m.seq = ANY(${seqs}::int[]) AND o.status = 'active'
      ) x
      WHERE rn <= ${perMemory}
      ORDER BY src, rn`;
    for (const { src, encrypted, ...ref } of rows) {
      const list = out.get(src) ?? [];
      list.push({ ...ref, title: this.codec.open(projectId, "title", ref.title, encrypted) });
      out.set(src, list);
    }
    return out;
  }

  /**
   * Breadth-first associative walk over links from `seq`, through active memories only.
   * Each reachable memory is returned once, at its shortest hop, via its strongest path.
   */
  walk(projectId: string, seq: number, hops: number): Promise<WalkStep[]> {
    return this.sql<WalkStep[]>`
      WITH RECURSIVE edges AS (
        SELECT e.src, e.dst, e.note, axon_link_strength(e.weight, e.last_traversed_at, e.created_at) AS strength
        FROM memory_edges e WHERE e.project_id = ${projectId}
      ),
      start AS (SELECT id FROM memories WHERE project_id = ${projectId} AND seq = ${seq}),
      walk (id, hop, via, note, strength, path) AS (
        SELECT id, 0, id, NULL::text, 1.0::float8, ARRAY[id] FROM start
        UNION ALL
        SELECT e.dst, w.hop + 1, w.id, e.note, w.strength * e.strength, w.path || e.dst
        FROM walk w
        JOIN edges e ON e.src = w.id
        JOIN memories m ON m.id = e.dst AND m.status = 'active'
        WHERE w.hop < ${hops} AND e.dst <> ALL(w.path)
      ),
      best AS (
        SELECT DISTINCT ON (id) id, hop, via, note, strength, path
        FROM walk WHERE hop > 0
        ORDER BY id, hop, strength DESC
      )
      SELECT m.seq, b.hop, v.seq AS via, b.note, b.strength,
             (SELECT array_agg(pm.seq ORDER BY p.ord) FROM unnest(b.path) WITH ORDINALITY p(id, ord)
              JOIN memories pm ON pm.id = p.id) AS path
      FROM best b
      JOIN memories m ON m.id = b.id
      JOIN memories v ON v.id = b.via
      ORDER BY b.hop, b.strength DESC, m.seq DESC`;
  }

  /** Hebbian reinforcement: strengthens the links between each pair of seqs (unlinked pairs are ignored). */
  async reinforce(projectId: string, pairs: [number, number][]): Promise<void> {
    if (pairs.length === 0) return;
    await this.sql`
      UPDATE memory_links l
      SET weight = least(${LINK_MAX_WEIGHT}, axon_link_strength(l.weight, l.last_traversed_at, l.created_at) + ${LINK_BUMP}),
          last_traversed_at = now()
      FROM (
        SELECT DISTINCT least(a.id, b.id) AS a_id, greatest(a.id, b.id) AS b_id
        FROM unnest(${pairs.map((p) => p[0])}::int[], ${pairs.map((p) => p[1])}::int[]) AS p(x, y)
        JOIN memories a ON a.project_id = ${projectId} AND a.seq = p.x
        JOIN memories b ON b.project_id = ${projectId} AND b.seq = p.y
      ) q
      WHERE l.a_id = q.a_id AND l.b_id = q.b_id`;
  }

  /**
   * Every link of the project (or only those between two active memories), lower seq first. The
   * weight is the current strength, decay applied, so an import made from it starts where this one is now.
   */
  allLinks(projectId: string, activeOnly: boolean): Promise<LinkExport[]> {
    return this.sql<LinkExport[]>`
      SELECT least(a.seq, b.seq) AS a, greatest(a.seq, b.seq) AS b, l.note,
             axon_link_strength(l.weight, l.last_traversed_at, l.created_at) AS weight
      FROM memory_links l
      JOIN memories a ON a.id = l.a_id
      JOIN memories b ON b.id = l.b_id
      WHERE l.project_id = ${projectId}
        ${activeOnly ? this.sql`AND a.status = 'active' AND b.status = 'active'` : this.sql``}
      ORDER BY 1, 2`;
  }

  /** Inserts links by seq with their note and weight, as a fresh link would be (untraversed, created now). */
  async insertLinks(projectId: string, links: LinkExport[]): Promise<number> {
    if (links.length === 0) return 0;
    const res = await this.sql`
      INSERT INTO memory_links (project_id, a_id, b_id, note, weight)
      SELECT ${projectId}, least(x.id, y.id), greatest(x.id, y.id), l.note, l.weight
      FROM unnest(${links.map((l) => l.a)}::int[], ${links.map((l) => l.b)}::int[],
                  ${links.map((l) => l.note)}::text[], ${links.map((l) => l.weight)}::real[]) AS l(a, b, note, weight)
      JOIN memories x ON x.project_id = ${projectId} AND x.seq = l.a
      JOIN memories y ON y.project_id = ${projectId} AND y.seq = l.b
      ON CONFLICT (a_id, b_id) DO NOTHING`;
    return res.count;
  }

  /** Every link among `seqs`, as seq pairs. */
  async linksAmong(projectId: string, seqs: number[]): Promise<[number, number][]> {
    if (seqs.length < 2) return [];
    const rows = await this.sql<{ a: number; b: number }[]>`
      SELECT a.seq AS a, b.seq AS b
      FROM memory_links l
      JOIN memories a ON a.id = l.a_id
      JOIN memories b ON b.id = l.b_id
      WHERE l.project_id = ${projectId} AND a.seq = ANY(${seqs}::int[]) AND b.seq = ANY(${seqs}::int[])`;
    return rows.map((r) => [r.a, r.b]);
  }

  // ── review ──────────────────────────────────────────────────────────────

  /** Housekeeping findings for one project: likely duplicates, plus each per-memory section. */
  async review(projectId: string, t: ReviewThresholds): Promise<ReviewFindings> {
    const sql = this.sql;
    type Fragment = postgres.PendingQuery<postgres.Row[]>;
    // Which active memories each section lists, and in what order. Every section looks at active
    // memories only; `total` is counted before the limit applies.
    const criteria: Record<ReviewSectionId, { where: Fragment; order: Fragment }> = {
      // Same rule as `degree`: links to retired memories don't count. Pinned memories need no links to be found.
      orphans: {
        where: sql`NOT m.pinned AND NOT EXISTS (
          SELECT 1 FROM memory_edges e JOIN memories o ON o.id = e.dst
          WHERE e.src = m.id AND o.status = 'active')`,
        order: sql`m.created_at, m.seq`,
      },
      oversized: { where: sql`m.tokens > ${t.largeTokens}`, order: sql`m.tokens DESC, m.seq` },
      stale: {
        where: sql`m.kind = 'state' AND m.updated_at < now() - make_interval(days => ${t.staleStateDays})`,
        order: sql`m.updated_at, m.seq`,
      },
      // Briefings deliver pinned memories without recording a read, so pinned ones would always look unread.
      unread: {
        where: sql`NOT m.pinned AND m.created_at < now() - make_interval(days => ${t.unreadDays})
            AND (m.last_accessed_at IS NULL OR m.last_accessed_at < now() - make_interval(days => ${t.unreadDays}))`,
        order: sql`m.last_accessed_at NULLS FIRST, m.created_at, m.seq`,
      },
      disputed: { where: sql`m.disputed_at IS NOT NULL`, order: sql`m.disputed_at, m.seq` },
    };
    const section = async (id: ReviewSectionId): Promise<[ReviewSectionId, ReviewSection]> => {
      const { where, order } = criteria[id];
      const rows = await sql<{ seq: number; total: number }[]>`
        SELECT m.seq, count(*) OVER ()::int AS total FROM memories m
        WHERE m.project_id = ${projectId} AND m.status = 'active' AND ${where}
        ORDER BY ${order} LIMIT ${t.limit}`;
      return [id, { seqs: rows.map((r) => r.seq), total: rows[0]?.total ?? 0 }];
    };
    const [[counts], duplicates, sections] = await Promise.all([
      sql<{ active: number; links: number }[]>`
        SELECT (SELECT count(*)::int FROM memories WHERE project_id = ${projectId} AND status = 'active') AS active,
               (SELECT count(*)::int FROM memory_links WHERE project_id = ${projectId}) AS links`,
      this.duplicatePairs(projectId, t),
      Promise.all(REVIEW_SECTIONS.map(section)),
    ]);
    return {
      active: counts?.active ?? 0,
      links: counts?.links ?? 0,
      duplicates,
      sections: Object.fromEntries(sections) as Record<ReviewSectionId, ReviewSection>,
    };
  }

  /**
   * The nearest few active neighbours of each of the first `duplicateScan` active memories (by seq), kept
   * when at or above `duplicateSimilarity`, each pair once. The scan bound keeps a review at most
   * scan × neighbours HNSW lookups however large the project grows; memories past it are still found as
   * the neighbour of an earlier one, just not checked against each other.
   */
  private duplicatePairs(projectId: string, t: ReviewThresholds): Promise<DuplicatePair[]> {
    return this.withIterativeScan(
      (sql) => sql<DuplicatePair[]>`
      WITH scan AS (
        SELECT id, seq, embedding FROM memories
        WHERE project_id = ${projectId} AND status = 'active' AND embedding IS NOT NULL
        ORDER BY seq LIMIT ${t.duplicateScan}
      ),
      pairs AS (
        SELECT DISTINCT ON (least(s.id, n.id), greatest(s.id, n.id))
               least(s.seq, n.seq) AS a, greatest(s.seq, n.seq) AS b, n.similarity,
               EXISTS (
                 SELECT 1 FROM memory_links l WHERE l.a_id = least(s.id, n.id) AND l.b_id = greatest(s.id, n.id)
               ) AS linked
        FROM scan s
        CROSS JOIN LATERAL (
          SELECT o.id, o.seq, 1 - (o.embedding${this.vecCast} <=> s.embedding${this.vecCast}) AS similarity
          FROM memories o
          WHERE o.project_id = ${projectId} AND o.status = 'active' AND o.embedding IS NOT NULL AND o.id <> s.id
          ORDER BY o.embedding${this.vecCast} <=> s.embedding${this.vecCast}
          LIMIT ${t.duplicateNeighbours}
        ) n
        WHERE n.similarity >= ${t.duplicateSimilarity}
        ORDER BY least(s.id, n.id), greatest(s.id, n.id)
      )
      SELECT a, b, similarity, linked FROM pairs ORDER BY similarity DESC, a, b LIMIT ${t.limit}`,
    );
  }

  // ── helpers ─────────────────────────────────────────────────────────────

  /** Guards every content write: see `keyStillBound`. */
  private keyStillBound() {
    return keyStillBound(this.sql, this.codec.keyId);
  }

  private async keyIsBound(): Promise<boolean> {
    const [row] = await this.sql<{ ok: boolean }[]>`SELECT ${this.keyStillBound()} AS ok`;
    return row?.ok ?? false;
  }

  private openMemory(projectId: string, m: Memory): Memory {
    return m.encrypted ? { ...m, ...openContent(this.codec, projectId, m, true) } : m;
  }

  private selectMemory(projectId: string) {
    return this.sql`
      SELECT m.seq, m.kind, m.title, m.body, m.tags, m.paths, m.pinned, m.importance, m.status,
             s.seq AS superseded_by, m.tokens, m.source, m.key, m.created_at, m.updated_at,
             m.confirmed_at, m.disputed_at, m.last_accessed_at, m.access_count, m.encrypted,
             (SELECT count(*)::int FROM memory_edges e JOIN memories o ON o.id = e.dst
               WHERE e.src = m.id AND o.status = 'active') AS degree
      FROM memories m
      LEFT JOIN memories s ON s.id = m.superseded_by
      WHERE m.project_id = ${projectId}`;
  }

  private filterSql(f: Filters) {
    const sql = this.sql;
    return sql`
      ${f.kinds?.length ? sql`AND m.kind = ANY(${f.kinds}::text[])` : sql``}
      ${f.tags?.length ? sql`AND m.tags && ${f.tags}::text[]` : sql``}
      ${
        f.paths?.length
          ? sql`AND EXISTS (
              SELECT 1 FROM unnest(m.paths) mp, unnest(${f.paths}::text[]) fp
              WHERE starts_with(mp, fp) OR starts_with(fp, mp))`
          : sql``
      }`;
  }

  /**
   * pgvector ≥0.8: keep scanning the HNSW graph until enough rows pass the project/status filter,
   * instead of returning a short result set.
   */
  private async withIterativeScan<T>(fn: (sql: Tx) => Promise<T>): Promise<T> {
    return this.transaction(async (store) => {
      await store.sql`SET LOCAL hnsw.iterative_scan = relaxed_order`;
      return fn(store.sql);
    });
  }
}
