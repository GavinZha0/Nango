/**
 * Workflow refs — the `@path` pointer syntax used by spec fields
 * to flow data between nodes / workflow inputs / runtime context.
 *
 * This module is the **"pointer ABI"** of the workflow subsystem:
 * pure syntax-layer parse / serialize / scan / filter. It does NOT
 * know what nodes exist, what fields a node declares, or what
 * values a ref resolves to at runtime. Those are answered by
 * `validate.ts` (reachability) and `engine/execution-context.ts`
 * (resolution).
 *
 * Three ref kinds (see `docs/workflow-architecture.md §3.4`):
 *
 *   @nodes.<numeric-id>.<field>     — upstream node output field
 *   @workflow.<inputKey>            — workflow-level input parameter
 *   @context.<path...>              — runtime context (user / now / etc.)
 *
 * Two ref forms:
 *
 *   Pure-reference: the WHOLE field value is a ref string
 *                     "data": "@nodes.0.dataset"
 *
 *   Embedded:        ref tokens interpolated INTO a larger string
 *                     "sql": "SELECT * FROM o WHERE id = @workflow.id"
 *                     "url": "https://api.com/orgs/@nodes.1.org_id/items"
 *
 * Consumers (V1):
 *   - `validate.ts`           — parseRef each ref; check node/field exists
 *   - `build-from-events.ts`  — D14 Strategy Z+ save-time ref reconstruction:
 *                               isRefCandidate filter + serializeRef writer
 *   - `engine/execution-context.ts` — runtime resolver
 *   - `engine/output-resolver.ts`   — resolve `spec.outputs` map at end of run
 */

// ─── Types ────────────────────────────────────────────────────────────

/**
 * Reference to an upstream node's output field. `nodeId` is the
 * numeric `spec.nodes[i].id` value (D29). `field` is a flat
 * top-level key in the producing node's `outputs[]` declaration
 * (D19) — refs do NOT traverse into nested structures (V1 keeps
 * this strict; downstream nodes that want nested access do their
 * own projection).
 */
export interface NodeOutputRef {
  kind: "node";
  nodeId: number;
  field: string;
}

/**
 * Reference to a workflow-level input parameter declared in
 * `spec.input_schema`. `key` is a top-level property name.
 */
export interface WorkflowInputRef {
  kind: "workflow";
  key: string;
}

/**
 * Reference to runtime context — a structured object the engine
 * injects per-run with user identity, current time, secrets, etc.
 * Unlike node / workflow refs, context refs can have **nested
 * paths** (e.g. `@context.user.id` → `path = ["user", "id"]`).
 */
export interface ContextRef {
  kind: "context";
  path: string[];
}

export type WorkflowRef = NodeOutputRef | WorkflowInputRef | ContextRef;

// ─── Internal grammar ─────────────────────────────────────────────────

/**
 * Character set allowed for each path segment (between dots).
 * Matches typical identifier syntax: letters, digits, underscore,
 * hyphen. Notably EXCLUDES `.` so the parser is unambiguous.
 */
const SEGMENT_RE = /^[a-zA-Z0-9_-]+$/;

/**
 * Regex used by `findEmbeddedRefs` to locate ref tokens inside a
 * larger string. Matches `@<sigil>` followed by one or more
 * dot-separated segments. The trailing segment ends at any
 * character outside the segment char set (whitespace, `,`, `/`,
 * `"`, `)`, etc.).
 *
 * Marked `g` for iterative scan via `regex.exec` (callers must
 * reset `lastIndex` if reusing across calls).
 */
const EMBEDDED_REF_RE = /@(nodes|workflow|context)(?:\.[a-zA-Z0-9_-]+)+/g;

// ─── parseRef ─────────────────────────────────────────────────────────

/**
 * Parse a candidate ref string into its structured form. Returns
 * `null` if the input is NOT a syntactically valid ref — callers
 * should treat null as "this string is a literal, not a ref".
 *
 * Strict rules (V1):
 *   - Must start with `@` followed by a known sigil.
 *   - Each path segment must match `[a-zA-Z0-9_-]+` (no dots, no
 *     empties).
 *   - `@nodes.<id>.<field>` — EXACTLY two segments; `<id>` must
 *     parse as a non-negative integer.
 *   - `@workflow.<key>` — EXACTLY one segment.
 *   - `@context.<path>(.<path>)*` — one OR MORE segments.
 *
 * Unrecognized sigil, wrong segment count, malformed nodeId, or
 * any non-conformant segment → null.
 */
export function parseRef(s: string): WorkflowRef | null {
  if (typeof s !== "string" || s.length < 2 || s[0] !== "@") return null;

  const parts = s.slice(1).split(".");
  if (parts.length < 2) return null;

  const sigil = parts[0];
  const segments = parts.slice(1);

  // Every segment must be non-empty and match the allowed char set.
  for (const seg of segments) {
    if (!SEGMENT_RE.test(seg)) return null;
  }

  switch (sigil) {
    case "nodes": {
      if (segments.length !== 2) return null;
      // Numeric id must be a non-negative integer (D29). Reject
      // leading zeros (other than the standalone "0") to keep the
      // round-trip via serializeRef stable.
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
      // Context allows any nesting depth.
      return { kind: "context", path: segments };
    }
    default:
      return null;
  }
}

// ─── serializeRef ─────────────────────────────────────────────────────

/**
 * Convert a structured ref back to its canonical string form.
 * Round-trips with {@link parseRef}: `parseRef(serializeRef(r))`
 * yields a deeply equal ref.
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
 * Scan a string for ALL embedded ref tokens. Used by the engine's
 * runtime resolver when interpolating refs into SQL / Python code /
 * HTTP URLs / prompt strings / etc.
 *
 * Returns refs in the ORDER they appear. Skips any token that
 * matches the embedded-ref shape but fails `parseRef` (e.g.,
 * `@nodes.abc.foo` — non-integer node id).
 */
export function findEmbeddedRefs(s: string): WorkflowRef[] {
  if (typeof s !== "string") return [];
  const refs: WorkflowRef[] = [];
  // Recreate the regex per call to keep lastIndex local — the
  // module-level constant is a template only.
  const re = new RegExp(EMBEDDED_REF_RE.source, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    const parsed = parseRef(m[0]);
    if (parsed !== null) refs.push(parsed);
  }
  return refs;
}

// ─── isRefCandidate (D14 Strategy Z+) ─────────────────────────────────

/**
 * D14 §7.10.2 step filter — "does this value LOOK like an upstream
 * ID we should try to rewrite as a ref?".
 *
 * Strategy Z+ algorithm walks each node's input recursively. For
 * every string-typed leaf, it calls `isRefCandidate`. Only
 * candidates participate in the value→source index lookup; literal
 * SQL, Python code, Markdown content, etc. are skipped because
 * they contain whitespace.
 *
 * Rules (must ALL hold):
 *   - `typeof value === "string"`
 *   - `value.length >= 6` — short strings (column names, status
 *     words like "ok"/"yes", currency codes, etc.) are unlikely
 *     to be IDs and would generate noise in the value→source index
 *   - contains no whitespace — `\s` excludes spaces, tabs, and
 *     newlines, which screens out SQL/code/prose; an ID-shaped
 *     string never contains whitespace
 *
 * V1.1 broadened from the original V1 regex-whitelist
 * ({UUID, nanoid, `prefix_token`} only) to "no whitespace + min
 * length". The whitelist was too narrow — LLM-emitted kebab-case
 * names like `latency-trend-2025-01-27` were rejected, so Strategy
 * Z+ failed to link chart_id ↔ dataset_name lineage in real chats.
 * Loosening is safe because:
 *   - Producer side (`addOutputsToIndex`) registers more upstream
 *     values into the index, but Strategy Z+'s ambiguity branch
 *     (sources.length > 1 → keep literal, record `ambiguous_matches`)
 *     safely degrades on collisions.
 *   - Consumer side (rewriting) only rewrites on unique match;
 *     candidates with no upstream producer pass through unchanged.
 * The residual risk — a downstream literal coincidentally matching
 * a single upstream output of the same value with semantic mismatch
 * — is bounded by the length floor and the no-whitespace rule.
 */
export function isRefCandidate(value: unknown): boolean {
  if (typeof value !== "string") return false;
  if (value.length < 6) return false;
  if (/\s/.test(value)) return false;
  return true;
}
