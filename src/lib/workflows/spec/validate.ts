/**
 * Canonical workflow spec validator — semantic invariants the Zod
 * schema can't express plus structural cross-references canonicalize
 * deferred.
 *
 * Runs *after* `canonicalize(spec, deps)` on the canonical form. Save
 * pipeline pattern:
 *
 *   const canonical = canonicalize(llmSpec, deps);
 *   validate(canonical);                  // throws WorkflowError
 *   const hash = specHash(canonical);
 *   await persist(canonical, hash);
 *
 * Failure mode: throws the first `WorkflowError` encountered. Spec
 * save is all-or-nothing per the canonicalize contract.
 *
 * See docs/workflow.md.
 */

import { WorkflowError } from "../error";
import { SUPPORTED_EXECUTOR_KEYS } from "./canonicalize";
import {
  findEmbeddedRefs,
  parseRef,
  type WorkflowRef,
} from "./refs";
import type {
  CanonicalNode,
  CanonicalWorkflowSpec,
} from "./schema";
import {
  getNodeTypeDescriptor,
  getOutputFields,
} from "../nodes/registry";

// ─── Public entrypoint ─────────────────────────────────────────────────

/**
 * Validate a canonical workflow spec. Throws `WorkflowError` on the
 * first invariant violation. Returns void on success.
 */
export function validate(spec: CanonicalWorkflowSpec): void {
  if (spec.nodes.length === 0) {
    throw new WorkflowError({
      errorCode: "SPEC_SCHEMA_MISMATCH",
      message: "Workflow must contain at least one node.",
    });
  }
  if (Object.keys(spec.outputs).length === 0) {
    throw new WorkflowError({
      errorCode: "SPEC_NO_OUTPUTS",
      message: "spec.outputs must contain at least one entry.",
    });
  }

  validateExecutorKeys(spec.nodes);
  validatePromotedToolNodes(spec.nodes);
  const { nodeById, depsOf } = buildDependsOnGraph(spec.nodes);
  detectCycle(spec.nodes, depsOf);
  const closureOf = buildClosure(spec.nodes, depsOf);
  validateNodeInputs(spec, nodeById, closureOf);
  validateWorkflowOutputs(spec, nodeById);
  validateToolInputCoverage(spec.nodes);
  validateCodeNodeSourceXor(spec.nodes);
  validateJsConstraints(spec.nodes);
  validateChartConfigNoRefs(spec.nodes);
  validateChartConfigSize(spec.nodes);
}

// ─── Executor key validation ────────────────────────────────────────────

/**
 * Verify every node's `"<type>:<schema_version>"` key is registered
 * in `SUPPORTED_EXECUTOR_KEYS`. Catches specs that reference a node
 * version this build's engine cannot run — surfaces as a save-time
 * error (`SCHEMA_VERSION_UNKNOWN`) rather than a silent refresh failure.
 *
 * All keys are "1" today, so this guard is a no-op for current specs.
 * It becomes load-bearing when the first breaking schema change bumps a
 * version: any spec persisted with the old version stays valid; any spec
 * authored against a future version that this older build doesn't know
 * about is rejected immediately.
 */
function validateExecutorKeys(nodes: readonly CanonicalNode[]): void {
  for (const node of nodes) {
    const key = `${node.type}:${node.schema_version}`;
    if (!SUPPORTED_EXECUTOR_KEYS.has(key)) {
      throw new WorkflowError({
        errorCode: "SCHEMA_VERSION_UNKNOWN",
        message:
          `Node ${node.id} (${node.type}): schema_version "${node.schema_version}" ` +
          `is not supported by this build. ` +
          `Supported: ${[...SUPPORTED_EXECUTOR_KEYS].filter((k) => k.startsWith(`${node.type}:`)).join(", ")}.`,
        nodeId: node.id,
        nodeName: `${node.type}:${node.schema_version}`,
      });
    }
  }
}

// ─── Promoted-tool-as-node guard ───────────────────────────────────────

/**
 * Tools that have been promoted to first-class node types must NOT
 * appear as `type: "tool"` nodes — they have dedicated executors and
 * canonical output shapes that a generic tool node cannot provide.
 *
 * Rejected names and their correct node types:
 *   - `run_code_in_sandbox`        → `type: "code"`
 *   - `extract_dataset_by_sql`     → `type: "sql"`
 *   - `generate_<lib>_config`      → `type: "chart"`
 *
 * Surface area: save time only — if this is caught here, the LLM
 * (or a hand-authored spec) gets an actionable error code instead
 * of a silent wrong-output failure at refresh time.
 */
const PROMOTED_TOOL_NAMES: ReadonlySet<string> = new Set([
  "run_code_in_sandbox",
  "extract_dataset_by_sql",
]);

/** Matches `generate_<lib>_config` — the chart-tool naming convention. */
const CHART_TOOL_NAME_RE = /^generate_[a-z][a-z0-9]*_config$/;

function validatePromotedToolNodes(nodes: readonly CanonicalNode[]): void {
  for (const node of nodes) {
    if (node.type !== "tool") continue;
    const name = node.inputs.name;
    if (PROMOTED_TOOL_NAMES.has(name) || CHART_TOOL_NAME_RE.test(name)) {
      const hint = PROMOTED_TOOL_NAMES.has(name)
        ? name === "run_code_in_sandbox"
          ? `Use type: "code" instead.`
          : `Use type: "sql" instead.`
        : `Use type: "chart" instead.`;
      throw new WorkflowError({
        errorCode: "PROMOTED_TOOL_AS_NODE",
        message:
          `Node ${node.id}: tool '${name}' has a dedicated node type ` +
          `and cannot be used as a generic tool node. ${hint}`,
        nodeId: node.id,
        nodeName: name,
      });
    }
  }
}

// ─── JavaScript-specific constraints ───────────────────────────────────

/**
 * v1 JavaScript support has two restrictions:
 *
 *  1. `inputs.datasets` is NOT allowed — the Node.js runtime has no
 *     Parquet reader pre-installed. Pass small data via `inputs.params`
 *     instead (upstream SQL/code node emits inline rows → ref'd into
 *     the JS node's params).
 *
 *  2. `inputs.code_file` is NOT supported — the preamble+exec-wrapper
 *     pattern used for Python's code_file mode has no equivalent in
 *     Node.js CommonJS. Support requires a dedicated File-mode runner.
 *     See docs/workflow-spec.md for the future roadmap.
 *
 * Both restrictions are save-time errors so the user gets immediate
 * actionable feedback rather than a runtime failure on refresh.
 */
function validateJsConstraints(nodes: readonly CanonicalNode[]): void {
  for (const node of nodes) {
    if (node.type !== "code" || node.inputs.language !== "javascript") continue;

    if (node.inputs.datasets !== undefined && node.inputs.datasets.length > 0) {
      throw new WorkflowError({
        errorCode: "JS_DATASETS_NOT_SUPPORTED",
        message:
          `Node ${node.id}: language="javascript" cannot consume datasets. ` +
          "v1 Node.js runtime has no Parquet reader. Pass data via " +
          "inputs.params (ref small inline rows from an upstream node) " +
          "or switch to language=\"python\".",
        nodeId: node.id,
        nodeName: "code:javascript",
      });
    }

    if (node.inputs.code_file !== undefined) {
      throw new WorkflowError({
        errorCode: "SPEC_FEATURE_UNSUPPORTED",
        message:
          `Node ${node.id}: inputs.code_file is not yet supported for ` +
          "language=\"javascript\". Use inputs.code_text or switch to " +
          "language=\"python\" for file-based execution.",
        nodeId: node.id,
        nodeName: "code:javascript",
      });
    }
  }
}

// ─── Code node `code_text` XOR `code_file` ─────────────────────────────

function validateCodeNodeSourceXor(nodes: readonly CanonicalNode[]): void {
  for (const node of nodes) {
    if (node.type !== "code") continue;
    const hasText =
      node.inputs.code_text !== undefined && node.inputs.code_text.length > 0;
    const hasFile =
      node.inputs.code_file !== undefined && node.inputs.code_file.length > 0;
    if (hasText && hasFile) {
      throw new WorkflowError({
        errorCode: "SPEC_SCHEMA_MISMATCH",
        message: `Node ${node.id}: code node may declare 'inputs.code_text' OR 'inputs.code_file', not both.`,
        nodeId: node.id,
        nodeName: `code:${node.inputs.language}`,
      });
    }
    if (!hasText && !hasFile) {
      throw new WorkflowError({
        errorCode: "SPEC_SCHEMA_MISMATCH",
        message: `Node ${node.id}: code node must declare exactly one of 'inputs.code_text' or 'inputs.code_file'.`,
        nodeId: node.id,
        nodeName: `code:${node.inputs.language}`,
      });
    }
  }
}

// ─── Graph construction ────────────────────────────────────────────────

interface DependsOnGraph {
  nodeById: Map<number, CanonicalNode>;
  depsOf: Map<number, readonly number[]>;
}

function buildDependsOnGraph(
  nodes: readonly CanonicalNode[],
): DependsOnGraph {
  const nodeById = new Map<number, CanonicalNode>();
  for (const n of nodes) {
    if (nodeById.has(n.id)) {
      throw new WorkflowError({
        errorCode: "SPEC_SCHEMA_MISMATCH",
        message: `Duplicate node id ${n.id}.`,
        nodeId: n.id,
      });
    }
    nodeById.set(n.id, n);
  }
  const depsOf = new Map<number, readonly number[]>();
  for (const n of nodes) {
    for (const dep of n.depends_on) {
      if (dep === n.id) {
        throw new WorkflowError({
          errorCode: "SPEC_DAG_CYCLE",
          message: `Node ${n.id}: self-dependency in depends_on.`,
          nodeId: n.id,
        });
      }
      if (!nodeById.has(dep)) {
        throw new WorkflowError({
          errorCode: "SPEC_REF_UNKNOWN_NODE",
          message: `Node ${n.id}: depends_on references unknown node id ${dep}.`,
          nodeId: n.id,
        });
      }
    }
    depsOf.set(n.id, n.depends_on);
  }
  return { nodeById, depsOf };
}

/** Detect cycles via Kahn's algorithm. */
function detectCycle(
  nodes: readonly CanonicalNode[],
  depsOf: Map<number, readonly number[]>,
): void {
  const indeg = new Map<number, number>();
  for (const n of nodes) indeg.set(n.id, depsOf.get(n.id)!.length);

  const dependents = new Map<number, number[]>();
  for (const n of nodes) dependents.set(n.id, []);
  for (const n of nodes) {
    for (const dep of depsOf.get(n.id)!) {
      dependents.get(dep)!.push(n.id);
    }
  }

  const queue: number[] = [];
  for (const [id, d] of indeg) if (d === 0) queue.push(id);

  let processed = 0;
  while (queue.length > 0) {
    const id = queue.shift()!;
    processed++;
    for (const next of dependents.get(id)!) {
      const d = indeg.get(next)! - 1;
      indeg.set(next, d);
      if (d === 0) queue.push(next);
    }
  }
  if (processed !== nodes.length) {
    throw new WorkflowError({
      errorCode: "SPEC_DAG_CYCLE",
      message: "Cyclic dependency detected in workflow spec.",
    });
  }
}

/**
 * Build the transitive `depends_on` closure for every node. Safe
 * only after `detectCycle` — recursion assumes acyclic graph.
 * Memoised; each closure computed exactly once.
 */
function buildClosure(
  nodes: readonly CanonicalNode[],
  depsOf: Map<number, readonly number[]>,
): Map<number, Set<number>> {
  const memo = new Map<number, Set<number>>();
  function closureFor(id: number): Set<number> {
    const cached = memo.get(id);
    if (cached !== undefined) return cached;
    const out = new Set<number>();
    memo.set(id, out);
    for (const dep of depsOf.get(id)!) {
      out.add(dep);
      for (const x of closureFor(dep)) out.add(x);
    }
    return out;
  }
  for (const n of nodes) closureFor(n.id);
  return memo;
}

// ─── Ref scanning ──────────────────────────────────────────────────────

/**
 * Walk a JSON-ish value depth-first and call `visit` on every string
 * leaf. Object KEYS are not visited (refs only appear as values).
 */
function forEachStringLeaf(
  value: unknown,
  visit: (s: string) => void,
): void {
  if (typeof value === "string") {
    visit(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const v of value) forEachStringLeaf(v, visit);
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const v of Object.values(value)) forEachStringLeaf(v, visit);
  }
}

/** Extract refs from a single string (pure or embedded form). */
function refsInString(s: string): WorkflowRef[] {
  const pure = parseRef(s);
  if (pure !== null) return [pure];
  return findEmbeddedRefs(s);
}

/**
 * Resolve the output field names a node declares, for @nodes.X.field
 * ref validation.
 *
 * - Tool nodes: per-instance `outputs[]` snapshot (stamped by canonicalize;
 *   tool schemas are dynamic per-tool).
 * - All other nodes (agent/code/sql/chart): fixed contract from NODE_TYPE_REGISTRY.
 *
 * Returns `undefined` when no declaration exists — ref check skipped.
 */
function resolveNodeOutputFields(
  node: CanonicalNode,
): ReadonlyArray<string> | undefined {
  if (node.type === "tool") return node.outputs;
  const descriptor = getNodeTypeDescriptor(node.type, node.schema_version ?? "1");
  return descriptor !== undefined ? getOutputFields(descriptor) : undefined;
}

interface RefCheckCtx {
  fromNodeId: number | undefined;
  /** undefined → skip reachability check (workflow outputs). */
  closure: Set<number> | undefined;
  nodeById: Map<number, CanonicalNode>;
  /** undefined → skip key check (no input_schema declared). */
  workflowInputKeys: Set<string> | undefined;
}

function checkRef(ref: WorkflowRef, ctx: RefCheckCtx): void {
  if (ref.kind === "context") return; // runtime concern
  if (ref.kind === "workflow") {
    if (
      ctx.workflowInputKeys !== undefined &&
      !ctx.workflowInputKeys.has(ref.key)
    ) {
      throw new WorkflowError({
        errorCode: "SPEC_REF_UNKNOWN_FIELD",
        message: `Workflow input '${ref.key}' is not declared in spec.input_schema.properties.`,
        nodeId: ctx.fromNodeId,
      });
    }
    return;
  }
  // ref.kind === "node"
  const target = ctx.nodeById.get(ref.nodeId);
  if (target === undefined) {
    throw new WorkflowError({
      errorCode: "SPEC_REF_UNKNOWN_NODE",
      message: `Ref @nodes.${ref.nodeId}.${ref.field} points to an unknown node id.`,
      nodeId: ctx.fromNodeId,
    });
  }
  if (ctx.closure !== undefined && !ctx.closure.has(ref.nodeId)) {
    throw new WorkflowError({
      errorCode: "SPEC_REF_UNREACHABLE",
      message: `Node ${ctx.fromNodeId}: ref @nodes.${ref.nodeId}.${ref.field} is not in the transitive depends_on closure.`,
      nodeId: ctx.fromNodeId,
    });
  }
  const targetOutputFields = resolveNodeOutputFields(target);
  if (targetOutputFields !== undefined && !targetOutputFields.includes(ref.field)) {
    const targetName = canonicalNodeDisplayName(target);
    throw new WorkflowError({
      errorCode: "SPEC_REF_UNKNOWN_FIELD",
      message: `Ref @nodes.${ref.nodeId}.${ref.field} — node ${ref.nodeId} ('${targetName}') does not declare output '${ref.field}'.`,
      nodeId: ctx.fromNodeId,
    });
  }
}

/** Per-type identifier surfaced in validation error messages. */
function canonicalNodeDisplayName(node: CanonicalNode): string {
  switch (node.type) {
    case "tool":
      return node.inputs.name;
    case "agent":
      return node.inputs.name;
    case "code":
      return `code:${node.inputs.language}`;
    case "sql":
      return `sql:${node.inputs.data_source_name}`;
    case "chart":
      return `chart:${node.inputs.renderer}`;
  }
}

// ─── Refs across nodes + spec.outputs ──────────────────────────────────

function validateNodeInputs(
  spec: CanonicalWorkflowSpec,
  nodeById: Map<number, CanonicalNode>,
  closureOf: Map<number, Set<number>>,
): void {
  const workflowInputKeys = extractInputSchemaKeys(spec.input_schema);
  for (const node of spec.nodes) {
    const closure = closureOf.get(node.id)!;
    const ctx: RefCheckCtx = {
      fromNodeId: node.id,
      closure,
      nodeById,
      workflowInputKeys,
    };
    // Walk only per-type string-bearing fields where the engine
    // resolves refs at runtime. Otherwise validate.ts would treat a
    // literal `@nodes.0.foo` *inside* a Python string as a ref and
    // reject valid code.
    //
    //   - tool:  `inputs.arguments` (refs live in the args bag, not
    //            in the const-pinned `inputs.name`)
    //   - agent: `inputs.task` + `inputs.context` (the only
    //            ref-bearing string fields; `inputs.name` and
    //            `inputs.agent_id` are static identifiers)
    //   - code:  `inputs.datasets` + `inputs.params` — `inputs.code_text`
    //            is passed to the sandbox as opaque stdin, NOT
    //            templated. `inputs.code_file` is a placeholder
    //            (CODE_FILE_NOT_SUPPORTED at runtime).
    //   - sql:   `inputs.sql_text`, `inputs.data_source_name`,
    //            `inputs.dataset_name` — each is templated through
    //            resolveRefs before calling extract_dataset_by_sql
    //   - chart: `inputs.dataset` is a string OR string[] of
    //            `@path` refs to upstream arrays (walked here).
    //            `inputs.config` is the option TEMPLATE — refs
    //            embedded there are NOT resolved by the engine
    //            (only `inputs.dataset` is a ref-bearing slot). A
    //            dedicated `validateChartConfigNoRefs` pass rejects any
    //            @path strings found inside config so they never
    //            reach the renderer as literal strings.
    const refCarriers: unknown[] = [];
    if (node.type === "tool") {
      refCarriers.push(node.inputs.arguments);
    } else if (node.type === "agent") {
      refCarriers.push(node.inputs.task);
      if (node.inputs.context !== undefined) {
        refCarriers.push(node.inputs.context);
      }
    } else if (node.type === "code") {
      if (node.inputs.datasets !== undefined) {
        refCarriers.push(node.inputs.datasets);
      }
      if (node.inputs.params !== undefined) {
        refCarriers.push(node.inputs.params);
      }
    } else if (node.type === "sql") {
      refCarriers.push(node.inputs.sql_text);
      refCarriers.push(node.inputs.data_source_name);
      if (node.inputs.dataset_name !== undefined) {
        refCarriers.push(node.inputs.dataset_name);
      }
    } else if (node.type === "chart") {
      // `inputs.dataset` is optional — the not-refreshable fallback
      // omits it and bakes the data into `inputs.config` instead,
      // so we walk it only when present.
      if (node.inputs.dataset !== undefined) {
        refCarriers.push(node.inputs.dataset);
      }
    }
    for (const carrier of refCarriers) {
      forEachStringLeaf(carrier, (s) => {
        for (const ref of refsInString(s)) checkRef(ref, ctx);
      });
    }
  }
}

function validateWorkflowOutputs(
  spec: CanonicalWorkflowSpec,
  nodeById: Map<number, CanonicalNode>,
): void {
  const workflowInputKeys = extractInputSchemaKeys(spec.input_schema);
  for (const [key, refStr] of Object.entries(spec.outputs)) {
    const ref = parseRef(refStr);
    if (ref === null) {
      throw new WorkflowError({
        errorCode: "SPEC_SCHEMA_MISMATCH",
        message: `spec.outputs['${key}'] is not a valid ref string: ${JSON.stringify(refStr)}`,
      });
    }
    // Workflow outputs are workflow-scoped: no "editing node", so
    // the reachability check doesn't apply.
    checkRef(ref, {
      fromNodeId: undefined,
      closure: undefined,
      nodeById,
      workflowInputKeys,
    });
  }
}

// ─── Tool input required-key coverage ──────────────────────────────────

function validateToolInputCoverage(nodes: readonly CanonicalNode[]): void {
  for (const node of nodes) {
    if (node.type !== "tool") continue;
    if (node.input_schema === undefined) continue;
    // Tool wrapper schema is always
    //   { name: const, arguments: { properties, required } }
    // — the required keys we want to check live one level deeper,
    // under `input_schema.properties.arguments.required`.
    const properties = (node.input_schema as { properties?: unknown })
      .properties;
    if (properties === null || typeof properties !== "object") continue;
    const argsSchema = (properties as { arguments?: unknown }).arguments;
    if (argsSchema === null || typeof argsSchema !== "object") continue;
    const required = (argsSchema as { required?: unknown }).required;
    if (!Array.isArray(required)) continue;
    for (const key of required) {
      if (typeof key !== "string") continue;
      if (!(key in node.inputs.arguments)) {
        throw new WorkflowError({
          errorCode: "TOOL_INPUT_SCHEMA_MISMATCH",
          message: `Node ${node.id}: tool '${node.inputs.name}' requires argument '${key}'.`,
          nodeId: node.id,
          nodeName: node.inputs.name,
        });
      }
    }
  }
}

// ─── Helpers ───────────────────────────────────────────────────────────

/**
 * Extract the top-level property keys from a JSON Schema. Returns
 * `undefined` (= skip @workflow.* key validation) when the schema is
 * absent or doesn't declare a `properties` object.
 */
function extractInputSchemaKeys(
  schema: Record<string, unknown> | undefined,
): Set<string> | undefined {
  if (schema === undefined) return undefined;
  const properties = (schema as { properties?: unknown }).properties;
  if (properties === null || typeof properties !== "object") return undefined;
  return new Set(Object.keys(properties as Record<string, unknown>));
}

// ─── Chart config size guard ───────────────────────────────────────────

/**
 * Maximum UTF-8 byte size for a chart node's `inputs.config`.
 * Matches the `ECHARTS_OPTION_HARD_CAP_BYTES` limit enforced at the
 * tool layer (`src/lib/outcomes/schema.ts`) so the two caps are
 * consistent. For refreshable charts the config stores only the
 * option TEMPLATE (no inline data), so this limit is rarely reached.
 * For charts saved without a refreshable upstream ref, the full
 * dataset is baked into `config.dataset.source`; those charts are
 * the primary risk.
 */
const CHART_CONFIG_MAX_BYTES = 64_000;

/**
 * Reject chart nodes whose `inputs.config` serializes to more than
 * `CHART_CONFIG_MAX_BYTES` (UTF-8). Oversized configs bloat the
 * `workflow.spec` JSONB column and inflate every GET bundle payload.
 *
 * Correct fix for an oversized not-refreshable chart: connect the
 * chart to an upstream SQL node via `inputs.dataset` so the row data
 * lives in a Parquet file rather than inline in the spec.
 */
function validateChartConfigSize(nodes: readonly CanonicalNode[]): void {
  for (const node of nodes) {
    if (node.type !== "chart") continue;
    let size: number;
    try {
      size = Buffer.byteLength(JSON.stringify(node.inputs.config), "utf8");
    } catch {
      // Un-serializable config — will fail at runtime. Skip here and
      // let the engine surface the error with full context.
      continue;
    }
    if (size > CHART_CONFIG_MAX_BYTES) {
      throw new WorkflowError({
        errorCode: "CHART_CONFIG_TOO_LARGE",
        message:
          `Node ${node.id} (chart): inputs.config is ${size.toLocaleString()} bytes ` +
          `(limit: ${CHART_CONFIG_MAX_BYTES.toLocaleString()} bytes). ` +
          `Large inline datasets in not-refreshable charts inflate the workflow spec. ` +
          `To make this chart refreshable, connect it to an upstream SQL node via ` +
          `inputs.dataset so the row data is stored in a Parquet file instead.`,
        nodeId: node.id,
        nodeName: `chart:${node.inputs.renderer}`,
      });
    }
  }
}

// ─── Chart config ref guard ────────────────────────────────────────────

/**
 * Walk every string leaf in a chart node's `inputs.config` and reject
 * any that contain `@path` ref syntax.
 *
 * Why this matters: `inputs.config` is an opaque ECharts option
 * TEMPLATE — the engine never calls `resolveRefs` on it;
 * `inputs.dataset` is the only data-binding slot. A ref string
 * embedded anywhere else in config (e.g. `config.title.text:
 * "@nodes.0.category"`) would be returned verbatim to the browser
 * and displayed as a literal string rather than the intended value.
 *
 * Rejected at save time rather than silently misbehaving at render
 * time. Correct pattern: bind upstream data to `inputs.dataset` and
 * let the engine inject it into `option.dataset.source`.
 */
function validateChartConfigNoRefs(nodes: readonly CanonicalNode[]): void {
  for (const node of nodes) {
    if (node.type !== "chart") continue;
    // We only scan config — inputs.dataset is intentionally a ref
    // carrier and is validated by the main validateNodeInputs pass.
    let firstOffending: string | undefined;
    forEachStringLeaf(node.inputs.config, (s) => {
      if (firstOffending !== undefined) return;
      if (refsInString(s).length > 0) firstOffending = s;
    });
    if (firstOffending !== undefined) {
      throw new WorkflowError({
        errorCode: "CHART_CONFIG_CONTAINS_REF",
        message:
          `Node ${node.id} (chart): inputs.config contains a @path ref ` +
          `(${JSON.stringify(firstOffending)}). ` +
          `Refs inside inputs.config are not resolved at execute time — ` +
          `use inputs.dataset to bind upstream array data instead.`,
        nodeId: node.id,
        nodeName: `chart:${node.inputs.renderer}`,
      });
    }
  }
}
