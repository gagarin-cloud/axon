import { z } from "zod";

export type ErrorCode = "invalid" | "not_found" | "conflict" | "rule";

/** A failure the caller can act on; the message is written for the agent. */
export class AxonError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/** Formats zod issues as one line, naming each offending field. */
export function describeIssues(err: z.ZodError): string {
  return err.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ");
}

/**
 * How a failure reaches a client, whatever the transport: bad input and rule violations carry a
 * message written for the agent; anything else is `internal`, and each transport decides how much
 * of its message to reveal.
 */
export function classifyError(err: unknown): { code: ErrorCode | "internal"; message: string } {
  if (err instanceof z.ZodError) return { code: "invalid", message: describeIssues(err) };
  if (err instanceof AxonError) return { code: err.code, message: err.message };
  return { code: "internal", message: err instanceof Error ? err.message : String(err) };
}
