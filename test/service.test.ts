import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AxonError, AxonService } from "../src/core/service.js";
import { countTokens } from "../src/core/tokens.js";
import type { Sql } from "../src/db/client.js";
import { FakeEmbedder } from "../src/embed/fake.js";
import { mem, setup, slug } from "./helpers.js";

let sql: Sql;
let service: AxonService;
/** The same database with AXON_MAX_MEMORIES=2. */
let capped: AxonService;

beforeAll(async () => {
  let config: Awaited<ReturnType<typeof setup>>["config"];
  ({ sql, service, config } = await setup());
  capped = await AxonService.create(sql, new FakeEmbedder(), { ...config, maxMemories: 2 });
});
afterAll(async () => {
  await sql`DELETE FROM projects WHERE slug LIKE 'test/%'`;
  await sql.end();
});

async function save(project: string, title: string, body: string, extra: Record<string, unknown> = {}) {
  const r = await service.remember(mem(project, title, body, extra));
  if (!r.saved) throw new Error(`not saved: ${r.text}`);
  return r.id;
}

describe("memories", () => {
  it("assigns per-project ids and isolates projects", async () => {
    const a = slug();
    const b = slug();
    expect(await save(a, "Alpha", "apples grow on orchard trees")).toBe(1);
    expect(await save(a, "Beta", "bananas ripen in warm rooms")).toBe(2);
    expect(await save(b, "Gamma", "grapes become wine in barrels")).toBe(1);

    const got = await service.get({ project: a, ids: [1, 2, 3] });
    expect(got.memories.map((m) => m.title)).toEqual(["Alpha", "Beta"]);
    expect(got.missing).toEqual([3]);

    const search = await service.search({ project: b, query: "apples orchard", k: 8, budget_tokens: 1200 });
    expect(search.hits.map((h) => h.memory.title)).not.toContain("Alpha");
  });

  it("refuses near-duplicates unless forced", async () => {
    const p = slug();
    await save(p, "Deploy", "merge to main and the pipeline ships the image");
    const dup = await service.remember(mem(p, "Deploy", "merge to main and the pipeline ships the image"));
    expect(dup.saved).toBe(false);
    if (!dup.saved) expect(dup.duplicates[0]?.seq).toBe(1);

    const forced = await service.remember(
      mem(p, "Deploy", "merge to main and the pipeline ships the image", { force: true }),
    );
    expect(forced.saved).toBe(true);
  });

  it("finds exact identifiers through the keyword lane", async () => {
    const p = slug();
    await save(p, "Env", "the service reads STRIPE_WEBHOOK_SECRET at boot");
    await save(p, "Other", "unrelated notes about colours and fonts");
    const r = await service.search({ project: p, query: "STRIPE_WEBHOOK_SECRET", k: 8, budget_tokens: 1200 });
    expect(r.hits[0]?.memory.title).toBe("Env");
    expect(r.hits[0]?.keyword).toBe(true);
  });

  it("filters by kind, tag and path prefix", async () => {
    const p = slug();
    await save(p, "Store", "postgres queries live in the repository", {
      kind: "architecture",
      tags: ["db"],
      paths: ["src/store"],
    });
    await save(p, "Style", "tabs versus spaces debate settled", { kind: "convention", tags: ["style"] });
    const byPath = await service.search({ project: p, k: 8, budget_tokens: 1200, paths: ["src/store/pg.ts"] });
    expect(byPath.hits.map((h) => h.memory.title)).toEqual(["Store"]);
    const byKind = await service.search({ project: p, k: 8, budget_tokens: 1200, kinds: ["convention"] });
    expect(byKind.hits.map((h) => h.memory.title)).toEqual(["Style"]);
    const byTag = await service.search({ project: p, k: 8, budget_tokens: 1200, tags: ["db"] });
    expect(byTag.hits.map((h) => h.memory.title)).toEqual(["Store"]);
  });

  it("keeps briefings within budget with pinned memories in full", async () => {
    const p = slug();
    await save(p, "Overview", "the whole system in one paragraph", { kind: "overview", pinned: true });
    for (let i = 0; i < 30; i++) await save(p, `Fact ${i}`, `word${i} `.repeat(60));
    const b = await service.briefing({ project: p, budget_tokens: 800 });
    expect(countTokens(b.text)).toBeLessThanOrEqual(800);
    expect(b.shown[0]?.memory.title).toBe("Overview");
    expect(b.shown[0]?.mode).toBe("full");
    expect(b.omitted.length).toBeGreaterThan(0);
  });

  it("reports unknown projects instead of failing", async () => {
    const b = await service.briefing({ project: slug(), budget_tokens: 500 });
    expect(b.found).toBe(false);
    await expect(service.get({ project: slug(), ids: [1] })).rejects.toBeInstanceOf(AxonError);
  });

  it("supersedes: old memory leaves search, links move to the successor", async () => {
    const p = slug();
    const old = await save(p, "Old rule", "we deploy on fridays with caution");
    const peer = await save(p, "Peer", "rollbacks use the previous image tag");
    await service.link({ project: p, id: old, to: [peer], remove: false });

    const r = await service.remember(mem(p, "New rule", "we never deploy on fridays", { supersedes: old }));
    expect(r.saved).toBe(true);
    if (!r.saved) return;

    const [before] = (await service.get({ project: p, ids: [old] })).memories;
    expect(before?.status).toBe("superseded");
    expect(before?.supersededBy).toBe(r.id);

    const search = await service.search({ project: p, query: "deploy fridays", k: 8, budget_tokens: 1200 });
    expect(search.hits.map((h) => h.memory.seq)).not.toContain(old);

    const related = await service.related({ project: p, id: r.id, hops: 1, budget_tokens: 1000 });
    expect(related.steps.map((s) => s.memory.seq)).toEqual([peer]);
  });
});

describe("memory cap", () => {
  const fill = async (p: string) => {
    for (const w of ["alpha", "bravo"]) await capped.remember(mem(p, w, `${w} fact about ${w} things`));
  };
  const third = (p: string, extra: Record<string, unknown> = {}) =>
    capped.remember(mem(p, "charlie", "charlie fact about charlie things", extra));

  it("refuses a plain remember at the cap until something is archived", async () => {
    const p = slug();
    await fill(p);
    await expect(third(p)).rejects.toMatchObject({ code: "rule", message: expect.stringMatching(/cap \(2\)/) });

    await capped.update({ project: p, id: 1, status: "archived" });
    expect(await third(p)).toMatchObject({ saved: true, id: 3 });
    await expect(capped.remember(mem(p, "delta", "delta fact about delta things"))).rejects.toMatchObject({
      code: "rule",
    });
  });

  it("admits a superseding remember at the cap: it does not grow the count", async () => {
    const p = slug();
    await fill(p);
    expect(await third(p, { supersedes: 2 })).toMatchObject({ saved: true, id: 3, superseded: 2 });
    await expect(capped.remember(mem(p, "delta", "delta fact about delta things"))).rejects.toMatchObject({
      code: "rule",
    });
  });

  it("is unlimited when unset", async () => {
    const p = slug();
    for (const w of ["alpha", "bravo", "charlie"]) await save(p, w, `${w} fact about ${w} things`);
    expect((await service.briefing({ project: p, budget_tokens: 1500 })).stats?.kinds).toEqual({ gotcha: 3 });
  });

  it("admits exactly one of several concurrent remembers at cap-1", async () => {
    const p = slug();
    await capped.remember(mem(p, "alpha", "alpha fact about alpha things"));
    const results = await Promise.allSettled(
      ["bravo", "charlie", "delta", "echo", "foxtrot"].map((w) =>
        capped.remember(mem(p, w, `${w} fact about ${w} things`)),
      ),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    for (const r of results) if (r.status === "rejected") expect(r.reason).toMatchObject({ code: "rule" });
    expect((await service.briefing({ project: p, budget_tokens: 1500 })).stats?.kinds).toEqual({ gotcha: 2 });
  });
});

describe("links", () => {
  it("rejects self-links and ids from other projects", async () => {
    const p = slug();
    const q = slug();
    const a = await save(p, "A", "alpha memory about caching layers");
    await save(q, "X", "xray memory about unrelated things");
    await save(q, "Y", "yankee memory about more things");

    await expect(service.link({ project: p, id: a, to: [a], remove: false })).rejects.toMatchObject({ code: "rule" });
    // #2 exists in project q but not in p.
    await expect(service.link({ project: p, id: a, to: [2], remove: false })).rejects.toMatchObject({
      code: "not_found",
    });
  });

  it("is undirected and idempotent", async () => {
    const p = slug();
    const a = await save(p, "A", "alpha memory about caching layers");
    const b = await save(p, "B", "bravo memory about queue workers");
    expect((await service.link({ project: p, id: a, to: [b], remove: false })).created).toBe(1);
    const again = await service.link({ project: p, id: b, to: [a], note: "same subsystem", remove: false });
    expect(again.created).toBe(0);
    expect(again.existing).toBe(1);

    const [{ n } = { n: -1 }] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM memory_links l JOIN projects pr ON pr.id = l.project_id WHERE pr.slug = ${p}`;
    expect(n).toBe(1);

    const [ma] = (await service.get({ project: p, ids: [a] })).memories;
    expect(ma?.links).toEqual([expect.objectContaining({ seq: b, note: "same subsystem" })]);
    expect(ma?.degree).toBe(1);
  });

  it("enforces the per-memory link cap", async () => {
    const p = slug();
    const ids = [];
    for (const w of ["one", "two", "three", "four", "five", "six"])
      ids.push(await save(p, w, `${w} distinct words ${w}`));
    const [hub, ...rest] = ids as [number, ...number[]];
    await service.link({ project: p, id: hub, to: rest.slice(0, 4), remove: false }); // cap is 4 in tests
    await expect(service.link({ project: p, id: hub, to: [rest[4] as number], remove: false })).rejects.toMatchObject({
      code: "rule",
    });
  });

  it("the database itself forbids self-links and cross-project links", async () => {
    const p = slug();
    const q = slug();
    await save(p, "A", "alpha memory about caching layers");
    await save(q, "B", "bravo memory about queue workers");
    const [a] = await sql<{ id: number; projectId: string }[]>`
      SELECT m.id, m.project_id FROM memories m JOIN projects pr ON pr.id = m.project_id WHERE pr.slug = ${p}`;
    const [b] = await sql<{ id: number }[]>`
      SELECT m.id FROM memories m JOIN projects pr ON pr.id = m.project_id WHERE pr.slug = ${q}`;
    if (!a || !b) throw new Error("setup failed");

    await expect(
      sql`INSERT INTO memory_links (project_id, a_id, b_id) VALUES (${a.projectId}, ${a.id}, ${a.id})`,
    ).rejects.toThrow(/check constraint/);
    await expect(
      sql`INSERT INTO memory_links (project_id, a_id, b_id) VALUES (${a.projectId}, ${Math.min(a.id, b.id)}, ${Math.max(a.id, b.id)})`,
    ).rejects.toThrow(/foreign key/);
  });

  it("walks a chain with a cycle, visiting each memory once at its shortest hop", async () => {
    const p = slug();
    const a = await save(p, "A", "alpha memory about caching layers");
    const b = await save(p, "B", "bravo memory about queue workers");
    const c = await save(p, "C", "charlie memory about database pools");
    const d = await save(p, "D", "delta memory about http routing");
    await service.link({ project: p, id: a, to: [b], remove: false });
    await service.link({ project: p, id: b, to: [c], remove: false });
    await service.link({ project: p, id: c, to: [a], remove: false }); // cycle back to A
    await service.link({ project: p, id: c, to: [d], remove: false });

    const one = await service.related({ project: p, id: a, hops: 1, budget_tokens: 2000 });
    expect(one.steps.map((s) => [s.memory.seq, s.hop]).sort()).toEqual([
      [b, 1],
      [c, 1],
    ]);

    const two = await service.related({ project: p, id: a, hops: 2, budget_tokens: 2000 });
    const seen = two.steps.map((s) => s.memory.seq);
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).not.toContain(a);
    expect(two.steps.find((s) => s.memory.seq === d)).toMatchObject({ hop: 2, via: c });
  });

  it("skips archived memories when walking", async () => {
    const p = slug();
    const a = await save(p, "A", "alpha memory about caching layers");
    const b = await save(p, "B", "bravo memory about queue workers");
    const c = await save(p, "C", "charlie memory about database pools");
    await service.link({ project: p, id: a, to: [b], remove: false });
    await service.link({ project: p, id: b, to: [c], remove: false });
    await service.update({ project: p, id: b, status: "archived" });
    const r = await service.related({ project: p, id: a, hops: 3, budget_tokens: 2000 });
    expect(r.steps).toEqual([]);
  });

  it("strengthens links that get traversed (Hebbian)", async () => {
    const p = slug();
    const hub = await save(p, "Hub", "hub memory about the payment system");
    const x = await save(p, "X", "xray memory about invoices");
    const y = await save(p, "Y", "yankee memory about refunds");
    await service.link({ project: p, id: hub, to: [x, y], remove: false });

    // Tied at first; newest wins ties (y).
    let r = await service.related({ project: p, id: hub, hops: 1, budget_tokens: 2000 });
    expect(r.steps.map((s) => s.memory.seq)).toEqual([y, x]);

    // Reading hub and x together reinforces hub–x.
    await service.get({ project: p, ids: [hub, x] });
    r = await service.related({ project: p, id: hub, hops: 1, budget_tokens: 2000 });
    expect(r.steps.map((s) => s.memory.seq)).toEqual([x, y]);
    expect(r.steps[0]?.strength).toBeGreaterThan(r.steps[1]?.strength ?? 0);
  });

  it("surfaces neighbours of top hits in search", async () => {
    const p = slug();
    const a = await save(p, "Payments", "stripe charges and payment intents");
    const b = await save(p, "Ledger", "double entry bookkeeping tables");
    await service.link({ project: p, id: a, to: [b], remove: false });
    const r = await service.search({ project: p, query: "stripe payment intents", k: 1, budget_tokens: 1200 });
    expect(r.hits.map((h) => h.memory.seq)).toEqual([a]);
    expect(r.linked.map((l) => [l.memory.seq, l.from])).toEqual([[b, a]]);
    expect(r.text).toContain("Linked:");
  });

  it("links new memories at creation and suggests similar ones", async () => {
    const p = slug();
    const a = await save(p, "Queue", "jobs retry with exponential backoff in the worker");
    const r = await service.remember(
      mem(p, "Queue retries", "jobs retry with exponential backoff in the worker process too", {
        links: [a],
        link_note: "same worker",
        force: true,
      }),
    );
    expect(r.saved && r.linked).toEqual([a]);
    const [created] = (await service.get({ project: p, ids: [r.saved ? r.id : 0] })).memories;
    expect(created?.links[0]).toMatchObject({ seq: a, note: "same worker" });
  });
});
