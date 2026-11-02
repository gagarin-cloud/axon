import type { Memory, MemoryContent, MemoryPatch } from "../store/types.js";
import { contentTokens, memoryWarnings } from "./content.js";
import { AxonError } from "./errors.js";
import type { UpdateInput } from "./schemas.js";

/** Everything `update` decides before touching the database. */
export interface UpdatePlan {
  patch: MemoryPatch;
  /** Title, body and source to rewrite (and re-seal), when any of them was given. */
  content?: MemoryContent;
  /** Title or body changed, so the memory needs a new embedding. */
  reembed: boolean;
  tokens: number;
  /** A key this update makes the memory hold; checked against other holders under the project lock. */
  claim: string | null;
  /** The call confirmed the memory (explicitly, or by editing its title or body). */
  confirmed: boolean;
  /** The memory is disputed after the call. */
  disputed: boolean;
  warnings: string[];
  /** The answer's text. */
  lines: string[];
  /** The refusal when another memory holds `claim`. */
  keyConflict: (holder: number) => AxonError;
}

/** Refuses a request that contradicts itself, before anything is read. */
export function checkUpdateInput(input: UpdateInput): void {
  if (input.confirm && input.dispute) {
    throw new AxonError("invalid", "confirm and dispute contradict each other; send one of them");
  }
}

/**
 * The rules of `update`, as a pure function of the memory as it is and the request: what may change,
 * what an edit implies for freshness, and what to tell the agent.
 */
export function planUpdate(current: Memory, input: UpdateInput, now: Date): UpdatePlan {
  checkUpdateInput(input);
  if (current.status === "superseded" && input.status === "active") {
    throw new AxonError("rule", `#${input.id} was superseded by #${current.supersededBy}; update that one instead`);
  }
  if (current.status === "superseded" && (input.confirm || input.dispute)) {
    const verb = input.confirm ? "confirm" : "dispute";
    throw new AxonError("rule", `#${input.id} was superseded by #${current.supersededBy}; ${verb} that one instead`);
  }

  const title = input.title ?? current.title;
  const body = input.body ?? current.body;
  const source = input.source === undefined ? current.source : input.source;
  const contentChanged = input.title !== undefined || input.body !== undefined || input.source !== undefined;
  const tokens = contentTokens(title, body);

  // Writing a memory's title or body asserts it is true now, so an edit confirms it like `confirm`
  // does; an explicit dispute in the same call still wins. Archiving leaves both flags alone.
  const edited = input.title !== undefined || input.body !== undefined;
  const confirmed = Boolean(input.confirm) || edited;
  const clearedDispute = confirmed && !input.dispute && current.disputedAt !== null;

  // Setting a key, or restoring a keyed memory, claims the key; only one active memory may hold it.
  const key = input.key === undefined ? current.key : input.key;
  const active = (input.status ?? current.status) === "active";
  const claim = active && (input.key !== undefined || input.status === "active") ? key : null;

  const { project: _project, id: _id, confirm: _confirm, dispute: _dispute, ...fields } = input;
  const fieldsChanged = Object.values(fields).some((v) => v !== undefined);
  const reembed = title !== current.title || body !== current.body;
  const warnings = input.body ? memoryWarnings(body, tokens) : [];

  const lines = [];
  if (fieldsChanged || !(input.confirm || input.dispute)) {
    lines.push(`Updated #${input.id}${reembed ? ` (${tokens}t, re-embedded)` : ""}.`);
  }
  if (input.confirm) lines.push(`Confirmed #${input.id}.`);
  if (input.dispute) {
    lines.push(
      `Disputed #${input.id} — fix it with update, replace it with remember supersedes=${input.id}, or archive it.`,
    );
  }
  if (clearedDispute && !input.confirm) lines.push(`Editing confirmed #${input.id} and cleared its dispute.`);
  lines.push(...warnings.map((w) => `⚠ ${w}`));

  return {
    patch: {
      kind: input.kind,
      tags: input.tags,
      paths: input.paths,
      pinned: input.pinned,
      importance: input.importance,
      status: input.status,
      key: input.key,
      confirmedAt: confirmed ? now : undefined,
      disputedAt: input.dispute ? now : confirmed ? null : undefined,
    },
    content: contentChanged ? { title, body, source } : undefined,
    reembed,
    tokens,
    claim,
    confirmed,
    disputed: Boolean(input.dispute) || (current.disputedAt !== null && !confirmed),
    warnings,
    lines,
    keyConflict: (holder) =>
      new AxonError(
        "conflict",
        input.key === undefined
          ? `#${input.id} can't be restored: its key ${claim} is now held by #${holder}. Restore it with key=null, or archive #${holder} first.`
          : `Key ${claim} is held by #${holder}. Remember with key=${claim} to replace it, or pick another key.`,
      ),
  };
}
