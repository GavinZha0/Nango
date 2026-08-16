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
   * Populated from the "rows" key in stdout JSON or extracted via multi-stage parsing.
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
   * Human-readable description from the "message" key in stdout JSON or raw stdout.
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
 * Uses a robust 5-Stage resolution pipeline:
 *   Stage 0: Exit Code Guard (ok=false → return error envelope)
 *   Stage 1: Strict JSON Parse (stdout is a clean JSON object containing "rows")
 *   Stage 2: Robust Regex Substring Extraction (extract JSON substring when stdout has extra print logs)
 *   Stage 3/4: Markdown/Text Table Parsing (auto-convert text tables to rows)
 *   Stage 5: Non-data Fallback (rows=null, message=stdout)
 */
export function assembleCodeOutput(raw: RawCodeResult): CodeOutputEnvelope {
  const ok = raw.exitCode === 0;
  const duration_ms = raw.durationMs;

  // Stage 0: Exit code check
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

  const trimmedStdout = raw.stdout.trim();
  if (trimmedStdout.length === 0) {
    return {
      ok,
      duration_ms,
      rows: null,
      row_count: null,
      row_schema: null,
      message: null,
      files: null,
      error: null,
    };
  }

  // Stage 1: Strict JSON Parsing
  try {
    const candidate: unknown = JSON.parse(trimmedStdout);
    if (candidate !== null && typeof candidate === "object" && !Array.isArray(candidate)) {
      const parsed = candidate as Record<string, unknown>;
      const rows = extractRows(parsed.rows);
      if (rows !== null || parsed.message !== undefined) {
        return buildEnvelope(raw, rows, typeof parsed.message === "string" ? parsed.message : null, extractFiles(parsed.files));
      }
    }
  } catch {
    // Continue to Stage 2
  }

  // Stage 2: Substring Regex JSON Extraction (handles print(df) + print(json.dumps({"rows": ...})))
  const regexResult = tryExtractSubstrJson(raw.stdout);
  if (regexResult !== null) {
    return buildEnvelope(raw, regexResult.rows, regexResult.message, regexResult.files);
  }

  // Stage 3 & 4: Text / Markdown Table Parsing
  const tableRows = tryParseMarkdownTable(raw.stdout);
  if (tableRows !== null) {
    return buildEnvelope(raw, tableRows, raw.stdout);
  }

  // Stage 5: Non-data Fallback (pure logic script or plain text)
  return buildEnvelope(raw, null, raw.stdout);
}

// ─── Stage Helpers ─────────────────────────────────────────────────────

function buildEnvelope(
  raw: RawCodeResult,
  rows: Record<string, unknown>[] | null,
  message: string | null,
  files: string[] | null = null,
): CodeOutputEnvelope {
  return {
    ok: true,
    duration_ms: raw.durationMs,
    rows,
    row_count: rows !== null ? rows.length : null,
    row_schema: inferRowSchema(rows),
    message: message && message.length > 0 ? message : null,
    files,
    error: null,
  };
}

/**
 * Stage 2: Extracts a JSON substring object containing "rows" from raw stdout
 * when extra print() statements preceded or followed the JSON output.
 */
function tryExtractSubstrJson(stdout: string): {
  rows: Record<string, unknown>[] | null;
  message: string | null;
  files: string[] | null;
} | null {
  // Matches the last JSON object in stdout that contains a "rows" key
  const match = stdout.match(/\{[\s\S]*?"rows"\s*:\s*\[[\s\S]*?\][\s\S]*?\}(?=[^{}]*$)/);
  if (!match) return null;

  try {
    const parsed: unknown = JSON.parse(match[0]);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      const dict = parsed as Record<string, unknown>;
      const rows = extractRows(dict.rows);
      if (rows !== null) {
        const jsonIndex = match.index ?? 0;
        const prefixLog = stdout.slice(0, jsonIndex).trim();
        const msgInJson = typeof dict.message === "string" ? dict.message : null;
        let message = msgInJson;
        if (prefixLog.length > 0) {
          message = msgInJson ? `${prefixLog}\n\n${msgInJson}` : prefixLog;
        }
        return {
          rows,
          message,
          files: extractFiles(dict.files),
        };
      }
    }
  } catch {
    // Ignores substring parse errors
  }
  return null;
}

/**
 * Stage 3 & 4: Parses Markdown tables in stdout (| col1 | col2 |) into structured rows.
 */
function tryParseMarkdownTable(stdout: string): Record<string, unknown>[] | null {
  const lines = stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const tableLines = lines.filter((l) => l.startsWith("|") && l.endsWith("|"));
  if (tableLines.length < 3) return null;

  const headers = tableLines[0].split("|").slice(1, -1).map((h) => h.trim());
  const delimiter = tableLines[1];
  if (!delimiter.includes("-")) return null;

  const rows: Record<string, unknown>[] = [];
  for (let i = 2; i < tableLines.length; i++) {
    const cells = tableLines[i].split("|").slice(1, -1).map((c) => c.trim());
    if (cells.length === headers.length) {
      const rowObj: Record<string, unknown> = {};
      headers.forEach((h, idx) => {
        const val = cells[idx];
        const num = Number(val);
        rowObj[h] = val !== "" && !isNaN(num) ? num : val;
      });
      rows.push(rowObj);
    }
  }
  return rows.length > 0 ? rows : null;
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
