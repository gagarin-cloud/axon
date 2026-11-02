/** `remember`: saving one memory, as a sequence of named steps under the project lock. */

import type { PgStore } from "../store/pg.js";
import type { Neighbour } from "../store/types.js";
import { memoryWarnings } from "./content.js";
import type { ServiceContext } from "./context.js";
import { AxonError } from "./errors.js";
import { num, seqList } from "./format.js";
import type { RememberInput } from "./schemas.js";
import { assertExist, linkChecked } from "./writes.js";

export type RememberResult =
  | {
      saved: true;
      id: number;
      tokens: number;
      superseded: number | null;
      key: string | null;
      linked: number[];
      suggestions: Neighbour[];
      warnings: string[];
      text: string;
    }
  | { saved: false; duplicates: Neighbour[]; text: string };

/** Suggested links returned by `remember`. */
const SUGGESTIONS = 5;
/** Percent of the memory cap at which `remember` starts warning. */
const CAP_WARN_PERCENT = 90;

export async function remember(ctx: ServiceContext, input: RememberInput): Promise<RememberResult> {
  const linkTo = [...new Set(input.links ?? [])];
  const { embedding, tokens } = await ctx.prepareContent(input.title, input.body);

  return ctx.store.transaction(async (store) => {
    const project = await store.ensureProject(input.project);
    // `ensureProject` is an upsert, which row-locks the project until this transaction ends, so
    // concurrent writers to one project queue there. Everything below runs after that lock, and READ
    // COMMITTED gives each statement a fresh snapshot, so each writer sees what the one before it
    // committed: the second of two writers at cap-1 is refused, and the second of two writers of a
    // new key finds the first one's memory and replaces it instead of colliding with it.
    const { holder, target } = await findTarget(store, project.id, input);
    await assertRoom(ctx, store, project.id, input.project, target);
    await assertExist(store, project.id, [...linkTo, ...(target ? [target] : [])]);
    const key = await successorKey(store, project.id, target, input.key ?? null);

    const near = await store.nearest(project.id, embedding, SUGGESTIONS + 2);
    const { duplicates, suggestions } = neighbourhood(near, {
      dedup: ctx.config.dedupSimilarity,
      linkSuggest: ctx.config.linkSuggestSimilarity,
      target,
      linked: linkTo,
    });
    if (duplicates.length && !input.force) return { saved: false, duplicates, text: refusalText(duplicates) };

    const seq = await store.insertMemory(
      project.id,
      {
        kind: input.kind,
        title: input.title,
        body: input.body,
        tags: input.tags,
        paths: input.paths,
        pinned: input.pinned,
        importance: input.importance,
        source: input.source ?? null,
        // A successor claims the key only once its predecessor has released it below:
        // a partial unique index can't be deferred to commit.
        key: target ? null : key,
      },
      embedding,
      tokens,
    );
    if (target) {
      await store.supersede(project.id, target, seq);
      if (key) await store.updateMemory(project.id, seq, { key });
    }
    if (linkTo.length) await linkChecked(ctx.config.maxLinks, store, project.id, seq, linkTo, input.link_note ?? null);

    const warnings = [...memoryWarnings(input.body, tokens), ...(await capWarnings(ctx, store, project.id))];
    const text = savedText({
      seq,
      tokens,
      key,
      project: input.project,
      replacedHolder: holder,
      superseded: target,
      linked: linkTo,
      suggestions,
      overlapFloor: ctx.overlapFloor,
      warnings,
    });
    return {
      saved: true,
      id: seq,
      tokens,
      superseded: target ?? null,
      key,
      linked: linkTo,
      suggestions,
      warnings,
      text,
    };
  });
}

/**
 * The memory this write replaces: the one named by `supersedes`, or else the current holder of its
 * key — a keyed write replaces the holder exactly as `supersedes=<holder>` would. Naming both, for
 * different memories, is refused.
 */
async function findTarget(
  store: PgStore,
  projectId: string,
  input: Pick<RememberInput, "key" | "supersedes">,
): Promise<{ holder: number | undefined; target: number | undefined }> {
  const holder = input.key ? (await store.keyHolders(projectId, [input.key])).get(input.key) : undefined;
  if (holder !== undefined && input.supersedes && input.supersedes !== holder) {
    throw new AxonError(
      "rule",
      `Key ${input.key} is held by #${holder}, not #${input.supersedes}. Drop supersedes to replace #${holder}, or use another key.`,
    );
  }
  return { holder, target: input.supersedes ?? holder };
}

/**
 * The cap counts active memories only, so archiving or superseding is always a way out, and a
 * superseding write is admitted at the cap: it retires one memory for the one it adds.
 */
async function assertRoom(
  ctx: ServiceContext,
  store: PgStore,
  projectId: string,
  slug: string,
  target: number | undefined,
): Promise<void> {
  const max = ctx.config.maxMemories;
  if (max === undefined || target || (await store.countActive(projectId)) < max) return;
  throw new AxonError(
    "rule",
    `Memory cap (${max}) reached for ${slug}. Archive or supersede memories that are no longer true (update with status=archived, or remember with supersedes=<id> or the same key), and search before remembering.`,
  );
}

/** The key the new memory will hold. Only an active memory can be superseded, and its successor carries its key on unless the write names another. */
async function successorKey(
  store: PgStore,
  projectId: string,
  target: number | undefined,
  key: string | null,
): Promise<string | null> {
  if (!target) return key;
  const [old] = await store.getMemories(projectId, [target]);
  if (old?.status !== "active") {
    throw new AxonError("rule", `#${target} is ${old?.status}; only active memories can be superseded`);
  }
  return key ?? old.key;
}

/** Near the cap, every write says so. Counted after the write, in its transaction, so it sees this memory. */
async function capWarnings(ctx: ServiceContext, store: PgStore, projectId: string): Promise<string[]> {
  const max = ctx.config.maxMemories;
  if (max === undefined) return [];
  const active = await store.countActive(projectId);
  if (active * 100 < max * CAP_WARN_PERCENT) return [];
  return [`${num(active)}/${num(max)} memories — archive or supersede what is stale; see review.`];
}

/**
 * Sorts a new memory's nearest neighbours into near-duplicates (refused unless forced) and link
 * suggestions. The memory being replaced and the memories it is linked to are neither.
 */
export function neighbourhood(
  near: Neighbour[],
  opts: { dedup: number; linkSuggest: number; target: number | undefined; linked: number[] },
): { duplicates: Neighbour[]; suggestions: Neighbour[] } {
  const duplicates = near.filter((n) => n.similarity >= opts.dedup && n.seq !== opts.target);
  const excluded = new Set([...opts.linked, ...duplicates.map((d) => d.seq)]);
  const suggestions = near
    .filter((n) => n.similarity >= opts.linkSuggest && n.seq !== opts.target && !excluded.has(n.seq))
    .slice(0, SUGGESTIONS);
  return { duplicates, suggestions };
}

export function refusalText(duplicates: Neighbour[]): string {
  const list = duplicates.map((d) => `#${d.seq} ${d.kind} · ${d.title} [${d.similarity.toFixed(2)}]`).join("\n");
  return `Not saved — near-duplicate of:\n${list}\nUse update to amend it, supersedes=<id> to replace it, or force=true to keep both.`;
}

/** What a saved `remember` tells the agent. Suggestions at or above `overlapFloor` are flagged as likely overlaps. */
export function savedText(r: {
  seq: number;
  tokens: number;
  key: string | null;
  project: string;
  /** Set when the write replaced the holder of its key. */
  replacedHolder: number | undefined;
  superseded: number | undefined;
  linked: number[];
  suggestions: Neighbour[];
  overlapFloor: number;
  warnings: string[];
}): string {
  const lines = [`Saved #${r.seq} (${r.tokens}t${r.key ? `, key ${r.key}` : ""}) in ${r.project}.`];
  if (r.replacedHolder !== undefined) {
    lines.push(`Replaced #${r.replacedHolder} (key ${r.key}); its links moved to #${r.seq}.`);
  } else if (r.superseded) {
    lines.push(`#${r.superseded} marked superseded; its links moved to #${r.seq}.`);
  }
  if (r.linked.length) lines.push(`Linked ↔ ${seqList(r.linked)}.`);
  const fmt = (ns: Neighbour[]) => ns.map((s) => `#${s.seq} ${s.title} [${s.similarity.toFixed(2)}]`).join(" · ");
  const overlaps = r.suggestions.filter((s) => s.similarity >= r.overlapFloor);
  const related = r.suggestions.filter((s) => s.similarity < r.overlapFloor);
  if (overlaps.length) {
    lines.push(`Likely overlaps: ${fmt(overlaps)} — if it's the same fact, update that one or supersede it instead.`);
  }
  if (related.length) lines.push(`Possibly related — link if so: ${fmt(related)}`);
  lines.push(...r.warnings.map((w) => `⚠ ${w}`));
  return lines.join("\n");
}
