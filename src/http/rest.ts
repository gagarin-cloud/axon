import type { Context, Hono } from "hono";
import { AxonError, classifyError, type ErrorCode } from "../core/errors.js";
import {
  BriefingInput,
  DeleteProjectInput,
  ExportInput,
  GetInput,
  ImportInput,
  LinkInput,
  RelatedInput,
  RememberInput,
  ReviewInput,
  SearchInput,
  UpdateInput,
} from "../core/schemas.js";
import type { AxonService } from "../core/service.js";

/** createMcpHonoApp stashes a parsed JSON body under `parsedBody`. */
export type AppEnv = { Variables: { parsedBody?: unknown } };

const STATUS: Record<ErrorCode, 400 | 404 | 409 | 422> = {
  invalid: 400,
  not_found: 404,
  conflict: 409,
  rule: 422,
};

/** `?kinds=a,b&kinds=c` → ["a", "b", "c"] */
function list(c: Context<AppEnv>, name: string): string[] | undefined {
  const values = c.req
    .queries(name)
    ?.flatMap((v) => v.split(","))
    .map((v) => v.trim())
    .filter(Boolean);
  return values?.length ? values : undefined;
}

async function body(c: Context<AppEnv>): Promise<Record<string, unknown>> {
  const parsed = c.get("parsedBody") ?? (await c.req.json().catch(() => null));
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new AxonError("invalid", "Expected a JSON object body");
  }
  return parsed as Record<string, unknown>;
}

// Project slugs may contain "/" (acme/api), so the project segment is a greedy regex param.
const P = "/v1/projects/:project{.+}";

/**
 * Project-scoped JSON API mirroring the MCP tools. Budgeted reads also return `text`, the same
 * compact rendering agents get over MCP, ready to drop into a prompt.
 */
export function mountRest(app: Hono<AppEnv>, service: AxonService): void {
  app.get("/v1/projects", async (c) => c.json(await service.listProjects()));

  app.get(`${P}/briefing`, async (c) =>
    c.json(
      await service.briefing(
        BriefingInput.parse({
          project: c.req.param("project"),
          focus: c.req.query("focus") || undefined,
          paths: list(c, "paths"),
          budget_tokens: c.req.query("budget"),
        }),
      ),
    ),
  );

  app.get(`${P}/review`, async (c) =>
    c.json(
      await service.review(
        ReviewInput.parse({ project: c.req.param("project"), budget_tokens: c.req.query("budget") }),
      ),
    ),
  );

  app.get(`${P}/memories`, async (c) => {
    const project = c.req.param("project");
    const ids = list(c, "ids");
    const keys = list(c, "keys");
    if (ids || keys) return c.json(await service.get(GetInput.parse({ project, ids, keys })));
    return c.json(
      await service.search(
        SearchInput.parse({
          project,
          query: c.req.query("query") || undefined,
          k: c.req.query("k"),
          kinds: list(c, "kinds"),
          tags: list(c, "tags"),
          paths: list(c, "paths"),
          budget_tokens: c.req.query("budget"),
        }),
      ),
    );
  });

  app.post(`${P}/memories`, async (c) => {
    const result = await service.remember(RememberInput.parse({ ...(await body(c)), project: c.req.param("project") }));
    return c.json(result, result.saved ? 201 : 409);
  });

  app.get(`${P}/memories/:id{[0-9]+}`, async (c) => {
    const result = await service.get(GetInput.parse({ project: c.req.param("project"), ids: [c.req.param("id")] }));
    const [memory] = result.memories;
    if (!memory) throw new AxonError("not_found", `#${c.req.param("id")} not found`);
    return c.json({ memory, text: result.text });
  });

  app.patch(`${P}/memories/:id{[0-9]+}`, async (c) =>
    c.json(
      await service.update(
        UpdateInput.parse({ ...(await body(c)), project: c.req.param("project"), id: c.req.param("id") }),
      ),
    ),
  );

  app.get(`${P}/memories/:id{[0-9]+}/related`, async (c) =>
    c.json(
      await service.related(
        RelatedInput.parse({
          project: c.req.param("project"),
          id: c.req.param("id"),
          hops: c.req.query("hops"),
          budget_tokens: c.req.query("budget"),
        }),
      ),
    ),
  );

  app.post(`${P}/memories/:id{[0-9]+}/links`, async (c) =>
    c.json(
      await service.link(
        LinkInput.parse({ ...(await body(c)), project: c.req.param("project"), id: c.req.param("id"), remove: false }),
      ),
    ),
  );

  app.delete(`${P}/memories/:id{[0-9]+}/links/:other{[0-9]+}`, async (c) =>
    c.json(
      await service.link(
        LinkInput.parse({
          project: c.req.param("project"),
          id: c.req.param("id"),
          to: [c.req.param("other")],
          remove: true,
        }),
      ),
    ),
  );

  // A trailing /export or /import can't be mistaken for part of the slug: no other route ends that way,
  // and the greedy param backtracks to leave it, so `a/export/export` exports the project `a/export`.
  app.get(`${P}/export`, async (c) => {
    const result = await service.exportProject(
      ExportInput.parse({
        project: c.req.param("project"),
        format: c.req.query("format"),
        include: c.req.query("include"),
      }),
    );
    const json = result.format === "json";
    return c.body(result.text, 200, {
      "content-type": json ? "application/json; charset=UTF-8" : "text/markdown; charset=UTF-8",
      "content-disposition": `attachment; filename="${result.document.project.replaceAll("/", "-")}.axon.${json ? "json" : "md"}"`,
    });
  });

  // No body limit: a large import is legitimate. The body is parsed once, by the MCP app's middleware.
  app.post(`${P}/import`, async (c) =>
    c.json(
      await service.importProject(ImportInput.parse({ project: c.req.param("project"), document: await body(c) })),
      201,
    ),
  );

  // The greedy project param would swallow the link route above (whatever the order), so exclude its shape.
  app.delete("/v1/projects/:project{(?!.+/memories/[0-9]+/links/[0-9]+$).+}", async (c) =>
    c.json(await service.deleteProject(DeleteProjectInput.parse({ project: c.req.param("project") }))),
  );

  app.onError((err, c) => {
    const { code, message } = classifyError(err);
    if (code !== "internal") return c.json({ error: { code, message } }, STATUS[code]);
    console.error("[axon] request failed", c.req.method, c.req.path, err);
    // Unlike agent-facing errors, an internal one's message may name hosts or SQL; keep it in the log.
    return c.json({ error: { code, message: "Internal error" } }, 500);
  });
}
