import { describe, expect, it } from "vitest";
import { type PackItem, type PackKey, pack } from "../src/core/pack.js";
import { countTokens } from "../src/core/tokens.js";

/** Small seeded PRNG (mulberry32), so a failing case can be replayed from its seed. */
function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1));
  return { next, int, pick: <T>(xs: T[]) => xs[int(0, xs.length - 1)] as T };
}

const WORDS = ["cache", "queue", "deploy", "stripe", "webhook", "schema", "tenant", "index", "retry", "token"];

function scenario(seed: number) {
  const r = rng(seed);
  const words = (n: number) => Array.from({ length: n }, () => r.pick(WORDS)).join(" ");
  const n = r.int(0, 30);
  const items: PackItem<PackKey>[] = [];
  for (let k = 1; k <= n; k++) {
    items.push({
      key: k,
      full: r.next() < 0.15 ? null : `## #${k} ${words(r.int(1, 250))}`,
      index: `#${k} · ${words(r.int(1, 8))}`,
      share: r.next() < 0.2 ? r.pick([0.3, 0.5, 0.8, 1]) : undefined,
      group: r.pick([undefined, "Relevant:", "Linked:"]),
    });
  }
  // Echo lines (a briefing's Recent): at most one per item, placed anywhere.
  const echoed = new Set<number>();
  for (let i = r.int(0, Math.min(8, n)); i > 0; i--) {
    const target = r.int(1, n);
    if (echoed.has(target)) continue;
    echoed.add(target);
    const echo = {
      key: `e${target}`,
      full: null,
      index: `#${target} · ${words(2)} · new`,
      group: "Recent:",
      echoes: target,
    };
    items.splice(r.int(0, items.length), 0, echo);
  }
  return {
    header: `# header ${words(r.int(0, 6))}`,
    footer: r.next() < 0.5 ? `Next: ${words(r.int(1, 6))}` : undefined,
    items,
    budget: r.int(60, 3000),
    fullShare: r.next() < 0.5 ? undefined : r.pick([0.5, 0.7, 0.85]),
  };
}

describe("pack, on random inputs", () => {
  const SEEDS = Array.from({ length: 400 }, (_, i) => i + 1);

  it(`keeps its contract on ${SEEDS.length} seeded cases`, () => {
    for (const seed of SEEDS) {
      try {
        check(seed);
      } catch (err) {
        throw new Error(`seed ${seed}: ${(err as Error).message}`);
      }
    }
  });
});

/** Every guarantee pack() makes, on one generated case. */
function check(seed: number) {
  const s = scenario(seed);
  const p = pack(s);
  const byKey = new Map(s.items.map((i) => [i.key, i]));
  const full = new Set(p.full);
  const listed = new Set(p.index);
  const omitted = new Set(p.omitted);
  const echoOf = new Map(s.items.flatMap((i) => (i.echoes === undefined ? [] : [[i.echoes, i.key] as const])));

  // Never over budget, and the reported size is the real one.
  expect(p.tokens).toBe(countTokens(p.text));
  expect(p.tokens).toBeLessThanOrEqual(s.budget);

  // Only items with a full rendering are full; nothing is both full and listed; no duplicates.
  for (const k of p.full) expect(byKey.get(k)?.full).not.toBeNull();
  for (const k of p.index) expect(full.has(k)).toBe(false);
  expect(full.size).toBe(p.full.length);
  expect(listed.size).toBe(p.index.length);

  // Each item is accounted for exactly once: full, listed (itself or through its echo), or omitted.
  for (const item of s.items) {
    if (item.echoes !== undefined) {
      expect(omitted.has(item.key)).toBe(false); // an echo is never counted itself
      // An echo is dropped when its item is shown in full. An item that comes after its listed echo
      // isn't listed again; one that comes before keeps its own line too (a briefing's pinned and
      // matching memories, listed ahead of Recent).
      if (listed.has(item.key)) {
        expect(full.has(item.echoes)).toBe(false);
        const echoFirst = s.items.indexOf(item) < s.items.findIndex((i) => i.key === item.echoes);
        if (echoFirst) expect(listed.has(item.echoes)).toBe(false);
      }
      continue;
    }
    const echo = echoOf.get(item.key);
    const states = [
      full.has(item.key),
      listed.has(item.key) || (echo !== undefined && listed.has(echo)),
      omitted.has(item.key),
    ];
    expect(states.filter(Boolean)).toHaveLength(1);
  }

  // mode() agrees with the lists, and rank order is kept within each.
  for (const item of s.items) {
    expect(p.mode(item.key)).toBe(full.has(item.key) ? "full" : listed.has(item.key) ? "index" : null);
  }
  const order = (keys: PackKey[]) => keys.map((k) => s.items.findIndex((i) => i.key === k));
  expect(order(p.full)).toEqual([...order(p.full)].sort((a, b) => a - b));
  expect(order(p.index)).toEqual([...order(p.index)].sort((a, b) => a - b));

  // Everything reported as shown is in the text; the omitted note matches the count.
  for (const k of p.full) expect(p.text).toContain(byKey.get(k)?.full);
  for (const k of p.index) expect(p.text).toContain(byKey.get(k)?.index);
  if (p.omitted.length) expect(p.text).toContain(`(+${p.omitted.length} more not shown`);
  else expect(p.text).not.toContain("more not shown");
}
