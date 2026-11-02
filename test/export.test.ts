import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type ExportDocument, ImportInput } from "../src/core/schemas.js";
import { AxonService } from "../src/core/service.js";
import { countTokens } from "../src/core/tokens.js";
import type { Sql } from "../src/db/client.js";
import { FakeEmbedder } from "../src/embed/fake.js";
import { mem, setup, slug } from "./helpers.js";

let sql: Sql;
let service: AxonService;
let config: Awaited<ReturnType<typeof setup>>["config"];
/** The same database with AXON_MAX_MEMORIES=3. */
let capped: AxonService;

beforeAll(async () => {
  ({ sql, service, config } = await setup());
  capped = await AxonService.create(sql, new FakeEmbedder(), { ...config, maxMemories: 3 });
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

/**
 * #1 pinned overview · #2 superseded by #3 · #4 archived.
 * Links: 1↔2 and 1↔3 "deploy policy" (supersede copied it; 1↔3 then reinforced), 3↔4 without a note.
 */
async function seed(p: string) {
  await save(p, "Overview", "the shop is a monolith with a postgres database", {
    kind: "overview",
    pinned: true,
    importance: 5,
    tags: ["arch", "core"],
    paths: ["src/core"],
    source: "docs/README.md",
  });
  await save(p, "Old deploy rule", "we deploy on fridays with caution", { kind: "decision", links: [1] });
  await service.link({ project: p, id: 1, to: [2], note: "deploy policy", remove: false });
  await save(p, "New deploy rule", "we never deploy on fridays at all", { kind: "decision", supersedes: 2 });
  await save(p, "Legacy cache", "memcached sat in front of the catalogue", { tags: ["cache"] });
  await service.link({ project: p, id: 3, to: [4], remove: false });
  await service.update({ project: p, id: 4, status: "archived" });
  await service.get({ project: p, ids: [1, 3] }); // reinforces 1↔3
}

const exportJson = async (project: string, include: "active" | "all" = "all") =>
  (await service.exportProject({ project, format: "json", include })).document;

const importDoc = (target: AxonService, project: string, document: unknown) =>
  target.importProject(ImportInput.parse({ project, document }));

const rows = async (project: string) => {
  const [r] = await sql<{ memories: number; links: number }[]>`
    SELECT (SELECT count(*)::int FROM memories m JOIN projects pr ON pr.id = m.project_id WHERE pr.slug = ${project}) AS memories,
           (SELECT count(*)::int FROM memory_links l JOIN projects pr ON pr.id = l.project_id WHERE pr.slug = ${project}) AS links`;
  return r;
};

const projectExists = async (project: string) => (await sql`SELECT 1 FROM projects WHERE slug = ${project}`).length > 0;

describe("export", () => {
  it("writes every field, link and supersession as JSON, without embeddings or access counters", async () => {
    const p = slug();
    await seed(p);
    const doc = await exportJson(p);

    expect(doc.axon).toEqual({ version: "0.1.0", format: 1 });
    expect(doc.project).toBe(p);
    expect(Date.parse(doc.exported_at)).toBeGreaterThan(Date.now() - 60_000);
    expect(doc.memories.map((m) => [m.seq, m.status, m.superseded_by])).toEqual([
      [1, "active", null],
      [2, "superseded", 3],
      [3, "active", null],
      [4, "archived", null],
    ]);
    expect(doc.memories[0]).toEqual({
      seq: 1,
      kind: "overview",
      title: "Overview",
      body: "the shop is a monolith with a postgres database",
      tags: ["arch", "core"],
      paths: ["src/core"],
      pinned: true,
      importance: 5,
      status: "active",
      superseded_by: null,
      source: "docs/README.md",
      key: null,
      created_at: expect.any(String),
      updated_at: expect.any(String),
      confirmed_at: expect.any(String),
      disputed_at: null,
    });
    expect(doc.links).toEqual([
      { a: 1, b: 2, note: "deploy policy", weight: 1 },
      { a: 1, b: 3, note: "deploy policy", weight: 1.25 },
      { a: 3, b: 4, note: null, weight: 1 },
    ]);
    const text = JSON.stringify(doc);
    expect(text).not.toMatch(/embedding|access_count|last_accessed|tokens|degree|encrypted/);
  });

  it("includes only active memories, and the links between them, with include=active", async () => {
    const p = slug();
    await seed(p);
    const doc = await exportJson(p, "active");
    expect(doc.memories.map((m) => m.seq)).toEqual([1, 3]);
    expect(doc.links).toEqual([{ a: 1, b: 3, note: "deploy policy", weight: 1.25 }]);

    const md = (await service.exportProject({ project: p, format: "markdown", include: "active" })).text;
    expect(md).toContain("we never deploy on fridays at all");
    expect(md).not.toContain("we deploy on fridays with caution");
    expect(md).not.toContain("memcached");
    expect(md).not.toContain("#3 ↔ #4");
  });

  it("renders Markdown with every complete body, its metadata and the links", async () => {
    const p = slug();
    await seed(p);
    const long = `${"a long body that no budget may cut ".repeat(400)}END`;
    await save(p, "Long one", long, { force: true });
    const r = await service.exportProject({ project: p, format: "markdown", include: "all" });

    expect(r.text.split("\n")[0]).toBe(
      `# ${p} — exported ${new Date().toISOString().slice(0, 10)} · 5 memories · 3 links`,
    );
    for (const m of r.document.memories) expect(r.text).toContain(m.body);
    expect(r.text).toContain(long);
    expect(r.text).toContain(
      "## #1 overview · Overview\n\n- tags: arch, core\n- paths: src/core\n- pinned: yes\n- importance: 5\n- status: active\n- source: docs/README.md",
    );
    expect(r.text).toContain(
      "## #2 decision · Old deploy rule\n\n- pinned: no\n- importance: 3\n- status: superseded\n- superseded by: #3",
    );
    expect(r.text).toMatch(
      /- status: archived\n- created: \S+\n- updated: \S+\n- confirmed: \S+\n\nmemcached sat in front of the catalogue/,
    );
    expect(r.text).toContain(
      "## Links\n\n- #1 ↔ #2 — deploy policy\n- #1 ↔ #3 — deploy policy (strength 1.25)\n- #3 ↔ #4",
    );
    expect(r.text.indexOf("## #1 ")).toBeLessThan(r.text.indexOf("## #5 "));
  });

  it("never includes another project's memories or links", async () => {
    const a = slug();
    const b = slug();
    await seed(a);
    await save(b, "B secret", "only project b knows the vault password rotation");
    await save(b, "B other", "project b runs its jobs on a cron", { links: [1], link_note: "b only" });

    const doc = await exportJson(a);
    expect(doc.memories).toHaveLength(4);
    expect(doc.links).toHaveLength(3);
    const text =
      JSON.stringify(doc) + (await service.exportProject({ project: a, format: "markdown", include: "all" })).text;
    expect(text).not.toMatch(/B secret|vault password|cron|b only/);
  });

  it("does not count as a read", async () => {
    const p = slug();
    await seed(p);
    const before =
      await sql`SELECT seq, access_count FROM memories m JOIN projects pr ON pr.id = m.project_id WHERE pr.slug = ${p} ORDER BY seq`;
    await exportJson(p);
    expect(
      await sql`SELECT seq, access_count FROM memories m JOIN projects pr ON pr.id = m.project_id WHERE pr.slug = ${p} ORDER BY seq`,
    ).toEqual(before);
  });

  it("reports an unknown project as not found", async () => {
    await expect(exportJson(slug())).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("import", () => {
  it("round-trips every field, link and the superseded chain into another project under new ids", async () => {
    const a = slug();
    const b = slug();
    await seed(a);
    await save(b, "Already here", "project b had one memory about queues");
    await save(b, "Also here", "and another one about invoices");

    const original = await exportJson(a);
    const r = await importDoc(service, b, original);
    expect(r).toMatchObject({ project: b, imported: 4, links: 3, mapping: { "1": 3, "2": 4, "3": 5, "4": 6 } });
    expect(r.text).toBe(`Imported 4 memories (#3–#6) and 3 links into ${b}.`);

    const copy = await exportJson(b);
    const to = (seq: number) => r.mapping[String(seq)];
    for (const m of original.memories) {
      expect(copy.memories.find((c) => c.seq === to(m.seq))).toEqual({
        ...m,
        seq: to(m.seq),
        superseded_by: m.superseded_by === null ? null : to(m.superseded_by),
      });
    }
    const links = copy.links.filter((l) => l.a > 2);
    expect(links.map((l) => ({ ...l, weight: Number(l.weight.toFixed(3)) }))).toEqual(
      original.links.map((l) => ({ ...l, a: to(l.a), b: to(l.b) })),
    );

    // Superseded stays superseded: out of search, and its successor is the remapped one.
    const [old] = (await service.get({ project: b, ids: [4] })).memories;
    expect(old).toMatchObject({ status: "superseded", supersededBy: 5 });
  });

  it("re-embeds and re-counts tokens, so the copy is searchable", async () => {
    const a = slug();
    const b = slug();
    await seed(a);
    await importDoc(service, b, await exportJson(a));

    const [{ missing } = { missing: -1 }] = await sql<{ missing: number }[]>`
      SELECT count(*)::int AS missing FROM memories m JOIN projects pr ON pr.id = m.project_id
      WHERE pr.slug = ${b} AND m.embedding IS NULL`;
    expect(missing).toBe(0);
    const [overview] = (await service.get({ project: b, ids: [1] })).memories;
    expect(overview?.tokens).toBe(countTokens("Overview\nthe shop is a monolith with a postgres database"));

    const hits = await service.search({ project: b, query: "monolith postgres database", k: 5, budget_tokens: 1200 });
    expect(hits.hits[0]?.memory.title).toBe("Overview");
    const deploy = await service.search({ project: b, query: "deploy on fridays", k: 5, budget_tokens: 1200 });
    expect(deploy.hits.map((h) => h.memory.title)).toEqual(["New deploy rule"]);
    // Linked memories walk as they did in the source.
    const related = await service.related({ project: b, id: 1, hops: 1, budget_tokens: 1000 });
    expect(related.steps.map((s) => s.memory.seq)).toEqual([3]);
  });

  it("restores near-duplicates instead of refusing them", async () => {
    const a = slug();
    await seed(a);
    const doc = await exportJson(a);
    const r = await importDoc(service, a, doc); // the same memories again, into the same project
    expect(r.imported).toBe(4);
    expect((await rows(a))?.memories).toBe(8);
  });

  it("leaves the source project untouched and keeps every row in the target", async () => {
    const a = slug();
    const b = slug();
    await seed(a);
    await save(b, "B secret", "only project b knows the vault password rotation");
    const before = await exportJson(a);
    await importDoc(service, b, before);

    const after = await exportJson(a);
    expect({ ...after, exported_at: "" }).toEqual({ ...before, exported_at: "" });
    expect(await rows(a)).toEqual({ memories: 4, links: 3 });

    // Every imported row and both ends of every link belong to b.
    const [stray] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM memory_links l
      JOIN projects pr ON pr.id = l.project_id
      JOIN memories x ON x.id = l.a_id JOIN memories y ON y.id = l.b_id
      WHERE pr.slug = ${b} AND (x.project_id <> pr.id OR y.project_id <> pr.id)`;
    expect(stray?.n).toBe(0);
    // b's ids don't reach a's memories: #5 is the imported #4 in b, and doesn't exist in a.
    expect((await service.get({ project: b, ids: [5] })).memories[0]?.title).toBe("Legacy cache");
    expect((await service.get({ project: a, ids: [5] })).missing).toEqual([5]);
    expect(JSON.stringify(after)).not.toContain("vault password");
  });

  it("carries keys, confirmations and disputes, and refuses a key the target already holds", async () => {
    const a = slug();
    const b = slug();
    await save(a, "Deploy", "prod runs v1.4", { kind: "state", key: "deploy/current" });
    await save(a, "Flaky cache", "the catalogue cache is sometimes stale", { kind: "gotcha" });
    await service.update({ project: a, id: 2, dispute: true });
    const doc = await exportJson(a);
    expect(doc.memories.map((m) => [m.key, m.disputed_at !== null])).toEqual([
      ["deploy/current", false],
      [null, true],
    ]);
    expect(doc.memories[0]?.confirmed_at).toBe(doc.memories[0]?.created_at);
    const md = (await service.exportProject({ project: a, format: "markdown", include: "all" })).text;
    expect(md).toContain("- key: deploy/current");
    expect(md).toMatch(/- disputed: \S+/);

    await importDoc(service, b, doc);
    const copy = await exportJson(b);
    const fields = (m: (typeof doc.memories)[number]) => [m.key, m.confirmed_at, m.disputed_at];
    expect(copy.memories.map(fields)).toEqual(doc.memories.map(fields));
    expect((await service.get({ project: b, keys: ["deploy/current"] })).memories[0]?.seq).toBe(1);

    // b now holds the key, so the same document is refused whole rather than quietly replacing it.
    await expect(importDoc(service, b, doc)).rejects.toMatchObject({
      code: "conflict",
      message: expect.stringContaining("deploy/current (#1)"),
    });
    expect(await rows(b)).toEqual({ memories: 2, links: 0 });
    // A superseded holder in the document does not claim its key, so a retired copy can land beside a live one.
    const retired = { ...doc, memories: doc.memories.map((m) => ({ ...m, status: "superseded" as const })) };
    await importDoc(service, b, retired);
    expect(await rows(b)).toEqual({ memories: 4, links: 0 });
  });

  it("imports an empty document as a no-op, creating the project but no memories", async () => {
    const b = slug();
    const r = await importDoc(service, b, { axon: { format: 1 }, memories: [], links: [] });
    expect(r).toMatchObject({ project: b, imported: 0, links: 0, mapping: {} });
    expect(r.text).toBe("Nothing to import: the document has no memories.");
    expect(await projectExists(b)).toBe(true);
    expect(await rows(b)).toEqual({ memories: 0, links: 0 });
  });

  it("creates the target project", async () => {
    const a = slug();
    const b = slug();
    await seed(a);
    expect(await projectExists(b)).toBe(false);
    await importDoc(service, b, await exportJson(a, "active"));
    expect(await rows(b)).toEqual({ memories: 2, links: 1 });
  });

  it("accepts a minimal hand-written document, filling in defaults", async () => {
    const b = slug();
    const r = await importDoc(service, b, {
      axon: { format: 1 },
      memories: [
        { seq: 10, kind: "howto", title: "Run it", body: "npm run axon -- serve" },
        { seq: 20, kind: "gotcha", title: "Port", body: "it listens on 7717", tags: ["Net"] },
      ],
      links: [{ a: 20, b: 10 }],
    });
    expect(r).toMatchObject({ imported: 2, links: 1, mapping: { "10": 1, "20": 2 } });
    const [port] = (await service.get({ project: b, ids: [2] })).memories;
    expect(port).toMatchObject({
      tags: ["net"],
      pinned: false,
      importance: 3,
      status: "active",
      source: null,
      degree: 1,
    });
  });

  it("refuses a link-crowded memory beyond the per-memory link cap, writing nothing", async () => {
    const b = slug();
    const memories = [1, 2, 3, 4, 5, 6].map((seq) => ({ seq, kind: "howto", title: `M${seq}`, body: `memory ${seq}` }));
    const links = [2, 3, 4, 5, 6].map((other) => ({ a: 1, b: other })); // cap is 4 in tests
    await expect(importDoc(service, b, { axon: { format: 1 }, memories, links })).rejects.toMatchObject({
      code: "rule",
      message: expect.stringMatching(/Link cap \(4\).*#1/),
    });
    expect(await projectExists(b)).toBe(false);
  });
});

describe("import validation", () => {
  const base = () => ({
    axon: { version: "0.1.0", format: 1 },
    memories: [
      { seq: 1, kind: "howto", title: "One", body: "first" },
      { seq: 2, kind: "gotcha", title: "Two", body: "second", status: "superseded", superseded_by: 1 },
    ],
    links: [{ a: 1, b: 2, note: "pair", weight: 1.5 }],
  });
  const problem = (mutate: (d: ReturnType<typeof base>) => unknown) => {
    const r = ImportInput.safeParse({ project: "test/x", document: mutate(base()) });
    if (r.success) throw new Error("expected the document to be refused");
    return r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
  };

  it("accepts the base document", () => {
    expect(ImportInput.safeParse({ project: "test/x", document: base() }).success).toBe(true);
  });

  it("refuses two active memories that hold one key, and normalises keys", () => {
    expect(
      problem((d) => ({
        ...d,
        memories: [
          { ...d.memories[0], key: "Deploy/Current" },
          { ...d.memories[1], status: "active", superseded_by: null, key: "deploy/current" },
        ],
      })),
    ).toBe("document.memories.1.key: key deploy/current is also held by #1");
    const r = ImportInput.safeParse({
      project: "test/x",
      document: { ...base(), memories: [{ ...base().memories[0], key: "no spaces" }] },
    });
    expect(r.success).toBe(false);
  });

  it.each([
    [
      "an unknown format version",
      (d) => ({ ...d, axon: { format: 2 } }),
      /document\.axon\.format: unsupported export format 2/,
    ],
    ["a missing header", ({ axon, ...d }) => d, /document\.axon/],
    [
      "a link to a seq not in the document",
      (d) => ({ ...d, links: [{ a: 1, b: 99 }] }),
      /document\.links\.0\.b: #99 is not a memory in this document/,
    ],
    ["a self-link", (d) => ({ ...d, links: [{ a: 2, b: 2 }] }), /document\.links\.0: #2 links to itself/],
    [
      "a duplicate link",
      (d) => ({ ...d, links: [...d.links, { a: 2, b: 1 }] }),
      /document\.links\.1: duplicate link #2 ↔ #1/,
    ],
    [
      "a memory that supersedes itself",
      (d) => ({ ...d, memories: [d.memories[0], { ...d.memories[1], superseded_by: 2 }] }),
      /document\.memories\.1\.superseded_by: #2 supersedes itself/,
    ],
    [
      "a superseded_by outside the document",
      (d) => ({ ...d, memories: [d.memories[0], { ...d.memories[1], superseded_by: 42 }] }),
      /document\.memories\.1\.superseded_by: #42 is not a memory in this document/,
    ],
    [
      "a duplicate seq",
      (d) => ({ ...d, memories: [...d.memories, { seq: 1, kind: "howto", title: "Again", body: "dup" }] }),
      /document\.memories\.2\.seq: duplicate seq 1/,
    ],
    ["an invalid kind", (d) => ({ ...d, memories: [{ ...d.memories[0], kind: "nonsense" }] }), /memories\.0\.kind/],
    [
      "an invalid status",
      (d) => ({ ...d, memories: [{ ...d.memories[0], status: "deleted" }] }),
      /memories\.0\.status/,
    ],
    [
      "a title over 120 characters",
      (d) => ({ ...d, memories: [{ ...d.memories[0], title: "t".repeat(121) }], links: [] }),
      /memories\.0\.title/,
    ],
    [
      "a body over 16000 characters",
      (d) => ({ ...d, memories: [{ ...d.memories[0], body: "b".repeat(16_001) }], links: [] }),
      /memories\.0\.body/,
    ],
    [
      "more than 12 tags",
      (d) => ({ ...d, memories: [{ ...d.memories[0], tags: [...Array(13).keys()].map(String) }], links: [] }),
      /memories\.0\.tags/,
    ],
    [
      "an importance out of range",
      (d) => ({ ...d, memories: [{ ...d.memories[0], importance: 9 }], links: [] }),
      /importance/,
    ],
    ["a link weight out of range", (d) => ({ ...d, links: [{ a: 1, b: 2, weight: 50 }] }), /links\.0\.weight/],
    [
      "a malformed timestamp",
      (d) => ({ ...d, memories: [{ ...d.memories[0], created_at: "yesterday" }], links: [] }),
      /created_at/,
    ],
    ["memories that are not a list", (d) => ({ ...d, memories: "none" }), /document\.memories/],
  ] as [string, (d: ReturnType<typeof base>) => unknown, RegExp][])("refuses %s", (_, mutate, expected) => {
    expect(problem(mutate)).toMatch(expected);
  });
});

describe("import and the memory cap", () => {
  // The seeded export holds 2 active memories (#1, #3) plus a superseded and an archived one.
  it("admits an import that lands exactly at the cap; retired memories don't count", async () => {
    const a = slug();
    const b = slug();
    await seed(a);
    await capped.remember(mem(b, "existing", "one memory already in b"));
    const r = await importDoc(capped, b, await exportJson(a));
    expect(r.imported).toBe(4);
    expect((await service.briefing({ project: b, budget_tokens: 1500 })).stats?.kinds).toEqual({
      gotcha: 1,
      overview: 1,
      decision: 1,
    });
  });

  it("refuses an import that would go over the cap and writes nothing", async () => {
    const a = slug();
    const b = slug();
    await seed(a);
    await capped.remember(mem(b, "existing", "one memory already in b"));
    await capped.remember(mem(b, "second", "another memory already in b"));
    const before = await rows(b);

    await expect(importDoc(capped, b, await exportJson(a))).rejects.toMatchObject({
      code: "rule",
      message: expect.stringMatching(
        /Memory cap \(3\) would be exceeded: .* holds 2 active memories and the import adds 2/,
      ),
    });
    expect(await rows(b)).toEqual(before);
    // Ids weren't consumed either: the next memory is #3.
    expect(await capped.remember(mem(b, "third", "a third memory fits"))).toMatchObject({ saved: true, id: 3 });
  });

  it("refuses an over-cap import into a new project without creating it", async () => {
    const b = slug();
    const memories = [1, 2, 3, 4].map((seq) => ({ seq, kind: "howto", title: `M${seq}`, body: `memory ${seq}` }));
    await expect(importDoc(capped, b, { axon: { format: 1 }, memories })).rejects.toMatchObject({ code: "rule" });
    expect(await projectExists(b)).toBe(false);
  });

  it("admits only one of two concurrent imports that each fit alone", async () => {
    // Slow embedding lets both imports pass the early cap look before either commits, so only the
    // check under the project lock stands between them.
    class SlowEmbedder extends FakeEmbedder {
      override async embedDocument(text: string) {
        await sleep(50);
        return super.embedDocument(text);
      }
    }
    const racing = await AxonService.create(sql, new SlowEmbedder(), { ...config, maxMemories: 3 });
    const b = slug();
    const doc = (n: string) => ({
      axon: { format: 1 },
      memories: [1, 2].map((seq) => ({ seq, kind: "howto", title: `${n}${seq}`, body: `${n} memory ${seq}` })),
    });
    const results = await Promise.allSettled([importDoc(racing, b, doc("x")), importDoc(racing, b, doc("y"))]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    for (const r of results) if (r.status === "rejected") expect(r.reason).toMatchObject({ code: "rule" });
    expect(await rows(b)).toEqual({ memories: 2, links: 0 });
  });
});

describe("CLI", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "axon-export-"));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const run = (args: string[], input = "") =>
    new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
      const { AXON_MAX_MEMORIES: _, ...env } = process.env;
      const child = execFile(
        process.execPath,
        ["--import", "tsx", "src/cli.ts", ...args, "--fake"],
        { env: { ...env, DATABASE_URL: config.databaseUrl, AXON_ENCRYPTION_KEY: "" } },
        (err, stdout, stderr) =>
          resolve({ code: err ? Number((err as { code?: number }).code ?? 1) : 0, stdout, stderr }),
      );
      child.stdin?.end(input);
    });

  it("exports JSON and Markdown to stdout", async () => {
    const a = slug();
    await seed(a);

    const json = await run(["export", a]);
    expect(json.code).toBe(0);
    const doc = JSON.parse(json.stdout) as ExportDocument;
    expect(doc.memories.map((m) => m.seq)).toEqual([1, 2, 3, 4]);

    const active = await run(["export", a, "--active"]);
    expect((JSON.parse(active.stdout) as ExportDocument).memories.map((m) => m.seq)).toEqual([1, 3]);

    const md = await run(["export", a, "--format", "markdown"]);
    expect(md.stdout).toMatch(new RegExp(`^# ${a} — exported`));
    expect(md.stdout).toContain("memcached sat in front of the catalogue");
  }, 60_000);

  it("imports from a file and from stdin, printing the mapping", async () => {
    const a = slug();
    const b = slug();
    await seed(a);
    const file = join(dir, "a.axon.json");
    await writeFile(file, JSON.stringify(await exportJson(a)));

    const fromFile = await run(["import", b, file]);
    expect(fromFile.code).toBe(0);
    expect(fromFile.stderr).toContain(`Imported 4 memories (#1–#4) and 3 links into ${b}.`);
    expect(JSON.parse(fromFile.stdout)).toEqual({ imported: 4, links: 3, mapping: { "1": 1, "2": 2, "3": 3, "4": 4 } });

    const fromStdin = await run(["import", b], JSON.stringify(await exportJson(a, "active")));
    expect(fromStdin.code).toBe(0);
    expect(JSON.parse(fromStdin.stdout)).toMatchObject({ imported: 2, mapping: { "1": 5, "3": 6 } });
    expect(await rows(b)).toEqual({ memories: 6, links: 4 });
  }, 60_000);

  it("names the problem in an invalid document and writes nothing", async () => {
    const b = slug();
    const bad = await run(
      ["import", b],
      JSON.stringify({ axon: { format: 1 }, memories: [], links: [{ a: 1, b: 2 }] }),
    );
    expect(bad.code).toBe(1);
    expect(bad.stderr).toContain("document.links.0.a: #1 is not a memory in this document");

    const notJson = await run(["import", b], "{nope");
    expect(notJson.code).toBe(1);
    expect(notJson.stderr).toContain("stdin is not JSON");
    expect(await projectExists(b)).toBe(false);
  }, 60_000);
});
