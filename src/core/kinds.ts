import type { Kind } from "../store/types.js";

/** How a kind of memory behaves in ranking and rendering. */
export interface KindPolicy {
  /** How much it matters to an agent arriving at a project cold: a multiplier on briefing rank. */
  weight: number;
  /** Days for trust in an unconfirmed memory to halve. */
  freshnessHalfLifeDays: number;
  /**
   * Index lines say how long the memory has gone unconfirmed once past this many days. Only kinds
   * whose staleness misleads get one; the rest age quietly (ranking still discounts them) to keep
   * index lines short.
   */
  flagUnconfirmedAfterDays?: number;
}

/**
 * Every kind in one place. "Where things stand" goes stale in weeks; gotchas, how-tos and
 * references last until the code moves; decisions and conventions hold for years. A stale `state`
 * or `gotcha` misleads, so the agent is told to check it before acting on it.
 */
export const KIND_POLICY: Record<Kind, KindPolicy> = {
  overview: { weight: 1.3, freshnessHalfLifeDays: 365 },
  architecture: { weight: 1.2, freshnessHalfLifeDays: 365 },
  convention: { weight: 1.15, freshnessHalfLifeDays: 365 },
  gotcha: { weight: 1.1, freshnessHalfLifeDays: 180, flagUnconfirmedAfterDays: 180 },
  decision: { weight: 1.0, freshnessHalfLifeDays: 365 },
  state: { weight: 1.0, freshnessHalfLifeDays: 30, flagUnconfirmedAfterDays: 60 },
  howto: { weight: 0.95, freshnessHalfLifeDays: 180 },
  reference: { weight: 0.8, freshnessHalfLifeDays: 180 },
};
