import { MemoryCipher } from "./core/cipher.js";
import { embeddingText } from "./core/content.js";
import type { Sql } from "./db/client.js";
import type { Embedder } from "./embed/embedder.js";
import {
  checkEncryptionKey,
  lockedEncryptionKeyId,
  openCodec,
  releaseEmbeddingModel,
  releaseEncryptionKey,
  setEmbeddingModel,
  setEncryptionKey,
} from "./store/bindings.js";
import { EncryptingCodec, PLAINTEXT } from "./store/codec.js";
import { MaintenanceStore } from "./store/maintenance.js";

/**
 * Offline, whole-database operations run by the CLI. They work on every project at once and on the
 * database's bindings, so they sit beside the service rather than in it.
 */

type Progress = (done: number) => void;

/**
 * Switches the database to `embedder`: drops the vector index, re-embeds every memory, then
 * binds the new model and rebuilds the index. Search is degraded (exact scan) while it runs.
 */
export async function reembed(
  sql: Sql,
  embedder: Embedder,
  encryptionKey?: Buffer,
  onProgress?: Progress,
): Promise<number> {
  const dim = await embedder.dimension();
  const store = new MaintenanceStore(sql, await openCodec(sql, encryptionKey));
  await releaseEmbeddingModel(sql);
  let done = 0;
  for await (const m of store.allContent()) {
    await store.setEmbedding(m.id, await embedder.embedDocument(embeddingText(m.title, m.body)));
    done++;
    onProgress?.(done);
  }
  await setEmbeddingModel(sql, embedder.id, dim);
  return done;
}

/**
 * Rewrites every memory not yet in the `target` mode (encrypt or decrypt).
 * Decrypting everything also forgets the key binding. Safe to re-run after an interruption.
 */
export async function convert(
  sql: Sql,
  encryptionKey: Buffer,
  target: "encrypted" | "plaintext",
  onProgress?: Progress,
): Promise<number> {
  const codec = new EncryptingCodec(new MemoryCipher(encryptionKey));
  await checkEncryptionKey(sql, codec.keyId);
  const encrypt = target === "encrypted";
  const reader = new MaintenanceStore(sql, codec);
  const writer = new MaintenanceStore(sql, encrypt ? codec : PLAINTEXT);
  let done = 0;
  // Each row is rewritten atomically, and rows already in the target mode are skipped, so a re-run resumes.
  for await (const m of reader.allContent(100, !encrypt)) {
    await writer.setContent(m);
    done++;
    onProgress?.(done);
  }
  if (!encrypt) await releaseEncryptionKey(sql);
  return done;
}

/**
 * Re-encrypts every encrypted memory from `currentKey` to `newKey`, in one transaction: an
 * interruption, a wrong key or an unreadable row leaves the database untouched, so it is never
 * half-rotated (rows don't record which key wrote them). Writers are locked out while it runs, and
 * a server still holding the old key is refused its next write once this commits. Returns the number
 * of memories rewritten, or 0 if the database is already on `newKey`.
 */
export async function rotateKey(sql: Sql, currentKey: Buffer, newKey: Buffer, onProgress?: Progress): Promise<number> {
  const from = new EncryptingCodec(new MemoryCipher(currentKey));
  const to = new EncryptingCodec(new MemoryCipher(newKey));
  if (from.keyId === to.keyId) throw new Error("the new encryption key is the same as the current one");

  // Already rotated (e.g. a re-run after success): nothing to do, and the old key is gone.
  if ((await lockedEncryptionKeyId(sql)) === to.keyId) return 0;
  await checkEncryptionKey(sql, from.keyId);

  let done = 0;
  await sql.begin(async (tx) => {
    // Re-read under the row lock, so two rotations can't interleave.
    const current = await lockedEncryptionKeyId(tx);
    if (current !== from.keyId) {
      throw new Error(`database is encrypted with key ${current} but the current key given is ${from.keyId}`);
    }
    const reader = new MaintenanceStore(tx, from);
    const writer = new MaintenanceStore(tx, to);
    await reader.lockAgainstWriters();
    // Rebind first, so the writer passes its own key-binding check.
    await setEncryptionKey(tx, to.keyId);
    // Authenticates every field on read: a row the old key can't open aborts the lot.
    for await (const m of reader.allContent(100, true)) {
      await writer.setContent(m);
      done++;
      onProgress?.(done);
    }
  });
  return done;
}
