import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type Config, loadConfig } from "../src/config.js";
import { MemoryCipher } from "../src/core/cipher.js";
import { ImportInput } from "../src/core/schemas.js";
import { AxonService } from "../src/core/service.js";
import { connect, type Sql, siblingDatabase } from "../src/db/client.js";
import { migrate } from "../src/db/migrate.js";
import { FakeEmbedder } from "../src/embed/fake.js";
import { createApp } from "../src/http/app.js";
import { convert, reembed, rotateKey } from "../src/maintenance.js";
import { checkEncryptionKey, releaseEmbeddingModel } from "../src/store/bindings.js";
import { EncryptingCodec } from "../src/store/codec.js";
import { MaintenanceStore } from "../src/store/maintenance.js";
import { PgStore } from "../src/store/pg.js";
import { mem } from "./helpers.js";

// Own scratch database: encrypted rows would make keyless services on the shared test database refuse to start.
let sql: Sql;
let url: string;
const base = loadConfig();
const key = Buffer.alloc(32, 1);
const otherKey = Buffer.alloc(32, 2);
const plain: Config = { ...base, encryptionKey: undefined };
const encrypted: Config = { ...base, encryptionKey: key };
const P = "enc/p";
const Q = "enc/q";

type RawRow = { seq: number; title: string; body: string; source: string | null; encrypted: boolean };
const raw = (project = P) =>
  sql<RawRow[]>`
    SELECT m.seq, m.title, m.body, m.source, m.encrypted
    FROM memories m JOIN projects p ON p.id = m.project_id WHERE p.slug = ${project} ORDER BY m.seq`;

const start = (config: Config = encrypted) => AxonService.create(sql, new FakeEmbedder(), config);

async function save(
  service: AxonService,
  title: string,
  body: string,
  extra: Record<string, unknown> = {},
  project = P,
) {
  const r = await service.remember(mem(project, title, body, extra));
  if (!r.saved) throw new Error(`not saved: ${r.text}`);
  return r.id;
}

beforeAll(async () => {
  url = await siblingDatabase(base.databaseUrl, "test_enc");
  sql = connect(url);
  await migrate(sql);
});
beforeEach(async () => {
  await sql`DELETE FROM projects`;
  await sql`DELETE FROM meta WHERE key = 'encryption_key_id'`;
  await releaseEmbeddingModel(sql);
});
afterAll(async () => {
  await sql`DELETE FROM projects`;
  await sql`DELETE FROM meta WHERE key = 'encryption_key_id'`;
  await sql.end();
});

describe("encrypted writes", () => {
  it("store title, body and source as ciphertext and read them back", async () => {
    const service = await start();
    await save(service, "Stripe webhooks", "verify signatures with the raw request body", {
      source: "docs/payments.md",
      tags: ["payments"],
    });

    const [row] = await raw();
    expect(row?.encrypted).toBe(true);
    expect(`${row?.title} ${row?.body} ${row?.source}`).not.toMatch(/Stripe|signatures|payments\.md/);

    const got = await service.get({ project: P, ids: [1] });
    expect(got.memories[0]).toMatchObject({
      title: "Stripe webhooks",
      body: "verify signatures with the raw request body",
      source: "docs/payments.md",
      encrypted: true,
    });
    expect(got.text).toContain("verify signatures with the raw request body");
    expect(got.text).not.toContain(row?.body);
  });

  it("keep keys in plaintext, so keyed writes and reads by key still work", async () => {
    const service = await start();
    await save(service, "Deploy", "production runs release v1.4", { key: "deploy/current" });
    const next = await service.remember(mem(P, "Deploy", "production runs release v1.5", { key: "deploy/current" }));
    expect(next).toMatchObject({ saved: true, id: 2, superseded: 1 });

    const rows = await sql<{ seq: number; key: string; encrypted: boolean }[]>`
      SELECT m.seq, m.key, m.encrypted FROM memories m JOIN projects p ON p.id = m.project_id
      WHERE p.slug = ${P} ORDER BY m.seq`;
    expect(rows).toEqual([
      { seq: 1, key: "deploy/current", encrypted: true },
      { seq: 2, key: "deploy/current", encrypted: true },
    ]);
    const got = await service.get({ project: P, keys: ["deploy/current"] });
    expect(got.memories[0]).toMatchObject({ seq: 2, body: "production runs release v1.5" });
  });

  it("keep a missing source as NULL and round-trip non-ASCII text", async () => {
    const service = await start();
    const title = "Ünïcode ✓ 日本語 🚀";
    const body = "Grüße — «кириллица» and emoji 🧪 survive encryption\nacross lines";
    await save(service, title, body);
    const [row] = await raw();
    expect(row).toMatchObject({ source: null, encrypted: true });
    expect((await service.get({ project: P, ids: [1] })).memories[0]).toMatchObject({ title, body, source: null });
  });

  it("accept a maximum-length title, whose ciphertext exceeds the plaintext limit", async () => {
    const service = await start();
    const title = "t".repeat(120);
    await save(service, title, "long titles still fit once encrypted");
    const [row] = await raw();
    expect(row?.title.length).toBeGreaterThan(120);
    expect((await service.get({ project: P, ids: [1] })).memories[0]?.title).toBe(title);
  });

  it("find encrypted memories by vector, and by keyword only on tags and paths", async () => {
    const service = await start();
    await save(service, "Stripe webhooks", "verify signatures with the raw request body", {
      tags: ["payments"],
      paths: ["src/billing/webhook.ts"],
    });

    const vec = await service.search({
      project: P,
      query: "verify signatures raw request body",
      k: 5,
      budget_tokens: 1200,
    });
    expect(vec.hits[0]?.memory.title).toBe("Stripe webhooks");

    const kw = async (q: string) => {
      const [r] = await sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM memories WHERE fts @@ websearch_to_tsquery('simple', ${q})`;
      return r?.n;
    };
    expect(await kw("signatures")).toBe(0);
    expect(await kw("stripe")).toBe(0);
    expect(await kw("payments")).toBe(1);
    expect(await kw("src/billing/webhook.ts")).toBe(1);

    const tagged = await service.search({ project: P, query: "payments", k: 5, budget_tokens: 1200 });
    expect(tagged.hits[0]).toMatchObject({ keyword: true, memory: { title: "Stripe webhooks" } });
  });
});

describe("decrypted everywhere text is shown", () => {
  it("in briefings, browsing, search, linked neighbours and link walks", async () => {
    const service = await start();
    await save(service, "Queue choice", "rabbitmq carries order events", { pinned: true });
    await save(service, "Cache layer", "redis caches product pages", { links: [1] });
    await save(service, "Session store", "sessions live in postgres tables", { links: [2] });

    const briefing = await service.briefing({ project: P, budget_tokens: 1500 });
    expect(briefing.text).toContain("Queue choice");
    expect(briefing.text).toContain("↔ #2 Cache layer");
    expect(briefing.shown.map((s) => s.memory.title).sort()).toEqual(["Cache layer", "Queue choice", "Session store"]);

    const browse = await service.search({ project: P, k: 8, budget_tokens: 1200 });
    expect(browse.hits.map((h) => h.memory.title).sort()).toEqual(["Cache layer", "Queue choice", "Session store"]);

    const search = await service.search({ project: P, query: "rabbitmq order events", k: 1, budget_tokens: 1200 });
    expect(search.hits[0]?.memory.title).toBe("Queue choice");
    expect(search.linked.map((l) => l.memory.title)).toEqual(["Cache layer"]);
    expect(search.text).toContain("#2 gotcha · Cache layer");

    const related = await service.related({ project: P, id: 1, hops: 2, budget_tokens: 1500 });
    expect(related.start.title).toBe("Queue choice");
    expect(related.steps.map((s) => s.memory.title)).toEqual(["Cache layer", "Session store"]);
    expect(related.text).toContain("Linked from #1 Queue choice");
    expect(related.text).toContain("sessions live in postgres tables");
  });

  it("in duplicate refusals and link suggestions", async () => {
    const service = await start({ ...encrypted, linkSuggestSimilarity: 0, dedupSimilarity: 0.99 });
    await save(service, "Queue choice", "rabbitmq carries order events");

    const dup = await service.remember(mem(P, "Queue choice", "rabbitmq carries order events"));
    expect(dup).toMatchObject({ saved: false, duplicates: [{ seq: 1, title: "Queue choice" }] });
    expect(dup.text).toContain("#1 gotcha · Queue choice");

    const r = await service.remember(mem(P, "Queue retries", "rabbitmq retries failed order events"));
    if (!r.saved) throw new Error(r.text);
    expect(r.suggestions.map((s) => s.title)).toEqual(["Queue choice"]);
    expect(r.text).toMatch(/Possibly related — link if so: #1 Queue choice/);

    // Just under the duplicate threshold, the same neighbour is flagged as a likely overlap instead.
    const similarity = r.suggestions[0]?.similarity ?? 0;
    const strict = await start({ ...encrypted, linkSuggestSimilarity: 0, dedupSimilarity: similarity + 0.05 });
    await save(strict, "Queue choice", "rabbitmq carries order events", {}, Q);
    const o = await strict.remember(mem(Q, "Queue retries", "rabbitmq retries failed order events"));
    if (!o.saved) throw new Error(o.text);
    expect(o.text).toMatch(/Likely overlaps: #1 Queue choice/);
  });

  it("in superseded memories and their successors", async () => {
    const service = await start();
    await save(service, "Old deploy", "deploys run from jenkins");
    await save(service, "Linked", "ci notes live here", { links: [1] });
    await save(service, "New deploy", "deploys run from github actions", { supersedes: 1 });

    const got = await service.get({ project: P, ids: [1, 3] });
    expect(got.memories.map((m) => [m.title, m.status, m.supersededBy])).toEqual([
      ["Old deploy", "superseded", 3],
      ["New deploy", "active", null],
    ]);
    expect(got.memories[1]?.links.map((l) => l.title)).toEqual(["Linked"]);
  });

  it("in REST responses, which also report the mode", async () => {
    const service = await start();
    await save(service, "Secret", "stored encrypted", { source: "notes.md" });
    const { app, close } = createApp(service, { host: "127.0.0.1" });
    try {
      const res = await app.request(`http://localhost/v1/projects/${P}/memories/1`, {
        headers: { host: "localhost:7717" },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { memory: unknown; text: string };
      expect(body.text).toContain("stored encrypted");
      expect(body.memory).toMatchObject({
        title: "Secret",
        body: "stored encrypted",
        source: "notes.md",
        encrypted: true,
      });
    } finally {
      await close();
    }
  });
});

describe("mixed modes", () => {
  it("read plaintext rows with a key, and encrypt them when their text is edited", async () => {
    await save(await start(plain), "Plain", "written before encryption was enabled", { source: "a.md" });

    const service = await start();
    await save(service, "Secret", "written with the key");
    expect((await raw()).map((r) => r.encrypted)).toEqual([false, true]);
    expect((await service.get({ project: P, ids: [1, 2] })).memories.map((m) => [m.title, m.encrypted])).toEqual([
      ["Plain", false],
      ["Secret", true],
    ]);

    await service.update({ project: P, id: 1, pinned: true, tags: ["x"], importance: 5 });
    expect((await raw())[0]).toMatchObject({ encrypted: false, title: "Plain" }); // metadata edits keep the mode

    await service.update({ project: P, id: 1, body: "edited with the key" });
    const [row] = await raw();
    expect(row?.encrypted).toBe(true);
    expect(`${row?.title} ${row?.body} ${row?.source}`).not.toMatch(/Plain|edited|a\.md/);
    expect((await service.get({ project: P, ids: [1] })).memories[0]).toMatchObject({
      title: "Plain",
      body: "edited with the key",
      source: "a.md",
      pinned: true,
      importance: 5,
    });
  });

  it("rewrite the whole text when only the title or only the source changes", async () => {
    await save(await start(plain), "Plain", "body stays the same", { source: "a.md" });
    const service = await start();

    await service.update({ project: P, id: 1, source: "b.md" });
    expect((await raw())[0]?.encrypted).toBe(true);
    expect((await service.get({ project: P, ids: [1] })).memories[0]).toMatchObject({
      title: "Plain",
      body: "body stays the same",
      source: "b.md",
    });

    const encryptedBody = (await raw())[0]?.body;
    await service.update({ project: P, id: 1, title: "Renamed" });
    const [row] = await raw();
    expect(row?.encrypted).toBe(true);
    expect(row?.body).not.toBe(encryptedBody); // re-encrypted with a fresh iv
    expect((await service.get({ project: P, ids: [1] })).memories[0]).toMatchObject({
      title: "Renamed",
      body: "body stays the same",
      source: "b.md",
    });
  });

  it("stay plaintext when a keyless server writes and edits", async () => {
    const service = await start(plain);
    await save(service, "Plain", "stays plaintext");
    await service.update({ project: P, id: 1, body: "still plaintext" });
    expect((await raw())[0]).toMatchObject({ encrypted: false, body: "still plaintext" });
  });

  it("keep plaintext titles within the length limit in the database", async () => {
    await save(await start(plain), "Plain", "a plaintext row");
    await expect(sql`UPDATE memories SET title = ${"t".repeat(121)} WHERE NOT encrypted`).rejects.toThrow(
      /memories_title_check/,
    );
    await expect(sql`UPDATE memories SET title = '' WHERE NOT encrypted`).rejects.toThrow(/memories_title_check/);
  });
});

describe("tamper resistance", () => {
  it("refuses ciphertext moved to another project or field", async () => {
    const service = await start();
    await save(service, "In P", "body of p");
    await save(service, "In Q", "body of q", {}, Q);

    await sql`
      UPDATE memories q SET body = p.body
      FROM memories p, projects pp, projects qp
      WHERE p.project_id = pp.id AND pp.slug = ${P} AND q.project_id = qp.id AND qp.slug = ${Q}`;
    await expect(service.get({ project: Q, ids: [1] })).rejects.toThrow(/cannot decrypt memory body/);

    await sql`
      UPDATE memories m SET title = m.body FROM projects p WHERE m.project_id = p.id AND p.slug = ${P}`;
    await expect(service.get({ project: P, ids: [1] })).rejects.toThrow(/cannot decrypt memory title/);
  });

  it("a store without the key refuses to read encrypted rows", async () => {
    await save(await start(), "Secret", "needs the key");
    const [project] = await sql<{ id: string }[]>`SELECT id FROM projects WHERE slug = ${P}`;
    const keyless = new PgStore(sql, 64);
    await expect(keyless.getMemories(project?.id ?? "", [1])).rejects.toThrow(/AXON_ENCRYPTION_KEY is not set/);
  });
});

describe("key binding", () => {
  it("records the first key's fingerprint", async () => {
    await start();
    const [row] = await sql<{ value: string }[]>`SELECT value FROM meta WHERE key = 'encryption_key_id'`;
    expect(row?.value).toBe(new MemoryCipher(key).keyId);
    await start(); // the same key starts again
  });

  it("refuses a different key even before anything is encrypted", async () => {
    await start();
    await expect(start({ ...base, encryptionKey: otherKey })).rejects.toThrow(
      /encrypted with key .* but AXON_ENCRYPTION_KEY is/,
    );
  });

  it("refuses to start without a key while encrypted rows exist, and allows it otherwise", async () => {
    await start(plain); // empty database, no binding
    await save(await start(), "Secret", "written with the key");
    await expect(start(plain)).rejects.toThrow(/1 memories are encrypted; set AXON_ENCRYPTION_KEY/);
  });

  it("lets exactly one of two racing keys claim the database", async () => {
    const results = await Promise.allSettled([
      checkEncryptionKey(sql, new MemoryCipher(key).keyId),
      checkEncryptionKey(sql, new MemoryCipher(otherKey).keyId),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  });
});

describe("convert", () => {
  it("encrypts and decrypts the whole database, preserving everything else", async () => {
    const before = await start(plain);
    await save(before, "One", "first plaintext memory", { source: "a.md" });
    await save(before, "Two", "second plaintext memory", { links: [1] });
    await save(before, "Three", "third memory in another project", {}, Q);
    const snapshot = () => sql`SELECT id, updated_at, embedding::text, tokens, tags, status FROM memories ORDER BY id`;
    const untouched = await snapshot();

    expect(await convert(sql, key, "encrypted")).toBe(3);
    expect([...(await raw()), ...(await raw(Q))].every((r) => r.encrypted && !/One|Two|Three/.test(r.title))).toBe(
      true,
    );
    expect(await snapshot()).toEqual(untouched);
    expect(await convert(sql, key, "encrypted")).toBe(0); // idempotent

    const service = await start();
    expect(
      (await service.get({ project: P, ids: [1, 2] })).memories.map((m) => [m.title, m.source, m.links.length]),
    ).toEqual([
      ["One", "a.md", 1],
      ["Two", null, 1],
    ]);

    expect(await convert(sql, key, "plaintext")).toBe(3);
    expect((await raw()).map((r) => [r.title, r.body, r.source, r.encrypted])).toEqual([
      ["One", "first plaintext memory", "a.md", false],
      ["Two", "second plaintext memory", null, false],
    ]);
    expect(await snapshot()).toEqual(untouched);
    expect(await convert(sql, key, "plaintext")).toBe(0);

    // The key binding is gone, so a keyless server — or a new key — starts again.
    await start(plain);
    await start({ ...base, encryptionKey: otherKey });
  });

  it("pages through more rows than one batch and reports progress", async () => {
    await sql`INSERT INTO projects (slug) VALUES (${P})`;
    await sql`
      INSERT INTO memories (project_id, seq, kind, title, body, tokens)
      SELECT p.id, g, 'gotcha', 'memory ' || g, 'body ' || g, 3
      FROM projects p, generate_series(1, 250) g WHERE p.slug = ${P}`;
    const progress: number[] = [];
    expect(await convert(sql, key, "encrypted", (n) => progress.push(n))).toBe(250);
    expect(progress.at(-1)).toBe(250);
    expect((await raw()).every((r) => r.encrypted)).toBe(true);

    const service = await start();
    const got = await service.get({ project: P, ids: [1, 101, 250] });
    expect(got.memories.map((m) => m.title)).toEqual(["memory 1", "memory 101", "memory 250"]);
  });

  it("refuses a key that doesn't match the database", async () => {
    await save(await start(), "Secret", "written with the key");
    await expect(convert(sql, otherKey, "plaintext")).rejects.toThrow(/encrypted with key/);
    expect((await raw())[0]?.encrypted).toBe(true);
  });

  it("re-embeds encrypted memories only with the key", async () => {
    const service = await AxonService.create(sql, new FakeEmbedder(64), encrypted);
    await save(service, "Queues", "rabbitmq carries order events");
    await expect(reembed(sql, new FakeEmbedder(32))).rejects.toThrow(/AXON_ENCRYPTION_KEY/);
    expect(await reembed(sql, new FakeEmbedder(32), key)).toBe(1);
    expect((await raw())[0]?.encrypted).toBe(true);
    const v2 = await AxonService.create(sql, new FakeEmbedder(32), encrypted);
    const hits = await v2.search({ project: P, query: "rabbitmq order events", k: 5, budget_tokens: 1000 });
    expect(hits.hits[0]?.memory.title).toBe("Queues");
  });
});

describe("rotateKey", () => {
  const keyId = (k: Buffer) => new MemoryCipher(k).keyId;
  const boundKey = async () => {
    const [row] = await sql<{ value: string }[]>`SELECT value FROM meta WHERE key = 'encryption_key_id'`;
    return row?.value ?? null;
  };

  it("re-encrypts every row under the new key, leaving everything else alone", async () => {
    const service = await start();
    await save(service, "One", "first secret memory", { source: "a.md" });
    await save(service, "Two", "second secret memory", { links: [1] });
    await save(service, "Three", "secret in another project", {}, Q);
    const snapshot = () => sql`SELECT id, updated_at, embedding::text, tokens, tags, status FROM memories ORDER BY id`;
    const untouched = await snapshot();
    const ciphertextBefore = (await raw()).map((r) => r.title);

    expect(await rotateKey(sql, key, otherKey)).toBe(3);
    expect(await boundKey()).toBe(keyId(otherKey));
    expect(await snapshot()).toEqual(untouched);
    const after = await raw();
    expect(after.every((r) => r.encrypted)).toBe(true);
    expect(after.map((r) => r.title)).not.toEqual(ciphertextBefore);

    const rotated = await start({ ...base, encryptionKey: otherKey });
    expect(
      (await rotated.get({ project: P, ids: [1, 2] })).memories.map((m) => [m.title, m.source, m.links.length]),
    ).toEqual([
      ["One", "a.md", 1],
      ["Two", null, 1],
    ]);
    expect((await rotated.get({ project: Q, ids: [1] })).memories[0]?.title).toBe("Three");

    await expect(start()).rejects.toThrow(/encrypted with key .* but AXON_ENCRYPTION_KEY is/);
    // Re-running once the database is already on the new key does nothing.
    expect(await rotateKey(sql, key, otherKey)).toBe(0);
  });

  it("leaves plaintext rows plaintext", async () => {
    await save(await start(plain), "Plain", "not encrypted at all");
    await save(await start(), "Secret", "encrypted", {}, Q);

    expect(await rotateKey(sql, key, otherKey)).toBe(1);
    expect((await raw())[0]).toMatchObject({ encrypted: false, title: "Plain" });
  });

  it("refuses a wrong current key, or a new key identical to it", async () => {
    await save(await start(), "Secret", "written with the key");
    const before = await raw();

    await expect(rotateKey(sql, otherKey, Buffer.alloc(32, 3))).rejects.toThrow(/encrypted with key/);
    await expect(rotateKey(sql, key, key)).rejects.toThrow(/same as the current one/);
    expect(await raw()).toEqual(before);
    expect(await boundKey()).toBe(keyId(key));
  });

  it("rolls back completely when a row cannot be decrypted", async () => {
    const service = await start();
    await save(service, "Good", "a readable memory");
    await save(service, "Broken", "about to be corrupted");
    // Same corruption as the tamper test: a title that is really a body's ciphertext.
    await sql`
      UPDATE memories m SET title = m.body FROM projects p
      WHERE m.project_id = p.id AND p.slug = ${P} AND m.seq = 2`;
    const before = await raw();

    await expect(rotateKey(sql, key, otherKey)).rejects.toThrow(/cannot decrypt memory title/);
    expect(await raw()).toEqual(before);
    expect(await boundKey()).toBe(keyId(key));
    // The untouched row still opens with the original key.
    expect((await service.get({ project: P, ids: [1] })).memories[0]?.title).toBe("Good");
  });

  it("pages through more rows than one batch and reports progress", async () => {
    const service = await start();
    for (let i = 1; i <= 120; i++) await save(service, `Memory ${i}`, `secret body number ${i}`);

    const progress: number[] = [];
    expect(await rotateKey(sql, key, otherKey, (n) => progress.push(n))).toBe(120);
    expect(progress.at(-1)).toBe(120);

    const rotated = await start({ ...base, encryptionKey: otherKey });
    expect((await rotated.get({ project: P, ids: [1, 60, 120] })).memories.map((m) => m.title)).toEqual([
      "Memory 1",
      "Memory 60",
      "Memory 120",
    ]);
  });

  it("stops a server still holding the old key from writing memory text", async () => {
    // A plaintext row the stale server can still read, so it gets as far as writing.
    await save(await start(plain), "Plain", "a plaintext memory");
    const stale = await start();
    await rotateKey(sql, key, otherKey);

    const rotated = /key was rotated/;
    // A write into a fresh project reads nothing first, so it fails on the insert guard.
    await expect(stale.remember(mem(Q, "After", "written after the rotation"))).rejects.toThrow(rotated);
    // Editing text would re-encrypt the plaintext row with the retired key.
    await expect(stale.update({ project: P, id: 1, body: "edited after the rotation" })).rejects.toThrow(rotated);

    expect(await raw(Q)).toHaveLength(0);
    expect((await raw())[0]).toMatchObject({ encrypted: false, body: "a plaintext memory" });
  });

  it("still lets the stale server change fields that aren't encrypted", async () => {
    await save(await start(plain), "Pin me", "a memory to pin");
    const stale = await start();
    await rotateKey(sql, key, otherKey);

    // No text is written, so nothing can be encrypted with the retired key.
    await expect(stale.update({ project: P, id: 1, pinned: true })).resolves.toMatchObject({ id: 1 });
    expect((await raw())[0]).toMatchObject({ encrypted: false, title: "Pin me" });
  });

  it("lets only one of two concurrent rotations through", async () => {
    const service = await start();
    await save(service, "Secret", "rotated by exactly one of them");
    const third = Buffer.alloc(32, 3);

    const results = await Promise.allSettled([rotateKey(sql, key, otherKey), rotateKey(sql, key, third)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);

    // Whichever won, the database is wholly on its key and the memory still reads.
    const winner = (await boundKey()) === keyId(otherKey) ? otherKey : third;
    const rotated = await start({ ...base, encryptionKey: winner });
    expect((await rotated.get({ project: P, ids: [1] })).memories[0]?.body).toBe("rotated by exactly one of them");
  });

  it("still reports a missing memory as not found, not as a rotation", async () => {
    await start();
    const [project] = await sql<{ id: string }[]>`
      INSERT INTO projects (slug) VALUES (${P}) RETURNING id`;
    const store = new PgStore(sql, 64, new EncryptingCodec(new MemoryCipher(key)));
    // The key is current, so a zero-row update means the memory really isn't there.
    await expect(
      store.updateMemory(project?.id ?? "", 99, {}, { title: "T", body: "B", source: null }),
    ).rejects.toThrow(/#99 not found/);
  });

  it("a bulk rewrite under a key the database has rotated away from writes nothing", async () => {
    await save(await start(), "Secret", "rewritten only under the bound key");
    await rotateKey(sql, key, otherKey);
    // A convert or rotation still holding the old key, racing the one that just committed.
    const stale = new MaintenanceStore(sql, new EncryptingCodec(new MemoryCipher(key)));
    const before = await raw();
    const [row] = await sql<{ id: number; projectId: string }[]>`SELECT id, project_id FROM memories LIMIT 1`;
    await expect(
      stale.setContent({ id: row?.id ?? 0, projectId: row?.projectId ?? "", title: "T", body: "B", source: null }),
    ).rejects.toThrow(/encryption key was rotated/);
    expect(await raw()).toEqual(before);
  });

  it("reads through the old key fail loudly rather than returning nothing", async () => {
    const stale = await start();
    await save(stale, "Secret", "only the old key opens this");
    await rotateKey(sql, key, otherKey);

    await expect(stale.get({ project: P, ids: [1] })).rejects.toThrow(/cannot decrypt memory/);
  });
});

describe("export and import", () => {
  const exportAll = async (service: AxonService, project = P) =>
    service.exportProject({ project, format: "json", include: "all" });

  it("export plaintext, and import stores ciphertext bound to the target project", async () => {
    const service = await start();
    await save(service, "Stripe webhooks", "verify signatures with the raw request body", {
      source: "docs/payments.md",
    });
    await save(service, "Refunds", "refunds go through the ledger first", { links: [1], link_note: "payments" });

    const exported = await exportAll(service);
    expect(exported.document.memories[0]).toMatchObject({
      title: "Stripe webhooks",
      body: "verify signatures with the raw request body",
      source: "docs/payments.md",
    });
    expect(exported.text).toContain("verify signatures with the raw request body");
    const md = await service.exportProject({ project: P, format: "markdown", include: "all" });
    expect(md.text).toContain("## #1 gotcha · Stripe webhooks");
    expect(md.text).toContain("- source: docs/payments.md");
    // The text as stored is ciphertext, and none of it reaches the export.
    for (const row of await raw()) expect(exported.text).not.toContain(row.body);

    const r = await service.importProject(ImportInput.parse({ project: Q, document: exported.document }));
    expect(r).toMatchObject({ imported: 2, links: 1 });
    const rows = await raw(Q);
    expect(rows.map((x) => x.encrypted)).toEqual([true, true]);
    expect(rows.map((x) => `${x.title} ${x.body} ${x.source}`).join(" ")).not.toMatch(
      /Stripe|signatures|payments\.md|ledger/,
    );
    expect((await service.get({ project: Q, ids: [1] })).memories[0]).toMatchObject({
      title: "Stripe webhooks",
      body: "verify signatures with the raw request body",
      source: "docs/payments.md",
      encrypted: true,
    });
    expect((await exportAll(service, Q)).document.memories).toEqual(exported.document.memories);
  });

  it("encrypt a plaintext export on import when the server has a key", async () => {
    const keyless = await start(plain);
    await save(keyless, "Plain", "written before the key existed");
    const { document } = await exportAll(keyless);
    await sql`DELETE FROM projects`;

    const service = await start();
    await service.importProject(ImportInput.parse({ project: Q, document }));
    expect((await raw(Q))[0]).toMatchObject({ encrypted: true });
    expect((await raw(Q))[0]?.body).not.toContain("written before");
    expect((await service.get({ project: Q, ids: [1] })).memories[0]?.body).toBe("written before the key existed");
  });
});

describe("CLI", () => {
  const run = async (args: string[], encryptionKey = "", newKey = "") => {
    try {
      const r = await promisify(execFile)(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
        env: { ...process.env, DATABASE_URL: url, AXON_ENCRYPTION_KEY: encryptionKey, AXON_ENCRYPTION_KEY_NEW: newKey },
      });
      return { code: 0, stderr: r.stderr };
    } catch (err) {
      const e = err as { code: number; stderr: string };
      return { code: e.code, stderr: e.stderr };
    }
  };

  it("encrypt and decrypt convert the database", async () => {
    await save(await start(plain), "Plain", "converted by the cli");
    const b64 = key.toString("base64");

    const enc = await run(["encrypt"], b64);
    expect(enc).toMatchObject({ code: 0 });
    expect(enc.stderr).toContain("encrypted 1 memories");
    expect((await raw())[0]?.encrypted).toBe(true);

    const dec = await run(["decrypt"], b64);
    expect(dec).toMatchObject({ code: 0 });
    expect(dec.stderr).toContain("decrypted 1 memories");
    expect(dec.stderr).toContain("unset AXON_ENCRYPTION_KEY");
    expect((await raw())[0]).toMatchObject({ encrypted: false, title: "Plain" });
  }, 60_000);

  it("fail without a key", async () => {
    const r = await run(["encrypt"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("AXON_ENCRYPTION_KEY is required to encrypt");
  }, 60_000);

  it("rotate-key rotates the database and says what to do next", async () => {
    await save(await start(), "Secret", "rotated by the cli");

    const r = await run(["rotate-key"], key.toString("base64"), otherKey.toString("base64"));
    expect(r).toMatchObject({ code: 0 });
    expect(r.stderr).toContain("rotated 1 memories");
    expect(r.stderr).toContain("remove AXON_ENCRYPTION_KEY_NEW");

    const service = await start({ ...base, encryptionKey: otherKey });
    expect((await service.get({ project: P, ids: [1] })).memories[0]?.title).toBe("Secret");
  }, 60_000);

  it("rotate-key fails when either key is missing", async () => {
    const noNew = await run(["rotate-key"], key.toString("base64"));
    expect(noNew.code).toBe(1);
    expect(noNew.stderr).toContain("AXON_ENCRYPTION_KEY_NEW");

    const noCurrent = await run(["rotate-key"], "", otherKey.toString("base64"));
    expect(noCurrent.code).toBe(1);
    expect(noCurrent.stderr).toContain("AXON_ENCRYPTION_KEY (the current key) is required");
  }, 60_000);
});

describe("migration 0002 on an existing database", () => {
  it("marks existing rows plaintext and keeps their keyword search", async () => {
    const mig = connect(await siblingDatabase(base.databaseUrl, "test_mig"));
    try {
      await mig.unsafe("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
      await mig.unsafe(await readFile(new URL("../migrations/0001_init.sql", import.meta.url), "utf8"));
      await mig`CREATE TABLE axon_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`;
      await mig`INSERT INTO axon_migrations (name) VALUES ('0001_init.sql')`;
      await mig`INSERT INTO projects (slug) VALUES ('old/p')`;
      await mig`
        INSERT INTO memories (project_id, seq, kind, title, body, tokens)
        SELECT id, 1, 'gotcha', 'Legacy', 'STRIPE_WEBHOOK_SECRET lives in vault', 8 FROM projects`;

      expect((await migrate(mig))[0]).toBe("0002_encryption.sql");

      const [row] = await mig<{ encrypted: boolean; hit: boolean }[]>`
        SELECT encrypted, fts @@ websearch_to_tsquery('simple', 'STRIPE_WEBHOOK_SECRET') AS hit FROM memories`;
      expect(row).toEqual({ encrypted: false, hit: true });
      await expect(mig`UPDATE memories SET title = ${"t".repeat(121)}`).rejects.toThrow(/memories_title_check/);

      const service = await AxonService.create(mig, new FakeEmbedder(), plain);
      const hits = await service.search({ project: "old/p", query: "STRIPE_WEBHOOK_SECRET", k: 5, budget_tokens: 800 });
      expect(hits.hits[0]).toMatchObject({ keyword: true, memory: { title: "Legacy", encrypted: false } });
    } finally {
      await mig.end();
    }
  });
});
