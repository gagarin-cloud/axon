import type { Memory } from "../store/types.js";
import { daysSince } from "./format.js";
import { KIND_POLICY } from "./kinds.js";

const RECENCY_HALF_LIFE_DAYS = 30;

/** Old-but-never-contradicted facts sink, but never vanish from a briefing. */
const FRESHNESS_FLOOR = 0.4;

/** A disputed memory's score is halved, and it sorts after every undisputed one with its pin status. */
const DISPUTED_FACTOR = 0.5;

/** Trust in a memory as it ages unconfirmed: 1 when just confirmed, halving per kind's half-life, floored. */
export function freshness(m: Pick<Memory, "kind" | "confirmedAt">, now = new Date()): number {
  return Math.max(FRESHNESS_FLOOR, 0.5 ** (daysSince(m.confirmedAt, now) / KIND_POLICY[m.kind].freshnessHalfLifeDays));
}

/**
 * Orders memories for a cold-start briefing: pinned first, disputed last within each pin status,
 * then by a blend of stated importance, recency of change, how often agents actually read it, and
 * how connected it is (hubs first), scaled by how recently it was confirmed true.
 *
 * Recency (`updatedAt`) and freshness (`confirmedAt`) answer different questions: recency is what's
 * being worked on now and nudges the blend; freshness is whether the fact can still be trusted, and
 * scales all of it, so an old unconfirmed `state` loses to a fresh one however connected it is.
 */
export function rankForBriefing(memories: Memory[], now = new Date()): Memory[] {
  const maxAccess = Math.max(1, ...memories.map((m) => m.accessCount));
  const maxDegree = Math.max(1, ...memories.map((m) => m.degree));

  const score = (m: Memory) => {
    const recency = 0.5 ** (daysSince(m.updatedAt, now) / RECENCY_HALF_LIFE_DAYS);
    const access = Math.log1p(m.accessCount) / Math.log1p(maxAccess);
    const degree = Math.log1p(m.degree) / Math.log1p(maxDegree);
    const base = 0.45 * (m.importance / 5) + 0.2 * recency + 0.15 * access + 0.2 * degree;
    return base * KIND_POLICY[m.kind].weight * freshness(m, now) * (m.disputedAt ? DISPUTED_FACTOR : 1);
  };

  return memories
    .map((m) => ({ m, s: score(m) }))
    .sort(
      (a, b) =>
        Number(b.m.pinned) - Number(a.m.pinned) ||
        Number(Boolean(a.m.disputedAt)) - Number(Boolean(b.m.disputedAt)) ||
        b.s - a.s ||
        b.m.seq - a.m.seq,
    )
    .map((x) => x.m);
}
