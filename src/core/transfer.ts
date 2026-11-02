/** Export and import: a whole project as one document, for people and scripts rather than agents. */

import { VERSION } from "../version.js";
import type { ServiceContext } from "./context.js";
import { AxonError } from "./errors.js";
import { plural } from "./format.js";
import { renderExport } from "./render.js";
import { EXPORT_FORMAT, type ExportDocument, type ExportInput, type ImportInput } from "./schemas.js";

export interface ExportResult {
  format: ExportInput["format"];
  document: ExportDocument;
  /** The document rendered in `format`: pretty-printed JSON, or Markdown. */
  text: string;
}

export interface ImportResult {
  project: string;
  imported: number;
  links: number;
  /** Seq in the document → seq it was given in the project. */
  mapping: Record<string, number>;
  text: string;
}

/**
 * The whole project, decrypted, in seq order. Unbudgeted and not counted as a read: it is an
 * operator's copy, not an agent's recall, so it neither touches memories nor strengthens links.
 */
export async function exportProject(ctx: ServiceContext, input: ExportInput): Promise<ExportResult> {
  const projectId = await ctx.requireProject(input.project);
  const activeOnly = input.include === "active";
  const memories = await ctx.store.allMemories(projectId, activeOnly);
  const included = new Set(memories.map((m) => m.seq));
  const links = await ctx.store.allLinks(projectId, activeOnly);

  const document: ExportDocument = {
    axon: { version: VERSION, format: EXPORT_FORMAT },
    project: input.project,
    exported_at: new Date().toISOString(),
    memories: memories.map((m) => ({
      seq: m.seq,
      kind: m.kind,
      title: m.title,
      body: m.body,
      tags: m.tags,
      paths: m.paths,
      pinned: m.pinned,
      importance: m.importance,
      status: m.status,
      // A successor left out of the file would be a dangling reference the importer refuses.
      superseded_by: m.supersededBy !== null && included.has(m.supersededBy) ? m.supersededBy : null,
      source: m.source,
      key: m.key,
      created_at: m.createdAt.toISOString(),
      updated_at: m.updatedAt.toISOString(),
      confirmed_at: m.confirmedAt.toISOString(),
      disputed_at: m.disputedAt?.toISOString() ?? null,
    })),
    links: links.map((l) => ({ ...l, weight: Math.round(l.weight * 1e4) / 1e4 })),
  };
  const text = input.format === "markdown" ? renderExport(document) : `${JSON.stringify(document, null, 2)}\n`;
  return { format: input.format, document, text };
}

/**
 * Appends an exported document to a project (creating it), as a restore: every memory gets a new
 * seq, links and supersessions are renumbered to match, and status, pinning, importance and both
 * timestamps are kept. Text is re-embedded with the current model and stored in the current
 * encryption mode. Near-duplicates are not refused, but the memory cap holds for the whole batch,
 * and either everything is imported or nothing is.
 */
export async function importProject(ctx: ServiceContext, input: ImportInput): Promise<ImportResult> {
  const doc = input.document;
  const memories = [...doc.memories].sort((a, b) => a.seq - b.seq);
  const adding = memories.filter((m) => m.status === "active").length;

  const degree = new Map<number, number>();
  for (const l of doc.links) for (const s of [l.a, l.b]) degree.set(s, (degree.get(s) ?? 0) + 1);
  const crowded = [...degree].filter(([, n]) => n > ctx.config.maxLinks).map(([s]) => `#${s}`);
  if (crowded.length) {
    throw new AxonError("rule", `Link cap (${ctx.config.maxLinks}) exceeded in the document by ${crowded.join(", ")}.`);
  }

  // Checked again under the project lock below; this early look just spares embedding a doomed batch.
  const existing = await ctx.store.getProject(input.project);
  checkImportCap(
    ctx.config.maxMemories,
    input.project,
    adding,
    existing ? await ctx.store.countActive(existing.id) : 0,
  );

  // Embedded before the transaction, so the project isn't locked while the model runs.
  const prepared: { m: (typeof memories)[number]; embedding: number[]; tokens: number }[] = [];
  for (const m of memories) {
    prepared.push({ m, ...(await ctx.prepareContent(m.title, m.body)) });
  }

  return ctx.store.transaction(async (store) => {
    // `ensureProject` row-locks the project until commit, so concurrent remembers and imports queue
    // behind this one and the count below can't be overtaken (see `remember`).
    const project = await store.ensureProject(input.project);
    checkImportCap(ctx.config.maxMemories, input.project, adding, await store.countActive(project.id));
    // Keys the document brings must be free in the target: a holder there is a different memory
    // than the one being restored, and replacing it silently is not what an import is for.
    const held = await store.keyHolders(
      project.id,
      memories.flatMap((m) => (m.status === "active" && m.key !== null ? [m.key] : [])),
    );
    if (held.size) {
      const list = [...held].map(([k, seq]) => `${k} (#${seq})`).join(", ");
      throw new AxonError(
        "conflict",
        `Keys already held in ${input.project}: ${list}. Archive or supersede the holders first, or strip the keys from the document.`,
      );
    }

    const seqOf = new Map<number, number>();
    for (const { m, embedding, tokens } of prepared) {
      const seq = await store.insertMemory(
        project.id,
        {
          kind: m.kind,
          title: m.title,
          body: m.body,
          tags: m.tags,
          paths: m.paths,
          pinned: m.pinned,
          importance: m.importance,
          source: m.source,
          key: m.key,
          status: m.status,
          createdAt: m.created_at,
          updatedAt: m.updated_at,
          confirmedAt: m.confirmed_at,
          disputedAt: m.disputed_at,
        },
        embedding,
        tokens,
      );
      seqOf.set(m.seq, seq);
    }
    // The schema guarantees every reference is in the document, so each one maps.
    const to = (seq: number) => seqOf.get(seq) as number;
    await store.setSupersededBy(
      project.id,
      memories.flatMap((m) => (m.superseded_by === null ? [] : [[to(m.seq), to(m.superseded_by)] as [number, number]])),
    );
    const links = await store.insertLinks(
      project.id,
      doc.links.map((l) => ({ a: to(l.a), b: to(l.b), note: l.note, weight: l.weight })),
    );

    const seqs = [...seqOf.values()];
    const n = seqs.length;
    const text = n
      ? `Imported ${plural(n, "memory", "memories")} (#${Math.min(...seqs)}–#${Math.max(...seqs)}) and ${plural(links, "link")} into ${input.project}.`
      : `Nothing to import: the document has no memories.`;
    return {
      project: input.project,
      imported: n,
      links,
      mapping: Object.fromEntries([...seqOf].map(([from, seq]) => [String(from), seq])),
      text,
    };
  });
}

/** An import may fill a project up to the cap, but not past it; archived and superseded rows don't count. */
function checkImportCap(max: number | undefined, slug: string, adding: number, active: number): void {
  if (max === undefined || adding === 0 || active + adding <= max) return;
  throw new AxonError(
    "rule",
    `Memory cap (${max}) would be exceeded: ${slug} holds ${active} active memories and the import adds ${adding}. Nothing was imported. Archive memories in ${slug} first, or import into a project with room.`,
  );
}
