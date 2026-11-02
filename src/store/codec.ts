import type { EncryptedField, MemoryCipher } from "../core/cipher.js";
import type { MemoryContent } from "./types.js";

/** Memory text as stored, and whether it is ciphertext. */
export type SealedContent = MemoryContent & { encrypted: boolean };

/**
 * How a store writes and reads memory text: in plaintext, or encrypted with one key. Rows record
 * which mode wrote them, so reading takes the row's `encrypted` flag rather than the codec's mode.
 */
export interface ContentCodec {
  /** Fingerprint of the key this codec writes with; null when it writes plaintext. */
  readonly keyId: string | null;
  seal(projectId: string, content: MemoryContent): SealedContent;
  open(projectId: string, field: EncryptedField, value: string, encrypted: boolean): string;
}

/** Writes plaintext; reads plaintext rows only. */
export const PLAINTEXT: ContentCodec = {
  keyId: null,
  seal: (_projectId, c) => ({ title: c.title, body: c.body, source: c.source, encrypted: false }),
  open(_projectId, _field, value, encrypted) {
    if (encrypted) throw new Error("memory is encrypted but AXON_ENCRYPTION_KEY is not set");
    return value;
  },
};

/** Writes ciphertext with `cipher`; reads both plaintext rows and rows that key encrypted. */
export class EncryptingCodec implements ContentCodec {
  readonly keyId: string;

  constructor(private readonly cipher: MemoryCipher) {
    this.keyId = cipher.keyId;
  }

  seal(projectId: string, c: MemoryContent): SealedContent {
    return {
      title: this.cipher.encrypt(projectId, "title", c.title),
      body: this.cipher.encrypt(projectId, "body", c.body),
      source: c.source === null ? null : this.cipher.encrypt(projectId, "source", c.source),
      encrypted: true,
    };
  }

  open(projectId: string, field: EncryptedField, value: string, encrypted: boolean): string {
    return encrypted ? this.cipher.decrypt(projectId, field, value) : value;
  }
}

export function codecFor(cipher: MemoryCipher | null): ContentCodec {
  return cipher ? new EncryptingCodec(cipher) : PLAINTEXT;
}

/** Title, body and source as plaintext, whichever mode the row was written in. */
export function openContent(
  codec: ContentCodec,
  projectId: string,
  c: MemoryContent,
  encrypted: boolean,
): MemoryContent {
  if (!encrypted) return { title: c.title, body: c.body, source: c.source };
  return {
    title: codec.open(projectId, "title", c.title, true),
    body: codec.open(projectId, "body", c.body, true),
    source: c.source === null ? null : codec.open(projectId, "source", c.source, true),
  };
}
