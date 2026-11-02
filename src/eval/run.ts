import { readFile } from "node:fs/promises";
import type { Config } from "../config.js";
import { AxonService } from "../core/service.js";
import { connect, type Sql, siblingDatabase } from "../db/client.js";
import { migrate } from "../db/migrate.js";
import type { Embedder } from "../embed/embedder.js";
import { releaseEmbeddingModel } from "../store/bindings.js";
import type { Kind } from "../store/types.js";

interface Golden {
  project: string;
  memories: { kind: Kind; title: string; body: string; tags: string[]; paths: string[]; pinned?: boolean }[];
  queries: { category: string; query: string; expect: string[] }[];
}

const DEFAULT_GOLDEN = new URL("../../eval/golden.json", import.meta.url);
const K = 10;

/**
 * Retrieval quality of the full search path (embedder + hybrid SQL + thresholds) on a golden set,
 * run in a scratch `<db>_eval` database. Reports recall@1/@5 and MRR@10 per query category, and
 * how much noise queries with no right answer return.
 */
export async function runEval(opts: { sql: Sql; embedder: Embedder; config: Config; golden?: string }) {
  const golden: Golden = JSON.parse(await readFile(opts.golden ?? DEFAULT_GOLDEN, "utf8"));
  const sql = connect(await siblingDatabase(opts.config.databaseUrl, "eval"));

  try {
    await migrate(sql);
    await releaseEmbeddingModel(sql);
    await sql`DELETE FROM projects WHERE slug = ${golden.project}`;
    const service = await AxonService.create(sql, opts.embedder, opts.config);
    console.error(`embedder ${service.embedderId}; indexing ${golden.memories.length} memories…`);

    const bySeq = new Map<number, string>();
    let t = performance.now();
    for (const m of golden.memories) {
      const r = await service.remember({
        project: golden.project,
        ...m,
        pinned: m.pinned ?? false,
        importance: 3,
        force: true,
      });
      if (!r.saved) throw new Error(`failed to index ${m.title}`);
      bySeq.set(r.id, m.title);
    }
    const indexMs = (performance.now() - t) / golden.memories.length;

    const rows: {
      category: string;
      rank: number | null;
      hits: number;
      topSim: number | null;
      query: string;
      top: string;
    }[] = [];
    t = performance.now();
    for (const q of golden.queries) {
      const r = await service.search({ project: golden.project, query: q.query, k: K, budget_tokens: 20_000 });
      const titles = r.hits.map((h) => bySeq.get(h.memory.seq) ?? "?");
      const idx = titles.findIndex((title) => q.expect.includes(title));
      rows.push({
        category: q.category,
        rank: q.expect.length ? (idx >= 0 ? idx + 1 : null) : null,
        hits: r.hits.length,
        topSim: r.hits[0]?.similarity ?? null,
        query: q.query,
        top: titles[0] ?? "—",
      });
    }
    const queryMs = (performance.now() - t) / golden.queries.length;

    const pct = (x: number) => `${(x * 100).toFixed(0)}%`.padStart(5);
    console.log(`\n${"category".padEnd(14)} ${"n".padStart(3)}   R@1   R@5  MRR@10`);
    const positives = rows.filter((r) => r.category !== "negative");
    for (const cat of [...new Set(positives.map((r) => r.category)), "all"]) {
      const rs = cat === "all" ? positives : positives.filter((r) => r.category === cat);
      const r1 = rs.filter((r) => r.rank === 1).length / rs.length;
      const r5 = rs.filter((r) => r.rank !== null && r.rank <= 5).length / rs.length;
      const mrr = rs.reduce((s, r) => s + (r.rank ? 1 / r.rank : 0), 0) / rs.length;
      console.log(`${cat.padEnd(14)} ${String(rs.length).padStart(3)} ${pct(r1)} ${pct(r5)}   ${mrr.toFixed(3)}`);
    }

    const negatives = rows.filter((r) => r.category === "negative");
    if (negatives.length) {
      const avgHits = negatives.reduce((s, r) => s + r.hits, 0) / negatives.length;
      console.log(
        `\nnegatives: ${negatives.length} queries with no right answer, avg ${avgHits.toFixed(1)} hits returned`,
      );
    }
    const sims = (rs: typeof rows) => rs.map((r) => r.topSim).filter((s): s is number => s !== null);
    const fmt = (xs: number[]) =>
      xs.length
        ? `min ${Math.min(...xs).toFixed(2)} · median ${median(xs).toFixed(2)} · max ${Math.max(...xs).toFixed(2)}`
        : "—";
    console.log(`top-1 similarity  positives: ${fmt(sims(positives))}`);
    console.log(`                  negatives: ${fmt(sims(negatives))}`);
    console.log(`latency: ${indexMs.toFixed(0)} ms/remember · ${queryMs.toFixed(0)} ms/search`);

    const misses = positives.filter((r) => r.rank !== 1);
    if (misses.length) {
      console.log("\nnot ranked first:");
      for (const m of misses) console.log(`  [${m.category}] "${m.query}" → rank ${m.rank ?? "–"}, top: ${m.top}`);
    }

    await sql`DELETE FROM projects WHERE slug = ${golden.project}`;
  } finally {
    await sql.end();
  }
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? (s[mid] ?? 0) : ((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2;
}
