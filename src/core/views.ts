import type { LinkRef, Memory } from "../store/types.js";
import type { Packed, PackKey } from "./pack.js";

/** A memory as returned to clients: the body is omitted when only its index line was shown. */
export type MemoryView = Omit<Memory, "body"> & { body?: string };

export interface Shown {
  mode: "full" | "index";
  memory: MemoryView;
  links: LinkRef[];
}

/** A retrieved memory and how it matched: cosine similarity (vector lane) and/or the keyword lane. */
export type Hit = { memory: Memory; similarity: number | null; keyword: boolean };

/** Memories from a browse, as hits that matched on neither lane. */
export function asHits(memories: Memory[]): Hit[] {
  return memories.map((memory) => ({ memory, similarity: null, keyword: false }));
}

export function view(m: Memory, full: boolean, links: Map<number, LinkRef[]>): Shown {
  const { body, ...rest } = m;
  return { mode: full ? "full" : "index", memory: full ? m : rest, links: links.get(m.seq) ?? [] };
}

/** `m` the way a pack showed it under `key`, or null when it was left out. */
export function shownIn<K extends PackKey>(
  packed: Pick<Packed<K>, "mode">,
  key: K,
  m: Memory,
  links: Map<number, LinkRef[]>,
): Shown | null {
  const mode = packed.mode(key);
  return mode && view(m, mode === "full", links);
}

/** The memories a pack showed, full ones first, each in the mode it was shown in. */
export function shown(memories: Memory[], full: number[], index: number[], links: Map<number, LinkRef[]>): Shown[] {
  const bySeq = new Map(memories.map((m) => [m.seq, m]));
  const isFull = new Set(full);
  return [...full, ...index].flatMap((seq) => {
    const m = bySeq.get(seq);
    return m ? [view(m, isFull.has(seq), links)] : [];
  });
}
