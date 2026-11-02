import { countTokens } from "./tokens.js";

/**
 * Identifies an item within one pack. Memories are usually keyed by seq; a caller that lists other
 * lines too (a briefing's Recent, a review's findings) picks keys that say what they are.
 */
export type PackKey = number | string;

export interface PackItem<K extends PackKey = number> {
  key: K;
  /** Full rendering, or null for items that may only appear as an index line. */
  full: string | null;
  index: string;
  /**
   * Share of the budget that full renderings, up to and including this one, may fill; overrides
   * `fullShare` (e.g. 1 for pinned memories, which may use the whole budget).
   */
  share?: number;
  /** Heading of the index group this item's line belongs to. */
  group?: string;
  /**
   * Key of an item this line repeats under another heading (e.g. "Recent"). It is dropped when that
   * item is shown in full, and that item isn't listed a second time if this line already is.
   */
  echoes?: K;
}

export interface Packed<K extends PackKey = number> {
  text: string;
  tokens: number;
  full: K[];
  index: K[];
  omitted: K[];
  /** How the item with `key` was shown: in full, as an index line, or not at all. */
  mode(key: K): "full" | "index" | null;
}

/** The part of a packed read every result carries as is. */
export function budgeted<K extends PackKey>(packed: Packed<K>): { omitted: K[]; text: string; tokens: number } {
  return { omitted: packed.omitted, text: packed.text, tokens: packed.tokens };
}

const DEFAULT_GROUP = "More:";

/**
 * Fits items into a token budget: full renderings in rank order while they fit within `fullShare`
 * of the budget (leaving room for breadth), one-line index entries for the rest, then any budget
 * still left upgrades index entries to full. Whatever doesn't fit is counted in an "omitted" note.
 * The measured size of the returned text never exceeds `budget`.
 */
export function pack<K extends PackKey = number>(opts: {
  header: string;
  items: PackItem<K>[];
  budget: number;
  fullShare?: number;
  footer?: string;
}): Packed<K> {
  const { header, items, budget, footer = "" } = opts;
  const fullLimit = Math.floor(budget * (opts.fullShare ?? 0.75));
  const cost = (s: string) => countTokens(s) + 2; // + separator
  const echoOf = echoes(items);

  let used = cost(header) + (footer ? cost(footer) : 0) + 12; // reserve for the omitted note
  const full = new Set<K>();
  for (const item of items) {
    if (item.full === null) continue;
    const c = cost(item.full);
    if (used + c <= (item.share === undefined ? fullLimit : Math.floor(budget * item.share))) {
      full.add(item.key);
      used += c;
    }
  }
  const listed = new Set<K>();
  for (const item of items) {
    if (full.has(item.key) || (item.echoes !== undefined && full.has(item.echoes))) continue;
    const echo = echoOf.get(item.key);
    if (echo !== undefined && listed.has(echo.key)) continue;
    const c = cost(item.index);
    if (used + c <= budget) {
      listed.add(item.key);
      used += c;
    }
  }
  // Budget left once everything that fits is listed: upgrade index lines to full, best-ranked first.
  // An upgrade also takes the place of the item's echo, if one is listed.
  for (const item of items) {
    if (item.full === null || full.has(item.key)) continue;
    const lines = [item, echoOf.get(item.key)].filter((i): i is PackItem<K> => i !== undefined && listed.has(i.key));
    if (lines.length === 0) continue;
    const extra = cost(item.full) - lines.reduce((sum, i) => sum + cost(i.index), 0);
    if (used + extra <= budget) {
      for (const i of lines) listed.delete(i.key);
      full.add(item.key);
      used += extra;
    }
  }

  // Token counts of parts don't add up exactly to the joined text; trim until the real count fits.
  const fullKeys = items.filter((i) => full.has(i.key)).map((i) => i.key);
  const index = items.filter((i) => listed.has(i.key)).map((i) => i.key);
  const parts = { header, footer, byKey: new Map(items.map((i) => [i.key, i])), echoOf };
  let render = assemble(parts, items, fullKeys, index);
  while (render.tokens > budget && (index.length || fullKeys.length)) {
    if (index.length) index.pop();
    else fullKeys.pop();
    render = assemble(parts, items, fullKeys, index);
  }
  const isFull = new Set(fullKeys);
  const isListed = new Set(index);
  const mode = (key: K) => (isFull.has(key) ? "full" : isListed.has(key) ? "index" : null);
  return { ...render, full: fullKeys, index, mode };
}

/** Echo line by the key of the item it repeats. */
function echoes<K extends PackKey>(items: PackItem<K>[]): Map<K, PackItem<K>> {
  return new Map(items.flatMap((i) => (i.echoes === undefined ? [] : [[i.echoes, i] as const])));
}

/** The text for one choice of full and index items, with its omitted keys and measured size. */
function assemble<K extends PackKey>(
  {
    header,
    footer,
    byKey,
    echoOf,
  }: { header: string; footer: string; byKey: Map<K, PackItem<K>>; echoOf: Map<K, PackItem<K>> },
  items: PackItem<K>[],
  fullKeys: K[],
  indexKeys: K[],
) {
  const shown = new Set([...fullKeys, ...indexKeys]);
  const isShown = (k: K | undefined) => k !== undefined && shown.has(k);
  // An echo is never counted itself: the item it repeats is, unless one of the two lines is shown.
  const omitted = items
    .filter((i) => i.echoes === undefined && !isShown(i.key) && !isShown(echoOf.get(i.key)?.key))
    .map((i) => i.key);

  const parts = [header];
  for (const k of fullKeys) parts.push(byKey.get(k)?.full ?? "");

  const groups = new Map<string, string[]>();
  for (const k of indexKeys) {
    const item = byKey.get(k);
    if (!item) continue;
    const g = item.group ?? DEFAULT_GROUP;
    groups.set(g, [...(groups.get(g) ?? []), item.index]);
  }
  for (const [heading, lines] of groups) parts.push([heading, ...lines].join("\n"));

  if (omitted.length) parts.push(`(+${omitted.length} more not shown — narrow with search or raise budget_tokens)`);
  if (footer) parts.push(footer);
  const text = parts.filter(Boolean).join("\n\n");
  return { text, tokens: countTokens(text), omitted };
}
