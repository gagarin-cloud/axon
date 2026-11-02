/** `review`: the housekeeping report. */

import type { DuplicatePair, Memory, ReviewSection, ReviewSectionId } from "../store/types.js";
import { REVIEW_SECTIONS } from "../store/types.js";
import { LARGE_MEMORY_TOKENS } from "./content.js";
import type { ServiceContext } from "./context.js";
import { day, daysSince, num } from "./format.js";
import { type PackItem, pack } from "./pack.js";
import { renderIndexLine } from "./render.js";
import type { ReviewInput } from "./schemas.js";
import { countTokens } from "./tokens.js";

export interface ReviewResult {
  project: string;
  /** Active memories against `AXON_MAX_MEMORIES` (null when unlimited). */
  cap: { active: number; max: number | null };
  sections: { duplicates: DuplicatePair[] } & Record<ReviewSectionId, ReviewSection>;
  text: string;
  tokens: number;
}

/**
 * `review` checks the nearest neighbours of this many active memories (oldest first), so its cost
 * stays bounded — at most 500 × 3 index lookups — however large a project grows.
 */
const REVIEW_DUPLICATE_SCAN = 500;
const REVIEW_DUPLICATE_NEIGHBOURS = 3;
/** `state` memories untouched for this long are listed as stale: state is the kind that goes out of date. */
const STALE_STATE_DAYS = 30;
/** Memories neither written nor read for this long are listed as unread. */
const UNREAD_DAYS = 90;
/** Rows fetched per review section — more than any budgeted report shows. */
const REVIEW_SECTION_LIMIT = 100;
/** Percent of the memory cap at which `review` flags it, and at which `remember` starts warning. */
const CAP_REVIEW_PERCENT = 80;

/** How `review` presents each per-memory section: its heading, its count's label, and why a memory is listed. */
const SECTION_VIEWS: Record<
  ReviewSectionId,
  { heading: string; label: string; reason: (m: Memory, now: Date) => string }
> = {
  orphans: { heading: "Orphans:", label: "orphans", reason: (m) => ` — no links since ${day(m.createdAt)}` },
  oversized: { heading: "Oversized:", label: "oversized", reason: () => ` — over ${LARGE_MEMORY_TOKENS}t` },
  stale: {
    heading: "Stale state:",
    label: "stale state",
    reason: (m, now) => ` — updated ${daysAgo(m.updatedAt, now)}`,
  },
  unread: {
    heading: "Unread:",
    label: "unread",
    reason: (m, now) => (m.lastAccessedAt ? ` — last read ${daysAgo(m.lastAccessedAt, now)}` : " — never read"),
  },
  // The index line already carries the ⚠ disputed mark; the reason says how long it has waited.
  disputed: {
    heading: "Disputed:",
    label: "disputed",
    reason: (m, now) => (m.disputedAt ? ` — since ${daysAgo(m.disputedAt, now)}` : ""),
  },
};

const daysAgo = (d: Date, now: Date) => `${Math.floor(daysSince(d, now))}d ago`;

/**
 * What needs tending in a project: likely duplicates, orphans, oversized bodies, stale state, memories
 * nobody reads, and how close it is to the memory cap. Read-only, and packed to the budget like any read.
 */
export async function review(ctx: ServiceContext, input: ReviewInput): Promise<ReviewResult> {
  const projectId = await ctx.requireProject(input.project);
  const f = await ctx.store.review(projectId, {
    duplicateSimilarity: ctx.overlapFloor,
    duplicateScan: REVIEW_DUPLICATE_SCAN,
    duplicateNeighbours: REVIEW_DUPLICATE_NEIGHBOURS,
    largeTokens: LARGE_MEMORY_TOKENS,
    staleStateDays: STALE_STATE_DAYS,
    unreadDays: UNREAD_DAYS,
    limit: REVIEW_SECTION_LIMIT,
  });
  const max = ctx.config.maxMemories ?? null;
  const sections = { duplicates: f.duplicates, ...f.sections };
  const result = (text: string): ReviewResult => ({
    project: input.project,
    cap: { active: f.active, max },
    sections,
    text,
    tokens: countTokens(text),
  });

  const capLine =
    max === null
      ? ""
      : `Cap: ${num(f.active)}/${num(max)} (${Math.floor((f.active * 100) / max)}%)${f.active * 100 >= max * CAP_REVIEW_PERCENT ? " ⚠ near cap — archive or supersede what is stale" : ""}`;
  const totals: [number, string][] = [
    [f.duplicates.length, "likely duplicates"],
    ...REVIEW_SECTIONS.map((id): [number, string] => [f.sections[id].total, SECTION_VIEWS[id].label]),
  ];
  const found = totals.filter(([n]) => n > 0);
  const summary = `${num(f.active)} memories, ${num(f.links)} links`;
  if (found.length === 0) {
    return result([`Nothing to tidy in ${input.project}: ${summary}.`, capLine].filter(Boolean).join("\n"));
  }

  const seqs = new Set([
    ...f.duplicates.flatMap((d) => [d.a, d.b]),
    ...REVIEW_SECTIONS.flatMap((id) => f.sections[id].seqs),
  ]);
  const bySeq = await ctx.memoryMap(projectId, [...seqs]);
  const now = new Date();
  // A memory can be in several sections (an old orphan is usually unread too), so a line is keyed by
  // its section and the memory (or pair) it names.
  const items: PackItem<string>[] = [];
  const add = (group: string, key: string, index: string) =>
    items.push({ key: `${group}${key}`, full: null, index, group });
  for (const d of f.duplicates) {
    const a = bySeq.get(d.a);
    const b = bySeq.get(d.b);
    if (a && b) {
      add(
        "Likely duplicates:",
        `#${a.seq}-#${b.seq}`,
        `#${a.seq} ↔ #${b.seq} [${d.similarity.toFixed(2)}] ${a.title} · ${b.title}${d.linked ? " (linked)" : ""}`,
      );
    }
  }
  for (const id of REVIEW_SECTIONS) {
    const { heading, reason } = SECTION_VIEWS[id];
    for (const seq of f.sections[id].seqs) {
      const m = bySeq.get(seq);
      if (m) add(heading, `#${seq}`, renderIndexLine(m, reason(m, now)));
    }
  }

  const header = [
    `# ${input.project} review — ${summary}`,
    capLine,
    found.map(([n, what]) => `${num(n)} ${what}`).join(" · "),
  ]
    .filter(Boolean)
    .join("\n");
  const footer =
    "Next: supersede duplicates (remember supersedes=id) · link orphans · split oversized · confirm, fix or archive stale and disputed";
  return result(pack({ header, items, budget: input.budget_tokens, footer }).text);
}
