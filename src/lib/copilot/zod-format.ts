/**
 * Pure ZodError formatting helpers. Lives in its own module — with NO
 * React or CopilotKit imports — so unit tests can exercise it without
 * pulling CopilotKit's CSS asset through the dependency graph.
 */

import type { ZodError } from "zod";

/**
 * Compress a `ZodError`'s issues into a single short line suitable
 * for a tool's structured-error `message` field.
 *
 *   "options: Array must contain at least 2 element(s) | mode: Invalid enum value"
 *
 * Issue path is `(root)` for top-level errors. We intentionally cap
 * the joined message at 500 characters — anything longer is going to
 * confuse the LLM more than it helps, and the full ZodError is still
 * available in dev tools / logs.
 */
export function formatZodIssues(error: ZodError): string {
  const MAX_LENGTH = 500;
  const joined = error.issues
    .map((i) => `${i.path.length === 0 ? "(root)" : i.path.join(".")}: ${i.message}`)
    .join(" | ");
  return joined.length <= MAX_LENGTH
    ? joined
    : `${joined.slice(0, MAX_LENGTH - 3)}...`;
}
