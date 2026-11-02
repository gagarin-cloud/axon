import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AxonService, BriefingResult } from "../src/core/service.js";
import { countTokens } from "../src/core/tokens.js";
import type { Sql } from "../src/db/client.js";
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

/** A similarity suffix, e.g. ` [0.42]` or ` [0.42 +kw]`. */
const SIM = "\\[\\d\\.\\d\\d(?: \\+kw)?\\]";

const modeOf = (b: BriefingResult, seq: number) => b.shown.find((s) => s.memory.seq === seq)?.mode;

/** A dozen high-importance memories, each too big for more than a couple to fit in full. */
async function crowd(project: string) {
  for (let i = 0; i < 12; i++) {
    await save(project, `Fact ${i}`, `word${i} `.repeat(80), { kind: "architecture", importance: 5 });
  }
}

/** About 170 tokens: too big to be upgraded with leftover budget, small enough for the focus share. */
const WEBHOOK = "stripe webhook signature checks need the raw request body before json parsing ".repeat(12);

describe("briefing focus", () => {
  it("gives a low-importance memory that matches the focus a full rendering", async () => {
    const p = slug();
    await crowd(p);
    const target = await save(p, "Webhook raw body", WEBHOOK, { kind: "reference", importance: 1 });

    const plain = await service.briefing({ project: p, budget_tokens: 700 });
    expect(modeOf(plain, target)).not.toBe("full");
    expect(plain.focus).toBeNull();

    const focus = "stripe webhook signature";
    const focused = await service.briefing({ project: p, focus, budget_tokens: 700 });
    expect(focused.focus).toBe(focus);
    expect(modeOf(focused, target)).toBe("full");
    expect(focused.text).toMatch(new RegExp(`## #${target} reference · Webhook raw body ${SIM}`));
    expect(countTokens(focused.text)).toBeLessThanOrEqual(700);
  });

  it("lists matches that don't fit in full under their own heading, with their similarity", async () => {
    const p = slug();
    await crowd(p);
    const huge = await save(p, "Webhook handbook", `${WEBHOOK} ${"appendix ".repeat(800)}`, { importance: 1 });

    const b = await service.briefing({ project: p, focus: "stripe webhook signature", budget_tokens: 700 });
    expect(modeOf(b, huge)).toBe("index");
    expect(b.text).toMatch(new RegExp(`Relevant to focus:\\n#${huge} gotcha · Webhook handbook · \\d+t ${SIM}`));
  });

  it("keeps pinned memories first, while leaving the matches room", async () => {
    const p = slug();
    // Five pinned memories, so without a focus they leave far too little to upgrade the match to full.
    // With four, the room left over came within a few tokens of the match's size, and the briefing
    // header (which names the random project slug) tipped it into full about one run in 200.
    for (let i = 0; i < 5; i++) {
      await save(p, `Pinned ${i}`, `pinword${i} `.repeat(80), { kind: "overview", pinned: true });
    }
    const target = await save(p, "Webhook raw body", WEBHOOK, { importance: 1 });

    const b = await service.briefing({ project: p, focus: "stripe webhook signature", budget_tokens: 900 });
    expect(b.shown[0]?.memory.pinned).toBe(true);
    expect(b.shown[0]?.mode).toBe("full");
    expect(modeOf(b, target)).toBe("full");
    // Without a focus the pinned memories may take the whole budget, and do.
    expect(modeOf(await service.briefing({ project: p, budget_tokens: 900 }), target)).not.toBe("full");
  });

  it("with paths alone, puts the memories on them ahead of the general ranking", async () => {
    const p = slug();
    await crowd(p);
    const target = await save(p, "Billing rounding", WEBHOOK.replaceAll("webhook", "invoice"), {
      importance: 1,
      paths: ["src/billing"],
    });
    const huge = await save(p, "Billing handbook", "ledger ".repeat(900), { importance: 1, paths: ["src/billing/"] });
    const elsewhere = await save(p, "Api rounding", "round half even in api responses", {
      importance: 1,
      paths: ["src/api"],
    });

    const plain = await service.briefing({ project: p, budget_tokens: 700 });
    expect(modeOf(plain, target)).not.toBe("full");

    const b = await service.briefing({ project: p, paths: ["src/billing/stripe.ts"], budget_tokens: 700 });
    expect(b.focus).toBeNull();
    expect(modeOf(b, target)).toBe("full");
    expect(b.text).toMatch(new RegExp(`Relevant to focus:\\n#${huge} gotcha · Billing handbook`));
    const group = b.text.slice(b.text.indexOf("Relevant to focus:")).split("\n\n")[0];
    expect(group).not.toMatch(new RegExp(`#${elsewhere} `));
    expect(countTokens(b.text)).toBeLessThanOrEqual(700);
  });

  it("narrows focus matches to the given paths", async () => {
    const p = slug();
    const onPath = await save(p, "Webhook raw body", WEBHOOK, { paths: ["src/billing"] });
    const offPath = await save(p, "Webhook docs", `${WEBHOOK} docs`, { paths: ["docs"] });
    const b = await service.briefing({
      project: p,
      focus: "stripe webhook signature",
      paths: ["src/billing"],
      budget_tokens: 2000,
    });
    expect(b.text).toMatch(new RegExp(`## #${onPath} gotcha · Webhook raw body ${SIM}`));
    expect(b.text).toMatch(new RegExp(`## #${offPath} gotcha · Webhook docs\\n`));
  });
});

describe("briefing recent", () => {
  it("lists what changed in the last 7 days, except memories shown in full", async () => {
    const p = slug();
    // Big enough that none of these can ever be shown in full at the budget below.
    const big = (word: string) => `${word} `.repeat(1000);
    const overview = await save(p, "Overview", "the whole system in one short paragraph", {
      kind: "overview",
      pinned: true,
    });
    const added = await save(p, "Added", big("alpha"), { importance: 1 });
    const old = await save(p, "Old rule", big("bravo"));
    const successor = await save(p, "New rule", big("charlie"), { supersedes: old });
    const retired = await save(p, "Retired", big("delta"));
    await service.update({ project: p, id: retired, status: "archived" });
    const edited = await save(p, "Edited", big("echo"));
    const stale = await save(p, "Stale", big("foxtrot"));
    await sql`
      UPDATE memories m SET created_at = now() - interval '30 days', updated_at = now() - interval '10 days'
      FROM projects pr
      WHERE pr.id = m.project_id AND pr.slug = ${p} AND m.seq = ANY(${[edited, stale]}::int[])`;
    await service.update({ project: p, id: edited, tags: ["cache"] });

    const b = await service.briefing({ project: p, budget_tokens: 800 });
    expect(modeOf(b, overview)).toBe("full");
    expect(Object.fromEntries(b.recent.map((r) => [r.memory.seq, r.change]))).toEqual({
      [added]: "new",
      [successor]: "new",
      [old]: "superseded",
      [retired]: "archived",
      [edited]: "updated",
    });
    expect(b.recent.find((r) => r.change === "superseded")?.memory.supersededBy).toBe(successor);
    expect(b.recent.every((r) => r.memory.body === undefined)).toBe(true);

    const [heading, ...lines] = b.text.slice(b.text.indexOf("Recent (7d):")).split("\n\n")[0]?.split("\n") ?? [];
    expect(heading).toBe("Recent (7d):");
    expect(lines).toHaveLength(5);
    expect(lines).toContainEqual(
      expect.stringMatching(new RegExp(`^#${old} gotcha · Old rule · \\d+t · superseded by #${successor}$`)),
    );
    expect(lines).toContainEqual(
      expect.stringMatching(new RegExp(`^#${retired} gotcha · Retired · \\d+t · archived$`)),
    );
    expect(lines).toContainEqual(expect.stringMatching(new RegExp(`^#${added} gotcha · Added · \\d+t · new$`)));
    expect(lines).toContainEqual(expect.stringMatching(new RegExp(`^#${edited} gotcha · Edited · \\d+t · updated$`)));
    expect(lines.join("\n")).not.toMatch(new RegExp(`#(${overview}|${stale}) `));
    // Archived and superseded memories are listed as changes, never ranked in the body.
    expect(b.shown.map((s) => s.memory.seq)).not.toContain(old);
    expect(b.shown.map((s) => s.memory.seq)).not.toContain(retired);
    expect(countTokens(b.text)).toBeLessThanOrEqual(800);
  });

  it("lists a changed memory once: its Recent line stands in for its line under More", async () => {
    const p = slug();
    const ids: number[] = [];
    for (const w of ["alpha", "bravo", "charlie"]) ids.push(await save(p, w, `${w} `.repeat(500)));
    const b = await service.briefing({ project: p, budget_tokens: 400 });
    for (const id of ids) {
      expect(b.text.match(new RegExp(`\\n#${id} gotcha`, "g"))).toHaveLength(1);
      expect(modeOf(b, id)).toBe("index");
    }
    expect(b.text).not.toContain("More:");
    expect(b.omitted).toEqual([]);
  });

  it("reports a memory listed only under Recent as omitted by its seq when the budget is too tight", async () => {
    const p = slug();
    // The longest Recent line: packing is greedy, so a shorter line could still fit after longer ones didn't.
    const title = "Juliet retired the legacy deployment pipeline and its staging environment configuration notes";
    const archived = await save(p, title, "juliet ".repeat(300));
    await service.update({ project: p, id: archived, status: "archived" });
    // Recent lists the latest change first, so these newer writes crowd the archived line out.
    for (let i = 0; i < 15; i++) await save(p, `Note ${i}`, `note${i} `.repeat(300));
    const b = await service.briefing({ project: p, budget_tokens: 200 });
    // Archived: out of the ranked body, so only a Recent line could have shown it.
    expect(b.shown.map((s) => s.memory.seq)).not.toContain(archived);
    expect(b.recent.map((r) => r.memory.seq)).not.toContain(archived);
    expect(b.omitted).toContain(archived);
    expect(b.omitted.every((k) => Number.isInteger(k) && k > 0)).toBe(true);
    expect(new Set(b.omitted).size).toBe(b.omitted.length);
  });
});

describe("briefing dispute warning", () => {
  it("counts every disputed memory but names at most five, and uses the singular for one", async () => {
    const p = slug();
    const ids: number[] = [];
    for (let i = 0; i < 7; i++) ids.push(await save(p, `Claim ${i}`, `claim number ${i} about the system`));
    await service.update({ project: p, id: ids[0] as number, dispute: true });
    const one = await service.briefing({ project: p, budget_tokens: 1500 });
    expect(one.text).toContain(`⚠ 1 disputed memory (#${ids[0]}) — confirm, fix or archive them`);

    for (const id of ids.slice(1)) await service.update({ project: p, id, dispute: true });
    const all = await service.briefing({ project: p, budget_tokens: 1500 });
    const line = all.text.split("\n").find((l) => l.startsWith("⚠ 7 disputed memories ("));
    expect(line).toBeDefined();
    const named = line?.match(/#\d+/g) ?? [];
    expect(named).toHaveLength(5);
    expect(new Set(named).size).toBe(5);
    for (const id of named) expect(ids).toContain(Number(id.slice(1)));
    expect(line).toContain(", …) — confirm, fix or archive them");
  });
});

describe("briefing header", () => {
  it("carries the date of the last write", async () => {
    const p = slug();
    await save(p, "A", "alpha memory about caching layers");
    const b = await save(p, "B", "bravo memory about queue workers");
    await service.update({ project: p, id: b, status: "archived" });
    await sql`
      UPDATE memories m SET updated_at = CASE WHEN m.seq = ${b} THEN '2026-10-24 12:00Z'::timestamptz
                                              ELSE '2026-10-20 12:00Z'::timestamptz END
      FROM projects pr WHERE pr.id = m.project_id AND pr.slug = ${p}`;
    const r = await service.briefing({ project: p, budget_tokens: 1500 });
    // The archived memory isn't counted, but archiving it was the last write.
    expect(r.text.split("\n")[0]).toBe(`# ${p} — 1 memories, 0 links · last write 2026-10-24`);
    expect(r.stats?.lastWrite?.toISOString()).toBe("2026-10-24T12:00:00.000Z");
  });

  it("still answers No memories for an unknown project, focus or not", async () => {
    const p = slug();
    const b = await service.briefing({ project: p, focus: "anything", paths: ["src"], budget_tokens: 500 });
    expect(b).toMatchObject({ found: false, focus: "anything", shown: [], recent: [], omitted: [] });
    expect(b.text).toMatch(/^No memories for/);
  });
});
