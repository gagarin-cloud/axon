import { readdir, readFile } from "node:fs/promises";
import type { Sql } from "./client.js";

const MIGRATIONS_DIR = new URL("../../migrations/", import.meta.url);
const LOCK_ID = 0x6178_6f6e; // "axon"

/** Applies pending SQL migrations in filename order, each in its own transaction. Returns applied names. */
export async function migrate(sql: Sql): Promise<string[]> {
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();
  const applied: string[] = [];

  await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(${LOCK_ID})`;
    await tx`CREATE TABLE IF NOT EXISTS axon_migrations (
      name text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`;
    const done = new Set((await tx<{ name: string }[]>`SELECT name FROM axon_migrations`).map((r) => r.name));

    for (const file of files) {
      if (done.has(file)) continue;
      const body = await readFile(new URL(file, MIGRATIONS_DIR), "utf8");
      await tx.unsafe(body);
      await tx`INSERT INTO axon_migrations (name) VALUES (${file})`;
      applied.push(file);
    }
  });

  return applied;
}
