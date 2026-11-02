import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AxonService, LARGE_MEMORY_TOKENS } from "../src/core/service.js";
import { countTokens } from "../src/core/tokens.js";
import type { Sql } from "../src/db/client.js";
import { FakeEmbedder } from "../src/embed/fake.js";
import { mem, setup, slug } from "./helpers.js";

let sql: Sql;
let service: AxonService;
let config: Awaited<ReturnType<typeof setup>>["config"];

beforeAll(async () => {
  ({ sql, service, config } = await setup());
});
afterAll(async () => {
  await sql`DELETE FROM projects WHERE slug LIKE 'test/%'`;
  await sql.end();
});

const withCap = (maxMemories: number) => AxonService.create(sql, new FakeEmbedder(), { ...config, maxMemories });

async function save(project: string, title: string, body: string, extra: Record<string, unknown> = {}, svc = service) {
  const r = await svc.remember(mem(project, title, body, { force: true, ...extra }));
  if (!r.saved) throw new Error(`not saved: ${r.text}`);
  return r.id;
}

/** Moves a memory's timestamps into the past, in days; reads are set, not just moved. */
async function backdate(project: string, seq: number, days: { created?: number; updated?: number; read?: number }) {
  const ago = (d?: number) => (d === undefined ? null : d);
  await sql`
    UPDATE memories m SET
      created_at = coalesce(now() - make_interval(days => ${ago(days.created)}::int), m.created_at),
      updated_at = coalesce(now() - make_interval(days => ${ago(days.updated)}::int), m.updated_at),
      last_accessed_at = coalesce(now() - make_interval(days => ${ago(days.read)}::int), m.last_accessed_at)
    FROM projects pr
    WHERE pr.id = m.project_id AND pr.slug = ${project} AND m.seq = ${seq}`;
}

// The fake embedder is bag-of-words: these two share all but one word (cosine ≈ 0.88), every other
// memory below shares almost none with anything (cosine < 0.4).
const DEPLOY = "merge to main and the pipeline builds the image then ships it to production";
const DEPLOY_TOO = "merge to main and the pipeline builds the image then ships it to staging";
const BIG = "lorem ipsum dolor sit amet ".repeat(150);

const HEADINGS = ["Likely duplicates:", "Orphans:", "Oversized:", "Stale state:", "Unread:", "Disputed:"];

describe("review", () => {
  it("finds duplicates, orphans, oversized, stale state and unread memories", async () => {
    const p = slug();
    const deploy = await save(p, "Deploys", DEPLOY);
    const deployToo = await save(p, "Deploy flow", DEPLOY_TOO);
    const orphan = await save(p, "Sessions", "redis holds sessions for exactly one week");
    const big = await save(p, "Big", BIG);
    const status = await save(p, "Billing status", "the billing migration is half done", { kind: "state" });
    const forgotten = await save(p, "Kafka", "kafka topics are partitioned by tenant");
    const readLongAgo = await save(p, "Fonts", "headings use the serif typeface everywhere");
    const readRecently = await save(p, "Queues", "workers poll queues every second");
    const pinned = await save(p, "Overview", "a monolith with a worker sidecar", { kind: "overview", pinned: true });
    // Linked memories are not orphans.
    await service.link({ project: p, id: big, to: [status, forgotten, readLongAgo], remove: false });
    await service.link({ project: p, id: readRecently, to: [status], remove: false });
    await backdate(p, status, { updated: 45 });
    await backdate(p, forgotten, { created: 120 });
    await backdate(p, readLongAgo, { created: 200, read: 100 });
    await backdate(p, readRecently, { created: 200, read: 10 });
    await backdate(p, pinned, { created: 300 });
    await backdate(p, orphan, { created: 5 });
    await service.update({ project: p, id: pinned, dispute: true });

    const r = await service.review({ project: p, budget_tokens: 1500 });
    const { duplicates, orphans, oversized, stale, unread, disputed } = r.sections;

    expect(duplicates).toEqual([{ a: deploy, b: deployToo, similarity: expect.any(Number), linked: false }]);
    expect(duplicates[0]?.similarity).toBeGreaterThanOrEqual(config.dedupSimilarity - 0.1);
    // Oldest first; linked and pinned memories are not orphans.
    expect(orphans.seqs).toEqual([orphan, deploy, deployToo]);
    expect(orphans.total).toBe(3);
    expect(oversized.seqs).toEqual([big]);
    expect(stale.seqs).toEqual([status]);
    // Never read sorts before read long ago; recently read and pinned memories are not unread.
    expect(unread.seqs).toEqual([forgotten, readLongAgo]);
    expect(disputed.seqs).toEqual([pinned]);
    expect(r.cap).toEqual({ active: 9, max: null });

    for (const heading of HEADINGS) expect(r.text).toContain(heading);
    expect(r.text).toMatch(/^# test\/\S+ review — 9 memories, 4 links\n/);
    expect(r.text).toContain("1 likely duplicates · 3 orphans · 1 oversized · 1 stale state · 2 unread · 1 disputed");
    expect(r.text).toMatch(/#1 ↔ #2 \[0\.\d\d\] Deploys · Deploy flow\n/);
    expect(r.text).toMatch(new RegExp(`#4 gotcha · Big · \\d+t ↔3 — over ${LARGE_MEMORY_TOKENS}t`));
    expect(r.text).toMatch(/#5 state · Billing status · \d+t ↔2 — updated 45d ago/);
    expect(r.text).toContain("#6 gotcha · Kafka · ");
    expect(r.text).toMatch(/Kafka · \d+t ↔1 — never read/);
    expect(r.text).toMatch(/Fonts · \d+t ↔1 — last read 100d ago/);
    expect(r.text).not.toContain("Queues");
    expect(r.text).toMatch(/Disputed:\n#9 overview · Overview ⚠ disputed · \d+t ★ — since 0d ago/);
    expect(r.text).not.toContain("Cap:");
    expect(r.text.trimEnd().split("\n").at(-1)).toBe(
      "Next: supersede duplicates (remember supersedes=id) · link orphans · split oversized · confirm, fix or archive stale and disputed",
    );
    expect(r.tokens).toBe(countTokens(r.text));
  });

  it("still lists a duplicate pair once linked, marked as linked", async () => {
    const p = slug();
    const a = await save(p, "Deploys", DEPLOY);
    const b = await save(p, "Deploy flow", DEPLOY_TOO, { links: [a] });
    const r = await service.review({ project: p, budget_tokens: 1500 });
    expect(r.sections.duplicates).toEqual([expect.objectContaining({ a, b, linked: true })]);
    expect(r.text).toContain("Deploys · Deploy flow (linked)");
    expect(r.sections.orphans.total).toBe(0);
  });

  it("omits empty sections", async () => {
    const p = slug();
    await save(p, "Big", BIG, { pinned: true });
    const r = await service.review({ project: p, budget_tokens: 1500 });
    expect(r.text).toContain("Oversized:");
    for (const heading of HEADINGS.filter((h) => h !== "Oversized:")) expect(r.text).not.toContain(heading);
    expect(r.sections).toMatchObject({
      duplicates: [],
      orphans: { seqs: [], total: 0 },
      stale: { seqs: [], total: 0 },
      unread: { seqs: [], total: 0 },
      disputed: { seqs: [], total: 0 },
    });
  });

  it("lists disputed memories until they are confirmed, edited or archived", async () => {
    const p = slug();
    const a = await save(p, "Sessions", "redis holds sessions for exactly one week");
    const b = await save(p, "Queues", "workers poll queues every second", { links: [a] });
    const c = await save(p, "Cache", "the catalogue cache lives for an hour", { links: [a] });
    await service.update({ project: p, id: a, dispute: true });
    await service.update({ project: p, id: b, dispute: true });
    await service.update({ project: p, id: c, dispute: true });
    let r = await service.review({ project: p, budget_tokens: 1500 });
    expect(r.sections.disputed).toEqual({ seqs: [a, b, c], total: 3 });
    expect(r.text).toContain("3 disputed");
    expect(r.text).toMatch(new RegExp(`Disputed:\\n#${a} gotcha · Sessions ⚠ disputed · \\d+t ↔2 — since 0d ago`));
    expect(r.text).toContain("confirm, fix or archive stale and disputed");

    await service.update({ project: p, id: a, confirm: true });
    await service.update({ project: p, id: b, body: "workers poll queues every two seconds" });
    await service.update({ project: p, id: c, status: "archived" });
    r = await service.review({ project: p, budget_tokens: 1500 });
    expect(r.sections.disputed).toEqual({ seqs: [], total: 0 });
    expect(r.text).not.toContain("Disputed:");
  });

  it("gives an all-clear when nothing needs tending", async () => {
    const p = slug();
    const a = await save(p, "Sessions", "redis holds sessions for exactly one week");
    await save(p, "Queues", "workers poll queues every second", { links: [a] });
    const r = await service.review({ project: p, budget_tokens: 1500 });
    expect(r.text).toBe(`Nothing to tidy in ${p}: 2 memories, 1 links.`);
    expect(r.tokens).toBe(countTokens(r.text));
  });

  it("never lists archived or superseded memories", async () => {
    const p = slug();
    const keep = await save(p, "Deploys", DEPLOY);
    const dup = await save(p, "Deploy flow", DEPLOY_TOO, { links: [keep] });
    const big = await save(p, "Big", BIG);
    const status = await save(p, "Billing status", "the billing migration is half done", { kind: "state" });
    const old = await save(p, "Kafka", "kafka topics are partitioned by tenant");
    await backdate(p, status, { updated: 45 });
    await backdate(p, old, { created: 120 });
    expect((await service.review({ project: p, budget_tokens: 1500 })).sections.duplicates).toHaveLength(1);

    await save(p, "Deploys v2", "merge to main and ship", { supersedes: dup, links: [keep] });
    for (const id of [big, status, old]) await service.update({ project: p, id, status: "archived" });
    const r = await service.review({ project: p, budget_tokens: 1500 });
    expect(r.text).toMatch(/^Nothing to tidy in test\/\S+: 2 memories, \d+ links\.$/);
  });

  it("refuses an unknown project", async () => {
    await expect(service.review({ project: slug(), budget_tokens: 1500 })).rejects.toMatchObject({
      code: "not_found",
    });
  });

  it("never exceeds the budget", async () => {
    const p = slug();
    for (let i = 0; i < 40; i++) await save(p, `Note ${i}`, `topic${i} detail${i} item${i} fact${i}`);
    for (let i = 0; i < 4; i++) await save(p, `Big ${i}`, `chunk${i} `.repeat(700));
    await save(p, "Deploys", DEPLOY);
    await save(p, "Deploy flow", DEPLOY_TOO);

    for (const budget of [200, 500, 1500]) {
      const r = await service.review({ project: p, budget_tokens: budget });
      expect(countTokens(r.text)).toBeLessThanOrEqual(budget);
      expect(r.tokens).toBeLessThanOrEqual(budget);
      expect(r.text).toContain(`# ${p} review`);
      if (budget < 1500) expect(r.text).toMatch(/more not shown/);
    }
  });
});

describe("cap", () => {
  it("shows distance to the cap, with ⚠ from 80%", async () => {
    const capped = await withCap(5);
    const p = slug();
    for (const w of ["alpha", "bravo", "charlie"]) await save(p, w, `${w} fact about ${w} things`, {}, capped);

    let r = await capped.review({ project: p, budget_tokens: 1500 });
    expect(r.cap).toEqual({ active: 3, max: 5 });
    expect(r.text).toMatch(/\nCap: 3\/5 \(60%\)\n/);
    expect(r.text).not.toContain("⚠");

    await save(p, "delta", "delta fact about delta things", {}, capped);
    r = await capped.review({ project: p, budget_tokens: 1500 });
    expect(r.cap).toEqual({ active: 4, max: 5 });
    expect(r.text).toContain("Cap: 4/5 (80%) ⚠ near cap");
  });

  it("keeps the cap line in an all-clear", async () => {
    const capped = await withCap(2);
    const p = slug();
    const a = await save(p, "Sessions", "redis holds sessions for exactly one week", {}, capped);
    await save(p, "Queues", "workers poll queues every second", { links: [a] }, capped);
    const r = await capped.review({ project: p, budget_tokens: 1500 });
    expect(r.text).toBe(
      `Nothing to tidy in ${p}: 2 memories, 1 links.\nCap: 2/2 (100%) ⚠ near cap — archive or supersede what is stale`,
    );
  });

  it("remember warns from 90% of the cap, not below", async () => {
    const capped = await withCap(10);
    const p = slug();
    const words = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf"];
    for (const w of words) await save(p, w, `${w} fact about ${w} things`, {}, capped);

    const below = await capped.remember(mem(p, "hotel", "hotel fact about hotel things", { force: true }));
    expect(below.saved && below.warnings).toEqual([]); // 8/10
    expect(below.text).not.toContain("⚠");

    const at = await capped.remember(mem(p, "india", "india fact about india things", { force: true }));
    if (!at.saved) throw new Error("not saved");
    expect(at.warnings).toEqual(["9/10 memories — archive or supersede what is stale; see review."]);
    expect(at.text).toContain("⚠ 9/10 memories — archive or supersede what is stale; see review.");

    // Without a cap there is nothing to warn about.
    const free = await service.remember(mem(p, "juliett", "juliett fact about juliett things", { force: true }));
    expect(free.saved && free.warnings).toEqual([]);
  });

  it("formats large counts with separators", async () => {
    const capped = await withCap(5000);
    const p = slug();
    await save(p, "Sessions", "redis holds sessions for exactly one week", {}, capped);
    // Pad the project to 4,519 active memories without embedding each one.
    await sql`
      INSERT INTO memories (project_id, seq, kind, title, body, tokens)
      SELECT pr.id, 1 + g, 'reference', 'filler ' || g, 'filler', 3
      FROM projects pr, generate_series(1, 4518) g WHERE pr.slug = ${p}`;
    await sql`UPDATE projects SET next_seq = 4520 WHERE slug = ${p}`;
    const r = await capped.remember(mem(p, "Queues", "workers poll queues every second", { force: true }));
    expect(r.saved && r.warnings).toEqual(["4,520/5,000 memories — archive or supersede what is stale; see review."]);
  });
});

describe("isolation", () => {
  it("a review of one project never lists another project's memories", async () => {
    const a = slug();
    const b = slug();
    // A holds one memory that is a near-duplicate of one in B: a pair only across projects.
    await save(a, "Deploys", DEPLOY);
    await save(b, "Bravo deploy flow", DEPLOY_TOO);
    await save(b, "Bravo sessions", "redis holds sessions for exactly one week");
    await save(b, "Bravo big", BIG);
    const status = await save(b, "Bravo status", "the billing migration is half done", { kind: "state" });
    const old = await save(b, "Bravo kafka", "kafka topics are partitioned by tenant");
    await backdate(b, status, { updated: 45 });
    await backdate(b, old, { created: 120 });

    const rb = await service.review({ project: b, budget_tokens: 1500 });
    expect(rb.sections.orphans.total).toBe(5);
    expect(rb.sections.duplicates).toEqual([]);

    const ra = await service.review({ project: a, budget_tokens: 1500 });
    expect(ra.sections.duplicates).toEqual([]);
    expect(ra.sections.orphans.seqs).toEqual([1]);
    for (const s of [ra.sections.oversized, ra.sections.stale, ra.sections.unread]) expect(s.total).toBe(0);
    expect(ra.cap.active).toBe(1);
    expect(ra.text).not.toContain("Bravo");
    expect(ra.text).toContain(`# ${a} review — 1 memories, 0 links`);
  });
});
