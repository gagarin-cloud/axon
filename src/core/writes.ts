/** Writes other than `remember`: update, link, and deleting a whole project. */

import type { PgStore } from "../store/pg.js";
import type { ServiceContext } from "./context.js";
import { AxonError } from "./errors.js";
import { plural, seqList } from "./format.js";
import type { DeleteProjectInput, LinkInput, UpdateInput } from "./schemas.js";
import { checkUpdateInput, planUpdate } from "./update-plan.js";

export interface UpdateResult {
  id: number;
  reembedded: boolean;
  /** This call confirmed the memory (explicitly, or by editing its title or body). */
  confirmed: boolean;
  /** The memory is disputed after this call. */
  disputed: boolean;
  warnings: string[];
  text: string;
}

export interface LinkResult {
  id: number;
  created: number;
  existing: number;
  removed: number;
  text: string;
}

export interface DeleteProjectResult {
  project: string;
  memories: number;
  links: number;
  text: string;
}

export async function update(ctx: ServiceContext, input: UpdateInput): Promise<UpdateResult> {
  checkUpdateInput(input);
  const projectId = await ctx.requireProject(input.project);
  const current = await ctx.requireMemory(projectId, input.id, input.project);
  const plan = planUpdate(current, input, new Date());
  const content = plan.content;
  // A changed title or body always arrives as content.
  const reembed = plan.reembed && content ? await ctx.prepareContent(content.title, content.body) : undefined;

  await ctx.store.transaction(async (store) => {
    const claim = plan.claim;
    if (claim) {
      // Checked under the project lock `remember` also takes, so no writer can claim the key
      // between this check and the write.
      await store.lockProject(projectId);
      const holder = (await store.keyHolders(projectId, [claim])).get(claim);
      if (holder !== undefined && holder !== input.id) throw plan.keyConflict(holder);
    }
    await store.updateMemory(projectId, input.id, plan.patch, content, reembed);
  });

  return {
    id: input.id,
    reembedded: Boolean(reembed),
    confirmed: plan.confirmed,
    disputed: plan.disputed,
    warnings: plan.warnings,
    text: plan.lines.join("\n"),
  };
}

export async function link(ctx: ServiceContext, input: LinkInput): Promise<LinkResult> {
  const projectId = await ctx.requireProject(input.project);
  const to = [...new Set(input.to)];
  if (to.includes(input.id)) throw new AxonError("rule", `A memory can't link to itself (#${input.id}).`);
  await assertExist(ctx.store, projectId, [input.id, ...to]);

  if (input.remove) {
    const removed = await ctx.store.unlink(projectId, input.id, to);
    return {
      id: input.id,
      created: 0,
      existing: 0,
      removed,
      text: `Removed ${plural(removed, "link")} from #${input.id}.`,
    };
  }

  const created = await ctx.store.transaction((store) =>
    linkChecked(ctx.config.maxLinks, store, projectId, input.id, to, input.note ?? null),
  );
  const existing = to.length - created;
  const text = `Linked #${input.id} ↔ ${seqList(to)}${existing ? ` (${existing} already linked${input.note ? ", note updated" : ""})` : ""}.`;
  return { id: input.id, created, existing, removed: 0, text };
}

/** Permanently removes a project with all its memories and links. */
export async function deleteProject(ctx: ServiceContext, input: DeleteProjectInput): Promise<DeleteProjectResult> {
  const removed = await ctx.store.deleteProject(input.project);
  if (!removed) throw new AxonError("not_found", `Project ${input.project} not found.`);
  const text = `Deleted ${input.project}: ${plural(removed.memories, "memory", "memories")}, ${plural(removed.links, "link")}.`;
  return { project: input.project, ...removed, text };
}

/** Links with the per-memory cap enforced (also used by `remember`). Returns the number of new links. */
export async function linkChecked(
  max: number,
  store: PgStore,
  projectId: string,
  seq: number,
  to: number[],
  note: string | null,
) {
  const counts = await store.linkCounts(projectId, [seq, ...to]);
  const linkedToSeq = new Set(
    (await store.linksAmong(projectId, [seq, ...to]))
      .filter(([a, b]) => a === seq || b === seq)
      .map(([a, b]) => (a === seq ? b : a)),
  );
  const adding = to.filter((t) => !linkedToSeq.has(t));
  const over = [seq, ...adding].filter((s) => (counts.get(s) ?? 0) + (s === seq ? adding.length : 1) > max);
  if (over.length) {
    throw new AxonError(
      "rule",
      `Link cap (${max}) reached for ${over.map((s) => `#${s}`).join(", ")}. Unlink weaker associations first (link with remove=true).`,
    );
  }
  return store.link(projectId, seq, to, note);
}

/** Refuses a write that names memories the project doesn't have. */
export async function assertExist(store: PgStore, projectId: string, seqs: number[]): Promise<void> {
  const missing = await store.missing(projectId, seqs);
  if (missing.length) throw new AxonError("not_found", `Not found: ${seqList(missing)}`);
}
