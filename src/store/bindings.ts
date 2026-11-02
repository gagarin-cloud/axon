import type postgres from "postgres";
import { MemoryCipher } from "../core/cipher.js";
import type { Sql, Tx } from "../db/client.js";
import { type ContentCodec, codecFor } from "./codec.js";

/**
 * What the database is bound to, recorded in `meta`: the embedding model that built its vectors,
 * and the fingerprint of the key that encrypted its text. A process configured differently is
 * refused at startup rather than mixing vectors or ciphertext.
 */

const INDEX_NAME = "memories_embedding_hnsw";

/**
 * Binds the database to one embedding model. The first model to run claims it; a later model
 * with a different id or dimension is refused until `axon reembed` switches the database over.
 */
export async function checkEmbeddingModel(sql: Sql, model: string, dim: number): Promise<void> {
  const rows = await sql<{ key: string; value: string }[]>`
    SELECT key, value FROM meta WHERE key IN ('embed_model', 'embed_dim')`;
  const meta = Object.fromEntries(rows.map((r) => [r.key, r.value]));

  if (meta.embed_model === undefined) {
    await setEmbeddingModel(sql, model, dim);
    return;
  }
  if (meta.embed_model !== model || Number(meta.embed_dim) !== dim) {
    throw new Error(
      `database is indexed with ${meta.embed_model} (${meta.embed_dim}d) but axon is configured for ${model} (${dim}d); run \`axon reembed\` to switch`,
    );
  }
}

/** Records the model and (re)creates the HNSW index for its dimension. */
export async function setEmbeddingModel(sql: Sql, model: string, dim: number): Promise<void> {
  if (!Number.isInteger(dim) || dim < 1 || dim > 4000) throw new Error(`invalid embedding dimension ${dim}`);
  await sql.begin(async (tx) => {
    await tx`INSERT INTO meta (key, value) VALUES ('embed_model', ${model}), ('embed_dim', ${String(dim)})
             ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`;
    await tx.unsafe(`DROP INDEX IF EXISTS ${INDEX_NAME}`);
    await tx.unsafe(
      `CREATE INDEX ${INDEX_NAME} ON memories USING hnsw ((embedding::vector(${dim})) vector_cosine_ops)`,
    );
  });
}

/** Drops the vector index and model binding, so vectors of a new dimension can be written. */
export async function releaseEmbeddingModel(sql: Sql): Promise<void> {
  await sql.begin(async (tx) => {
    await tx.unsafe(`DROP INDEX IF EXISTS ${INDEX_NAME}`);
    await tx`DELETE FROM meta WHERE key IN ('embed_model', 'embed_dim')`;
  });
}

/**
 * Binds the database to one encryption key (by fingerprint). A different key is refused, and so is
 * running without a key while encrypted memories exist.
 */
export async function checkEncryptionKey(sql: Sql, keyId: string | null): Promise<void> {
  if (keyId === null) {
    const [{ n } = { n: 0 }] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM memories WHERE encrypted`;
    if (n > 0) throw new Error(`${n} memories are encrypted; set AXON_ENCRYPTION_KEY to read them`);
    return;
  }
  // The first key to run claims the database (atomically, if two servers start at once).
  await sql`INSERT INTO meta (key, value) VALUES ('encryption_key_id', ${keyId}) ON CONFLICT (key) DO NOTHING`;
  const [row] = await sql<{ value: string }[]>`SELECT value FROM meta WHERE key = 'encryption_key_id'`;
  if (row?.value !== keyId) {
    throw new Error(`database is encrypted with key ${row?.value} but AXON_ENCRYPTION_KEY is ${keyId}`);
  }
}

/** Rebinds the database to another key, as part of a rotation. */
export async function setEncryptionKey(sql: Tx, keyId: string): Promise<void> {
  await sql`
    INSERT INTO meta (key, value) VALUES ('encryption_key_id', ${keyId})
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`;
}

/** Forgets the encryption key binding (after every memory has been decrypted). */
export async function releaseEncryptionKey(sql: Sql): Promise<void> {
  await sql`DELETE FROM meta WHERE key = 'encryption_key_id'`;
}

/** The bound key's fingerprint, row-locked until the transaction ends, so two rotations can't interleave. */
export async function lockedEncryptionKeyId(tx: Tx): Promise<string | null> {
  const [row] = await tx<{ value: string }[]>`
    SELECT value FROM meta WHERE key = 'encryption_key_id' FOR UPDATE`;
  return row?.value ?? null;
}

/**
 * SQL condition guarding a content write: the database must still be bound to the key the writer
 * holds. Checked in the writing statement itself, so a rotation that commits mid-request can't slip
 * rows in under the old key. Plaintext writes have nothing to guard.
 */
export function keyStillBound(sql: Tx, keyId: string | null): postgres.PendingQuery<postgres.Row[]> {
  if (keyId === null) return sql`true`;
  return sql`EXISTS (SELECT 1 FROM meta WHERE key = 'encryption_key_id' AND value = ${keyId})`;
}

/** A write attempted with a key the database has since rotated away from. */
export function rotatedError(): Error {
  return new Error("encryption key was rotated; restart axon with the new AXON_ENCRYPTION_KEY");
}

/** The codec for `key` (plaintext without one), once the database has accepted it. */
export async function openCodec(sql: Sql, key: Buffer | undefined): Promise<ContentCodec> {
  const codec = codecFor(key ? new MemoryCipher(key) : null);
  await checkEncryptionKey(sql, codec.keyId);
  return codec;
}
