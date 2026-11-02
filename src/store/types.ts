export const KINDS = [
  "overview",
  "architecture",
  "decision",
  "convention",
  "gotcha",
  "howto",
  "reference",
  "state",
] as const;
export type Kind = (typeof KINDS)[number];

export type Status = "active" | "superseded" | "archived";

/** A memory as seen by clients. `seq` is the per-project id agents use (`#42`). */
export interface Memory {
  seq: number;
  kind: Kind;
  title: string;
  body: string;
  tags: string[];
  paths: string[];
  pinned: boolean;
  importance: number;
  status: Status;
  supersededBy: number | null;
  tokens: number;
  source: string | null;
  /** Names a mutable fact; unique among a project's active memories. */
  key: string | null;
  createdAt: Date;
  updatedAt: Date;
  /** Last time it was asserted true: written, edited or confirmed. Ranking ages it from here. */
  confirmedAt: Date;
  /** Flagged as probably wrong; cleared by confirming or editing it. */
  disputedAt: Date | null;
  lastAccessedAt: Date | null;
  accessCount: number;
  /** Number of links to active memories. */
  degree: number;
  /** Title, body and source are stored encrypted. */
  encrypted: boolean;
}

export interface Project {
  id: string;
  slug: string;
}

export interface ProjectSummary {
  slug: string;
  active: number;
  total: number;
  links: number;
  updatedAt: Date | null;
}

export interface NewMemory {
  kind: Kind;
  title: string;
  body: string;
  tags: string[];
  paths: string[];
  pinned: boolean;
  importance: number;
  source: string | null;
  key: string | null;
  /** Set only when restoring an export; a new memory is active and stamped now. */
  status?: Status;
  createdAt?: Date;
  updatedAt?: Date;
  confirmedAt?: Date;
  disputedAt?: Date | null;
}

/** A link between two memories as exported: seqs, its note, and its current (decayed) strength. */
export interface LinkExport {
  a: number;
  b: number;
  note: string | null;
  weight: number;
}

/** A memory's encryptable text; written together so a row is either encrypted or not. */
export interface MemoryContent {
  title: string;
  body: string;
  source: string | null;
}

export interface MemoryPatch {
  kind?: Kind;
  tags?: string[];
  paths?: string[];
  pinned?: boolean;
  importance?: number;
  status?: "active" | "archived";
  confirmedAt?: Date;
  disputedAt?: Date | null;
  key?: string | null;
}

export interface Filters {
  kinds?: Kind[];
  /** Memory must carry at least one of these tags. */
  tags?: string[];
  /** Memory path equals, contains, or sits under one of these paths. */
  paths?: string[];
}

export interface Neighbour {
  seq: number;
  kind: Kind;
  title: string;
  similarity: number;
}

export interface SearchHit {
  seq: number;
  /** Reciprocal-rank-fusion score. */
  score: number;
  similarity: number | null;
  keyword: boolean;
}

export interface LinkRef {
  seq: number;
  title: string;
  strength: number;
  note: string | null;
}

export interface WalkStep {
  seq: number;
  hop: number;
  /** Memory this one was reached from. */
  via: number;
  note: string | null;
  /** Product of link strengths along the path. */
  strength: number;
  /** Seqs from the start memory to this one, inclusive. */
  path: number[];
}

export interface ProjectStats {
  kinds: Record<string, number>;
  tags: { tag: string; count: number }[];
  links: number;
  /** Latest change to any of the project's memories, whatever its status. */
  lastWrite: Date | null;
}

/** Two active memories that embed close together. */
export interface DuplicatePair {
  a: number;
  b: number;
  similarity: number;
  /** Already linked: likely a deliberate pair, but still worth a look. */
  linked: boolean;
}

/** One housekeeping finding: the first `seqs` (bounded) of `total` matches. */
export interface ReviewSection {
  seqs: number[];
  total: number;
}

export interface ReviewThresholds {
  /** Pairs at or above this cosine similarity count as likely duplicates. */
  duplicateSimilarity: number;
  /** Active memories (lowest seqs) whose nearest neighbours are checked for duplicates. */
  duplicateScan: number;
  /** Nearest neighbours checked per scanned memory. */
  duplicateNeighbours: number;
  largeTokens: number;
  staleStateDays: number;
  unreadDays: number;
  /** Rows returned per section; `total` still counts them all. */
  limit: number;
}

/** The per-memory housekeeping checks, in the order a review lists them (after duplicate pairs). */
export const REVIEW_SECTIONS = ["orphans", "oversized", "stale", "unread", "disputed"] as const;
export type ReviewSectionId = (typeof REVIEW_SECTIONS)[number];

export interface ReviewFindings {
  active: number;
  links: number;
  duplicates: DuplicatePair[];
  sections: Record<ReviewSectionId, ReviewSection>;
}
