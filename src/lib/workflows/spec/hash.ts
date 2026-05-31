/**
 * Deterministic JSON serialization + SHA-256 — the cache-key
 * primitives the engine's workflow cache builds on.
 *
 * Spec-shape-agnostic: knows nothing about workflow specs and accepts
 * any JSON-ish value. Callers decide what to feed in.
 *
 * Determinism invariants:
 *   - Object keys are sorted lexicographically before serialization.
 *   - `-0` and `0` serialize identically (JSON has no signed zero).
 *   - Strings use `JSON.stringify` quoting for consistent Unicode
 *     escaping across Node versions.
 *
 * Non-canonicalizable inputs throw `WorkflowError(SPEC_SCHEMA_MISMATCH)`
 * (workflow-scoped — hash has no node context):
 *   - `undefined`, `NaN`, `Infinity`, `-Infinity`
 *   - `BigInt`, `Symbol`, `Function`
 *   - Circular references
 *
 * See docs/workflow.md.
 */

import { createHash } from "node:crypto";

import { WorkflowError } from "../error";

// ─── Canonical JSON serialization ──────────────────────────────────────

/**
 * Serialize an arbitrary JSON-ish value to a deterministic string.
 * Output is single-line with no whitespace — meant as a hash *input*,
 * not a human-readable artefact.
 *
 * Throws on any non-JSON value.
 */
export function canonicalJson(value: unknown): string {
  return serialize(value, new WeakSet<object>());
}

function fail(message: string): never {
  throw new WorkflowError({
    errorCode: "SPEC_SCHEMA_MISMATCH",
    message: `canonicalJson: ${message}`,
  });
}

function serialize(value: unknown, seen: WeakSet<object>): string {
  if (value === null) return "null";

  const t = typeof value;
  if (t === "boolean") return value ? "true" : "false";
  if (t === "string") return JSON.stringify(value);
  if (t === "number") {
    if (!Number.isFinite(value as number)) {
      fail(`non-finite number is not JSON-serializable (${String(value)})`);
    }
    return JSON.stringify(value);
  }
  if (t === "undefined") fail("undefined is not JSON-serializable");
  if (t === "bigint") fail("bigint is not JSON-serializable");
  if (t === "symbol" || t === "function") {
    fail(`${t} is not JSON-serializable`);
  }

  const obj = value as object;
  if (seen.has(obj)) fail("circular reference detected");
  seen.add(obj);
  try {
    if (Array.isArray(value)) {
      const parts: string[] = [];
      for (const v of value) parts.push(serialize(v, seen));
      return `[${parts.join(",")}]`;
    }
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    const parts: string[] = [];
    for (const k of keys) {
      parts.push(`${JSON.stringify(k)}:${serialize(record[k], seen)}`);
    }
    return `{${parts.join(",")}}`;
  } finally {
    seen.delete(obj);
  }
}

// ─── SHA-256 over canonical JSON ───────────────────────────────────────

/**
 * SHA-256 (lowercase hex) of `canonicalJson(value)`. Stable across
 * Node versions and processes.
 */
export function hashJson(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}
