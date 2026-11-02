import { z } from "zod";
import { KINDS, type Kind, type LinkExport, type Status } from "../store/types.js";

/** Input schemas shared by the MCP tools and the REST API (snake_case on the wire). */

export const PROJECT_RE = /^[a-z0-9][a-z0-9._/-]{0,127}$/;
/** Mirrors the CHECK on `memories.key`. */
export const KEY_RE = /^[a-z0-9][a-z0-9._/:-]{0,79}$/;

export const project = z
  .string()
  .trim()
  .toLowerCase()
  .regex(PROJECT_RE, "project: lowercase letters, digits and . _ / - (max 128), e.g. acme/api")
  .describe("Project slug, e.g. acme/api");

const id = z.coerce.number().int().positive();
const kind = z.enum(KINDS);
const tag = z.string().trim().toLowerCase().min(1).max(40);
const path = z.string().trim().min(1).max(200);
const key = z
  .string()
  .trim()
  .toLowerCase()
  .regex(KEY_RE, "key: lowercase letters, digits and . _ / : - (max 80), e.g. deploy/current");
const title = z.string().trim().min(1).max(120);
const body = z.string().trim().min(1).max(16_000);
/** Without repeats, in first-seen order. */
const unique = <T>(xs: T[]): T[] => [...new Set(xs)];
/** `./src/api/` and `src/api` name the same path, so a memory stores the bare form. */
const normalizePath = (p: string) => p.replace(/^\.\//, "").replace(/\/+$/, "");
/** Tags and paths as a memory stores them; written by remember, update and import alike. */
const tags = z.array(tag).max(12).transform(unique);
const paths = z.array(path.transform(normalizePath)).max(20).transform(unique);
const importance = z.number().int().min(1).max(5);
const source = z.string().trim().max(120);
const note = z.string().trim().max(80);
const budget = (def: number) => z.coerce.number().int().min(200).max(20_000).default(def);

export const BriefingInput = z.object({
  project,
  focus: z
    .string()
    .trim()
    .max(1000)
    .optional()
    .describe("What you are about to work on; relevant memories get part of the budget"),
  paths: z.array(path).max(20).optional().describe("Files/dirs you will touch"),
  budget_tokens: budget(1500).describe("Max tokens to return"),
});

export const SearchInput = z.object({
  project,
  query: z.string().trim().max(1000).optional().describe("Question or keywords; omit to browse by rank"),
  k: z.coerce.number().int().min(1).max(50).default(8),
  kinds: z.array(kind).optional(),
  tags: z.array(tag).optional().describe("Match any"),
  paths: z.array(path).optional().describe("Files/dirs; matches memories on, above or below them"),
  budget_tokens: budget(1200),
});

export const GetInput = z
  .object({
    project,
    ids: z.array(id).min(1).max(20).optional(),
    keys: z.array(key).min(1).max(20).optional(),
  })
  .refine((i) => Boolean(i.ids || i.keys), "ids or keys required");

export const RememberInput = z.object({
  project,
  kind,
  title,
  body: body.describe("Markdown. One fact/decision per memory"),
  tags: tags.default([]),
  paths: paths.default([]).describe("Related files/dirs"),
  pinned: z.boolean().default(false).describe("Always include in briefings"),
  importance: importance.default(3),
  links: z.array(id).max(16).optional().describe("Ids to link the new memory to"),
  link_note: note.optional().describe("Why they relate"),
  supersedes: id.optional().describe("Id this replaces; its links move to the new memory"),
  key: key
    .optional()
    .describe("Stable name for a mutable fact; a later remember with the same key replaces this memory"),
  force: z.boolean().default(false).describe("Save even if a near-duplicate exists"),
  source: source.optional().describe("Who/what wrote it"),
});

export const UpdateInput = z.object({
  project,
  id,
  kind: kind.optional(),
  title: title.optional(),
  body: body.optional(),
  tags: tags.optional(),
  paths: paths.optional(),
  pinned: z.boolean().optional(),
  importance: importance.optional(),
  status: z.enum(["active", "archived"]).optional(),
  source: source.optional(),
  confirm: z.boolean().optional().describe("Still true: resets its age"),
  dispute: z.boolean().optional().describe("Probably wrong: flags it and lowers its rank until confirmed or edited"),
  key: key.nullable().optional().describe("null clears it"),
});

export const LinkInput = z.object({
  project,
  id,
  to: z.array(id).min(1).max(32),
  note: note.optional().describe("Why they relate"),
  remove: z.boolean().default(false),
});

export const RelatedInput = z.object({
  project,
  id,
  hops: z.coerce.number().int().min(1).max(3).default(2),
  budget_tokens: budget(1000),
});

export const ReviewInput = z.object({
  project,
  budget_tokens: budget(1500).describe("Max tokens to return"),
});

export const DeleteProjectInput = z.object({ project });

export const ExportInput = z.object({
  project,
  format: z.enum(["json", "markdown"]).default("json"),
  /** `active` leaves out archived and superseded memories, and the links that touch them. */
  include: z.enum(["active", "all"]).default("all"),
});

/** Version of the export document's shape; bumped only when an older importer could misread a newer file. */
export const EXPORT_FORMAT = 1;

const seq = z.number().int().positive();
/** Exports write UTC (`Z`); hand-edited files may carry an offset. */
const timestamp = z.iso.datetime({ offset: true }).transform((s) => new Date(s));

/**
 * A project's memories as `axon export` writes them and `axon import` reads them. Seqs are the
 * exporting project's ids: links and `superseded_by` refer to them, and import renumbers all three.
 * The field limits are `remember`'s, so nothing gets in through import that couldn't be written directly.
 */
export const ImportDocument = z
  .object({
    axon: z.object({
      version: z.string().optional(),
      format: z.literal(EXPORT_FORMAT, {
        error: (i) => `unsupported export format ${JSON.stringify(i.input)}; this axon reads format ${EXPORT_FORMAT}`,
      }),
    }),
    // Informational: the import target is named by the caller, not the file.
    project: z.string().optional(),
    exported_at: z.string().optional(),
    memories: z.array(
      z.object({
        seq,
        kind,
        title,
        body,
        tags: tags.default([]),
        paths: paths.default([]),
        pinned: z.boolean().default(false),
        importance: importance.default(3),
        status: z.enum(["active", "superseded", "archived"]).default("active"),
        superseded_by: seq.nullable().default(null),
        source: source.nullable().default(null),
        key: key.nullable().default(null),
        created_at: timestamp.optional(),
        updated_at: timestamp.optional(),
        confirmed_at: timestamp.optional(),
        disputed_at: timestamp.nullable().default(null),
      }),
    ),
    links: z
      .array(
        z.object({
          a: seq,
          b: seq,
          note: note.nullable().default(null),
          // A link's strength: 1 when made, up to 5 as agents traverse it.
          weight: z.number().min(1).max(5).default(1),
        }),
      )
      .default([]),
  })
  .superRefine((doc, ctx) => {
    const seqs = new Set<number>();
    doc.memories.forEach((m, i) => {
      if (seqs.has(m.seq))
        ctx.addIssue({ code: "custom", path: ["memories", i, "seq"], message: `duplicate seq ${m.seq}` });
      seqs.add(m.seq);
    });
    // One active holder per key, as the database will insist once the rows land.
    const holders = new Map<string, number>();
    doc.memories.forEach((m, i) => {
      if (m.key === null || m.status !== "active") return;
      const first = holders.get(m.key);
      if (first !== undefined)
        ctx.addIssue({
          code: "custom",
          path: ["memories", i, "key"],
          message: `key ${m.key} is also held by #${first}`,
        });
      else holders.set(m.key, m.seq);
    });
    doc.memories.forEach((m, i) => {
      if (m.superseded_by === null) return;
      const path = ["memories", i, "superseded_by"];
      if (m.superseded_by === m.seq) ctx.addIssue({ code: "custom", path, message: `#${m.seq} supersedes itself` });
      else if (!seqs.has(m.superseded_by))
        ctx.addIssue({ code: "custom", path, message: `#${m.superseded_by} is not a memory in this document` });
    });
    const pairs = new Set<string>();
    doc.links.forEach((l, i) => {
      for (const end of ["a", "b"] as const) {
        if (!seqs.has(l[end]))
          ctx.addIssue({
            code: "custom",
            path: ["links", i, end],
            message: `#${l[end]} is not a memory in this document`,
          });
      }
      if (l.a === l.b) ctx.addIssue({ code: "custom", path: ["links", i], message: `#${l.a} links to itself` });
      const pair = `${Math.min(l.a, l.b)}-${Math.max(l.a, l.b)}`;
      if (pairs.has(pair))
        ctx.addIssue({ code: "custom", path: ["links", i], message: `duplicate link #${l.a} ↔ #${l.b}` });
      pairs.add(pair);
    });
  });

export const ImportInput = z.object({ project, document: ImportDocument });

/** What `export` writes: decrypted text, no embeddings (they only mean something to one model) and no access counters. */
export interface ExportDocument {
  axon: { version: string; format: typeof EXPORT_FORMAT };
  project: string;
  exported_at: string;
  memories: {
    seq: number;
    kind: Kind;
    title: string;
    body: string;
    tags: string[];
    paths: string[];
    pinned: boolean;
    importance: number;
    status: Status;
    superseded_by: number | null;
    source: string | null;
    key: string | null;
    created_at: string;
    updated_at: string;
    confirmed_at: string;
    disputed_at: string | null;
  }[];
  links: LinkExport[];
}

export type BriefingInput = z.infer<typeof BriefingInput>;
export type SearchInput = z.infer<typeof SearchInput>;
export type GetInput = z.infer<typeof GetInput>;
export type RememberInput = z.infer<typeof RememberInput>;
export type UpdateInput = z.infer<typeof UpdateInput>;
export type LinkInput = z.infer<typeof LinkInput>;
export type RelatedInput = z.infer<typeof RelatedInput>;
export type ReviewInput = z.infer<typeof ReviewInput>;
export type DeleteProjectInput = z.infer<typeof DeleteProjectInput>;
export type ExportInput = z.infer<typeof ExportInput>;
export type ImportDocument = z.infer<typeof ImportDocument>;
export type ImportInput = z.infer<typeof ImportInput>;
