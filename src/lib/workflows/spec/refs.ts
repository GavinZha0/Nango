/**
 * Workflow refs — the `@path` pointer syntax used by spec fields to
 * flow data between nodes / workflow inputs / runtime context.
 *
 * Pure syntax-layer parse / serialize / scan / filter. Reachability
 * checks live in `validate.ts`; runtime resolution lives in
 * `engine/execution-context.ts`.
 *
 * Three ref kinds:
 *   @nodes.<numeric-id>.<field>  — upstream node output field
 *   @workflow.<inputKey>         — workflow-level input parameter
 *   @context.<path...>           — runtime context (user / now / …)
 *
 * Two forms:
 *   Pure-reference:  the whole field value is a ref string
 *                      "data": "@nodes.0.dataset"
 *   Embedded:        ref tokens interpolated INTO a larger string
 *                      "sql": "SELECT * FROM o WHERE id = @workflow.id"
 *
 * See docs/workflow.md.
 */

// ─── Types ────────────────────────────────────────────────────────────

/**
 * Reference to an upstream node's output field. `nodeId` is the
 * numeric `spec.nodes[i].id`. `field` is a flat top-level key in the
 * producing node's `outputs[]` — refs do not traverse nested
 * structures.
 */
export interface NodeOutputRef {
  kind: "node";
  nodeId: number;
  field: string;
}

/** Reference to a workflow-level input declared in `spec.input_schema`. */
export interface WorkflowInputRef {
  kind: "workflow";
  key: string;
}

/**
 * Reference to runtime context — a structured object the engine
 * injects per-run (user identity, current time, secrets, …). Context
 * refs allow nested paths, e.g. `@context.user.id` →
 * `path = ["user", "id"]`.
 */
export interface ContextRef {
  kind: "context";
  path: string[];
}

export type WorkflowRef = NodeOutputRef | WorkflowInputRef | ContextRef;

// ─── Internal grammar ─────────────────────────────────────────────────

/** Path segment alphabet. Notably excludes `.` to keep parsing unambiguous. */
const SEGMENT_RE = /^[a-zA-Z0-9_-]+$/;

/**
 * Regex used by `findEmbeddedRefs` to locate ref tokens inside a
 * larger string. `g` is for iterative scan via `regex.exec`; callers
 * recreate the regex per call to keep `lastIndex` local.
 */
const EMBEDDED_REF_RE = /@(nodes|workflow|context)(?:\.[a-zA-Z0-9_-]+)+/g;

// ─── parseRef ─────────────────────────────────────────────────────────

/**
 * Parse a candidate ref string into structured form. Returns `null`
 * for any malformed input — callers treat null as "literal, not a
 * ref".
 *
 * Rules:
 *   - starts with `@<sigil>`
 *   - each segment matches `[a-zA-Z0-9_-]+`
 *   - `@nodes.<id>.<field>`     — exactly two segments; `<id>` is a
 *                                  non-negative integer with no
 *                                  leading zeros (other than "0")
 *   - `@workflow.<key>`         — exactly one segment
 *   - `@context.<seg>(.<seg>)*` — one or more segments
 */
export function parseRef(s: string): WorkflowRef | null {
  if (typeof s !== "string" || s.length < 2 || s[0] !== "@") return null;

  const parts = s.slice(1).split(".");
  if (parts.length < 2) return null;

  const sigil = parts[0];
  const segments = parts.slice(1);

  for (const seg of segments) {
    if (!SEGMENT_RE.test(seg)) return null;
  }

  switch (sigil) {
    case "nodes": {
      if (segments.length !== 2) return null;
      const raw = segments[0];
      if (!/^(0|[1-9][0-9]*)$/.test(raw)) return null;
      const nodeId = Number(raw);
      if (!Number.isSafeInteger(nodeId) || nodeId < 0) return null;
      return { kind: "node", nodeId, field: segments[1] };
    }
    case "workflow": {
      if (segments.length !== 1) return null;
      return { kind: "workflow", key: segments[0] };
    }
    case "context": {
      return { kind: "context", path: segments };
    }
    default:
      return null;
  }
}

// ─── serializeRef ─────────────────────────────────────────────────────

/**
 * Convert a structured ref back to its canonical string form.
 * Round-trips with `parseRef`: `parseRef(serializeRef(r))` is deeply
 * equal to `r`.
 */
export function serializeRef(r: WorkflowRef): string {
  switch (r.kind) {
    case "node":
      return `@nodes.${r.nodeId}.${r.field}`;
    case "workflow":
      return `@workflow.${r.key}`;
    case "context":
      return `@context.${r.path.join(".")}`;
  }
}

// ─── findEmbeddedRefs ─────────────────────────────────────────────────

/**
 * Scan a string for all embedded ref tokens, in order of appearance.
 * Used by the runtime resolver when interpolating refs into SQL /
 * code / URLs / prompts. Tokens that match the shape but fail
 * `parseRef` (e.g. non-integer node id) are skipped.
 */
export function findEmbeddedRefs(s: string): WorkflowRef[] {
  if (typeof s !== "string") return [];
  const refs: WorkflowRef[] = [];
  const re = new RegExp(EMBEDDED_REF_RE.source, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    const parsed = parseRef(m[0]);
    if (parsed !== null) refs.push(parsed);
  }
  return refs;
}

// ─── isRefCandidate ───────────────────────────────────────────────────

/**
 * Save-time filter — "does this value look like an upstream ID we
 * should try to rewrite as a ref?".
 *
 * Used by the value→source index in `build-from-events.ts`. Only
 * candidates participate in the rewrite; literal SQL, code, prose,
 * etc. are skipped because they contain whitespace.
 *
 * Rules (all must hold):
 *   - `typeof value === "string"`
 *   - `value.length >= 6` — short strings (column names, "ok"/"yes",
 *     currency codes) are unlikely IDs and would generate noise
 *   - no whitespace — IDs do not contain spaces / tabs / newlines
 */
export function isRefCandidate(value: unknown): boolean {
  if (typeof value !== "string") return false;
  if (value.length < 6) return false;
  if (/\s/.test(value)) return false;
  return true;
}
