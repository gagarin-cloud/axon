import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AxonService } from "../src/core/service.js";
import { connect, type Sql } from "../src/db/client.js";
import { FakeEmbedder } from "../src/embed/fake.js";
import { createApp } from "../src/http/app.js";
import { PgStore } from "../src/store/pg.js";
import { setup, slug } from "./helpers.js";

let sql: Sql;
let service: AxonService;
let config: Awaited<ReturnType<typeof setup>>["config"];
let app: ReturnType<typeof createApp>["app"];
let close: () => Promise<void>;

beforeAll(async () => {
  ({ sql, service, config } = await setup());
  ({ app, close } = createApp(service, { host: "127.0.0.1" }));
});
afterAll(async () => {
  await close();
  await sql`DELETE FROM projects WHERE slug LIKE 'test/%'`;
  await sql.end();
});

const req = (method: string, path: string, body?: unknown) =>
  app.request(`http://localhost${path}`, {
    method,
    // Real clients always send Host; app.request() doesn't, and the rebinding guard requires it.
    headers: { host: "localhost:7717", ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });

// biome-ignore lint/suspicious/noExplicitAny: response shapes are asserted field by field
const json = (res: Response): Promise<any> => res.json();

describe("/healthz", () => {
  it("answers 200 with db ok when the database responds", async () => {
    const res = await req("GET", "/healthz");
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ ok: true, embedder: service.embedderId, db: "ok" });
  });

  it("gives up on a database that does not answer in time, and the pool survives the cancelled probe", async () => {
    // One connection, held by a slow query: the probe queues behind it and cannot be answered in time.
    const busy = postgres(config.databaseUrl, { max: 1, onnotice: () => {} });
    const store = new PgStore(busy, 64);
    try {
      const slow = busy`SELECT pg_sleep(1.5)`.execute();
      await expect(store.ping(100)).rejects.toMatchObject({ code: "PING_TIMEOUT" });
      await slow;
      // The timed-out probe was cancelled rather than left queued: the pool answers again at once.
      await expect(store.ping(2000)).resolves.toBeUndefined();
      expect((await busy`SELECT 1 AS one`)[0]).toEqual({ one: 1 });
    } finally {
      await busy.end();
    }
  });

  it("answers 503 naming only the error code when the probe times out", async () => {
    const hung = Object.create(service) as AxonService;
    hung.ping = () =>
      Promise.reject(
        Object.assign(new Error("database did not answer in time: postgres://axon:axon@db"), { code: "PING_TIMEOUT" }),
      );
    const { app: hungApp, close: closeHung } = createApp(hung, { host: "127.0.0.1" });
    try {
      const res = await hungApp.request("http://localhost/healthz", { headers: { host: "localhost:7717" } });
      expect(res.status).toBe(503);
      const text = await res.text();
      expect(JSON.parse(text)).toEqual({ ok: false, embedder: service.embedderId, db: "PING_TIMEOUT" });
      expect(text).not.toContain("axon:axon");
    } finally {
      await closeHung();
    }
  });

  it("answers 503 without leaking the connection URL when the database is gone", async () => {
    const dead = connect(config.databaseUrl);
    const deadService = await AxonService.create(dead, new FakeEmbedder(), config);
    const { app: deadApp, close: closeDead } = createApp(deadService, { host: "127.0.0.1" });
    await dead.end();
    try {
      const res = await deadApp.request("http://localhost/healthz", { headers: { host: "localhost:7717" } });
      expect(res.status).toBe(503);
      const text = await res.text();
      expect(JSON.parse(text)).toMatchObject({ ok: false, embedder: service.embedderId });
      expect(typeof JSON.parse(text).db).toBe("string");
      const url = new URL(config.databaseUrl);
      for (const secret of [config.databaseUrl, url.password, "axon:axon", url.host]) {
        if (secret) expect(text).not.toContain(secret);
      }
    } finally {
      await closeDead();
    }
  });
});

describe("REST", () => {
  it("covers the memory lifecycle with slugs containing slashes", async () => {
    const p = slug(); // test/xxxx
    const base = `/v1/projects/${p}`;

    let res = await req("POST", `${base}/memories`, {
      kind: "convention",
      title: "Money in cents",
      body: "store prices as integer cents never floats",
      tags: ["Money"],
    });
    expect(res.status).toBe(201);
    expect(await json(res)).toMatchObject({ saved: true, id: 1 });

    res = await req("POST", `${base}/memories`, {
      kind: "gotcha",
      title: "Rounding",
      body: "round half even in reports",
    });
    expect(res.status).toBe(201);

    res = await req("POST", `${base}/memories`, {
      kind: "convention",
      title: "Money in cents",
      body: "store prices as integer cents never floats",
    });
    expect(res.status).toBe(409);
    expect(await json(res)).toMatchObject({ saved: false, duplicates: [expect.objectContaining({ seq: 1 })] });

    res = await req("POST", `${base}/memories/1/links`, { to: [2], note: "both about money" });
    expect(await json(res)).toMatchObject({ created: 1 });

    res = await req("GET", `${base}/memories/1`);
    const one = await json(res);
    expect(one.memory).toMatchObject({ seq: 1, tags: ["money"], degree: 1 });
    expect(one.memory.links[0]).toMatchObject({ seq: 2, note: "both about money" });

    res = await req("GET", `${base}/memories?query=integer%20cents&k=5`);
    const search = await json(res);
    expect(search.hits[0].memory.seq).toBe(1);
    expect(typeof search.text).toBe("string");

    res = await req("GET", `${base}/memories?ids=1,2`);
    expect((await json(res)).memories).toHaveLength(2);

    res = await req("GET", `${base}/memories/1/related?hops=2`);
    expect((await json(res)).steps.map((s: { memory: { seq: number } }) => s.memory.seq)).toEqual([2]);

    res = await req("PATCH", `${base}/memories/2`, { pinned: true, importance: 5 });
    expect(await json(res)).toMatchObject({ id: 2, reembedded: false });

    res = await req("GET", `${base}/briefing?budget=600`);
    const briefing = await json(res);
    expect(briefing.found).toBe(true);
    expect(briefing.shown[0]).toMatchObject({ mode: "full", memory: { seq: 2, pinned: true } });
    expect(briefing.tokens).toBeLessThanOrEqual(600);

    res = await req("DELETE", `${base}/memories/1/links/2`);
    expect(await json(res)).toMatchObject({ removed: 1 });

    res = await req("GET", "/v1/projects");
    expect((await json(res)).projects).toContainEqual(expect.objectContaining({ slug: p, active: 2 }));
  });

  it("confirms and disputes over PATCH, and carries both dates in JSON", async () => {
    const p = slug();
    const base = `/v1/projects/${p}`;
    await req("POST", `${base}/memories`, { kind: "state", title: "Release", body: "release 4.2 is in qa" });
    let one = await json(await req("GET", `${base}/memories/1`));
    expect(one.memory.confirmedAt).toBe(one.memory.createdAt);
    expect(one.memory.disputedAt).toBeNull();

    let res = await req("PATCH", `${base}/memories/1`, { dispute: true });
    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({ id: 1, disputed: true, text: expect.stringMatching(/^Disputed #1 — /) });
    one = await json(await req("GET", `${base}/memories/1`));
    expect(Date.parse(one.memory.disputedAt)).not.toBeNaN();
    expect(one.text).toContain("## #1 state · Release ⚠ disputed");

    res = await req("PATCH", `${base}/memories/1`, { confirm: true, dispute: true });
    expect(res.status).toBe(400);
    expect((await json(res)).error.code).toBe("invalid");

    res = await req("PATCH", `${base}/memories/1`, { confirm: true });
    expect(await json(res)).toMatchObject({ confirmed: true, disputed: false, text: "Confirmed #1." });
    one = await json(await req("GET", `${base}/memories/1`));
    expect(one.memory.disputedAt).toBeNull();
    expect(Date.parse(one.memory.confirmedAt)).toBeGreaterThan(Date.parse(one.memory.createdAt));

    res = await req("PATCH", `${base}/memories/1`, { confirm: "yes" });
    expect(res.status).toBe(400);
    res = await req("PATCH", `/v1/projects/${slug()}/memories/1`, { dispute: true });
    expect(res.status).toBe(404);
  });

  it("tailors a briefing with focus and paths", async () => {
    const p = slug();
    const base = `/v1/projects/${p}`;
    const webhook = "stripe webhook signature checks need the raw request body before json parsing";
    for (const [title, paths] of [
      ["Webhook raw body", ["src/billing"]],
      ["Webhook docs", ["docs"]],
    ] as const) {
      const res = await req("POST", `${base}/memories`, { kind: "gotcha", title, body: webhook, paths, force: true });
      expect(res.status).toBe(201);
    }

    let res = await req("GET", `${base}/briefing?focus=stripe%20webhook%20signature&paths=src/billing/hook.ts,src/api`);
    expect(res.status).toBe(200);
    const b = await json(res);
    expect(b.focus).toBe("stripe webhook signature");
    expect(b.shown[0]).toMatchObject({ mode: "full", memory: { seq: 1 } });
    // Only the memory on the given paths counts as a match and carries its similarity.
    expect(b.text).toMatch(/## #1 gotcha · Webhook raw body \[\d\.\d\d( \+kw)?\]/);
    expect(b.text).toMatch(/## #2 gotcha · Webhook docs\n/);
    expect(b.recent).toEqual([]); // both are shown in full

    res = await req("GET", `${base}/briefing?focus=${"x".repeat(1001)}`);
    expect(res.status).toBe(400);
    expect((await json(res)).error.message).toMatch(/focus/);
  });

  it("maps errors to status codes", async () => {
    const p = slug();
    await req("POST", `/v1/projects/${p}/memories`, { kind: "howto", title: "A", body: "alpha text here" });

    let res = await req("POST", `/v1/projects/${p}/memories/1/links`, { to: [1] });
    expect(res.status).toBe(422);
    expect((await json(res)).error.code).toBe("rule");

    res = await req("GET", `/v1/projects/${p}/memories/99`);
    expect(res.status).toBe(404);

    res = await req("POST", `/v1/projects/${p}/memories`, { kind: "nonsense", title: "", body: "x" });
    expect(res.status).toBe(400);
    expect((await json(res)).error.message).toMatch(/kind/);

    res = await req("GET", "/v1/projects/NOT VALID!/briefing");
    expect(res.status).toBe(400);
  });

  it("deletes a project with its memories and links, leaving others alone", async () => {
    const p = slug();
    const other = `${p}/memories/1`; // a legal slug that looks like a memory path
    for (const project of [p, other]) {
      await req("POST", `/v1/projects/${project}/memories`, { kind: "howto", title: "A", body: "alpha text here" });
      await req("POST", `/v1/projects/${project}/memories`, {
        kind: "gotcha",
        title: "B",
        body: "an unrelated note about rounding",
        links: [1],
      });
    }

    // Link removal still routes to the link handler, not the project one.
    let res = await req("DELETE", `/v1/projects/${p}/memories/1/links/2`);
    expect(await json(res)).toMatchObject({ removed: 1 });

    res = await req("DELETE", `/v1/projects/${p}`);
    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({ project: p, memories: 2, links: 0 });

    const [left] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM memories m JOIN projects pr ON pr.id = m.project_id WHERE pr.slug = ${p}`;
    expect(left?.n).toBe(0);
    const { projects } = await json(await req("GET", "/v1/projects"));
    expect(projects).not.toContainEqual(expect.objectContaining({ slug: p }));
    expect(projects).toContainEqual(expect.objectContaining({ slug: other, total: 2, links: 1 }));

    res = await req("DELETE", `/v1/projects/${p}`);
    expect(res.status).toBe(404);
    expect((await json(res)).error.code).toBe("not_found");

    // Ids restart: the slug is free to be reused as a fresh project.
    res = await req("POST", `/v1/projects/${p}/memories`, { kind: "howto", title: "A", body: "alpha text here" });
    expect(await json(res)).toMatchObject({ saved: true, id: 1 });

    res = await req("DELETE", "/v1/projects/NOT VALID!");
    expect(res.status).toBe(400);
  });

  it("answers 422 at the memory cap", async () => {
    const capped = createApp(await AxonService.create(sql, new FakeEmbedder(), { ...config, maxMemories: 1 }), {
      host: "127.0.0.1",
    });
    const p = slug();
    const post = (title: string) =>
      capped.app.request(`http://localhost/v1/projects/${p}/memories`, {
        method: "POST",
        headers: { host: "localhost:7717", "content-type": "application/json" },
        body: JSON.stringify({ kind: "howto", title, body: `${title} text about ${title}` }),
      });
    expect((await post("first")).status).toBe(201);
    const res = await post("second");
    expect(res.status).toBe(422);
    expect((await json(res)).error).toMatchObject({ code: "rule", message: expect.stringMatching(/cap \(1\)/) });
    await capped.close();
  });

  it("serves the review report, budgeted, and 404 for an unknown project", async () => {
    const p = slug();
    const base = `/v1/projects/${p}`;
    await req("POST", `${base}/memories`, { kind: "howto", title: "Lonely", body: "nobody links to this note" });
    await req("POST", `${base}/memories`, { kind: "state", title: "Huge", body: "lorem ipsum dolor ".repeat(300) });

    let res = await req("GET", `${base}/review?budget=300`);
    expect(res.status).toBe(200);
    const review = await json(res);
    expect(review).toMatchObject({
      project: p,
      cap: { active: 2, max: null },
      sections: { orphans: { seqs: [1, 2], total: 2 }, oversized: { seqs: [2], total: 1 }, duplicates: [] },
    });
    expect(review.text).toContain("Orphans:");
    expect(review.tokens).toBeLessThanOrEqual(300);

    res = await req("GET", `/v1/projects/${slug()}/review`);
    expect(res.status).toBe(404);
    res = await req("GET", `${base}/review?budget=50`);
    expect(res.status).toBe(400);
  });

  it("replaces by key, reads by keys, and answers 409 to a taken key", async () => {
    const base = `/v1/projects/${slug()}/memories`;
    let res = await req("POST", base, {
      kind: "state",
      title: "Deploy",
      body: "prod runs v1.4",
      key: "Deploy/Current",
    });
    expect(res.status).toBe(201);
    expect(await json(res)).toMatchObject({ id: 1, key: "deploy/current", superseded: null });

    res = await req("POST", base, { kind: "state", title: "Deploy", body: "prod runs v1.5", key: "deploy/current" });
    expect(res.status).toBe(201);
    const replaced = await json(res);
    expect(replaced).toMatchObject({ id: 2, key: "deploy/current", superseded: 1 });
    expect(replaced.text).toContain("Replaced #1 (key deploy/current)");

    res = await req("POST", base, {
      kind: "state",
      title: "Owner",
      body: "payments owns billing",
      key: "owner/billing",
    });
    res = await req("GET", `${base}?keys=deploy/current,owner/billing,nobody`);
    const got = await json(res);
    expect(got.memories.map((m: { seq: number; key: string }) => [m.seq, m.key])).toEqual([
      [2, "deploy/current"],
      [3, "owner/billing"],
    ]);
    expect(got.missingKeys).toEqual(["nobody"]);

    res = await req("GET", `${base}/1`);
    expect((await json(res)).memory).toMatchObject({ status: "superseded", key: "deploy/current" });

    res = await req("PATCH", `${base}/3`, { key: "deploy/current" });
    expect(res.status).toBe(409);
    expect((await json(res)).error.code).toBe("conflict");
    res = await req("PATCH", `${base}/3`, { key: null });
    expect(res.status).toBe(200);

    res = await req("POST", base, { kind: "state", title: "Bad", body: "bad key", key: "no spaces allowed" });
    expect(res.status).toBe(400);
    expect((await json(res)).error.message).toMatch(/key/);
  });

  it("exports and imports with slugs that end in /export or /import", async () => {
    const p = slug();
    const post = (project: string, body: Record<string, unknown>) =>
      req("POST", `/v1/projects/${project}/memories`, body);
    await post(p, { kind: "howto", title: "Serve", body: "npm run axon serve starts it", tags: ["ops"] });
    await post(p, { kind: "gotcha", title: "Port", body: "it listens on port 7717", links: [1], link_note: "ops" });
    // Legal slugs that end in the route words themselves.
    await post(`${p}/export`, { kind: "howto", title: "Inner", body: "a project literally named export" });

    let res = await req("GET", `/v1/projects/${p}/export`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^application\/json/);
    expect(res.headers.get("content-disposition")).toBe(`attachment; filename="${p.replace("/", "-")}.axon.json"`);
    const doc = await json(res);
    expect(doc).toMatchObject({ axon: { format: 1 }, project: p, links: [{ a: 1, b: 2, note: "ops", weight: 1 }] });
    expect(doc.memories.map((m: { title: string }) => m.title)).toEqual(["Serve", "Port"]);

    res = await req("GET", `/v1/projects/${p}/export/export`);
    expect(await json(res)).toMatchObject({ project: `${p}/export`, memories: [{ seq: 1, title: "Inner" }] });

    res = await req("GET", `/v1/projects/${p}/export?format=markdown&include=active`);
    expect(res.headers.get("content-type")).toMatch(/^text\/markdown/);
    expect(res.headers.get("content-disposition")).toContain(".axon.md");
    const md = await res.text();
    expect(md).toContain(`# ${p} — exported`);
    expect(md).toContain("## #2 gotcha · Port");
    expect(md).toContain("- #1 ↔ #2 — ops");

    // Into a new project whose slug ends in /import, then appended to the original.
    res = await req("POST", `/v1/projects/${p}/import/import`, doc);
    expect(res.status).toBe(201);
    expect(await json(res)).toMatchObject({
      project: `${p}/import`,
      imported: 2,
      links: 1,
      mapping: { "1": 1, "2": 2 },
    });
    res = await req("POST", `/v1/projects/${p}/import`, doc);
    expect(await json(res)).toMatchObject({ project: p, imported: 2, mapping: { "1": 3, "2": 4 } });

    const { projects } = await json(await req("GET", "/v1/projects"));
    expect(projects).toContainEqual(expect.objectContaining({ slug: p, total: 4, links: 2 }));
    expect(projects).toContainEqual(expect.objectContaining({ slug: `${p}/import`, total: 2, links: 1 }));
    expect(projects).toContainEqual(expect.objectContaining({ slug: `${p}/export`, total: 1 }));
    expect(projects).not.toContainEqual(expect.objectContaining({ slug: `${p}/import/import` }));

    // DELETE …/export is the project named …/export, not an export.
    res = await req("DELETE", `/v1/projects/${p}/export`);
    expect(await json(res)).toMatchObject({ project: `${p}/export`, memories: 1 });
    expect((await req("GET", `/v1/projects/${p}/export/export`)).status).toBe(404);
    expect((await req("GET", `/v1/projects/${p}/export`)).status).toBe(200);
  });

  it("answers export and import errors with the right status", async () => {
    const p = slug();
    await req("POST", `/v1/projects/${p}/memories`, { kind: "howto", title: "A", body: "alpha text here" });

    let res = await req("GET", `/v1/projects/${slug()}/export`);
    expect(res.status).toBe(404);
    res = await req("GET", `/v1/projects/${p}/export?format=pdf`);
    expect(res.status).toBe(400);
    expect((await json(res)).error.message).toMatch(/format/);
    res = await req("GET", `/v1/projects/${p}/export?include=some`);
    expect(res.status).toBe(400);

    const target = slug();
    res = await req("POST", `/v1/projects/${target}/import`, {
      axon: { format: 1 },
      memories: [{ seq: 1, kind: "howto", title: "One", body: "first" }],
      links: [{ a: 1, b: 7 }],
    });
    expect(res.status).toBe(400);
    expect((await json(res)).error).toMatchObject({
      code: "invalid",
      message: expect.stringContaining("document.links.0.b: #7 is not a memory in this document"),
    });
    res = await req("POST", `/v1/projects/${target}/import`, { axon: { format: 3 }, memories: [] });
    expect((await json(res)).error.message).toMatch(/unsupported export format 3/);
    res = await req("POST", `/v1/projects/${target}/import`, [1, 2]);
    expect(res.status).toBe(400);
    const { projects } = await json(await req("GET", "/v1/projects"));
    expect(projects).not.toContainEqual(expect.objectContaining({ slug: target }));
  });

  it("answers 422 when an import would pass the memory cap", async () => {
    const capped = createApp(await AxonService.create(sql, new FakeEmbedder(), { ...config, maxMemories: 1 }), {
      host: "127.0.0.1",
    });
    const res = await capped.app.request(`http://localhost/v1/projects/${slug()}/import`, {
      method: "POST",
      headers: { host: "localhost:7717", "content-type": "application/json" },
      body: JSON.stringify({
        axon: { format: 1 },
        memories: [1, 2].map((seq) => ({ seq, kind: "howto", title: `M${seq}`, body: `memory ${seq}` })),
      }),
    });
    expect(res.status).toBe(422);
    expect((await json(res)).error).toMatchObject({ code: "rule", message: expect.stringMatching(/cap \(1\)/) });
    await capped.close();
  });

  it("rejects foreign Host headers (DNS rebinding)", async () => {
    const res = await app.request("http://evil.example/v1/projects", { headers: { host: "evil.example" } });
    expect(res.status).toBe(403);
  });
});

function mcpClient(target: ReturnType<typeof createApp>["app"]) {
  const client = new Client({ name: "test", version: "0.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL("http://localhost/mcp"), {
    fetch: (url, init) => {
      const headers = new Headers(init?.headers);
      headers.set("host", "localhost:7717");
      return Promise.resolve(target.request(url.toString(), { ...init, headers } as RequestInit));
    },
  });
  return { client, connect: () => client.connect(transport) };
}

describe("MCP default project", () => {
  it("lets tools omit project when the server is scoped to one", async () => {
    const p = slug();
    const scoped = createApp(service, { host: "127.0.0.1", defaultProject: p });
    const { client, connect } = mcpClient(scoped.app);
    await connect();

    const saved = await client.callTool({
      name: "remember",
      arguments: { kind: "howto", title: "Scoped", body: "written without naming a project" },
    });
    expect(saved.isError).toBeFalsy();
    const r = await service.get({ project: p, ids: [1] });
    expect(r.memories[0]?.title).toBe("Scoped");

    await client.close();
    await scoped.close();
  });

  it("requires project when the server is not scoped", async () => {
    const { client, connect } = mcpClient(app);
    await connect();
    const r = await client.callTool({ name: "briefing", arguments: {} });
    expect(r.isError).toBe(true);
    await client.close();
  });
});

describe("MCP over Streamable HTTP", () => {
  it("lists the tools and runs a remember → search → related round trip", async () => {
    const client = new Client({ name: "test", version: "0.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL("http://localhost/mcp"), {
      fetch: (url, init) => {
        const headers = new Headers(init?.headers);
        headers.set("host", "localhost:7717");
        return Promise.resolve(app.request(url.toString(), { ...init, headers } as RequestInit));
      },
    });
    await client.connect(transport);

    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      ["briefing", "get", "link", "list_projects", "related", "remember", "review", "search", "update"].sort(),
    );
    expect(tools.find((t) => t.name === "review")?.annotations).toMatchObject({ readOnlyHint: true });

    const p = slug();
    const text = (r: Awaited<ReturnType<typeof client.callTool>>) =>
      (r.content as { type: string; text: string }[]).map((c) => c.text).join("\n");

    const saved = await client.callTool({
      name: "remember",
      arguments: { project: p, kind: "gotcha", title: "Raw body", body: "stripe webhooks need the raw body" },
    });
    expect(text(saved)).toMatch(/^Saved #1/);
    await client.callTool({
      name: "remember",
      arguments: { project: p, kind: "howto", title: "Replay", body: "replay events from the dashboard", links: [1] },
    });

    const found = await client.callTool({ name: "search", arguments: { project: p, query: "stripe webhooks" } });
    expect(text(found)).toContain("## #1 gotcha · Raw body");
    expect(text(found)).toContain("↔ #2 Replay");

    const related = await client.callTool({ name: "related", arguments: { project: p, id: 1 } });
    expect(text(related)).toContain("#2 howto · Replay");

    const review = await client.callTool({ name: "review", arguments: { project: p } });
    expect(text(review)).toBe(`Nothing to tidy in ${p}: 2 memories, 1 links.`);
    const disputed = await client.callTool({ name: "update", arguments: { project: p, id: 1, dispute: true } });
    expect(text(disputed)).toMatch(/^Disputed #1 — /);
    expect(text(await client.callTool({ name: "get", arguments: { project: p, ids: [1] } }))).toContain(
      "## #1 gotcha · Raw body ⚠ disputed",
    );

    const bad = await client.callTool({ name: "link", arguments: { project: p, id: 1, to: [1] } });
    expect(bad.isError).toBe(true);
    expect(text(bad)).toMatch(/itself/);

    // Constraints aren't advertised, but the server still enforces them.
    const tooLong = await client.callTool({
      name: "remember",
      arguments: { project: p, kind: "gotcha", title: "x".repeat(200), body: "b" },
    });
    expect(tooLong.isError).toBe(true);
    expect(text(tooLong)).toMatch(/Invalid arguments: title/);
    expect(JSON.stringify(tools)).not.toContain("maxLength");

    await client.close();
  });
});

describe("internal errors", () => {
  // A driver-style failure whose message names a host and a user: exactly what must not reach a client.
  const leaky = "connect ECONNREFUSED 10.0.0.5:5432 (user axon, database axon_prod)";
  const broken = (): AxonService =>
    Object.assign(Object.create(service), {
      listProjects: async () => {
        throw new Error(leaky);
      },
    });

  it("REST answers 500 with a generic message and logs the real one", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const failing = createApp(broken(), { host: "127.0.0.1" });
    try {
      const res = await failing.app.request("http://localhost/v1/projects", { headers: { host: "localhost:7717" } });
      expect(res.status).toBe(500);
      const body = await res.text();
      expect(JSON.parse(body)).toEqual({ error: { code: "internal", message: "Internal error" } });
      expect(body).not.toContain("10.0.0.5");
      expect(log).toHaveBeenCalledWith("[axon] request failed", "GET", "/v1/projects", expect.any(Error));
    } finally {
      log.mockRestore();
      await failing.close();
    }
  });

  it("MCP returns an error result marked internal instead of throwing, and logs it", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const failing = createApp(broken(), { host: "127.0.0.1" });
    const { client, connect } = mcpClient(failing.app);
    try {
      await connect();
      const r = await client.callTool({ name: "list_projects", arguments: {} });
      expect(r.isError).toBe(true);
      expect((r.content as { text: string }[])[0]?.text).toMatch(/^Internal error: /);
      expect(log).toHaveBeenCalledWith("[axon] tool error", "list_projects", expect.any(Error));
    } finally {
      log.mockRestore();
      await client.close();
      await failing.close();
    }
  });

  it("MCP keeps agent-facing errors free of the internal prefix", async () => {
    const { client, connect } = mcpClient(app);
    await connect();
    const p = slug();
    const r = await client.callTool({ name: "get", arguments: { project: p, ids: [1] } });
    expect(r.isError).toBe(true);
    expect((r.content as { text: string }[])[0]?.text).toBe(`Project ${p} has no memories yet.`);
    await client.close();
  });
});
