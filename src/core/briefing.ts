/** `briefing`: the cold-start primer, packed to a budget and tilted towards the task at hand. */

import type { Memory, ProjectStats } from "../store/types.js";
import type { ServiceContext } from "./context.js";
import { DAY_MS, day, plural } from "./format.js";
import { type PackItem, pack } from "./pack.js";
import { rankForBriefing } from "./rank.js";
import {
  type Change,
  FOOTER_LINKS,
  formatSimilarity,
  renderChangeLine,
  renderFull,
  renderIndexLine,
} from "./render.js";
import type { BriefingInput } from "./schemas.js";
import { countTokens } from "./tokens.js";
import { asHits, type Hit, type MemoryView, type Shown, shown, view } from "./views.js";

export interface BriefingResult {
  project: string;
  found: boolean;
  focus: string | null;
  stats: ProjectStats | null;
  shown: Shown[];
  /** Changes of the last few days listed under "Recent"; memories shown in full aren't repeated there. */
  recent: { memory: MemoryView; change: Change }[];
  omitted: number[];
  text: string;
  tokens: number;
}

/** Candidates considered for a briefing; ranking happens in memory. */
const BRIEFING_POOL = 300;
/** Focus (or path) matches a briefing puts ahead of its cold-start ranking. */
const FOCUS_HITS = 10;
const FOCUS_GROUP = "Relevant to focus:";
/** A briefing lists what changed this many days back, at most RECENT_LIMIT memories of it. */
const RECENT_DAYS = 7;
const RECENT_LIMIT = 20;
const RECENT_GROUP = `Recent (${RECENT_DAYS}d):`;
/**
 * How much of a briefing's budget full renderings may fill, each a cap on the running total in item
 * order. Without matches, pinned memories may fill all of it and the cold-start ranking up to 70%.
 * With focus or path matches, pinned memories stop at 50% and the matches may go on to 80% before
 * the ranking fills in up to 70%: the matches always get at least 30% of the budget in full, however
 * many pinned or high-importance memories the project holds, and 20% stays for index lines.
 */
const BRIEFING_SHARE = 0.7;
const PINNED_SHARE_WITH_FOCUS = 0.5;
const FOCUS_SHARE = 0.8;
/** Disputed ids named in the briefing footer; more are summarised with "…". */
const DISPUTED_LISTED = 5;

export async function briefing(ctx: ServiceContext, input: BriefingInput): Promise<BriefingResult> {
  const focus = input.focus || null;
  const project = await ctx.store.getProject(input.project);
  const stats = project ? await ctx.store.stats(project.id) : null;
  const total = stats ? Object.values(stats.kinds).reduce((a, b) => a + b, 0) : 0;
  if (!project || !stats || total === 0) {
    const text = `No memories for ${input.project} yet. As you learn the project, \`remember\` its overview, architecture, conventions, decisions and gotchas.`;
    return {
      project: input.project,
      found: false,
      focus,
      stats,
      shown: [],
      recent: [],
      omitted: [],
      text,
      tokens: countTokens(text),
    };
  }

  const ranked = rankForBriefing(await ctx.store.browse(project.id, {}, BRIEFING_POOL));
  const matches = await focusMatches(ctx, project.id, focus, input.paths);
  const matched = new Map(matches.map((h) => [h.memory.seq, h]));
  // Pinned memories first, as always, then what matches the task, then the cold-start ranking.
  const pinned = ranked.filter((m) => m.pinned);
  const pinnedSeqs = new Set(pinned.map((m) => m.seq));
  const head = [...pinned, ...matches.map((h) => h.memory).filter((m) => !pinnedSeqs.has(m.seq))];
  const inHead = new Set(head.map((m) => m.seq));
  const tail = ranked.filter((m) => !inHead.has(m.seq));
  const body = [...head, ...tail];
  const inBody = new Set(body.map((m) => m.seq));

  const since = new Date(Date.now() - RECENT_DAYS * DAY_MS);
  const recent = (await ctx.store.changedSince(project.id, since, RECENT_LIMIT)).map((m) => ({
    m,
    change: changeOf(m, since),
  }));

  const links = await ctx.store.neighbours(
    project.id,
    body.slice(0, 60).map((m) => m.seq),
    FOOTER_LINKS,
  );

  const kinds = Object.entries(stats.kinds)
    .map(([k, n]) => `${k} ${n}`)
    .join(" · ");
  const lastWrite = stats.lastWrite ? ` · last write ${day(stats.lastWrite)}` : "";
  const header = `# ${input.project} — ${total} memories, ${stats.links} links${lastWrite}\n${kinds}`;
  const tags = stats.tags.slice(0, 20).map((t) => `${t.tag}(${t.count})`);
  // Counted over the whole pool, not just what fits: disputed memories rank last, so a tight budget
  // would otherwise hide exactly the ones that need fixing. Ids make them reachable with `get`.
  const disputed = ranked.filter((m) => m.disputedAt).map((m) => `#${m.seq}`);
  const footer = [
    tags.length ? `tags: ${tags.join(" ")}` : "",
    disputed.length
      ? `⚠ ${plural(disputed.length, "disputed memory", "disputed memories")} (${disputed.slice(0, DISPUTED_LISTED).join(", ")}${disputed.length > DISPUTED_LISTED ? ", …" : ""}) — confirm, fix or archive them`
      : "",
    "Next: search · get ids · related id (follow ↔ links) · remember what you learn · update confirm/dispute what you checked",
  ]
    .filter(Boolean)
    .join("\n");

  const focused = matches.some((h) => !h.memory.pinned);
  const item = (m: Memory): PackItem<BriefingKey> => {
    const hit = matched.get(m.seq);
    const suffix = hit ? formatSimilarity(hit.similarity, hit.keyword) : "";
    return {
      key: m.seq,
      full: renderFull(m, links.get(m.seq), suffix),
      index: renderIndexLine(m, suffix),
      share: m.pinned ? (focused ? PINNED_SHARE_WITH_FOCUS : 1) : hit ? FOCUS_SHARE : undefined,
      group: hit ? FOCUS_GROUP : undefined,
    };
  };
  // Recent lines have keys of their own. They are listed ahead of the cold-start ranking's index lines,
  // so older memories can't crowd them out, and stand in for a memory's own line under "More:"
  // (pinned and matching memories, listed earlier, keep theirs).
  const changes: PackItem<BriefingKey>[] = recent.map(({ m, change }) => ({
    key: recentKey(m.seq),
    full: null,
    index: renderChangeLine(m, change),
    group: RECENT_GROUP,
    echoes: inBody.has(m.seq) ? m.seq : undefined,
  }));
  const items = [...head.map(item), ...changes, ...tail.map(item)];
  const packed = pack({ header, items, budget: input.budget_tokens, footer, fullShare: BRIEFING_SHARE });

  // A memory listed only through its Recent line still counts as shown, as an index line.
  const indexed = body.filter(
    (m) => packed.mode(m.seq) === "index" || (packed.mode(m.seq) === null && packed.mode(recentKey(m.seq)) !== null),
  );
  return {
    project: input.project,
    found: true,
    focus,
    stats,
    shown: shown(
      body,
      packed.full.filter(isSeq),
      indexed.map((m) => m.seq),
      links,
    ),
    recent: recent
      .filter(({ m }) => packed.mode(recentKey(m.seq)) !== null)
      .map(({ m, change }) => ({ memory: view(m, false, links).memory, change })),
    omitted: [...new Set(packed.omitted.map(seqOf))],
    text: packed.text,
    tokens: packed.tokens,
  };
}

/** What a briefing puts first for the task at hand: search hits for `focus`, else memories on `paths`. */
async function focusMatches(
  ctx: ServiceContext,
  projectId: string,
  focus: string | null,
  paths?: string[],
): Promise<Hit[]> {
  if (focus) {
    const found = await ctx.store.search(projectId, {
      embedding: await ctx.embedder.embedQuery(focus),
      text: focus,
      filters: { paths },
      limit: FOCUS_HITS,
      minSimilarity: ctx.config.searchMinSimilarity,
    });
    return ctx.loadHits(projectId, found);
  }
  if (!paths?.length) return [];
  return asHits(rankForBriefing(await ctx.store.browse(projectId, { paths }, FOCUS_HITS)));
}

/** A briefing packs memories (by seq) and Recent lines, keyed apart so one memory can have both. */
type BriefingKey = number | `recent:${number}`;
const recentKey = (seq: number): BriefingKey => `recent:${seq}`;
const isSeq = (k: BriefingKey): k is number => typeof k === "number";
const seqOf = (k: BriefingKey): number => (isSeq(k) ? k : Number(k.slice("recent:".length)));

/** A status change wins: an archived or superseded memory is listed as such, however new it is. */
function changeOf(m: Memory, since: Date): Change {
  if (m.status === "superseded" || m.status === "archived") return m.status;
  return m.createdAt >= since ? "new" : "updated";
}
