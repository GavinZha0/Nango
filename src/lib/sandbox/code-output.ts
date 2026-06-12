/**
 * CodeOutputEnvelope — standard output contract for all sandbox-executed
 * code: workflow code nodes, run_code_in_sandbox tool, run_skill_script tool.
 *
 * Python output convention (enforced via tool description / LLM prompt):
 *
 *   print(json.dumps({
 *     "rows":    [{"col1": val, ...}, ...],   # structured data, always array
 *     "message": "Human-readable description",
 *     "files":   ["output.csv"]               # generated files (future)
 *   }))
 *   # Use sys.stderr for debug logging — it does not affect ok.
 *
 * assembleCodeOutput() is the single conversion point shared by every consumer.
 * See docs/workflow-spec.md (code node output convention).
 */

import type { SandboxOutput } from "./types";

// ─── Types ─────────────────────────────────────────────────────────────

/**
 * Minimal shape accepted by assembleCodeOutput. Both SandboxOutput
 * (used by the tool layer) and CodeRunResult (used by the workflow engine)
 * satisfy this interface structurally.
 */
export interface RawCodeResult {
  stdout:     string;
  stderr:     string;
  exitCode:   number;
  durationMs: number;
}

/**
 * Structured output envelope returned by all code execution tools and the
 * workflow code-node executor.
 *
 * Downstream workflow nodes reference fields via @nodes.X.<field> syntax:
 *   @nodes.1.rows       — structured data array for chart/code nodes
 *   @nodes.1.message    — human-readable summary for agent context
 *   @nodes.1.row_count  — row count for conditional logic
 */
export interface CodeOutputEnvelope {
  /** True when the sandbox process exited with code 0. */
  ok:          boolean;

  /** Wall-clock execution time in milliseconds. */
  duration_ms: number;

  /**
   * Structured output data — always an array of plain objects, or null.
   * Populated from the "rows" key in the stdout JSON.
   * For chart nodes: inputs.dataset = "@nodes.X.rows"
   */
  rows:        Record<string, unknown>[] | null;

  /** rows.length, or null when rows is null. */
  row_count:   number | null;

  /**
   * Per-column type metadata inferred from rows[0].
   * Shape: { colName: { type: "string"|"number"|"boolean"|"object"|"array" } }
   * Null when rows is null, empty, or rows[0] is not a plain object.
   */
  row_schema:  Record<string, unknown> | null;

  /**
   * Human-readable description from the "message" key in stdout JSON.
   * Falls back to the raw stdout content when stdout is not valid JSON.
   * Null when stdout is empty and no message key was found.
   */
  message:     string | null;

  /**
   * File names listed in the "files" key in stdout JSON.
   * Reserved for future file-output support; null when absent or empty.
   */
  files:       string[] | null;

  /**
   * Error text when ok=false (from stderr, or a fallback exit-code message).
   * Always null when ok=true.
   */
  error:       string | null;
}

// ─── Assembly ──────────────────────────────────────────────────────────

/**
 * Assemble a CodeOutputEnvelope from a raw sandbox execution result.
 *
 * Accepts both `SandboxOutput` (tool layer) and `CodeRunResult` (workflow
 * engine) since both satisfy `RawCodeResult` structurally.
 *
 * Parsing rules (when ok=true):
 *   1. stdout is a JSON object with our convention keys → extract rows/message/files
 *   2. stdout is not a valid JSON object → message = raw stdout (soft fallback)
 *
 * When ok=false: error = stderr content, all data fields are null.
 */
export function assembleCodeOutput(raw: RawCodeResult): CodeOutputEnvelope {
  const ok = raw.exitCode === 0;
  const duration_ms = raw.durationMs;

  if (!ok) {
    const errorText =
      raw.stderr.trim().length > 0
        ? raw.stderr.trim()
        : `Process exited with code ${raw.exitCode}`;
    return {
      ok,
      duration_ms,
      rows: null,
      row_count: null,
      row_schema: null,
      message: null,
      files: null,
      error: errorText,
    };
  }

  // Try to parse stdout as a JSON object conforming to the output convention.
  let parsed: Record<string, unknown> | null = null;
  try {
    const candidate: unknown = JSON.parse(raw.stdout);
    if (
      candidate !== null &&
      typeof candidate === "object" &&
      !Array.isArray(candidate)
    ) {
      parsed = candidate as Record<string, unknown>;
    }
  } catch {
    // stdout is not valid JSON — fall back to message = raw stdout.
  }

  if (parsed === null) {
    return {
      ok,
      duration_ms,
      rows: null,
      row_count: null,
      row_schema: null,
      message: raw.stdout.length > 0 ? raw.stdout : null,
      files: null,
      error: null,
    };
  }

  const rows = extractRows(parsed.rows);
  return {
    ok,
    duration_ms,
    rows,
    row_count: rows !== null ? rows.length : null,
    row_schema: inferRowSchema(rows),
    message:
      typeof parsed.message === "string" && parsed.message.length > 0
        ? parsed.message
        : null,
    files: extractFiles(parsed.files),
    error: null,
  };
}

// ─── Internal helpers ──────────────────────────────────────────────────

/** Extract a rows array from the raw "rows" field.
 *  Returns null when the value is not a non-empty array of plain objects. */
function extractRows(
  raw: unknown,
): Record<string, unknown>[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const allObjects = raw.every(
    (item) =>
      item !== null &&
      typeof item === "object" &&
      !Array.isArray(item),
  );
  if (!allObjects) return null;
  return raw as Record<string, unknown>[];
}

/** Extract a files array from the raw "files" field.
 *  Returns null when the value is not a non-empty array of strings. */
function extractFiles(raw: unknown): string[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  if (!raw.every((item) => typeof item === "string")) return null;
  return raw as string[];
}

/**
 * Infer a column-type schema from the first row.
 * Produces { colName: { type: primitive_type } } for each key.
 * Returns null when rows is null/empty or rows[0] is not a plain object.
 */
function inferRowSchema(
  rows: Record<string, unknown>[] | null,
): Record<string, unknown> | null {
  if (!rows || rows.length === 0) return null;
  const first = rows[0];
  if (first === null || typeof first !== "object" || Array.isArray(first)) {
    return null;
  }
  const schema: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(first)) {
    const t = Array.isArray(value) ? "array" : typeof value;
    schema[key] = { type: t };
  }
  return schema;
}

// Re-export SandboxOutput for callers that bridge from the adapter.
export type { SandboxOutput };
