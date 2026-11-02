import { createHash } from "node:crypto";
import type { Embedder } from "./embedder.js";

/**
 * Deterministic bag-of-words embedder for tests: each lowercased word hashes to a few signed
 * dimensions, so texts sharing words are similar and identical texts are identical.
 */
export class FakeEmbedder implements Embedder {
  readonly id: string;

  constructor(private readonly dim = 64) {
    this.id = `fake-${dim}`;
  }

  async dimension(): Promise<number> {
    return this.dim;
  }

  async embedQuery(text: string): Promise<number[]> {
    return this.vector(text);
  }

  async embedDocument(text: string): Promise<number[]> {
    return this.vector(text);
  }

  private vector(text: string): number[] {
    const v = new Array<number>(this.dim).fill(0);
    for (const word of text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []) {
      const h = createHash("sha256").update(word).digest();
      for (let i = 0; i < 3; i++) {
        const idx = h.readUInt16BE(i * 2) % this.dim;
        v[idx] = (v[idx] ?? 0) + ((h[8 + i] ?? 0) & 1 ? 1 : -1);
      }
    }
    const norm = Math.hypot(...v) || 1;
    return v.map((x) => x / norm);
  }
}
