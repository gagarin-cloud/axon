import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { AxonService } from "../src/core/service.js";
import { connect, type Sql, siblingDatabase } from "../src/db/client.js";
import { migrate } from "../src/db/migrate.js";
import { FakeEmbedder } from "../src/embed/fake.js";
import { reembed } from "../src/maintenance.js";
import { releaseEmbeddingModel } from "../src/store/bindings.js";
import { mem } from "./helpers.js";

// Own scratch database: these tests rebind the model, which would disturb the shared test database.
let sql: Sql;
const config = loadConfig();

beforeAll(async () => {
  sql = connect(await siblingDatabase(config.databaseUrl, "test_embed"));
  await migrate(sql);
  await sql`DELETE FROM projects`;
  await releaseEmbeddingModel(sql);
});
afterAll(async () => {
  await sql`DELETE FROM projects`;
  await sql.end();
});

describe("embedding model binding", () => {
  it("refuses a different model until reembed switches the database over", async () => {
    const v1 = await AxonService.create(sql, new FakeEmbedder(64), config);
    await v1.remember(mem("embed/p", "Queues", "rabbitmq carries order events"));
    await v1.remember(mem("embed/p", "Cache", "redis caches product pages"));

    await expect(AxonService.create(sql, new FakeEmbedder(32), config)).rejects.toThrow(/reembed/);

    expect(await reembed(sql, new FakeEmbedder(32))).toBe(2);
    const v2 = await AxonService.create(sql, new FakeEmbedder(32), config);
    const hits = await v2.search({ project: "embed/p", query: "rabbitmq order events", k: 5, budget_tokens: 1000 });
    expect(hits.hits[0]?.memory.title).toBe("Queues");

    await expect(AxonService.create(sql, new FakeEmbedder(64), config)).rejects.toThrow(/reembed/);

    const [index] = await sql<{ def: string }[]>`
      SELECT indexdef AS def FROM pg_indexes WHERE indexname = 'memories_embedding_hnsw'`;
    expect(index?.def).toContain("vector(32)");
  });
});
