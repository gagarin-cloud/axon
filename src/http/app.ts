import { createMcpHonoApp } from "@modelcontextprotocol/hono";
import { createMcpHandler } from "@modelcontextprotocol/server";
import type { Hono } from "hono";
import type { AxonService } from "../core/service.js";
import { mcpServerFactory } from "../mcp/server.js";
import { type AppEnv, mountRest } from "./rest.js";

/**
 * One HTTP app: the REST API under /v1 and MCP (Streamable HTTP, stateless) at /mcp.
 * Bound to localhost, the app rejects foreign Host/Origin headers (DNS-rebinding protection) —
 * there is no auth, so anything that can reach the port can read and write memories.
 */
export function createApp(service: AxonService, opts: { host: string; defaultProject?: string }) {
  // createMcpHonoApp is typed as a plain `Hono`, though its middleware sets `parsedBody` on every
  // JSON request; the cast records that variable so `c.get("parsedBody")` type-checks downstream.
  const app = createMcpHonoApp({ host: opts.host }) as unknown as Hono<AppEnv>;
  const mcp = createMcpHandler(mcpServerFactory(service, opts.defaultProject));

  // Readiness means the database answers: a pod that cannot reach it must not take traffic.
  app.get("/healthz", async (c) => {
    const embedder = service.embedderId;
    try {
      await service.ping();
      return c.json({ ok: true, embedder, db: "ok" });
    } catch (err) {
      console.error("[axon] healthz: database check failed", err);
      // Only the error's code/name: the driver's message can carry host, port and user.
      const { code, name } = err as { code?: unknown; name?: unknown };
      const db = typeof code === "string" ? code : typeof name === "string" ? name : "error";
      return c.json({ ok: false, embedder, db }, 503);
    }
  });
  app.all("/mcp", (c) => mcp.fetch(c.req.raw, { parsedBody: c.get("parsedBody") }));
  mountRest(app, service);

  return { app, close: () => mcp.close() };
}
