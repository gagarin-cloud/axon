import pgvector from "pgvector";
import type { Tx } from "../db/client.js";
import { keyStillBound, rotatedError } from "./bindings.js";
import { type ContentCodec, openContent } from "./codec.js";
import type { MemoryContent } from "./types.js";

/** A memory's text, decrypted, with the internal id and project it is bound to. */
export type ContentRow = MemoryContent & { id: number; projectId: string };

/**
 * Whole-database rewrites for the offline commands (reembed, encrypt/decrypt, rotate-key). Rows are
 * addressed by internal id across every project; reads open text whichever mode wrote it, and writes
 * seal it with this store's codec.
 */
export class MaintenanceStore {
  constructor(
    private readonly sql: Tx,
    private readonly codec: ContentCodec,
  ) {}

  /**
   * Streams every memory's decrypted text in id order, optionally only rows in one mode. Paging by id
   * means rows rewritten along the way are never revisited.
   */
  async *allContent(batch = 100, encrypted?: boolean): AsyncGenerator<ContentRow> {
    let after = 0;
    for (;;) {
      const rows = await this.sql<(ContentRow & { encrypted: boolean })[]>`
        SELECT id, project_id, title, body, source, encrypted FROM memories
        WHERE id > ${after} ${encrypted === undefined ? this.sql`` : this.sql`AND encrypted = ${encrypted}`}
        ORDER BY id LIMIT ${batch}`;
      if (rows.length === 0) return;
      for (const { encrypted: enc, ...r } of rows) yield { ...r, ...openContent(this.codec, r.projectId, r, enc) };
      after = rows[rows.length - 1]?.id ?? after;
    }
  }

  /** Rewrites a memory's text in this store's mode, leaving `updated_at` alone. */
  async setContent(row: ContentRow): Promise<void> {
    const c = this.codec.seal(row.projectId, row);
    const res = await this.sql`
      UPDATE memories SET title = ${c.title}, body = ${c.body}, source = ${c.source}, encrypted = ${c.encrypted}
      WHERE id = ${row.id} AND ${keyStillBound(this.sql, this.codec.keyId)}`;
    if (res.count === 0) throw rotatedError();
  }

  /** Stores a vector. The column is untyped, so this works mid-switch between models of different dimensions. */
  async setEmbedding(id: number, embedding: number[]): Promise<void> {
    await this.sql`UPDATE memories SET embedding = ${pgvector.toSql(embedding)}::vector WHERE id = ${id}`;
  }

  /** Keeps writers out of `memories` until the transaction ends; readers carry on. */
  async lockAgainstWriters(): Promise<void> {
    await this.sql`LOCK TABLE memories IN SHARE ROW EXCLUSIVE MODE`;
  }
}
