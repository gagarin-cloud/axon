import { fromJsonSchema, type JsonSchemaType, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { classifyError } from "../core/errors.js";
import {
  BriefingInput,
  GetInput,
  LinkInput,
  project,
  RelatedInput,
  RememberInput,
  ReviewInput,
  SearchInput,
  UpdateInput,
} from "../core/schemas.js";
import type { AxonService } from "../core/service.js";
import { VERSION } from "../version.js";

// Tool definitions are paid for in every session's context, so descriptions stay terse.
const INSTRUCTIONS = `Axon holds durable, per-project memories. Start work on a project with \`briefing\`; \`search\` before exploring code; follow ↔ links with \`related\`. \`remember\` anything a future session would otherwise have to rediscover (one fact per memory, in English); \`update\` or supersede memories that are wrong or stale.`;

/** Constraint keywords the model doesn't need to read; the server still enforces them on every call. */
const ENFORCED_SERVER_SIDE = new Set([
  "$schema",
  "pattern",
  "minLength",
  "maxLength",
  "minimum",
  "maximum",
  "minItems",
  "maxItems",
  "additionalProperties",
]);

/**
 * The JSON Schema advertised to clients: types, enums, defaults and descriptions only. Validation
 * happens against the full zod schema inside the handler, so dropping constraints from the
 * advertised schema saves about a third of the tool-definition tokens without loosening anything.
 */
function advertised(schema: z.ZodType) {
  const prune = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(prune);
    if (node === null || typeof node !== "object") return node;
    return Object.fromEntries(
      Object.entries(node)
        .filter(([k]) => !ENFORCED_SERVER_SIDE.has(k))
        .map(([k, v]) => [
          k,
          k === "properties" ? Object.fromEntries(Object.entries(v).map(([p, s]) => [p, prune(s)])) : prune(v),
        ]),
    );
  };
  return fromJsonSchema(prune(z.toJSONSchema(schema, { io: "input" })) as JsonSchemaType);
}

/**
 * Builds the MCP server factory. With a default project configured, `project` becomes optional on
 * every tool — handy for stdio servers configured per repository.
 */
export function mcpServerFactory(service: AxonService, defaultProject?: string) {
  // Rebuilt from the shape rather than extended: zod refuses to extend a schema with refinements
  // (GetInput), and the advertised schema only needs the fields.
  const advertise = (schema: z.ZodObject) =>
    advertised(
      defaultProject
        ? z.object({
            ...schema.shape,
            project: project.optional().describe(`Project slug (default ${defaultProject})`),
          })
        : schema,
    );
  const withDefault = (args: unknown) => ({ project: defaultProject, ...(args as object) });

  return () => {
    const server = new McpServer({ name: "axon", version: VERSION }, { instructions: INSTRUCTIONS });

    const tool = <S extends z.ZodObject>(
      name: string,
      description: string,
      schema: S,
      annotations: { readOnlyHint?: boolean; idempotentHint?: boolean },
      run: (args: z.infer<S>) => Promise<{ text: string }>,
    ) => {
      server.registerTool(name, { description, inputSchema: advertise(schema), annotations }, async (args: unknown) => {
        const text = (t: string, isError = false) => ({ content: [{ type: "text" as const, text: t }], isError });
        try {
          return text((await run(schema.parse(withDefault(args)))).text);
        } catch (err) {
          const { code, message } = classifyError(err);
          if (code === "internal") console.error("[axon] tool error", name, err);
          const prefix =
            err instanceof z.ZodError ? "Invalid arguments: " : code === "internal" ? "Internal error: " : "";
          return text(prefix + message, true);
        }
      });
    };

    const read = { readOnlyHint: true };

    tool(
      "briefing",
      "Project primer packed to a token budget: pinned and top-ranked memories in full, the rest as index lines, plus what changed in the last 7 days. `focus` and `paths` tailor it to your task. Call first when starting on a project.",
      BriefingInput,
      read,
      (a) => service.briefing(a),
    );
    tool(
      "search",
      "Hybrid semantic + keyword search over a project's memories. Top hits in full, rest as index lines, plus linked neighbours.",
      SearchInput,
      read,
      (a) => service.search(a),
    );
    tool("get", "Read memories in full by id or key.", GetInput, read, (a) => service.get(a));
    tool(
      "related",
      "Follow ↔ links from a memory: associated memories within N hops, nearest first.",
      RelatedInput,
      read,
      (a) => service.related(a),
    );
    tool(
      "remember",
      "Save one durable fact, decision, convention or gotcha. With key, replaces the memory holding that key. Refuses near-duplicates (returns them) unless force.",
      RememberInput,
      {},
      (a) => service.remember(a),
    );
    tool(
      "update",
      "Edit a memory's fields, pin/unpin it, archive it (status=archived), confirm it still holds, or dispute it as probably wrong. Editing title/body also confirms it.",
      UpdateInput,
      { idempotentHint: true },
      (a) => service.update(a),
    );
    tool(
      "link",
      "Associate a memory with others (undirected), or unlink with remove=true.",
      LinkInput,
      { idempotentHint: true },
      (a) => service.link(a),
    );
    tool(
      "review",
      "Housekeeping report: near-duplicates, orphans, oversized, stale, unread and disputed memories, and distance to the cap.",
      ReviewInput,
      read,
      (a) => service.review(a),
    );
    tool("list_projects", "Projects with memory and link counts.", z.object({}), read, () => service.listProjects());

    return server;
  };
}
