import { randomUUID } from "node:crypto";
import { loadConfig } from "../src/config.js";
import { AxonService } from "../src/core/service.js";
import { connect, type Sql, siblingDatabase } from "../src/db/client.js";
import { migrate } from "../src/db/migrate.js";
import { FakeEmbedder } from "../src/embed/fake.js";
import { releaseEmbeddingModel } from "../src/store/bindings.js";

/**
 * A service over the `<db>_test` scratch database with the deterministic fake embedder.
 * Needs the compose Postgres (`docker compose up -d db`).
 */
export async function setup(): Promise<{ sql: Sql; service: AxonService; config: ReturnType<typeof loadConfig> }> {
  const base = loadConfig();
  const config = { ...base, databaseUrl: await siblingDatabase(base.databaseUrl, "test"), maxLinks: 4 };
  const sql = connect(config.databaseUrl);
  await migrate(sql);
  await releaseEmbeddingModel(sql);
  const service = await AxonService.create(sql, new FakeEmbedder(), config);
  return { sql, service, config };
}

/** A fresh project slug, so tests never see each other's memories. */
export function slug(): string {
  return `test/${randomUUID().slice(0, 8)}`;
}

export const mem = (project: string, title: string, body: string, extra: Record<string, unknown> = {}) => ({
  project,
  kind: "gotcha" as const,
  title,
  body,
  tags: [],
  paths: [],
  pinned: false,
  importance: 3,
  force: false,
  ...extra,
});
