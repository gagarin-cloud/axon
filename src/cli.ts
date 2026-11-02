#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { text } from "node:stream/consumers";
import { parseArgs } from "node:util";
import { serve } from "@hono/node-server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import { loadConfig } from "./config.js";
import { describeIssues } from "./core/errors.js";
import { ExportInput, ImportInput } from "./core/schemas.js";
import { AxonService } from "./core/service.js";
import { connect } from "./db/client.js";
import { migrate } from "./db/migrate.js";
import type { Embedder } from "./embed/embedder.js";
import { FakeEmbedder } from "./embed/fake.js";
import { TransformersEmbedder } from "./embed/transformers.js";
import { createApp } from "./http/app.js";
import { convert, reembed, rotateKey } from "./maintenance.js";
import { mcpServerFactory } from "./mcp/server.js";

const USAGE = `axon — per-project memory for AI agents

  axon serve [--stdio]      HTTP server (REST /v1 + MCP /mcp), or MCP over stdio
  axon migrate              apply database migrations
  axon reembed              re-embed all memories with the configured model
  axon encrypt              encrypt every plaintext memory with AXON_ENCRYPTION_KEY
  axon decrypt              decrypt every encrypted memory (then unset AXON_ENCRYPTION_KEY)
  axon rotate-key           re-encrypt everything from AXON_ENCRYPTION_KEY to AXON_ENCRYPTION_KEY_NEW
  axon export <project> [--format json|markdown] [--active]
                            write a project to stdout (--active: leave out archived and superseded)
  axon import <project> [file]
                            append an exported JSON document (file, or stdin) to a project
  axon eval [--golden f]    retrieval quality on a golden set (recall@k, MRR)
  axon warmup               download and load the embedding model (no database needed)

  --fake                    use a deterministic test embedder instead of the model

Configuration is read from the environment; see .env.example.`;

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    stdio: { type: "boolean", default: false },
    golden: { type: "string" },
    format: { type: "string" },
    active: { type: "boolean", default: false },
    fake: { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
});

const command = positionals[0];
if (values.help || !command) {
  console.error(USAGE);
  process.exit(command ? 0 : 1);
}

// stdout carries the MCP protocol in stdio mode; keep every log on stderr.
if (values.stdio) console.log = console.error;

try {
  process.loadEnvFile(); // .env in the working directory, if present
} catch {}

const config = loadConfig();
const sql = connect(config.databaseUrl);
const embedder = (): Embedder =>
  values.fake ? new FakeEmbedder() : new TransformersEmbedder(config.embedModel, config.embedDtype, config.modelDir);

interface Command {
  /** Applies pending migrations before running (default true). */
  migrate?: boolean;
  /** Keeps serving after `run` returns, so the runner leaves the connection open. */
  daemon?: boolean;
  run(): Promise<void>;
}

/** Every 50 rows, so a long rewrite shows it is alive. */
const progress = (done: number) => {
  if (done % 50 === 0) console.error(`${done}…`);
};

function need<T>(value: T | undefined, message: string): T {
  if (value === undefined) throw new Error(message);
  return value;
}

const projectArg = () =>
  need(positionals[1], `usage: axon ${command} <project>${command === "import" ? " [file]" : ""}`);

const convertAll = (target: "encrypted" | "plaintext"): Command => ({
  async run() {
    const key = need(config.encryptionKey, `AXON_ENCRYPTION_KEY is required to ${command}`);
    const n = await convert(sql, key, target, progress);
    console.error(`${command}ed ${n} memories`);
    if (target === "plaintext") {
      console.error("unset AXON_ENCRYPTION_KEY now, or new and edited memories will be encrypted again");
    }
  },
});

const commands: Record<string, Command> = {
  migrate: {
    migrate: false,
    async run() {
      const applied = await migrate(sql);
      console.error(applied.length ? `applied ${applied.join(", ")}` : "up to date");
    },
  },

  reembed: {
    async run() {
      const n = await reembed(sql, embedder(), config.encryptionKey, progress);
      console.error(`re-embedded ${n} memories`);
    },
  },

  encrypt: convertAll("encrypted"),
  decrypt: convertAll("plaintext"),

  "rotate-key": {
    async run() {
      const current = need(config.encryptionKey, "AXON_ENCRYPTION_KEY (the current key) is required to rotate-key");
      const next = need(config.newEncryptionKey, "AXON_ENCRYPTION_KEY_NEW (the key to rotate to) is required");
      const n = await rotateKey(sql, current, next, progress);
      console.error(`rotated ${n} memories`);
      console.error("set AXON_ENCRYPTION_KEY to the new key, remove AXON_ENCRYPTION_KEY_NEW, then restart axon");
    },
  },

  export: {
    async run() {
      const project = projectArg();
      const service = await AxonService.create(sql, embedder(), config);
      const input = ExportInput.parse({ project, format: values.format, include: values.active ? "active" : "all" });
      process.stdout.write((await service.exportProject(input)).text);
    },
  },

  import: {
    async run() {
      const project = projectArg();
      const service = await AxonService.create(sql, embedder(), config);
      const file = positionals[2];
      const raw = file ? await readFile(file, "utf8") : await text(process.stdin);
      let document: unknown;
      try {
        document = JSON.parse(raw);
      } catch (err) {
        throw new Error(`${file ?? "stdin"} is not JSON: ${err instanceof Error ? err.message : err}`);
      }
      const result = await service.importProject(ImportInput.parse({ project, document }));
      console.error(result.text);
      // The mapping on stdout, for scripts that need to translate old ids.
      process.stdout.write(
        `${JSON.stringify({ imported: result.imported, links: result.links, mapping: result.mapping })}\n`,
      );
    },
  },

  warmup: {
    migrate: false,
    async run() {
      const e = embedder();
      console.error(`${e.id}: ${await e.dimension()} dimensions`);
    },
  },

  eval: {
    migrate: false,
    async run() {
      const { runEval } = await import("./eval/run.js");
      await runEval({ sql, embedder: embedder(), config, golden: values.golden });
    },
  },

  serve: {
    daemon: true,
    async run() {
      const started = performance.now();
      const service = await AxonService.create(sql, embedder(), config);
      console.error(`[axon] ${service.embedderId} ready in ${Math.round(performance.now() - started)}ms`);

      const close = values.stdio ? serveMcpStdio(service) : serveHttp(service);
      const stop = async () => {
        await close();
        await sql.end();
        process.exit(0);
      };
      if (values.stdio) process.stdin.on("end", stop);
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
    },
  },
};

/** Serves MCP over stdin/stdout; returns how to shut it down. */
function serveMcpStdio(service: AxonService): () => Promise<void> {
  const handle = serveStdio(mcpServerFactory(service, config.defaultProject));
  return () => handle.close();
}

/** Starts the HTTP server; returns how to shut it down. */
function serveHttp(service: AxonService): () => Promise<void> {
  const { app, close } = createApp(service, { host: config.httpHost, defaultProject: config.defaultProject });
  const server = serve({ fetch: app.fetch, hostname: config.httpHost, port: config.httpPort }, (info) =>
    console.error(`[axon] listening on http://${info.address}:${info.port} (REST /v1, MCP /mcp)`),
  );
  return async () => {
    server.close();
    await close();
  };
}

async function main() {
  const cmd = commands[command as string];
  if (!cmd) {
    console.error(`unknown command: ${command}\n\n${USAGE}`);
    process.exit(1);
  }
  if (cmd.migrate !== false) await migrate(sql);
  await cmd.run();
  if (!cmd.daemon) await sql.end();
}

main().catch(async (err) => {
  console.error(`[axon] ${err instanceof z.ZodError ? describeIssues(err) : err instanceof Error ? err.message : err}`);
  await sql.end({ timeout: 1 });
  process.exit(1);
});
