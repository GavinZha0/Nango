/**
 * Shared tool-result status detection.
 *
 * Tool-call results in Nango carry either an MCP-style `isError` flag
 * (MCP protocol standard + the `wrapToolExecute` fallback shape from
 * `src/lib/runner/tool-failure.ts`) or an internal `ok` flag (supervisor
 * tools, data-source extract, skills, etc.). This module is the single
 * source of truth for "is this tool result success or failure", consumed
 * by both the admin run-detail timeline and the chat tool-call cards.
 *
 * Keep this module:
 *   - **client-safe** (no `import "server-only"`, no DB/fs)
 *   - **dependency-free** beyond TypeScript built-ins, so it works in
 *     the React tree without bundle bloat.
 */

/**
 * Four-way: explicit success, explicit failure, warning (protocol/
 * system anomaly that is NOT a business failure), or "not reported".
 *
 * Why a `warning` state separate from `failure`?
 *
 * Some `isError: true` results carry a `severity: "warning"` tag,
 * meaning "we don't have a real tool result to show but the run did
 * not necessarily fail". The canonical case is history replay where
 * `tool_call_result` was never persisted (frontend tools, crashes
 * mid-run, etc.) — `event-reconstruction.ts` synthesises a placeholder
 * tagged `severity: "warning"`. Without this state, the UI would
 * either claim a fake "Done" (misleading) or a fake "Error" (alarming
 * for what's just missing telemetry).
 */
export type ToolResultStatus = "success" | "failure" | "warning" | null;

/**
 * Inspect a tool-call result string and classify it.
 *
 * Recognises (in priority order):
 *   - MCP protocol:   `{ isError: bool, content, structuredContent }`
 *   - Nango wrapper:  `{ isError: true, message, toolName }` (from
 *                     `wrapToolExecute` when an `execute` throws)
 *   - Synthetic warn: `{ isError: true, severity: "warning", message }`
 *                     (system-layer anomalies, see ToolResultStatus
 *                     docstring)
 *   - Business shape: `{ ok: bool, ... }` (supervisor / extract /
 *                     skills / etc.)
 *   - Process result: `{ exitCode: number, stdout, stderr, … }`
 *                     (`run_code_in_sandbox` and future shell-like
 *                     tools — non-zero exitCode is failure, zero is
 *                     success). The check runs ONLY when neither
 *                     `isError` nor `ok` is present, so a tool that
 *                     wraps a sandbox call and emits its own
 *                     `{ ok: false }` keeps that classification.
 *
 * Mirrors the envelope shapes recognised by
 * `lib/artifacts/coalesce-tool-calls.ts::isFailedEnvelope` so the
 * chat-side card, the admin event timeline, and the save-pipeline
 * filter all agree on what counts as a failed tool call.
 *
 * Returns `null` when:
 *   - input is empty/undefined
 *   - input is not valid JSON
 *   - parsed value is not a plain object
 *   - parsed object carries none of `isError` / `ok` / numeric
 *     `exitCode` — the tool didn't tell us, so we don't guess.
 */
export function detectToolResultStatus(
  result: string | null | undefined,
): ToolResultStatus {
  if (!result) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(result);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;
  // MCP-style first — both protocol and wrapper failures use this field.
  if (obj.isError === true) {
    // Explicit severity tag (`event-reconstruction`'s synthetic
    // results) downgrades a hard `failure` to a `warning`. Anything
    // else, including missing severity, defaults to `failure` so old
    // `wrapToolExecute` payloads keep their classification.
    return obj.severity === "warning" ? "warning" : "failure";
  }
  if (obj.isError === false) return "success";
  // Business `ok` flag — supervisor tools, extract_dataset_by_sql, etc.
  if (obj.ok === false) return "failure";
  if (obj.ok === true) return "success";
  // Process-result envelope — only consulted when no semantic envelope
  // was present. A non-numeric / absent `exitCode` is ignored to avoid
  // catching unrelated numeric fields on other tools' results.
  if (typeof obj.exitCode === "number") {
    return obj.exitCode === 0 ? "success" : "failure";
  }
  return null;
}

/**
 * Extract a human-readable error message from a failure result.
 *
 * Attempts (in priority order):
 *   1. top-level `message` string         — wrapper fallback shape
 *   2. top-level `error` string           — simple business failures
 *   3. nested `error.message` string      — structured business failures
 *      (e.g. extract_dataset_by_sql `{ ok: false, error: { code, message } }`)
 *   4. MCP `content[].text` joined        — protocol-level error payload
 *   5. top-level `stderr` string          — process-result envelope
 *      fallback (`run_code_in_sandbox`'s Python tracebacks land here)
 *
 * Returns `null` if none of those produce a non-empty string. Callers
 * fall back to a generic "Tool failed" label.
 *
 * The `stderr` fallback is last so a tool that returns BOTH a
 * structured `message` AND raw `stderr` (defensive future shape)
 * prefers the curated message — the raw subprocess output is the
 * diagnostic of last resort.
 *
 * NOTE: This function does not itself check whether the result is a
 * failure — caller should pair it with {@link detectToolResultStatus}
 * to avoid extracting an "error message" out of a successful result
 * that happens to have a `message` field.
 */
export function extractErrorMessage(
  result: string | null | undefined,
): string | null {
  if (!result) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(result);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;

  if (typeof obj.message === "string" && obj.message.length > 0) {
    return obj.message;
  }
  if (typeof obj.error === "string" && obj.error.length > 0) {
    return obj.error;
  }
  if (obj.error && typeof obj.error === "object") {
    const err = obj.error as Record<string, unknown>;
    if (typeof err.message === "string" && err.message.length > 0) {
      return err.message;
    }
  }
  if (Array.isArray(obj.content)) {
    const texts: string[] = [];
    for (const c of obj.content) {
      if (
        typeof c === "object" &&
        c !== null &&
        (c as Record<string, unknown>).type === "text" &&
        typeof (c as Record<string, unknown>).text === "string"
      ) {
        texts.push((c as Record<string, unknown>).text as string);
      }
    }
    if (texts.length > 0) return texts.join("\n");
  }
  // Process-result envelope last — surfaces subprocess stderr
  // (Python tracebacks, ModuleNotFoundError, OOM) as the failure
  // message when no curated field is available.
  if (typeof obj.stderr === "string" && obj.stderr.length > 0) {
    return obj.stderr;
  }
  return null;
}
