import { z } from "zod";

/** Embedding precisions transformers.js can load. */
export const EMBED_DTYPES = ["fp32", "fp16", "q8", "q4", "q4f16"] as const;
export type EmbedDtype = (typeof EMBED_DTYPES)[number];

const Env = z.object({
  DATABASE_URL: z.string().default("postgres://axon:axon@localhost:54329/axon"),
  /** Optional default project, so stdio clients configured per-repo can omit `project` on every call. */
  AXON_PROJECT: z.string().optional(),
  AXON_EMBED_MODEL: z.string().default("onnx-community/Qwen3-Embedding-0.6B-ONNX"),
  AXON_EMBED_DTYPE: z.enum(EMBED_DTYPES).default("q8"),
  AXON_MODEL_DIR: z.string().default(".models"),
  // Similarity defaults are calibrated for Qwen3-Embedding-0.6B, whose cosine scores are compressed:
  // a paraphrase of the same fact scores ~0.88, same-topic facts ~0.6, unrelated text ~0.25.
  /** Cosine similarity at or above which `remember` treats a write as a duplicate. */
  AXON_DEDUP_SIMILARITY: z.coerce.number().min(0).max(1).default(0.85),
  /** Lower bound of the similarity band returned as link candidates on `remember`. */
  AXON_LINK_SUGGEST_SIMILARITY: z.coerce.number().min(0).max(1).default(0.55),
  /** Vector-only search hits below this similarity are dropped (keyword hits are always kept). */
  AXON_SEARCH_MIN_SIMILARITY: z.coerce.number().min(0).max(1).default(0.35),
  AXON_MAX_LINKS: z.coerce.number().int().min(1).default(32),
  /** Active memories a project may hold; `remember` refuses beyond it. Unset means unlimited. */
  AXON_MAX_MEMORIES: z.coerce.number().int().positive().optional(),
  AXON_HTTP_HOST: z.string().default("127.0.0.1"),
  AXON_HTTP_PORT: z.coerce.number().int().default(7717),
  /** Base64 32-byte key. When set, new and edited memories are encrypted at rest. */
  AXON_ENCRYPTION_KEY: encryptionKey("AXON_ENCRYPTION_KEY"),
  /** The key to rotate to; read only by `axon rotate-key`. */
  AXON_ENCRYPTION_KEY_NEW: encryptionKey("AXON_ENCRYPTION_KEY_NEW"),
});

function encryptionKey(name: string) {
  return z
    .string()
    .trim()
    .optional()
    .transform((v) => (v ? Buffer.from(v, "base64") : undefined))
    .refine((k) => k === undefined || k.length === 32, `${name} must be 32 bytes, base64-encoded`);
}

/** The environment as the rest of axon sees it: parsed, defaulted and renamed once, here. */
const ConfigSchema = Env.transform((e) => ({
  databaseUrl: e.DATABASE_URL,
  defaultProject: e.AXON_PROJECT,
  embedModel: e.AXON_EMBED_MODEL,
  embedDtype: e.AXON_EMBED_DTYPE,
  modelDir: e.AXON_MODEL_DIR,
  dedupSimilarity: e.AXON_DEDUP_SIMILARITY,
  linkSuggestSimilarity: e.AXON_LINK_SUGGEST_SIMILARITY,
  searchMinSimilarity: e.AXON_SEARCH_MIN_SIMILARITY,
  maxLinks: e.AXON_MAX_LINKS,
  maxMemories: e.AXON_MAX_MEMORIES,
  httpHost: e.AXON_HTTP_HOST,
  httpPort: e.AXON_HTTP_PORT,
  encryptionKey: e.AXON_ENCRYPTION_KEY,
  newEncryptionKey: e.AXON_ENCRYPTION_KEY_NEW,
}));

export type Config = z.output<typeof ConfigSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return ConfigSchema.parse(env);
}
