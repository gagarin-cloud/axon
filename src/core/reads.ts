/** Reads other than the briefing: project list, search, get by id or key, and link walks. */

import type { LinkRef, Memory, ProjectSummary, WalkStep } from "../store/types.js";
import type { ServiceContext } from "./context.js";
import { day } from "./format.js";
import { budgeted, type PackItem, pack } from "./pack.js";
import { rankForBriefing } from "./rank.js";
import { FOOTER_LINKS, formatSimilarity, renderFull, renderIndexLine } from "./render.js";
import type { GetInput, RelatedInput, SearchInput } from "./schemas.js";
import { countTokens } from "./tokens.js";
import { asHits, type Hit, type MemoryView, type Shown, shownIn, view } from "./views.js";

export interface ProjectsResult {
  projects: ProjectSummary[];
  text: string;
}

export interface SearchResult {
  project: string;
  query: string | null;
  hits: (Shown & { similarity: number | null; keyword: boolean })[];
  /** 1-hop neighbours of the top hits (spreading activation), index lines only. */
  linked: (Shown & { from: number })[];
  omitted: number[];
  text: string;
  tokens: number;
}

export interface GetResult {
  memories: (Memory & { links: LinkRef[] })[];
  missing: number[];
  /** Requested keys no active memory holds. */
  missingKeys: string[];
  text: string;
}

export interface RelatedResult {
  start: MemoryView;
  steps: (Shown & Omit<WalkStep, "seq">)[];
  omitted: number[];
  text: string;
  tokens: number;
}

/** Top search hits whose neighbours are surfaced as "linked". */
const SPREAD_FROM = 3;

export async function listProjects(ctx: ServiceContext): Promise<ProjectsResult> {
  const projects = await ctx.store.listProjects();
  const text = projects.length
    ? projects
        .map(
          (p) =>
            `${p.slug} · ${p.active} memories${p.total > p.active ? ` (+${p.total - p.active} retired)` : ""} · ${p.links} links${p.updatedAt ? ` · updated ${day(p.updatedAt)}` : ""}`,
        )
        .join("\n")
    : "No projects yet. `remember` creates one on first write.";
  return { projects, text };
}

export async function search(ctx: ServiceContext, input: SearchInput): Promise<SearchResult> {
  const project = await ctx.store.getProject(input.project);
  const empty = (text: string): SearchResult => ({
    project: input.project,
    query: input.query ?? null,
    hits: [],
    linked: [],
    omitted: [],
    text,
    tokens: countTokens(text),
  });
  if (!project) return empty(`No memories for ${input.project} yet.`);
  const filters = { kinds: input.kinds, tags: input.tags, paths: input.paths };

  let hits: Hit[];
  if (input.query) {
    const embedding = await ctx.embedder.embedQuery(input.query);
    const found = await ctx.store.search(project.id, {
      embedding,
      text: input.query,
      filters,
      limit: input.k,
      minSimilarity: ctx.config.searchMinSimilarity,
    });
    hits = await ctx.loadHits(project.id, found);
  } else {
    hits = asHits(rankForBriefing(await ctx.store.browse(project.id, filters, input.k)));
  }
  if (hits.length === 0) return empty(`No matches in ${input.project}${input.query ? ` for "${input.query}"` : ""}.`);

  const hitSeqs = hits.map((h) => h.memory.seq);
  const isHit = new Set(hitSeqs);
  const links = await ctx.store.neighbours(project.id, hitSeqs, FOOTER_LINKS);

  // Spreading activation: strongest neighbours of the top hits that weren't hits themselves.
  const spread = new Map<number, number>(); // seq → from
  for (const seq of hitSeqs.slice(0, SPREAD_FROM)) {
    for (const l of links.get(seq) ?? []) {
      if (!isHit.has(l.seq) && !spread.has(l.seq)) spread.set(l.seq, seq);
    }
  }
  const linkedMemories = await ctx.store.getMemories(project.id, [...spread.keys()]);

  const header = input.query
    ? `${hits.length} hits for "${input.query}" in ${input.project}`
    : `${hits.length} memories in ${input.project}`;
  const items: PackItem[] = [
    ...hits.map((h) => ({
      key: h.memory.seq,
      full: renderFull(h.memory, links.get(h.memory.seq), formatSimilarity(h.similarity, h.keyword)),
      index: renderIndexLine(h.memory, formatSimilarity(h.similarity, h.keyword)),
    })),
    ...linkedMemories.map((m) => ({
      key: m.seq,
      full: null,
      index: renderIndexLine(m, ` (↔ #${spread.get(m.seq)})`),
      group: "Linked:",
    })),
  ];
  const packed = pack({ header, items, budget: input.budget_tokens, fullShare: 0.85 });
  await ctx.recordRead(project.id, packed.full);

  return {
    project: input.project,
    query: input.query ?? null,
    hits: hits.flatMap((h) => {
      const s = shownIn(packed, h.memory.seq, h.memory, links);
      return s ? [{ ...s, similarity: h.similarity, keyword: h.keyword }] : [];
    }),
    linked: linkedMemories.flatMap((m) => {
      const s = shownIn(packed, m.seq, m, links);
      return s ? [{ ...s, from: spread.get(m.seq) ?? 0 }] : [];
    }),
    ...budgeted(packed),
  };
}

export async function get(ctx: ServiceContext, input: GetInput): Promise<GetResult> {
  const projectId = await ctx.requireProject(input.project);
  const keys = [...new Set(input.keys)];
  const holders = await ctx.store.keyHolders(projectId, keys);
  const missingKeys = keys.filter((k) => !holders.has(k));
  const ids = [...new Set([...(input.ids ?? []), ...keys.flatMap((k) => holders.get(k) ?? [])])];
  const memories = await ctx.store.getMemories(projectId, ids);
  const found = memories.map((m) => m.seq);
  const foundSet = new Set(found);
  const missing = ids.filter((id) => !foundSet.has(id));

  const links = await ctx.store.neighbours(projectId, found, FOOTER_LINKS);
  // Reading linked memories together strengthens the links between them.
  await ctx.recordRead(projectId, found, await ctx.store.linksAmong(projectId, found));

  const parts = memories.map((m) => renderFull(m, links.get(m.seq)));
  const notFound = [...missing.map((s) => `#${s}`), ...missingKeys.map((k) => `key ${k}`)];
  if (notFound.length) parts.push(`Not found: ${notFound.join(", ")}`);
  return {
    memories: memories.map((m) => ({ ...m, links: links.get(m.seq) ?? [] })),
    missing,
    missingKeys,
    text: parts.join("\n\n"),
  };
}

export async function related(ctx: ServiceContext, input: RelatedInput): Promise<RelatedResult> {
  const projectId = await ctx.requireProject(input.project);
  const start = await ctx.requireMemory(projectId, input.id, input.project);

  const steps = await ctx.store.walk(projectId, input.id, input.hops);
  if (steps.length === 0) {
    const text = `#${start.seq} ${start.title} has no links yet. Connect related memories with \`link\`.`;
    return {
      start: view(start, false, new Map()).memory,
      steps: [],
      omitted: [],
      text,
      tokens: countTokens(text),
    };
  }

  const memories = await ctx.memoryMap(
    projectId,
    steps.map((s) => s.seq),
  );
  const links = await ctx.store.neighbours(
    projectId,
    steps.slice(0, 30).map((s) => s.seq),
    FOOTER_LINKS,
  );
  const describe = (s: WalkStep) =>
    ` · hop ${s.hop}${s.hop > 1 ? ` via #${s.via}` : ""}${s.note ? ` — ${s.note}` : ""}`;

  const header = `Linked from #${start.seq} ${start.title} (${steps.length} within ${input.hops} hop${input.hops > 1 ? "s" : ""})`;
  const items: PackItem[] = steps.flatMap((s) => {
    const m = memories.get(s.seq);
    if (!m) return [];
    return [{ key: s.seq, full: renderFull(m, links.get(s.seq), describe(s)), index: renderIndexLine(m, describe(s)) }];
  });
  const packed = pack({ header, items, budget: input.budget_tokens, fullShare: 0.8 });

  // Hebbian: the paths the agent actually followed (to memories it read in full) get stronger.
  const followed = steps
    .filter((s) => packed.mode(s.seq) === "full")
    .flatMap((s) => s.path.slice(1).map((seq, i) => [s.path[i], seq] as [number, number]));
  await ctx.recordRead(projectId, packed.full, followed);

  return {
    start: view(start, false, new Map()).memory,
    steps: steps.flatMap(({ seq, ...step }) => {
      const m = memories.get(seq);
      const s = m && shownIn(packed, seq, m, links);
      return s ? [{ ...s, ...step }] : [];
    }),
    ...budgeted(packed),
  };
}
