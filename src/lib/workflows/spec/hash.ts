/**
 * Deterministic JSON serialization + SHA-256 — the cache-key
 * primitives the engine's two-level workflow cache builds on
 * (`docs/workflow-architecture.md` §7.4).
 *
 * Two consumers in V1:
 *
 *   - **Level 1 — per-node cache** (D20, Plan C):
 *       cache_key(node) = sha256(
 *         canonical(node.spec_excluding_runtime_metadata),
 *         canonical(resolved_inputs_for_node),
 *         upstream_outputs_hash(node))
 *     Lets cosmetic edits (description / retries) NOT bust caches,
 *     and constrains invalidation to the changed node + downstream.
 *
 *   - **Level 2 — workflow-output cache** (coalescing layer):
 *       workflow_cache_key = sha256(
 *         canonical(workflow.spec),
 *         canonical(inputs))
 *     Lets concurrent `/api/data/resolve` requests for the same
 *     (workflow, inputs) collapse onto a single execution.
 *
 * This module is *spec-shape-agnostic* — it knows nothing about
 * workflow specs and accepts any JSON-ish value. The engine's
 * cache layer decides what to feed in (e.g. which fields to strip
 * before hashing). Keeping the API narrow avoids coupling cache
 * invariants to spec-shape evolution.
 *
 * Determinism invariants:
 *   - Object keys are sorted lexicographically before serialization
 *     (JSON.stringify object-key order is implementation-defined).
 *   - `-0` and `0` serialize identically (JSON has no signed zero).
 *   - Strings use `JSON.stringify` quoting → consistent Unicode
 *     escaping across Node versions.
 *
 * Non-canonicalizable inputs throw `WorkflowError` with code
 * `SPEC_SCHEMA_MISMATCH` (workflow-scoped: no `nodeId` since hash
 * has no node context — matches the validate.ts pattern for
 * structural failures with no single node to blame):
 *   - `undefined`, `NaN`, `Infinity`, `-Infinity`
 *   - `BigInt`, `Symbol`, `Function`
 *   - Circular references
 *
 * The original `Error` (if any) is preserved in `WorkflowError.cause`
 * for developer-side stack traces.
 */

import { createHash } from "node:crypto";

import { WorkflowError } from "../error";

// ─── Canonical JSON serialization ──────────────────────────────────────

/**
 * Serialize an arbitrary JSON-ish value to a deterministic string.
 *
 * Output is a single-line stringification with no whitespace —
 * meant as a hash *input*, not a human-readable artefact. Use
 * `JSON.parse(canonicalJson(v))` if you need to round-trip it
 * back; semantics are pure JSON.
 *
 * Throws on any non-JSON value (see file header for the full
 * list).
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
    // JSON.stringify renders -0 as "0" → matches JSON semantics.
    return JSON.stringify(value);
  }
  if (t === "undefined") fail("undefined is not JSON-serializable");
  if (t === "bigint") fail("bigint is not JSON-serializable");
  if (t === "symbol" || t === "function") {
    fail(`${t} is not JSON-serializable`);
  }

  // Object or array path.
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
 * Node versions and processes — same input bytes always produce
 * the same 64-char digest.
 */
export function hashJson(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}
