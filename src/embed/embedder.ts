/** Turns text into unit-length vectors. Queries and documents may be encoded differently (asymmetric models). */
export interface Embedder {
  /** Stable identifier recorded in the database; changing it requires `axon reembed`. */
  readonly id: string;
  /** Resolves the output dimension, loading the model if needed. */
  dimension(): Promise<number>;
  embedQuery(text: string): Promise<number[]>;
  embedDocument(text: string): Promise<number[]>;
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}
