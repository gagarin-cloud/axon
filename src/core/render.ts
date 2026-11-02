import type { Kind, LinkRef, Memory } from "../store/types.js";
import { day, daysSince, plural } from "./format.js";
import { KIND_POLICY } from "./kinds.js";
import type { ExportDocument } from "./schemas.js";

/** Links listed under a full memory; the rest are summarised as "+N". */
export const FOOTER_LINKS = 5;

const DISPUTED = " ⚠ disputed";

/** What happened to a memory recently, as listed under a briefing's "Recent". */
export type Change = "new" | "updated" | "superseded" | "archived";

function status(m: Memory): string {
  if (m.status === "superseded") return m.supersededBy ? ` (superseded by #${m.supersededBy})` : " (superseded)";
  if (m.status === "archived") return " (archived)";
  return "";
}

const disputed = (m: Memory) => (m.disputedAt ? DISPUTED : "");

/** The key as a short tag after the title: ` [deploy/current]`. */
function keyTag(m: Memory): string {
  return m.key ? ` [${m.key}]` : "";
}

/** ` · unconfirmed 140d` for an active state/gotcha memory not confirmed within its threshold. */
function unconfirmed(m: Memory, now: Date): string {
  const after = KIND_POLICY[m.kind].flagUnconfirmedAfterDays;
  if (after === undefined || m.status !== "active") return "";
  const days = Math.floor(daysSince(m.confirmedAt, now));
  return days > after ? ` · unconfirmed ${days}d` : "";
}

/** `## #42 decision · Use pgvector` */
function heading(m: { seq: number; kind: Kind; title: string }): string {
  return `## #${m.seq} ${m.kind} · ${m.title}`;
}

/** One line: `#42 decision · Use pgvector [db/engine] · 180t ↔3 ★`, flagged `⚠ disputed` or `· unconfirmed 140d` when stale. */
export function renderIndexLine(m: Memory, suffix = "", now = new Date()): string {
  return indexLine(m, status(m), suffix, now);
}

/** A "Recent" line: `#42 decision · Use pgvector · 180t ↔3 · superseded by #43`. The change replaces the status. */
export function renderChangeLine(m: Memory, change: Change, now = new Date()): string {
  return indexLine(
    m,
    "",
    ` · ${change === "superseded" && m.supersededBy ? `superseded by #${m.supersededBy}` : change}`,
    now,
  );
}

function indexLine(m: Memory, status: string, suffix: string, now: Date): string {
  const marks = [m.degree ? `↔${m.degree}` : "", m.pinned ? "★" : ""].filter(Boolean).join(" ");
  return `#${m.seq} ${m.kind} · ${m.title}${keyTag(m)}${status}${disputed(m)} · ${m.tokens}t${marks ? ` ${marks}` : ""}${unconfirmed(m, now)}${suffix}`;
}

/** Full memory: heading, a metadata line, the body, and a footer of linked memories. */
export function renderFull(m: Memory, links: LinkRef[] = [], headingSuffix = ""): string {
  const meta = [
    m.key ? `key ${m.key}` : "",
    m.tags.length ? `tags: ${m.tags.join(", ")}` : "",
    m.paths.length ? `paths: ${m.paths.join(", ")}` : "",
    m.pinned ? "pinned" : "",
    m.importance !== 3 ? `importance ${m.importance}` : "",
    `updated ${day(m.updatedAt)}`,
    `confirmed ${day(m.confirmedAt)}`,
    m.disputedAt ? `disputed ${day(m.disputedAt)}` : "",
  ].filter(Boolean);

  const lines = [`${heading(m)}${status(m)}${disputed(m)}${headingSuffix}`, meta.join(" · "), m.body.trim()];
  const footer = renderLinkFooter(links, m.degree);
  if (footer) lines.push(footer);
  return lines.join("\n");
}

export function renderLinkFooter(links: LinkRef[], degree: number): string {
  if (links.length === 0) return "";
  const shown = links.slice(0, FOOTER_LINKS);
  const more = degree - shown.length;
  return `↔ ${shown.map((l) => `#${l.seq} ${l.title}`).join(" · ")}${more > 0 ? ` (+${more})` : ""}`;
}

export function formatSimilarity(similarity: number | null, keyword: boolean): string {
  if (similarity === null) return keyword ? " [keyword]" : "";
  return ` [${similarity.toFixed(2)}${keyword ? " +kw" : ""}]`;
}

/**
 * A whole export as one Markdown document, for reading or ejecting: every memory in seq order with
 * all its metadata and its complete body (exports are not budgeted), then the links.
 */
export function renderExport(doc: ExportDocument): string {
  const n = doc.memories.length;
  const l = doc.links.length;
  const parts = [
    `# ${doc.project} — exported ${doc.exported_at.slice(0, 10)} · ${plural(n, "memory", "memories")} · ${plural(l, "link")}`,
  ];
  for (const m of doc.memories) {
    // A list rather than `---` front matter: a closing `---` would turn the lines above it into a heading.
    const meta = [
      m.tags.length ? `tags: ${m.tags.join(", ")}` : "",
      m.paths.length ? `paths: ${m.paths.join(", ")}` : "",
      `pinned: ${m.pinned ? "yes" : "no"}`,
      `importance: ${m.importance}`,
      `status: ${m.status}`,
      m.superseded_by ? `superseded by: #${m.superseded_by}` : "",
      m.source ? `source: ${m.source}` : "",
      m.key ? `key: ${m.key}` : "",
      `created: ${m.created_at}`,
      `updated: ${m.updated_at}`,
      `confirmed: ${m.confirmed_at}`,
      m.disputed_at ? `disputed: ${m.disputed_at}` : "",
    ].filter(Boolean);
    parts.push([heading(m), "", ...meta.map((x) => `- ${x}`), "", m.body.trim()].join("\n"));
  }
  const links = doc.links.map(
    (k) => `- #${k.a} ↔ #${k.b}${k.note ? ` — ${k.note}` : ""}${k.weight !== 1 ? ` (strength ${k.weight})` : ""}`,
  );
  parts.push(["## Links", "", ...(links.length ? links : ["None."])].join("\n"));
  return `${parts.join("\n\n")}\n`;
}
