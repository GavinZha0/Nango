/**
 * Engine per-run state + ref resolution.
 *
 *   - `createExecutionState(params)` builds the mutable bag the
 *     scheduler + node executors mutate during a single run.
 *   - `resolveRefs(value, state)` walks a JSON-ish value depth-first
 *     and replaces every `@path` ref with its resolved runtime value.
 *
 * Two ref forms (see `spec/refs.ts`):
 *   - Pure (whole string IS the ref) → the resolved value replaces
 *     the string (preserves type, supports objects/arrays).
 *   - Embedded (refs inside a larger string) → each ref's resolved
 *     value is stringified and substituted in-place (e.g.
 *     `"SELECT … WHERE id = @inputs.order_id"`).
 *
 * Refs that resolve to `undefined` throw `WorkflowError(REF_UNRESOLVED)`
 * — V1 does not silently substitute null / empty string.
 */

import { WorkflowError } from "../error";
import {
  findEmbeddedRefTokens,
  parseRef,
  serializeRef,
  type WorkflowRef,
} from "../spec/refs";
import type { CanonicalWorkflowSpec } from "../spec/schema";
import type { ExecuteParams } from "./index";

// ─── ExecutionState ────────────────────────────────────────────────────

/**
 * Mutable per-run state. Node executors read input/context; engine
 * writes into `outputs` when a node completes.
 *
 *   spec / input / context  — read-only run inputs.
 *   abortSignal             — cancellation source; node executors
 *                             plumb into fetch / SQL / sandbox.
 *   outputs                 — node id → output bag. Source for
 *                             `@nodes.<id>.<field>` refs of
 *                             downstream nodes.
 *   completed / failed /    — id sets; scheduler reads to find
 *   skipped                   ready nodes + termination state.
 *   nodeErrors              — node id → WorkflowError for failed nodes.
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
 * resolved runtime value from `state`. Returns a *new* value tree —
 * never mutates the input.
 *
 * Throws `WorkflowError(REF_UNRESOLVED)` if any ref's target is
 * `undefined` at runtime.
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
  return value;
}

/**
 * Resolve refs inside a single string. Pure-form returns the resolved
 * value directly (may be any JSON type incl. object/array). Embedded
 * form does substring substitution with stringified values.
 */
function resolveRefsInString(s: string, state: ExecutionState): unknown {
  const pure = parseRef(s);
  if (pure !== null) return resolveSingleRef(pure, state);

  const embedded = findEmbeddedRefTokens(s);
  if (embedded.length === 0) return s;

  // Sort replacements by length-descending so longer matches replace
  // before shorter ones (avoid replacing `@nodes.1` inside
  // `@nodes.10.foo`).
  //
  // Use `token` (the original matched text, e.g. `@workflow.key`) as
  // the needle rather than `serializeRef(ref)` (which always outputs
  // the canonical `@inputs.key` form). This ensures the backward-compat
  // `@workflow.*` alias is found correctly in older specs.
  const replacements = embedded.map(({ ref, token }) => ({
    token,
    value: resolveSingleRef(ref, state),
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
 * `undefined` (node hasn't completed, workflow input key not
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
 * Stringify a resolved value for substitution into a larger string.
 * Object/array values JSON-encode; primitives use `String()`; null
 * becomes `"null"`. Undefined throws — caller should have caught
 * that earlier in `resolveSingleRef`.
 */
function stringifyForEmbedding(value: unknown): string {
  if (value === undefined) {
    throw new WorkflowError({
      errorCode: "REF_UNRESOLVED",
      message: "Embedded ref resolved to undefined.",
    });
  }
  if (value === null) return "null";
  const t = typeof value;
  if (t === "string") return value as string;
  if (t === "number" || t === "boolean") return String(value);
  return JSON.stringify(value);
}

/**
 * String#replaceAll polyfill that avoids regex escaping pitfalls
 * (`@nodes.0.foo` contains `.`, a regex metachar).
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
