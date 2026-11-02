import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AxonService } from "../src/core/service.js";
import { countTokens } from "../src/core/tokens.js";
import type { Sql } from "../src/db/client.js";
import { migrate } from "../src/db/migrate.js";
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

async function save(project: string, title: string, body: string, extra: Record<string, unknown> = {}) {
  const r = await service.remember(mem(project, title, body, { force: true, ...extra }));
  if (!r.saved) throw new Error(`not saved: ${r.text}`);
  return r.id;
}

const titles = (hits: { memory: { title: string } }[]) => hits.map((h) => h.memory.title);

describe("ids", () => {
  it("stay unique and gapless under concurrent writes", async () => {
    const p = slug();
    const words = ["amber", "birch", "cedar", "dune", "ember", "fjord", "grove", "heath", "inlet", "jetty"];
    const ids = await Promise.all(words.map((w) => save(p, w, `${w} ${w} ${w}`)));
    expect([...ids].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });
});

describe("lifecycle", () => {
  it("archived memories leave search and the briefing body but stay readable", async () => {
    const p = slug();
    const a = await save(p, "Kept", "kafka topics are partitioned by tenant");
    const b = await save(p, "Retired", "kafka topics used to be partitioned by region");
    await service.update({ project: p, id: b, status: "archived" });

    const search = await service.search({ project: p, query: "kafka topics partitioned", k: 8, budget_tokens: 2000 });
    expect(titles(search.hits)).toEqual(["Kept"]);
    const briefing = await service.briefing({ project: p, budget_tokens: 2000 });
    expect(briefing.shown.map((s) => s.memory.seq)).toEqual([a]);
    // Only the briefing's list of recent changes still names it, as archived.
    expect(briefing.recent.map((r) => [r.memory.seq, r.change])).toEqual([[b, "archived"]]);
    const [archived] = (await service.get({ project: p, ids: [b] })).memories;
    expect(archived?.status).toBe("archived");

    await service.update({ project: p, id: b, status: "active" });
    const again = await service.search({ project: p, query: "kafka topics partitioned", k: 8, budget_tokens: 2000 });
    expect(titles(again.hits).sort()).toEqual(["Kept", "Retired"]);
  });

  it("update re-embeds only when title or body change", async () => {
    const p = slug();
    const id = await save(p, "Cache", "redis holds sessions");
    const meta = await service.update({ project: p, id, tags: ["infra"], pinned: true });
    expect(meta.reembedded).toBe(false);

    const text = await service.update({ project: p, id, body: "memcached holds sessions" });
    expect(text.reembedded).toBe(true);
    const hits = await service.search({ project: p, query: "memcached", k: 8, budget_tokens: 2000 });
    expect(hits.hits[0]?.memory.seq).toBe(id);
    const [m] = (await service.get({ project: p, ids: [id] })).memories;
    expect(m).toMatchObject({ body: "memcached holds sessions", tags: ["infra"], pinned: true });
    expect(m?.tokens).toBe(countTokens("Cache\nmemcached holds sessions"));
  });

  it("superseded memories cannot be revived or superseded again", async () => {
    const p = slug();
    const old = await save(p, "Old", "we use yarn for packages");
    await save(p, "New", "we use npm for packages", { supersedes: old });
    await expect(service.update({ project: p, id: old, status: "active" })).rejects.toMatchObject({ code: "rule" });
    await expect(
      service.remember(mem(p, "Newer", "we use pnpm for packages", { supersedes: old })),
    ).rejects.toMatchObject({ code: "rule" });
  });

  it("remember with unknown link or supersede targets writes nothing", async () => {
    const p = slug();
    await save(p, "Only", "the only memory here");
    await expect(service.remember(mem(p, "Bad", "links nowhere", { links: [42] }))).rejects.toMatchObject({
      code: "not_found",
    });
    const [{ n } = { n: -1 }] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM memories m JOIN projects pr ON pr.id = m.project_id WHERE pr.slug = ${p}`;
    expect(n).toBe(1);
  });

  it("warns about oversized and non-English memories without refusing them", async () => {
    const p = slug();
    const big = await service.remember(mem(p, "Big", "lorem ipsum dolor sit amet ".repeat(150), { force: true }));
    expect(big.saved && big.warnings.join()).toMatch(/consider splitting/);
    const uk = await service.remember(
      mem(
        p,
        "Міграції",
        "Перед запуском сервера потрібно виконати міграції бази даних, інакше застосунок впаде під час старту.",
        { force: true },
      ),
    );
    expect(uk.saved && uk.warnings.join()).toMatch(/not English/);
  });
});

describe("links", () => {
  it("cap applies to the target memory too", async () => {
    const p = slug();
    const words = ["one", "two", "three", "four", "five", "six"];
    const [target, a, b, c, d, newcomer] = (await Promise.all(words.map((w) => save(p, w, `${w} ${w}`)))).sort(
      (x, y) => x - y,
    ) as number[];
    await service.link({ project: p, id: target as number, to: [a, b, c, d] as number[], remove: false }); // cap is 4
    await expect(
      service.link({ project: p, id: newcomer as number, to: [target as number], remove: false }),
    ).rejects.toMatchObject({ code: "rule", message: expect.stringContaining(`#${target}`) });
  });

  it("re-linking an existing pair does not count against the cap", async () => {
    const p = slug();
    const ids = await Promise.all(["one", "two", "three", "four", "five"].map((w) => save(p, w, `${w} ${w}`)));
    const [hub, ...rest] = ids.sort((x, y) => x - y) as [number, ...number[]];
    await service.link({ project: p, id: hub, to: rest, remove: false });
    const again = await service.link({ project: p, id: hub, to: rest, note: "renamed", remove: false });
    expect(again).toMatchObject({ created: 0, existing: 4 });
  });

  it("unlink removes the pair in either direction", async () => {
    const p = slug();
    const a = await save(p, "A", "alpha alpha");
    const b = await save(p, "B", "bravo bravo");
    await service.link({ project: p, id: a, to: [b], remove: false });
    expect((await service.link({ project: p, id: b, to: [a], remove: true })).removed).toBe(1);
    const [m] = (await service.get({ project: p, ids: [a] })).memories;
    expect(m?.degree).toBe(0);
    expect(m?.links).toEqual([]);
  });

  it("degree and footers count only active neighbours", async () => {
    const p = slug();
    const a = await save(p, "A", "alpha alpha");
    const b = await save(p, "B", "bravo bravo");
    const c = await save(p, "C", "charlie charlie");
    await service.link({ project: p, id: a, to: [b, c], remove: false });
    await service.update({ project: p, id: c, status: "archived" });
    const [m] = (await service.get({ project: p, ids: [a] })).memories;
    expect(m?.degree).toBe(1);
    expect(m?.links.map((l) => l.seq)).toEqual([b]);
  });

  it("memory_edges lists every link once in each direction, within its project", async () => {
    const p = slug();
    const other = slug();
    const [a, b, c] = [
      await save(p, "A", "alpha one"),
      await save(p, "B", "beta two"),
      await save(p, "C", "gamma three"),
    ];
    await save(other, "X", "xray four");
    await service.link({ project: p, id: a, to: [b, c], note: "same area", remove: false });
    const edges = await sql<{ src: number; dst: number; note: string | null }[]>`
      SELECT s.seq AS src, d.seq AS dst, e.note
      FROM memory_edges e JOIN memories s ON s.id = e.src JOIN memories d ON d.id = e.dst
      JOIN projects pr ON pr.id = e.project_id
      WHERE pr.slug = ${p} ORDER BY 1, 2`;
    expect(edges).toEqual([
      { src: a, dst: b, note: "same area" },
      { src: a, dst: c, note: "same area" },
      { src: b, dst: a, note: "same area" },
      { src: c, dst: a, note: "same area" },
    ]);
    const [{ n } = { n: -1 }] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM memory_edges e JOIN projects pr ON pr.id = e.project_id WHERE pr.slug = ${other}`;
    expect(n).toBe(0);
  });

  it("extra link strength decays towards 1 with a 60-day half-life", async () => {
    const [row] = await sql<{ fresh: number; halved: number; base: number }[]>`
      SELECT axon_link_strength(3, now(), now()) AS fresh,
             axon_link_strength(3, now() - interval '60 days', now()) AS halved,
             axon_link_strength(1, now() - interval '600 days', now()) AS base`;
    expect(row?.fresh).toBeCloseTo(3, 3);
    expect(row?.halved).toBeCloseTo(2, 3);
    expect(row?.base).toBeCloseTo(1, 6);
  });
});

describe("budgets", () => {
  it("search and related never exceed their token budgets", async () => {
    const p = slug();
    const hub = await save(p, "Hub", "payments hub ".repeat(40));
    const spokes: number[] = [];
    for (let i = 0; i < 12; i++) spokes.push(await save(p, `Spoke ${i}`, `payments spoke${i} `.repeat(60)));
    await service.link({ project: p, id: hub, to: spokes.slice(0, 4), remove: false }); // cap is 4

    for (const budget of [200, 500, 1500]) {
      const s = await service.search({ project: p, query: "payments", k: 20, budget_tokens: budget });
      expect(countTokens(s.text)).toBeLessThanOrEqual(budget);
      expect(s.tokens).toBeLessThanOrEqual(budget);
      const r = await service.related({ project: p, id: hub, hops: 3, budget_tokens: budget });
      expect(countTokens(r.text)).toBeLessThanOrEqual(budget);
    }
  });
});

describe("budgets with a focus", () => {
  it("briefings never exceed their token budgets, and pinned memories still come first", async () => {
    const p = slug();
    await save(p, "Overview", "payments overview ".repeat(40), { kind: "overview", pinned: true });
    for (let i = 0; i < 12; i++) {
      await save(p, `Spoke ${i}`, `payments spoke${i} `.repeat(60), { importance: 5, paths: [`src/pay/${i}.ts`] });
    }
    const retired = await save(p, "Retired", "payments used to settle weekly ".repeat(20));
    await service.update({ project: p, id: retired, status: "archived" });

    const tailored = [
      { focus: "payments" },
      { focus: "payments spoke3 settlement", paths: ["src/pay"] },
      { paths: ["src/pay/3.ts", "src/pay/4.ts"] },
    ];
    for (const budget of [200, 500, 1500]) {
      for (const t of tailored) {
        const b = await service.briefing({ project: p, budget_tokens: budget, ...t });
        expect(countTokens(b.text)).toBeLessThanOrEqual(budget);
        expect(b.tokens).toBeLessThanOrEqual(budget);
        if (budget === 1500) expect(b.shown[0]?.memory.title).toBe("Overview");
      }
    }
  });
});

describe("migrations", () => {
  it("are idempotent", async () => {
    expect(await migrate(sql)).toEqual([]);
  });
});

/** Strength of the link between `from` and a neighbour, as `related` reports it. */
async function strength(project: string, from: number, to: number): Promise<number | undefined> {
  const r = await service.related({ project, id: from, hops: 1, budget_tokens: 20_000 });
  return r.steps.find((s) => s.memory.seq === to)?.strength;
}

describe("link strength", () => {
  it("never exceeds the ceiling, however often a link is used", async () => {
    const p = slug();
    const a = await save(p, "A", "alpha cache invalidation");
    const b = await save(p, "B", "bravo queue retries");
    await service.link({ project: p, id: a, to: [b], remove: false });
    for (let i = 0; i < 25; i++) await service.get({ project: p, ids: [a, b] });
    const s = (await strength(p, a, b)) ?? 0;
    expect(s).toBeLessThanOrEqual(5);
    expect(s).toBeGreaterThan(4.9);
  });

  it("grows only along paths related actually delivered in full", async () => {
    const p = slug();
    const a = await save(p, "A", "alpha ".repeat(400));
    const b = await save(p, "B", "bravo ".repeat(400));
    await service.link({ project: p, id: a, to: [b], remove: false });
    // Too small a budget for B's body: B is only an index line, so the link wasn't followed.
    const tight = await service.related({ project: p, id: a, hops: 1, budget_tokens: 200 });
    expect(tight.steps.map((s) => s.mode)).toEqual(["index"]);
    expect(
      await sql`SELECT 1 FROM memory_links l JOIN projects pr ON pr.id = l.project_id
                     WHERE pr.slug = ${p} AND l.weight > 1`,
    ).toHaveLength(0);
    const roomy = await service.related({ project: p, id: a, hops: 1, budget_tokens: 5000 });
    expect(roomy.steps.map((s) => s.mode)).toEqual(["full"]);
    expect(
      await sql`SELECT 1 FROM memory_links l JOIN projects pr ON pr.id = l.project_id
                     WHERE pr.slug = ${p} AND l.weight > 1`,
    ).toHaveLength(1);
  });

  it("walks reach a memory through its strongest path among equally short ones", async () => {
    const p = slug();
    const [a, b, c, d] = [
      await save(p, "A", "alpha start node"),
      await save(p, "B", "bravo weak side"),
      await save(p, "C", "charlie strong side"),
      await save(p, "D", "delta goal node"),
    ];
    await service.link({ project: p, id: a, to: [b, c], remove: false });
    await service.link({ project: p, id: d, to: [b, c], remove: false });
    // Reading A, C and D together strengthens A–C and C–D, not the B side.
    await service.get({ project: p, ids: [a, c, d] });
    const r = await service.related({ project: p, id: a, hops: 2, budget_tokens: 20_000 });
    const goal = r.steps.find((s) => s.memory.seq === d);
    expect(goal).toMatchObject({ hop: 2, via: c, path: [a, c, d] });
    expect(r.steps.filter((s) => s.memory.seq === d)).toHaveLength(1);
  });
});

describe("link notes", () => {
  it("are kept when a pair is re-linked without one, and replaced when it is re-linked with one", async () => {
    const p = slug();
    const a = await save(p, "A", "alpha billing exports");
    const b = await save(p, "B", "bravo invoice pdfs");
    await service.link({ project: p, id: a, to: [b], note: "first", remove: false });
    const bare = await service.link({ project: p, id: b, to: [a], remove: false });
    expect(bare.text).toBe(`Linked #${b} ↔ #${a} (1 already linked).`);
    expect((await service.get({ project: p, ids: [a] })).memories[0]?.links[0]?.note).toBe("first");

    const noted = await service.link({ project: p, id: a, to: [b], note: "second", remove: false });
    expect(noted.text).toBe(`Linked #${a} ↔ #${b} (1 already linked, note updated).`);
    expect((await service.get({ project: p, ids: [b] })).memories[0]?.links[0]?.note).toBe("second");
  });
});

describe("search similarity floor", () => {
  it("drops vector-only hits below it but always keeps keyword hits", async () => {
    const p = slug();
    const kafka = await save(p, "Kafka partitions", "kafka topics are partitioned by tenant id");
    const loose = { project: p, query: "kafka partitioned by region", k: 8, budget_tokens: 2000 };
    const exact = { project: p, query: "tenant", k: 8, budget_tokens: 2000 };

    // Default floor: the paraphrase matches on vectors alone ("region" isn't in the memory, so no keyword hit).
    const found = await service.search(loose);
    expect(found.hits.map((h) => [h.memory.seq, h.keyword])).toEqual([[kafka, false]]);

    const strict = await AxonService.create(sql, new FakeEmbedder(), { ...config, searchMinSimilarity: 0.99 });
    expect((await strict.search(loose)).hits).toEqual([]);
    const kept = await strict.search(exact);
    expect(kept.hits.map((h) => [h.memory.seq, h.keyword])).toEqual([[kafka, true]]);
    expect(kept.hits[0]?.similarity ?? 0).toBeLessThan(0.99);
  });
});

describe("isolation and ids", () => {
  it("refuses to supersede an id that exists only in another project", async () => {
    const p1 = slug();
    const p2 = slug();
    for (const w of ["one", "two", "three"]) await save(p1, w, `${w} memory in the first project`);
    await save(p2, "Only", "the second project has a single memory");
    await expect(
      service.remember(mem(p2, "Replacement", "tries to retire #3 of the first project", { supersedes: 3 })),
    ).rejects.toMatchObject({ code: "not_found" });
    expect((await service.get({ project: p1, ids: [3] })).memories[0]?.status).toBe("active");
    expect((await service.get({ project: p2, ids: [2] })).missing).toEqual([2]);
  });

  it("stay gapless after a write that fails part-way (link cap hit after the insert)", async () => {
    const p = slug();
    const targets = [];
    for (const w of ["a", "b", "c", "d", "e"]) targets.push(await save(p, w, `${w} distinct target ${w}`));
    // Five links on a new memory break the cap of 4: the insert is rolled back with everything else.
    await expect(
      service.remember(mem(p, "Hub", "links to every target", { links: targets, force: true })),
    ).rejects.toMatchObject({ code: "rule" });
    expect(await save(p, "Next", "the following write")).toBe(targets.length + 1);
  });
});
