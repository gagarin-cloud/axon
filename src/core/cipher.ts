import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** Memory fields that are encrypted at rest. */
export type EncryptedField = "title" | "body" | "source";

/**
 * AES-256-GCM for memory text. Ciphertext is base64(iv | ciphertext | tag); the project id and field
 * name are bound as associated data, so a value can't be moved to another project or field.
 */
export class MemoryCipher {
  /** Short fingerprint of the key, recorded in the database to catch a wrong key at startup. */
  readonly keyId: string;

  constructor(private readonly key: Buffer) {
    if (key.length !== 32) throw new Error("encryption key must be 32 bytes");
    this.keyId = createHmac("sha256", key).update("axon key id").digest("hex").slice(0, 16);
  }

  encrypt(projectId: string, field: EncryptedField, plaintext: string): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, this.key, iv);
    cipher.setAAD(aad(projectId, field));
    const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return Buffer.concat([iv, ct, cipher.getAuthTag()]).toString("base64");
  }

  decrypt(projectId: string, field: EncryptedField, encoded: string): string {
    const buf = Buffer.from(encoded, "base64");
    if (buf.length < IV_BYTES + TAG_BYTES) throw new Error(`cannot decrypt memory ${field}: ciphertext too short`);
    const decipher = createDecipheriv(ALGORITHM, this.key, buf.subarray(0, IV_BYTES));
    decipher.setAAD(aad(projectId, field));
    decipher.setAuthTag(buf.subarray(buf.length - TAG_BYTES));
    try {
      return Buffer.concat([
        decipher.update(buf.subarray(IV_BYTES, buf.length - TAG_BYTES)),
        decipher.final(),
      ]).toString("utf8");
    } catch {
      throw new Error(`cannot decrypt memory ${field}: wrong key or corrupted data`);
    }
  }
}

function aad(projectId: string, field: EncryptedField): Buffer {
  return Buffer.from(`axon:v1:${projectId}:${field}`, "utf8");
}
