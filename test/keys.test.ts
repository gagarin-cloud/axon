import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { renderIndexLine } from "../src/core/render.js";
import { GetInput, RememberInput } from "../src/core/schemas.js";
import { AxonError, AxonService } from "../src/core/service.js";
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
  return r;
}

const one = async (project: string, id: number) => {
  const [m] = (await service.get({ project, ids: [id] })).memories;
  if (!m) throw new Error(`#${id} missing`);
  return m;
};

/** Active memories holding `key` in `project`, straight from the table. */
const holders = async (project: string, key: string) =>
  (
    await sql<{ seq: number }[]>`
      SELECT m.seq FROM memories m JOIN projects p ON p.id = m.project_id
      WHERE p.slug = ${project} AND m.key = ${key} AND m.status = 'active'`
  ).map((r) => r.seq);

describe("keys", () => {
  it("are normalised and validated", () => {
    const parsed = RememberInput.parse(mem("p", "T", "b", { key: "  Deploy/Current " }));
    expect(parsed.key).toBe("deploy/current");
    for (const bad of ["-lead", "has space", "x".repeat(81), "comma,list", ""]) {
      expect(() => RememberInput.parse(mem("p", "T", "b", { key: bad }))).toThrow(/key/);
    }
    expect(() => GetInput.parse({ project: "p" })).toThrow(/ids or keys required/);
    expect(GetInput.parse({ project: "p", keys: ["Owner/Billing"] }).keys).toEqual(["owner/billing"]);
  });

  it("a later remember with the key replaces the holder, moves its links and says so", async () => {
    const p = slug();
    const first = await save(p, "Current deploy", "production runs release v1.4", { key: "deploy/current" });
    expect(first).toMatchObject({ id: 1, key: "deploy/current", superseded: null });
    expect(first.text).toMatch(/^Saved #1 \(\d+t, key deploy\/current\)/);
    const peer = await save(p, "Rollback", "rollbacks redeploy the previous image tag");
    await service.link({ project: p, id: 1, to: [peer.id], remove: false });

    const next = await save(p, "Current deploy", "production runs release v1.5", { key: "deploy/current" });
    expect(next).toMatchObject({ id: 3, key: "deploy/current", superseded: 1 });
    expect(next.text).toContain("Replaced #1 (key deploy/current); its links moved to #3.");

    expect(await one(p, 1)).toMatchObject({ status: "superseded", supersededBy: 3 });
    expect(await one(p, 3)).toMatchObject({ status: "active", key: "deploy/current" });
    const related = await service.related({ project: p, id: 3, hops: 1, budget_tokens: 1000 });
    expect(related.steps.map((s) => s.memory.seq)).toEqual([peer.id]);
    expect(await holders(p, "deploy/current")).toEqual([3]);
  });

  it("the holder is not a near-duplicate of its replacement", async () => {
    const p = slug();
    await save(p, "Owner", "billing is owned by the payments team", { key: "owner/billing" });
    // Same text, which would be refused as a near-duplicate without the key.
    const again = await service.remember(mem(p, "Owner", "billing is owned by the payments team"));
    expect(again.saved).toBe(false);
    const keyed = await service.remember(
      mem(p, "Owner", "billing is owned by the payments team", { key: "owner/billing" }),
    );
    expect(keyed).toMatchObject({ saved: true, superseded: 1 });
  });

  it("refuses supersedes naming a different memory than the key's holder, writing nothing", async () => {
    const p = slug();
    await save(p, "Deploy", "production runs release v1.4", { key: "deploy/current" });
    await save(p, "Other", "an unrelated fact about fonts");
    await expect(
      service.remember(mem(p, "Deploy", "production runs v1.5", { key: "deploy/current", supersedes: 2 })),
    ).rejects.toMatchObject({ code: "rule", message: expect.stringContaining("held by #1") });
    const [{ n } = { n: -1 }] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM memories m JOIN projects pr ON pr.id = m.project_id WHERE pr.slug = ${p}`;
    expect(n).toBe(2);

    const same = await save(p, "Deploy", "production runs v1.5", { key: "deploy/current", supersedes: 1 });
    expect(same).toMatchObject({ superseded: 1, key: "deploy/current" });
  });

  it("superseding a keyed memory without a key carries the key on", async () => {
    const p = slug();
    await save(p, "Deploy", "production runs release v1.4", { key: "deploy/current" });
    const next = await save(p, "Deploy", "production runs release v1.5", { supersedes: 1 });
    expect(next).toMatchObject({ key: "deploy/current", superseded: 1 });
    expect(await holders(p, "deploy/current")).toEqual([2]);
  });

  it("a keyed replacement is admitted at the memory cap", async () => {
    const p = slug();
    await capped.remember(mem(p, "alpha", "alpha fact about alpha things", { key: "alpha" }));
    await capped.remember(mem(p, "bravo", "bravo fact about bravo things"));
    await expect(capped.remember(mem(p, "charlie", "charlie fact about charlie things"))).rejects.toMatchObject({
      code: "rule",
    });
    expect(await capped.remember(mem(p, "alpha 2", "alpha moved somewhere else", { key: "alpha" }))).toMatchObject({
      saved: true,
      id: 3,
      superseded: 1,
    });
    // A new key is a new memory, so the cap still applies to it.
    await expect(capped.remember(mem(p, "delta", "delta fact", { key: "delta" }))).rejects.toMatchObject({
      code: "rule",
    });
  });

  it("are unique per project: the same key in another project is unaffected", async () => {
    const a = slug();
    const b = slug();
    await save(a, "Deploy A", "project a runs release v1.4", { key: "deploy/current" });
    const inB = await save(b, "Deploy B", "project b runs release v9", { key: "deploy/current" });
    // B's remember neither replaced nor saw A's holder.
    expect(inB).toMatchObject({ id: 1, superseded: null });
    expect(await holders(a, "deploy/current")).toEqual([1]);
    expect(await holders(b, "deploy/current")).toEqual([1]);
    expect((await one(a, 1)).title).toBe("Deploy A");

    // Claiming it by update in B doesn't see A's holder either.
    await save(b, "Spare", "another fact in project b", { key: "spare" });
    await service.update({ project: b, id: 1, key: null });
    await service.update({ project: b, id: 2, key: "deploy/current" });
    expect(await holders(b, "deploy/current")).toEqual([2]);
    expect(await holders(a, "deploy/current")).toEqual([1]);

    const got = await service.get({ project: b, keys: ["deploy/current"] });
    expect(got.memories.map((m) => m.title)).toEqual(["Spare"]);

    // SAFETY (tenancy): a key held only in B is nobody's in A — reading by key never crosses projects.
    const theirs = await service.get({ project: a, keys: ["spare"] });
    expect(theirs.memories).toEqual([]);
    expect(theirs.missingKeys).toEqual(["spare"]);
  });

  it("update refuses a key another active memory holds, and null clears it", async () => {
    const p = slug();
    await save(p, "Deploy", "production runs release v1.4", { key: "deploy/current" });
    await save(p, "Owner", "billing is owned by payments", { key: "owner/billing" });

    await expect(service.update({ project: p, id: 2, key: "deploy/current", title: "Renamed" })).rejects.toMatchObject({
      code: "conflict",
      message: expect.stringContaining("held by #1"),
    });
    expect(await one(p, 2)).toMatchObject({ key: "owner/billing", title: "Owner" });

    await service.update({ project: p, id: 1, key: null });
    expect((await one(p, 1)).key).toBeNull();
    await service.update({ project: p, id: 2, key: "deploy/current" });
    expect(await holders(p, "deploy/current")).toEqual([2]);
    // Re-setting the key a memory already holds is fine.
    await service.update({ project: p, id: 2, key: "deploy/current" });
  });

  it("archiving releases a key; restoring refuses once another memory holds it", async () => {
    const p = slug();
    await save(p, "Deploy", "production runs release v1.4", { key: "deploy/current" });
    await service.update({ project: p, id: 1, status: "archived" });

    // Released: the next keyed write is a new memory, not a replacement of the archived one.
    const next = await save(p, "Deploy", "production runs release v1.5", { key: "deploy/current" });
    expect(next).toMatchObject({ id: 2, superseded: null });
    expect(await one(p, 1)).toMatchObject({ status: "archived", key: "deploy/current" });

    await expect(service.update({ project: p, id: 1, status: "active", title: "Changed" })).rejects.toMatchObject({
      code: "conflict",
      message: expect.stringContaining("held by #2"),
    });
    expect(await one(p, 1)).toMatchObject({ status: "archived", title: "Deploy" });

    await service.update({ project: p, id: 1, status: "active", key: null });
    expect(await one(p, 1)).toMatchObject({ status: "active", key: null });
    expect(await holders(p, "deploy/current")).toEqual([2]);
  });

  it("superseding releases a key, and a superseded holder can't be revived", async () => {
    const p = slug();
    await save(p, "Deploy", "production runs release v1.4", { key: "deploy/current" });
    await save(p, "Deploy", "production runs release v1.5", { key: "deploy/current" });
    expect(await one(p, 1)).toMatchObject({ status: "superseded", key: "deploy/current" });
    await expect(service.update({ project: p, id: 1, status: "active" })).rejects.toMatchObject({ code: "rule" });
    expect(await holders(p, "deploy/current")).toEqual([2]);
  });

  it("get reads by keys, alongside ids, and reports keys nobody holds", async () => {
    const p = slug();
    await save(p, "Deploy", "production runs release v1.4", { key: "deploy/current" });
    await save(p, "Owner", "billing is owned by payments", { key: "owner/billing" });
    await save(p, "Plain", "a fact without a key");

    const got = await service.get({ project: p, ids: [3], keys: ["owner/billing", "deploy/current", "nobody"] });
    expect(got.memories.map((m) => m.seq)).toEqual([3, 2, 1]);
    expect(got.missingKeys).toEqual(["nobody"]);
    expect(got.text).toContain("Not found: key nobody");
    expect(got.text).toMatch(/## #1 gotcha · Deploy\nkey deploy\/current · /);

    // Index lines carry the key as a short tag after the title.
    expect(renderIndexLine(await one(p, 1))).toMatch(/^#1 gotcha · Deploy \[deploy\/current\] · \d+t$/);
  });

  it("the database enforces one active holder and the key format", async () => {
    const p = slug();
    await save(p, "A", "alpha fact", { key: "k" });
    await save(p, "B", "bravo fact");
    await expect(
      sql`UPDATE memories m SET key = 'k' FROM projects pr WHERE pr.id = m.project_id AND pr.slug = ${p} AND m.seq = 2`,
    ).rejects.toThrow(/memories_active_key_idx/);
    await expect(
      sql`UPDATE memories m SET key = 'Bad Key' FROM projects pr WHERE pr.id = m.project_id AND pr.slug = ${p} AND m.seq = 2`,
    ).rejects.toThrow(/check constraint/);
  });
});

describe("keys under concurrency", () => {
  /** Rows of `project` in seq order, with the seq each superseded one was replaced by. */
  const chain = (project: string) => sql<{ seq: number; status: string; next: number | null }[]>`
    SELECT m.seq, m.status, s.seq AS next FROM memories m
    JOIN projects pr ON pr.id = m.project_id LEFT JOIN memories s ON s.id = m.superseded_by
    WHERE pr.slug = ${project} AND m.key = 'deploy/now' ORDER BY m.seq`;

  const writers = (project: string) =>
    ["amber", "birch", "cedar", "dune", "ember", "fjord"].map((w) =>
      service.remember(mem(project, `Deploy ${w}`, `production runs release ${w}`, { key: "deploy/now" })),
    );

  /** Every save of the key replaced the one before it: a single chain, newest active, no internal error. */
  const expectOneChain = async (project: string, results: PromiseSettledResult<unknown>[]) => {
    for (const r of results) if (r.status === "rejected") expect(r.reason).toBeInstanceOf(AxonError);
    const saved = results.filter((r) => r.status === "fulfilled" && (r.value as { saved: boolean }).saved);
    expect(saved.length).toBeGreaterThan(0);
    expect(await holders(project, "deploy/now")).toHaveLength(1);
    const rows = await chain(project);
    expect(rows).toHaveLength(saved.length);
    expect(rows.filter((r) => r.status === "superseded").map((r) => r.next)).toEqual(rows.slice(1).map((r) => r.seq));
  };

  it("concurrent remembers of one new key in a new project leave exactly one active holder", async () => {
    const p = slug();
    await expectOneChain(p, await Promise.allSettled(writers(p)));
  });

  it("writers queued on the project lock each see the key their predecessor claimed", async () => {
    const p = slug();
    await save(p, "Seed", "an unrelated fact so the project exists");
    // Hold the project's lock until every writer is waiting on it, so any read a writer made before
    // taking the lock would be stale by the time it writes.
    let release = () => {};
    let locked = () => {};
    const isLocked = new Promise<void>((r) => {
      locked = r;
    });
    const holding = sql.begin(async (tx) => {
      await tx`SELECT 1 FROM projects WHERE slug = ${p} FOR UPDATE`;
      locked();
      await new Promise<void>((r) => {
        release = r;
      });
    });
    await isLocked;
    const pending = Promise.allSettled(writers(p));
    for (let i = 0; i < 200; i++) {
      const [{ n } = { n: 0 }] = await sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock'`;
      if (n >= 6) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    release();
    await holding;
    await expectOneChain(p, await pending);
  });

  it("concurrent updates claiming one key: one wins, the rest get a conflict", async () => {
    const p = slug();
    const words = ["amber", "birch", "cedar", "dune", "ember"];
    for (const w of words) await save(p, w, `${w} fact about ${w} things`);
    const results = await Promise.allSettled(
      words.map((_, i) => service.update({ project: p, id: i + 1, key: "owner/billing" })),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    for (const r of results) if (r.status === "rejected") expect(r.reason).toMatchObject({ code: "conflict" });
    expect(await holders(p, "owner/billing")).toHaveLength(1);
  });
});
