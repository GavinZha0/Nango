/**
 * Engine per-run state + ref resolution.
 *
 * Two responsibilities:
 *
 *   1. `createExecutionState(params)` — build the mutable bag the
 *      scheduler + node executors mutate during a single run:
 *      completed / failed / skipped sets, per-node `outputs` map,
 *      workflow `input` + `context` (read-only), and `abortSignal`.
 *
 *   2. `resolveRefs(value, state)` — walk a JSON-ish value
 *      depth-first and replace every `@path` ref with its resolved
 *      runtime value, in either of the two supported forms
 *      (`spec/refs.ts`):
 *
 *        - **Pure** (whole string IS the ref) → the resolved
 *          *value* replaces the string (preserves type, supports
 *          objects/arrays);
 *        - **Embedded** (refs inside a larger string) → each ref's
 *          resolved value is *stringified* (String() for
 *          primitives, JSON.stringify() for objects/arrays) and
 *          substituted in-place.
 *
 *      Refs that resolve to `undefined` → `WorkflowError`
 *      (REF_UNRESOLVED). This is the §7.10.3 hard-error contract
 *      — V1 does not silently substitute null / empty string.
 */

import { WorkflowError } from "../error";
import {
  findEmbeddedRefs,
  parseRef,
  serializeRef,
  type WorkflowRef,
} from "../spec/refs";
import type { CanonicalWorkflowSpec } from "../spec/schema";
import type { ExecuteParams } from "./index";

// ─── ExecutionState ────────────────────────────────────────────────────

/**
 * Mutable per-run state. Engine code reads + writes; node
 * executors read input/context, write into `outputs` when
 * completing.
 *
 * Fields:
 *   spec / input / context  — read-only run inputs.
 *   abortSignal             — cancellation source; node executors
 *                             plumb into fetch / SQL / sandbox.
 *   outputs                 — node id → output bag. Written by the
 *                             engine after each node completes.
 *                             Source for `@nodes.<id>.<field>` refs
 *                             of downstream nodes.
 *   completed / failed /    — id sets; scheduler reads to find
 *   skipped                   ready nodes + termination state.
 *   nodeErrors              — node id → WorkflowError for failed
 *                             nodes. Engine reads after the run to
 *                             surface the failure cause.
 */
export interface ExecutionState {
  /** Stable id of the surrounding entity_run row (event correlation). */
  readonly runId: string;
  readonly spec: CanonicalWorkflowSpec;
  readonly input: Readonly<Record<string, unknown>>;
  readonly context: Readonly<Record<string, unknown>>;
  readonly abortSignal: AbortSignal;
  readonly outputs: Map<number, Record<string, unknown>>;
  readonly completed: Set<number>;
  readonly failed: Set<number>;
  readonly skipped: Set<number>;
  readonly nodeErrors: Map<number, WorkflowError>;
}

/** Build a fresh ExecutionState from `ExecuteParams`. */
export function createExecutionState(params: ExecuteParams): ExecutionState {
  return {
    runId: params.runId,
    spec: params.spec,
    input: params.input,
    context: params.context,
    abortSignal: params.abortController.signal,
    outputs: new Map<number, Record<string, unknown>>(),
    completed: new Set<number>(),
    failed: new Set<number>(),
    skipped: new Set<number>(),
    nodeErrors: new Map<number, WorkflowError>(),
  };
}

// ─── Ref resolution ────────────────────────────────────────────────────

/**
 * Recursively walk `value`, replacing every ref string with its
 * resolved runtime value from `state`. Returns a *new* value tree
 * — never mutates the input.
 *
 * Throws `WorkflowError(REF_UNRESOLVED)` if any ref's target is
 * `undefined` at runtime (§7.10.3 hard-error contract).
 */
export function resolveRefs(value: unknown, state: ExecutionState): unknown {
  if (typeof value === "string") return resolveRefsInString(value, state);
  if (Array.isArray(value)) {
    return value.map((v) => resolveRefs(v, state));
  }
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(obj)) out[k] = resolveRefs(obj[k], state);
    return out;
  }
  // null / number / boolean → unchanged
  return value;
}

/**
 * Resolve refs inside a single string. Two forms:
 *
 *   - Pure (whole string IS the ref) — returns the resolved value
 *     directly (may be any JSON type incl. object/array).
 *   - Embedded — substring substitution with stringified values.
 *   - No refs — string returned unchanged.
 */
function resolveRefsInString(s: string, state: ExecutionState): unknown {
  const pure = parseRef(s);
  if (pure !== null) return resolveSingleRef(pure, state);

  const embedded = findEmbeddedRefs(s);
  if (embedded.length === 0) return s;

  // Substitute each embedded ref's stringified value back into
  // the original string. Sort by length-descending serialization
  // so longer matches replace before shorter ones (e.g. avoid
  // replacing `@nodes.1` inside `@nodes.10.foo`).
  const replacements = embedded.map((r) => ({
    token: serializeRef(r),
    value: resolveSingleRef(r, state),
  }));
  replacements.sort((a, b) => b.token.length - a.token.length);

  let out = s;
  for (const { token, value } of replacements) {
    const replacement = stringifyForEmbedding(value);
    out = replaceAll(out, token, replacement);
  }
  return out;
}

/**
 * Resolve a single ref. Throws REF_UNRESOLVED if the target is
 * `undefined` (e.g. node hasn't completed, workflow input key not
 * provided, context path doesn't exist).
 */
function resolveSingleRef(ref: WorkflowRef, state: ExecutionState): unknown {
  if (ref.kind === "node") {
    const nodeOutputs = state.outputs.get(ref.nodeId);
    if (nodeOutputs === undefined) {
      throw refUnresolved(
        ref,
        `node ${ref.nodeId} has not produced outputs (incomplete or skipped)`,
      );
    }
    if (!(ref.field in nodeOutputs)) {
      throw refUnresolved(
        ref,
        `node ${ref.nodeId} output does not include field '${ref.field}'`,
      );
    }
    return nodeOutputs[ref.field];
  }
  if (ref.kind === "workflow") {
    if (!(ref.key in state.input)) {
      throw refUnresolved(
        ref,
        `workflow input '${ref.key}' was not provided at execution time`,
      );
    }
    return state.input[ref.key];
  }
  // ref.kind === "context"
  let cursor: unknown = state.context;
  for (let i = 0; i < ref.path.length; i++) {
    if (cursor === null || typeof cursor !== "object") {
      throw refUnresolved(
        ref,
        `context.${ref.path.slice(0, i).join(".")} is not an object`,
      );
    }
    const segment = ref.path[i]!;
    const obj = cursor as Record<string, unknown>;
    if (!(segment in obj)) {
      throw refUnresolved(
        ref,
        `context.${ref.path.slice(0, i + 1).join(".")} is undefined`,
      );
    }
    cursor = obj[segment];
  }
  return cursor;
}

function refUnresolved(ref: WorkflowRef, why: string): WorkflowError {
  return new WorkflowError({
    errorCode: "REF_UNRESOLVED",
    message: `Ref ${serializeRef(ref)} could not be resolved: ${why}.`,
  });
}

/**
 * Stringify a resolved value for substitution into a larger
 * string. Object/array values JSON-encode; primitives use
 * `String()`; null becomes `"null"`.
 *
 * Throws if the value is `undefined` — caller should have caught
 * that earlier in `resolveSingleRef`.
 */
function stringifyForEmbedding(value: unknown): string {
  if (value === undefined) {
    // Defensive — resolveSingleRef should have thrown already.
    throw new WorkflowError({
      errorCode: "REF_UNRESOLVED",
      message: "Embedded ref resolved to undefined.",
    });
  }
  if (value === null) return "null";
  const t = typeof value;
  if (t === "string") return value as string;
  if (t === "number" || t === "boolean") return String(value);
  // object / array → JSON-encoded
  return JSON.stringify(value);
}

/**
 * String#replaceAll polyfill that avoids regex escaping pitfalls
 * (`@nodes.0.foo` contains a `.` which is a regex metachar). The
 * native API exists in Node 16+, but we keep the loop explicit so
 * the substitution behavior is locally readable.
 */
function replaceAll(haystack: string, needle: string, replacement: string): string {
  if (needle.length === 0) return haystack;
  let out = "";
  let i = 0;
  while (i < haystack.length) {
    const idx = haystack.indexOf(needle, i);
    if (idx === -1) {
      out += haystack.slice(i);
      break;
    }
    out += haystack.slice(i, idx) + replacement;
    i = idx + needle.length;
  }
  return out;
}
