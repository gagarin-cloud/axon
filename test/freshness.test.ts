import { readdir, readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import type { AxonService } from "../src/core/service.js";
import { connect, type Sql, siblingDatabase } from "../src/db/client.js";
import { migrate } from "../src/db/migrate.js";
import { mem, setup, slug } from "./helpers.js";

let sql: Sql;
let service: AxonService;

beforeAll(async () => {
  ({ sql, service } = await setup());
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

type Flags = { createdAt: Date; updatedAt: Date; confirmedAt: Date; disputedAt: Date | null };
async function flags(project: string, seq: number): Promise<Flags> {
  const [row] = await sql<Flags[]>`
    SELECT m.created_at, m.updated_at, m.confirmed_at, m.disputed_at
    FROM memories m JOIN projects p ON p.id = m.project_id WHERE p.slug = ${project} AND m.seq = ${seq}`;
  if (!row) throw new Error(`#${seq} missing`);
  return row;
}

/** Moves a memory's last confirmation `days` into the past. */
async function age(project: string, seq: number, days: number) {
  await sql`
    UPDATE memories m SET confirmed_at = now() - make_interval(days => ${days}::int)
    FROM projects p WHERE p.id = m.project_id AND p.slug = ${project} AND m.seq = ${seq}`;
}

const recent = (d: Date | null) => d !== null && Date.now() - d.getTime() < 60_000;

describe("confirm and dispute", () => {
  it("a new memory counts as confirmed when it was written, and is not disputed", async () => {
    const p = slug();
    await save(p, "Fresh", "a brand new fact about queues");
    const f = await flags(p, 1);
    expect(f.confirmedAt).toEqual(f.createdAt);
    expect(f.disputedAt).toBeNull();
    const [m] = (await service.get({ project: p, ids: [1] })).memories;
    expect(m).toMatchObject({ confirmedAt: f.createdAt, disputedAt: null });
  });

  it("confirm resets the age and clears a dispute", async () => {
    const p = slug();
    await save(p, "Deploys", "deploys go out on tuesdays", { kind: "state" });
    await age(p, 1, 100);
    await service.update({ project: p, id: 1, dispute: true });
    expect(recent((await flags(p, 1)).disputedAt)).toBe(true);

    const r = await service.update({ project: p, id: 1, confirm: true });
    expect(r).toMatchObject({ confirmed: true, disputed: false, text: "Confirmed #1." });
    const f = await flags(p, 1);
    expect(recent(f.confirmedAt)).toBe(true);
    expect(f.disputedAt).toBeNull();
  });

  it("dispute flags a memory, says what to do, and drops it below a comparable undisputed one", async () => {
    const p = slug();
    await save(p, "Cache TTL", "the cache ttl is five minutes", { importance: 5 });
    await save(p, "Retry limit", "workers retry three times then park the job");
    let b = await service.briefing({ project: p, budget_tokens: 1500 });
    expect(b.shown.map((s) => s.memory.seq)).toEqual([1, 2]);

    const r = await service.update({ project: p, id: 1, dispute: true });
    expect(r.text).toBe("Disputed #1 — fix it with update, replace it with remember supersedes=1, or archive it.");
    expect(r).toMatchObject({ confirmed: false, disputed: true });

    b = await service.briefing({ project: p, budget_tokens: 1500 });
    expect(b.shown.map((s) => s.memory.seq)).toEqual([2, 1]);
    expect(b.shown[1]?.memory.disputedAt).toBeInstanceOf(Date);
    expect(b.text).toContain("## #1 gotcha · Cache TTL ⚠ disputed");
    expect(b.text).toContain("⚠ 1 disputed memory (#1) — confirm, fix or archive them");
    expect(b.text).toContain("update confirm/dispute");
  });

  it("leaves the disputed line out of a briefing with nothing disputed", async () => {
    const p = slug();
    await save(p, "Plain", "nothing wrong with this one");
    const b = await service.briefing({ project: p, budget_tokens: 1500 });
    expect(b.text).not.toMatch(/disputed/);
  });

  it("editing the title or body confirms the memory and clears its dispute", async () => {
    const p = slug();
    await save(p, "Port", "the api listens on 8080");
    await save(p, "Host", "the api binds to localhost");
    for (const seq of [1, 2]) {
      await age(p, seq, 400);
      await service.update({ project: p, id: seq, dispute: true });
    }

    const body = await service.update({ project: p, id: 1, body: "the api listens on 7717" });
    expect(body).toMatchObject({ confirmed: true, disputed: false, reembedded: true });
    expect(body.text).toContain("Editing confirmed #1 and cleared its dispute.");
    await service.update({ project: p, id: 2, title: "Bind host" });
    for (const seq of [1, 2]) {
      const f = await flags(p, seq);
      expect(recent(f.confirmedAt)).toBe(true);
      expect(f.disputedAt).toBeNull();
    }
  });

  it("an explicit dispute wins over the confirmation implied by an edit", async () => {
    const p = slug();
    await save(p, "Region", "we run in eu-west-1");
    const r = await service.update({ project: p, id: 1, body: "we run in eu-central-1", dispute: true });
    expect(r).toMatchObject({ confirmed: true, disputed: true });
    expect(recent((await flags(p, 1)).disputedAt)).toBe(true);
  });

  it("other edits, archiving and reads leave confirmation and disputes alone", async () => {
    const p = slug();
    await save(p, "Owner", "team platform owns the gateway");
    await age(p, 1, 50);
    await service.update({ project: p, id: 1, dispute: true });
    const before = await flags(p, 1);

    await service.update({ project: p, id: 1, pinned: true, importance: 4, tags: ["gateway"], source: "review" });
    await service.update({ project: p, id: 1, status: "archived" });
    await service.get({ project: p, ids: [1] });
    const after = await flags(p, 1);
    expect(after.confirmedAt).toEqual(before.confirmedAt);
    expect(after.disputedAt).toEqual(before.disputedAt);
  });

  it("refuses confirm and dispute together, changing nothing", async () => {
    const p = slug();
    await save(p, "Both", "a fact that is either true or not");
    await age(p, 1, 10);
    const before = await flags(p, 1);
    await expect(service.update({ project: p, id: 1, confirm: true, dispute: true })).rejects.toMatchObject({
      code: "invalid",
    });
    expect(await flags(p, 1)).toEqual(before);
  });

  it("refuses to confirm or dispute a superseded memory, pointing at its successor", async () => {
    const p = slug();
    await save(p, "Old", "builds use node 20");
    const r = await service.remember(mem(p, "New", "builds use node 22", { supersedes: 1 }));
    expect(r.saved).toBe(true);
    const before = await flags(p, 1);
    for (const flag of [{ confirm: true }, { dispute: true }]) {
      await expect(service.update({ project: p, id: 1, ...flag })).rejects.toMatchObject({
        code: "rule",
        message: expect.stringMatching(/superseded by #2/),
      });
    }
    expect(await flags(p, 1)).toEqual(before);
  });

  it("cannot confirm or dispute a memory in another project", async () => {
    const p = slug();
    const q = slug();
    await save(p, "Mine", "only one memory here");
    await save(q, "Theirs one", "first memory of the other project");
    await save(q, "Theirs two", "second memory of the other project");
    await age(q, 2, 30);
    const before = await flags(q, 2);

    for (const flag of [{ confirm: true }, { dispute: true }]) {
      await expect(service.update({ project: p, id: 2, ...flag })).rejects.toMatchObject({ code: "not_found" });
    }
    // Same seq in both projects: flagging p's #1 leaves q's #1 alone.
    await service.update({ project: p, id: 1, dispute: true });
    expect((await flags(q, 1)).disputedAt).toBeNull();
    expect(await flags(q, 2)).toEqual(before);
  });
});

describe("markers", () => {
  it("search still finds a disputed memory, marked, in full and as an index line", async () => {
    const p = slug();
    await save(p, "Webhook secret", "the service reads STRIPE_WEBHOOK_SECRET at boot");
    await save(p, "Fonts", "unrelated notes about colours and fonts");
    await service.update({ project: p, id: 1, dispute: true });

    const full = await service.search({ project: p, query: "STRIPE_WEBHOOK_SECRET", k: 8, budget_tokens: 1200 });
    expect(full.hits[0]?.memory.seq).toBe(1);
    expect(full.text).toContain("## #1 gotcha · Webhook secret ⚠ disputed");

    const pad = "lorem ipsum dolor sit amet ".repeat(80);
    await service.update({ project: p, id: 1, body: `the service reads STRIPE_WEBHOOK_SECRET at boot ${pad}` });
    await service.update({ project: p, id: 1, dispute: true });
    const index = await service.search({ project: p, query: "STRIPE_WEBHOOK_SECRET", k: 8, budget_tokens: 200 });
    expect(index.hits[0]).toMatchObject({ mode: "index", memory: { seq: 1 } });
    expect(index.text).toMatch(/#1 gotcha · Webhook secret ⚠ disputed · \d+t/);
  });

  it("get and related render the dispute", async () => {
    const p = slug();
    await save(p, "Payments", "stripe charges and payment intents");
    await save(p, "Ledger", "double entry bookkeeping tables");
    await service.link({ project: p, id: 1, to: [2], remove: false });
    await service.update({ project: p, id: 2, dispute: true });

    const got = await service.get({ project: p, ids: [2] });
    expect(got.text).toContain("## #2 gotcha · Ledger ⚠ disputed");
    expect(got.text).toMatch(/confirmed \d{4}-\d{2}-\d{2} · disputed \d{4}-\d{2}-\d{2}/);

    const related = await service.related({ project: p, id: 1, hops: 1, budget_tokens: 1000 });
    expect(related.text).toContain("#2 gotcha · Ledger ⚠ disputed");
    expect(related.steps[0]?.memory.disputedAt).toBeInstanceOf(Date);
  });

  it("an old state memory ranks below a fresh one of equal importance and says how long it went unconfirmed", async () => {
    const p = slug();
    // Long bodies so neither fits in full: both render as index lines.
    await save(p, "Fresh status", `release train is green ${"alpha bravo charlie ".repeat(120)}`, { kind: "state" });
    await save(p, "Stale status", `release train is blocked ${"delta echo foxtrot ".repeat(120)}`, { kind: "state" });
    await age(p, 2, 140);

    const b = await service.briefing({ project: p, budget_tokens: 300 });
    expect(b.shown.map((s) => [s.memory.seq, s.mode])).toEqual([
      [1, "index"],
      [2, "index"],
    ]);
    expect(b.text).toMatch(/#2 state · Stale status · \d+t · unconfirmed 140d/);
    expect(b.text).not.toMatch(/#1 state · Fresh status .*unconfirmed/);

    await service.update({ project: p, id: 2, confirm: true });
    const after = await service.briefing({ project: p, budget_tokens: 300 });
    expect(after.shown[0]?.memory.seq).toBe(2);
    expect(after.text).not.toContain("unconfirmed");
  });
});

describe("migration 0004 on an existing database", () => {
  it("backfills confirmed_at from created_at and leaves nothing disputed", async () => {
    const base = loadConfig();
    const mig = connect(await siblingDatabase(base.databaseUrl, "test_mig_confirm"));
    try {
      await mig.unsafe("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
      await mig`CREATE TABLE axon_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`;
      const dir = new URL("../migrations/", import.meta.url);
      for (const file of (await readdir(dir)).filter((f) => f.endsWith(".sql") && f < "0004_confirm.sql").sort()) {
        await mig.unsafe(await readFile(new URL(file, dir), "utf8"));
        await mig`INSERT INTO axon_migrations (name) VALUES (${file})`;
      }
      await mig`INSERT INTO projects (slug) VALUES ('old/p')`;
      await mig`
        INSERT INTO memories (project_id, seq, kind, title, body, tokens, created_at, updated_at)
        SELECT id, 1, 'state', 'Legacy', 'written long ago', 4, '2025-01-02T03:04:05Z', '2026-01-01T00:00:00Z'
        FROM projects`;

      expect(await migrate(mig)).toContain("0004_confirm.sql");

      const [row] = await mig<{ confirmedAt: Date; disputedAt: Date | null }[]>`
        SELECT confirmed_at, disputed_at FROM memories`;
      expect(row).toEqual({ confirmedAt: new Date("2025-01-02T03:04:05Z"), disputedAt: null });
      await expect(mig`UPDATE memories SET confirmed_at = NULL`).rejects.toThrow(/not-null/);
    } finally {
      await mig.end();
    }
  });
});
