import { describe, expect, it } from "vitest";
import { z } from "zod";
import { loadConfig } from "../src/config.js";
import { MemoryCipher } from "../src/core/cipher.js";
import { AxonError, classifyError } from "../src/core/errors.js";
import { plural, seqList } from "../src/core/format.js";
import { nonEnglishLanguage } from "../src/core/lang.js";
import { budgeted, type PackKey, pack } from "../src/core/pack.js";
import { freshness, rankForBriefing } from "../src/core/rank.js";
import { neighbourhood, refusalText, savedText } from "../src/core/remember.js";
import { renderFull, renderIndexLine, renderLinkFooter } from "../src/core/render.js";
import { ImportDocument, RememberInput, UpdateInput } from "../src/core/schemas.js";
import { countTokens } from "../src/core/tokens.js";
import { planUpdate } from "../src/core/update-plan.js";
import { shownIn } from "../src/core/views.js";
import type { Sql } from "../src/db/client.js";
import { setEmbeddingModel } from "../src/store/bindings.js";
import { codecFor, EncryptingCodec, openContent, PLAINTEXT } from "../src/store/codec.js";
import type { Memory } from "../src/store/types.js";

const memory = (seq: number, over: Partial<Memory> = {}): Memory => ({
  seq,
  kind: "decision",
  title: `Memory ${seq}`,
  body: "body",
  tags: [],
  paths: [],
  pinned: false,
  importance: 3,
  status: "active",
  supersededBy: null,
  tokens: 10,
  source: null,
  key: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  confirmedAt: new Date(),
  disputedAt: null,
  lastAccessedAt: null,
  accessCount: 0,
  degree: 0,
  encrypted: false,
  ...over,
});

describe("pack", () => {
  const items = Array.from({ length: 40 }, (_, i) => ({
    key: i + 1,
    full: `## #${i + 1} ${"lorem ipsum dolor sit amet ".repeat(20)}`,
    index: `#${i + 1} decision · Title number ${i + 1} · 120t`,
  }));

  it("never exceeds the budget", () => {
    for (const budget of [60, 200, 500, 1000, 3000]) {
      const p = pack({ header: "# header", items, budget, footer: "tags: a b c" });
      expect(countTokens(p.text)).toBeLessThanOrEqual(budget);
      expect(p.tokens).toBeLessThanOrEqual(budget);
    }
  });

  it("shows full bodies first, then index lines, then an omitted note", () => {
    const p = pack({ header: "# h", items, budget: 800 });
    expect(p.full.length).toBeGreaterThan(0);
    expect(p.index.length).toBeGreaterThan(0);
    expect(p.omitted.length).toBe(40 - p.full.length - p.index.length);
    expect(p.text.indexOf("## #1 ")).toBeLessThan(p.text.indexOf("More:"));
    expect(p.text).toMatch(/\+\d+ more not shown/);
  });

  it("reserves room for breadth unless an item has its own share", () => {
    const big = { key: 99, full: "x ".repeat(300), index: "#99 · big" };
    const small = Array.from({ length: 20 }, (_, i) => ({
      key: i,
      full: null,
      index: `#${i} decision · a short index line`,
    }));
    const plain = pack({ header: "h", items: [big, ...small], budget: 450, fullShare: 0.5 });
    expect(plain.full).toEqual([]);
    expect(plain.index).toContain(99);
    const pinned = pack({ header: "h", items: [{ ...big, share: 1 }, ...small], budget: 450, fullShare: 0.5 });
    expect(pinned.full).toEqual([99]);
  });

  it("spends leftover budget upgrading index lines to full", () => {
    const item = { key: 1, full: "x ".repeat(300), index: "#1 · big" };
    expect(pack({ header: "h", items: [item], budget: 400, fullShare: 0.5 }).full).toEqual([1]);
  });

  it("drops an echo line when the item it repeats is shown in full", () => {
    const original = { key: 1, full: "## #1 small", index: "#1 · small" };
    const echo = { key: "recent:1", full: null, index: "#1 · small · new", group: "Recent:", echoes: 1 };
    const p = pack<PackKey>({ header: "h", items: [original, echo], budget: 500 });
    expect(p.full).toEqual([1]);
    expect(p.index).toEqual([]);
    expect(p.omitted).toEqual([]);
    expect(p.text).not.toContain("Recent:");
  });

  it("lists an item once when its echo comes first, and never counts the echo as omitted", () => {
    const big = { key: 1, full: "x ".repeat(400), index: "#1 · big" };
    const echo = { key: "recent:1", full: null, index: "#1 · big · new", group: "Recent:", echoes: 1 };
    const p = pack<PackKey>({ header: "h", items: [echo, big], budget: 200 });
    expect(p.full).toEqual([]);
    expect(p.index).toEqual(["recent:1"]);
    expect(p.omitted).toEqual([]);
    expect(p.text).toContain("Recent:\n#1 · big · new");
    expect(p.text).not.toContain("More:");

    // Too small for either line: the item is omitted once, not twice.
    const none = pack<PackKey>({ header: "h", items: [echo, big], budget: 14 });
    expect(none.omitted).toEqual([1]);
  });

  it("upgrades an item listed only through its echo, replacing the echo", () => {
    const item = { key: 1, full: "x ".repeat(300), index: "#1 · big" };
    const echo = { key: "recent:1", full: null, index: "#1 · big · new", group: "Recent:", echoes: 1 };
    const p = pack<PackKey>({ header: "h", items: [echo, item], budget: 400, fullShare: 0.5 });
    expect(p.full).toEqual([1]);
    expect(p.index).toEqual([]);
  });

  it("keys items by any string or number, so one memory can have several lines", () => {
    // A review lists one memory under two sections: distinct keys, both shown, neither omitted.
    const p = pack<string>({
      header: "h",
      items: [
        { key: "Orphans:#1", full: null, index: "#1 · old", group: "Orphans:" },
        { key: "Unread:#1", full: null, index: "#1 · old", group: "Unread:" },
      ],
      budget: 500,
    });
    expect(p.index).toEqual(["Orphans:#1", "Unread:#1"]);
    expect(p.text).toContain("Orphans:\n#1 · old\n\nUnread:\n#1 · old");
    expect(p.omitted).toEqual([]);
  });

  it("says how each item was shown, and what a result carries over", () => {
    const items = [
      { key: 1, full: "## #1 small", index: "#1 · small" },
      { key: 2, full: "x ".repeat(400), index: "#2 · big" },
      { key: 3, full: "y ".repeat(400), index: "#3 · bigger" },
    ];
    const p = pack({ header: "h", items, budget: 220 });
    expect([1, 2, 3, 4].map((k) => p.mode(k))).toEqual(["full", "index", "index", null]);
    expect(budgeted(p)).toEqual({ omitted: p.omitted, text: p.text, tokens: p.tokens });

    const links = new Map([[1, [{ seq: 9, title: "Linked", strength: 1, note: null }]]]);
    expect(shownIn(p, 1, memory(1), links)).toMatchObject({
      mode: "full",
      memory: { body: "body" },
      links: [{ seq: 9 }],
    });
    const indexed = shownIn(p, 2, memory(2), links);
    expect(indexed?.mode).toBe("index");
    expect(indexed?.memory).not.toHaveProperty("body");
    expect(shownIn(p, 4, memory(4), links)).toBeNull();
  });

  it("keeps index-only items out of the full section", () => {
    const p = pack({ header: "h", items: [{ key: 1, full: null, index: "#1 linked", group: "Linked:" }], budget: 500 });
    expect(p.full).toEqual([]);
    expect(p.text).toContain("Linked:\n#1 linked");
  });
});

describe("rankForBriefing", () => {
  it("puts pinned memories first, then weighs importance, kind and connectivity", () => {
    const ranked = rankForBriefing([
      memory(1, { importance: 2 }),
      memory(2, { importance: 5 }),
      memory(3, { pinned: true, importance: 1 }),
      memory(4, { kind: "overview" }),
      memory(5, { degree: 12 }),
    ]);
    expect(ranked[0]?.seq).toBe(3);
    expect(ranked.at(-1)?.seq).toBe(1);
    expect(ranked.findIndex((m) => m.seq === 5)).toBeLessThan(ranked.findIndex((m) => m.seq === 1));
  });
});

describe("freshness", () => {
  const now = new Date("2026-10-26T12:00:00Z");
  const ago = (days: number) => new Date(now.getTime() - days * 86_400_000);

  it("halves per kind's half-life and never drops below the floor", () => {
    expect(freshness({ kind: "state", confirmedAt: now }, now)).toBe(1);
    expect(freshness({ kind: "state", confirmedAt: ago(30) }, now)).toBeCloseTo(0.5);
    for (const kind of ["gotcha", "howto", "reference"] as const) {
      expect(freshness({ kind, confirmedAt: ago(180) }, now)).toBeCloseTo(0.5);
    }
    for (const kind of ["overview", "architecture", "decision", "convention"] as const) {
      expect(freshness({ kind, confirmedAt: ago(365) }, now)).toBeCloseTo(0.5);
    }
    expect(freshness({ kind: "state", confirmedAt: ago(3650) }, now)).toBe(0.4);
    expect(freshness({ kind: "decision", confirmedAt: ago(3650) }, now)).toBe(0.4);
  });

  it("ranks an old unconfirmed state below a fresh one of equal importance", () => {
    const ranked = rankForBriefing(
      [memory(1, { kind: "state" }), memory(2, { kind: "state", confirmedAt: ago(140) })],
      now,
    );
    // Without freshness the newer seq would win the tie.
    expect(ranked.map((m) => m.seq)).toEqual([1, 2]);
  });

  it("ages state faster than decisions", () => {
    const ranked = rankForBriefing(
      [memory(1, { kind: "decision", confirmedAt: ago(90) }), memory(2, { kind: "state", confirmedAt: ago(90) })],
      now,
    );
    expect(ranked.map((m) => m.seq)).toEqual([1, 2]);
  });

  it("sorts disputed memories after undisputed ones of the same pin status", () => {
    const ranked = rankForBriefing(
      [
        memory(1, { importance: 1 }),
        memory(2, { importance: 5, kind: "overview", degree: 9, disputedAt: now }),
        memory(3, { pinned: true, disputedAt: now }),
        memory(4, { pinned: true, importance: 1 }),
        memory(5, { importance: 2 }),
      ],
      now,
    );
    expect(ranked.map((m) => m.seq)).toEqual([4, 3, 5, 1, 2]);
  });
});

describe("render", () => {
  const now = new Date("2026-10-26T12:00:00Z");
  const ago = (days: number) => new Date(now.getTime() - days * 86_400_000);

  it("marks disputed memories in index lines and full headings", () => {
    const m = memory(12, { kind: "gotcha", title: "Raw body", disputedAt: ago(2), confirmedAt: ago(10) });
    expect(renderIndexLine(m, "", now)).toBe("#12 gotcha · Raw body ⚠ disputed · 10t");
    const full = renderFull(m).split("\n");
    expect(full[0]).toBe("## #12 gotcha · Raw body ⚠ disputed");
    expect(full[1]).toContain(`confirmed ${ago(10).toISOString().slice(0, 10)}`);
    expect(full[1]).toContain(`disputed ${ago(2).toISOString().slice(0, 10)}`);
  });

  it("shows the confirmed date on every full memory and keeps undisputed lines unmarked", () => {
    const m = memory(3, { confirmedAt: new Date("2026-03-01T00:00:00Z") });
    const full = renderFull(m);
    expect(full).toContain("confirmed 2026-03-01");
    expect(full).not.toMatch(/disputed/);
    expect(renderIndexLine(m, "", now)).toBe("#3 decision · Memory 3 · 10t");
  });

  it("says how long a state or gotcha has gone unconfirmed past its threshold", () => {
    const line = (kind: Memory["kind"], days: number) =>
      renderIndexLine(memory(1, { kind, confirmedAt: ago(days) }), " [0.80]", now);
    expect(line("state", 59)).toBe("#1 state · Memory 1 · 10t [0.80]");
    expect(line("state", 140)).toBe("#1 state · Memory 1 · 10t · unconfirmed 140d [0.80]");
    expect(line("gotcha", 170)).not.toContain("unconfirmed");
    expect(line("gotcha", 200)).toContain(" · unconfirmed 200d");
    // Other kinds age quietly, and so do memories that are no longer active.
    expect(line("decision", 1000)).not.toContain("unconfirmed");
    expect(
      renderIndexLine(memory(1, { kind: "state", status: "archived", confirmedAt: ago(400) }), "", now),
    ).not.toContain("unconfirmed");
  });
});

describe("nonEnglishLanguage", () => {
  it("ignores English prose, code and short text", () => {
    expect(
      nonEnglishLanguage(
        "Run the migrations before starting the server, otherwise the app crashes on boot because tables are missing.",
      ),
    ).toBeNull();
    expect(nonEnglishLanguage("`npm test` in src/app.ts")).toBeNull();
    expect(nonEnglishLanguage("короткий текст")).toBeNull();
  });

  it("flags confidently non-English prose", () => {
    expect(
      nonEnglishLanguage(
        "Перед запуском сервера потрібно виконати міграції бази даних, інакше застосунок впаде під час старту через відсутні таблиці.",
      ),
    ).toBe("ukr");
  });
});

describe("MemoryCipher", () => {
  const key = Buffer.alloc(32, 7);
  const cipher = new MemoryCipher(key);

  it("round-trips text and never repeats a ciphertext", () => {
    const a = cipher.encrypt("p1", "body", "Stripe webhooks need the raw body — ünïcode ✓");
    expect(a).not.toContain("Stripe");
    expect(cipher.decrypt("p1", "body", a)).toBe("Stripe webhooks need the raw body — ünïcode ✓");
    expect(cipher.encrypt("p1", "body", "same")).not.toBe(cipher.encrypt("p1", "body", "same"));
  });

  it("binds ciphertext to its project and field", () => {
    const a = cipher.encrypt("p1", "title", "secret");
    expect(() => cipher.decrypt("p2", "title", a)).toThrow(/wrong key or corrupted/);
    expect(() => cipher.decrypt("p1", "body", a)).toThrow(/wrong key or corrupted/);
  });

  it("rejects tampering and other keys", () => {
    const a = Buffer.from(cipher.encrypt("p1", "body", "secret"), "base64");
    a[14] = (a[14] ?? 0) ^ 1;
    expect(() => cipher.decrypt("p1", "body", a.toString("base64"))).toThrow();
    const other = new MemoryCipher(Buffer.alloc(32, 8));
    expect(other.keyId).not.toBe(cipher.keyId);
    expect(() => other.decrypt("p1", "body", cipher.encrypt("p1", "body", "x"))).toThrow();
  });

  it("rejects keys that aren't 32 bytes and ciphertext too short to hold an iv and tag", () => {
    expect(() => new MemoryCipher(Buffer.alloc(16))).toThrow(/32 bytes/);
    expect(() => cipher.decrypt("p1", "body", Buffer.alloc(27).toString("base64"))).toThrow(/too short/);
    expect(cipher.decrypt("p1", "body", cipher.encrypt("p1", "body", ""))).toBe("");
  });

  it("has a stable fingerprint that doesn't reveal the key", () => {
    expect(new MemoryCipher(Buffer.alloc(32, 7)).keyId).toBe(cipher.keyId);
    expect(cipher.keyId).toMatch(/^[0-9a-f]{16}$/);
    expect(cipher.keyId).not.toContain(key.toString("hex").slice(0, 8));
  });

  it("config accepts only 32-byte base64 keys", () => {
    expect(loadConfig({ AXON_ENCRYPTION_KEY: ` ${key.toString("base64")}\n` }).encryptionKey).toEqual(key);
    expect(loadConfig({ AXON_ENCRYPTION_KEY: "" }).encryptionKey).toBeUndefined();
    expect(() => loadConfig({ AXON_ENCRYPTION_KEY: "short" })).toThrow(/32 bytes/);
    expect(loadConfig({ AXON_ENCRYPTION_KEY: key.toString("base64") }).encryptionKey).toEqual(key);
    expect(loadConfig({}).encryptionKey).toBeUndefined();
    expect(loadConfig({ AXON_ENCRYPTION_KEY_NEW: key.toString("base64") }).newEncryptionKey).toEqual(key);
    expect(() => loadConfig({ AXON_ENCRYPTION_KEY_NEW: "short" })).toThrow(/AXON_ENCRYPTION_KEY_NEW must be 32 bytes/);
    expect(loadConfig({}).newEncryptionKey).toBeUndefined();
    expect(() => loadConfig({ AXON_ENCRYPTION_KEY: Buffer.alloc(16).toString("base64") })).toThrow(/32 bytes/);
  });
});

describe("errors", () => {
  it("classifies agent-facing failures by code and everything else as internal", () => {
    expect(classifyError(new AxonError("conflict", "taken"))).toEqual({ code: "conflict", message: "taken" });
    const zod = z.object({ n: z.number() }).safeParse({ n: "x" }).error;
    expect(classifyError(zod)).toEqual({ code: "invalid", message: expect.stringMatching(/^n: /) });
    expect(classifyError(new Error("connect ECONNREFUSED"))).toEqual({
      code: "internal",
      message: "connect ECONNREFUSED",
    });
    expect(classifyError("boom")).toEqual({ code: "internal", message: "boom" });
  });
});

describe("format", () => {
  it("pluralises and lists ids", () => {
    expect(plural(1, "link")).toBe("1 link");
    expect(plural(0, "link")).toBe("0 links");
    expect(plural(2, "memory", "memories")).toBe("2 memories");
    expect(seqList([3, 7])).toBe("#3, #7");
  });
});

describe("stored tags and paths", () => {
  const base = { project: "a", kind: "gotcha", title: "t", body: "b" };

  it("are deduplicated, and paths normalised, on every way in", () => {
    const raw = { tags: ["db", "DB", "api"], paths: ["./src/api/", "src/api", "src//"] };
    const want = { tags: ["db", "api"], paths: ["src/api", "src"] };
    expect(RememberInput.parse({ ...base, ...raw })).toMatchObject(want);
    expect(UpdateInput.parse({ project: "a", id: 1, ...raw })).toMatchObject(want);
    const doc = ImportDocument.parse({
      axon: { format: 1 },
      memories: [{ seq: 1, kind: "gotcha", title: "t", body: "b", ...raw }],
    });
    expect(doc.memories[0]).toMatchObject(want);
  });
});

describe("content codecs", () => {
  const content = { title: "T", body: "B", source: null };

  it("plaintext writes as-is and refuses to read ciphertext", () => {
    expect(PLAINTEXT.keyId).toBeNull();
    expect(PLAINTEXT.seal("p", content)).toEqual({ ...content, encrypted: false });
    expect(() => PLAINTEXT.open("p", "title", "x", true)).toThrow(/AXON_ENCRYPTION_KEY is not set/);
  });

  it("encrypting writes ciphertext and reads both modes", () => {
    const codec = codecFor(new MemoryCipher(Buffer.alloc(32, 9)));
    expect(codec).toBeInstanceOf(EncryptingCodec);
    const sealed = codec.seal("p", { ...content, source: "agent" });
    expect(sealed.encrypted).toBe(true);
    expect(sealed.title).not.toBe("T");
    expect(openContent(codec, "p", sealed, true)).toEqual({ title: "T", body: "B", source: "agent" });
    expect(openContent(codec, "p", content, false)).toEqual(content);
    expect(codecFor(null)).toBe(PLAINTEXT);
  });
});

describe("planUpdate", () => {
  const now = new Date("2026-10-31T12:00:00Z");
  const disputed = memory(1, { disputedAt: new Date("2026-10-01"), key: "deploy/current" });
  const plan = (m: Memory, input: Record<string, unknown>) =>
    planUpdate(m, UpdateInput.parse({ project: "a", id: 1, ...input }), now);

  it("confirms and clears a dispute when the text is edited, and re-embeds only then", () => {
    const p = plan(disputed, { body: "new body" });
    expect(p).toMatchObject({ confirmed: true, disputed: false, reembed: true });
    expect(p.patch).toMatchObject({ confirmedAt: now, disputedAt: null });
    expect(p.content).toEqual({ title: disputed.title, body: "new body", source: null });
    expect(p.lines).toContain("Editing confirmed #1 and cleared its dispute.");

    const unchanged = plan(disputed, { body: disputed.body });
    expect(unchanged.reembed).toBe(false);
    expect(unchanged.confirmed).toBe(true); // writing the same text still asserts it
  });

  it("lets an explicit dispute win over an edit, and leaves flags alone on other edits", () => {
    expect(plan(disputed, { body: "x", dispute: true })).toMatchObject({ confirmed: true, disputed: true });
    expect(plan(disputed, { body: "x", dispute: true }).patch.disputedAt).toEqual(now);
    const tagged = plan(disputed, { tags: ["a"] });
    expect(tagged).toMatchObject({ confirmed: false, disputed: true, content: undefined, reembed: false });
    expect(tagged.patch).toMatchObject({ confirmedAt: undefined, disputedAt: undefined });
    expect(plan(disputed, { status: "archived" }).patch.disputedAt).toBeUndefined();
  });

  it("claims a key when setting it or restoring a keyed memory, never when archiving", () => {
    expect(plan(memory(1), { key: "owner/billing" }).claim).toBe("owner/billing");
    expect(plan({ ...disputed, status: "archived" }, { status: "active" }).claim).toBe("deploy/current");
    expect(plan(disputed, { status: "archived", key: "x/y" }).claim).toBeNull();
    expect(plan(disputed, { tags: ["a"] }).claim).toBeNull();
    expect(plan({ ...disputed, status: "archived" }, { status: "active" }).keyConflict(7).message).toMatch(
      /can't be restored: its key deploy\/current is now held by #7/,
    );
  });

  it("refuses to revive, confirm or dispute a superseded memory, and contradictory flags", () => {
    const old = memory(1, { status: "superseded", supersededBy: 4 });
    expect(() => plan(old, { status: "active" })).toThrow(/superseded by #4; update that one/);
    expect(() => plan(old, { confirm: true })).toThrow(/confirm that one instead/);
    expect(() => plan(memory(1), { confirm: true, dispute: true })).toThrow(/contradict/);
  });

  it("reports only what the call did", () => {
    expect(plan(memory(1), { confirm: true }).lines).toEqual(["Confirmed #1."]);
    expect(plan(memory(1), { pinned: true }).lines).toEqual(["Updated #1."]);
    expect(plan(memory(1), { title: "New" }).lines[0]).toMatch(/^Updated #1 \(\d+t, re-embedded\)\.$/);
  });
});

describe("remember steps", () => {
  const n = (seq: number, similarity: number) => ({ seq, kind: "gotcha" as const, title: `M${seq}`, similarity });
  const near = [n(1, 0.95), n(2, 0.88), n(3, 0.8), n(4, 0.7), n(5, 0.6), n(6, 0.5)];
  const opts = { dedup: 0.85, linkSuggest: 0.55, target: undefined, linked: [] };

  it("sorts neighbours into duplicates and suggestions", () => {
    const { duplicates, suggestions } = neighbourhood(near, opts);
    expect(duplicates.map((d) => d.seq)).toEqual([1, 2]);
    expect(suggestions.map((d) => d.seq)).toEqual([3, 4, 5]);
  });

  it("never treats the replaced memory or already-linked ones as duplicates or suggestions", () => {
    const { duplicates, suggestions } = neighbourhood(near, { ...opts, target: 1, linked: [3] });
    expect(duplicates.map((d) => d.seq)).toEqual([2]);
    expect(suggestions.map((d) => d.seq)).toEqual([4, 5]);
  });

  it("caps suggestions at five", () => {
    const many = Array.from({ length: 9 }, (_, i) => n(i + 1, 0.7));
    expect(neighbourhood(many, opts).suggestions).toHaveLength(5);
  });

  it("explains a refusal with the duplicates and the ways out", () => {
    expect(refusalText([n(1, 0.951)])).toBe(
      "Not saved — near-duplicate of:\n#1 gotcha · M1 [0.95]\nUse update to amend it, supersedes=<id> to replace it, or force=true to keep both.",
    );
  });

  it("describes a save: replacement, links, overlaps, related and warnings", () => {
    const base = { seq: 7, tokens: 40, project: "a", linked: [], suggestions: [], overlapFloor: 0.75, warnings: [] };
    expect(savedText({ ...base, key: null, replacedHolder: undefined, superseded: undefined })).toBe(
      "Saved #7 (40t) in a.",
    );
    const keyed = savedText({ ...base, key: "deploy/current", replacedHolder: 3, superseded: 3 });
    expect(keyed).toBe(
      "Saved #7 (40t, key deploy/current) in a.\nReplaced #3 (key deploy/current); its links moved to #7.",
    );
    const full = savedText({
      ...base,
      key: null,
      replacedHolder: undefined,
      superseded: 2,
      linked: [4],
      suggestions: [n(5, 0.8), n(6, 0.6)],
      warnings: ["big"],
    });
    expect(full.split("\n")).toEqual([
      "Saved #7 (40t) in a.",
      "#2 marked superseded; its links moved to #7.",
      "Linked ↔ #4.",
      "Likely overlaps: #5 M5 [0.80] — if it's the same fact, update that one or supersede it instead.",
      "Possibly related — link if so: #6 M6 [0.60]",
      "⚠ big",
    ]);
  });
});

describe("edge cases", () => {
  it("link footers name at most five links and count the rest", () => {
    const links = Array.from({ length: 7 }, (_, i) => ({ seq: i + 1, title: `L${i + 1}`, strength: 1, note: null }));
    expect(renderLinkFooter(links, 7)).toBe("↔ #1 L1 · #2 L2 · #3 L3 · #4 L4 · #5 L5 (+2)");
    expect(renderLinkFooter(links.slice(0, 2), 2)).toBe("↔ #1 L1 · #2 L2");
    expect(renderLinkFooter([], 3)).toBe("");
  });

  it("ranking breaks exact ties by putting the newer memory first, so order is deterministic", () => {
    const now = new Date("2026-10-31T00:00:00Z");
    const twins = [memory(3, { updatedAt: now, confirmedAt: now }), memory(9, { updatedAt: now, confirmedAt: now })];
    expect(rankForBriefing(twins, now).map((m) => m.seq)).toEqual([9, 3]);
    expect(rankForBriefing([...twins].reverse(), now).map((m) => m.seq)).toEqual([9, 3]);
  });

  it("refuses an embedding dimension the vector index can't hold, before touching the database", async () => {
    const untouched = new Proxy(
      {},
      {
        get: () => {
          throw new Error("database used");
        },
      },
    ) as unknown as Sql;
    for (const dim of [0, -1, 1.5, 4001, Number.NaN]) {
      await expect(setEmbeddingModel(untouched, "m", dim)).rejects.toThrow(/invalid embedding dimension/);
    }
  });
});
