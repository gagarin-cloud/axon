/** Small text helpers shared by every rendering. */

export const DAY_MS = 86_400_000;

/** `2026-10-31` */
export const day = (d: Date) => d.toISOString().slice(0, 10);

/** Days (fractional) from `since` to `now`, never negative. */
export function daysSince(since: Date, now = new Date()): number {
  return Math.max(0, (now.getTime() - since.getTime()) / DAY_MS);
}

/** 4520 → "4,520" */
export function num(n: number): string {
  return n.toLocaleString("en-US");
}

/** `plural(1, "link")` → "1 link"; `plural(2, "memory", "memories")` → "2 memories". */
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** `#3, #7` */
export function seqList(seqs: number[]): string {
  return seqs.map((s) => `#${s}`).join(", ");
}
