/**
 * Canonical workflow spec validator — semantic invariants the Zod
 * schema can't express plus the structural cross-references that
 * `canonicalize.ts` deferred.
 *
 * Runs *after* `canonicalize(spec, deps)` on the canonical form
 * (`CanonicalWorkflowSpec`). The save pipeline pattern is:
 *
 *   const canonical = canonicalize(llmSpec, deps);
 *   validate(canonical);                  // throws WorkflowError
 *   const hash = specHash(canonical);     // W1.3 hash.ts
 *   await persist(canonical, hash);
 *
 * What this layer checks (`docs/workflow-architecture.md` §6.3):
 *
 *   - Node id uniqueness, self-dependencies, missing depends_on
 *     targets               →  SPEC_SCHEMA_MISMATCH / SPEC_REF_UNKNOWN_NODE
 *                              / SPEC_DAG_CYCLE
 *   - DAG cycle detection (Kahn)
 *                            →  SPEC_DAG_CYCLE
 *   - `@nodes.N.field` refs in node inputs:
 *       * N must exist        → SPEC_REF_UNKNOWN_NODE
 *       * N must be in the    → SPEC_REF_UNREACHABLE
 *         editing node's
 *         transitive
 *         depends_on closure
 *       * field must be in    → SPEC_REF_UNKNOWN_FIELD
 *         target.outputs[]
 *         (when declared)
 *   - `@workflow.key` refs: key must be declared in
 *     spec.input_schema.properties when the schema is present
 *                            →  SPEC_REF_UNKNOWN_FIELD
 *   - `@context.<path>` refs: pass — runtime concern
 *   - spec.outputs:
 *       * non-empty           → SPEC_NO_OUTPUTS
 *       * each value parses   → SPEC_SCHEMA_MISMATCH
 *         as a pure ref
 *       * each target exists  → SPEC_REF_UNKNOWN_NODE / FIELD
 *         (workflow-scoped:
 *          no requireReachable
 *          check)
 *   - Tool nodes: every key in `input_schema.required` is present
 *     in `node.input`        →  TOOL_INPUT_SCHEMA_MISMATCH
 *     (cheap key-presence check; ref-resolved type validation runs
 *     at execute time)
 *
 * Out of scope:
 *   - Deep JSON-Schema validation of node.input post-ref-resolution
 *     → engine performs at execute time
 *   - Agent input schema validation
 *     → no agent input_schema in V1 spec
 *   - Soft caps (50 nodes / 100 edges)
 *     → UI warning concern, not save-blocking
 *   - Condition / nested workflow validation
 *     → V1.1+ / V2 feature; SPEC_FEATURE_UNSUPPORTED handled
 *       structurally upstream
 *
 * Failure mode: throws the first `WorkflowError` encountered.
 * V1 spec save is all-or-nothing per the canonicalize contract.
 */

import { WorkflowError } from "../error";
import {
  findEmbeddedRefs,
  parseRef,
  type WorkflowRef,
} from "./refs";
import type {
  CanonicalNode,
  CanonicalWorkflowSpec,
} from "./schema";

// ─── Public entrypoint ─────────────────────────────────────────────────

/**
 * Validate a canonical workflow spec. Throws `WorkflowError` on
 * the first invariant violation. Returns void on success.
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
      message: "spec.outputs must contain at least one entry (D28).",
    });
  }

  const { nodeById, depsOf } = buildDependsOnGraph(spec.nodes);
  detectCycle(spec.nodes, depsOf);
  const closureOf = buildClosure(spec.nodes, depsOf);
  validateNodeInputs(spec, nodeById, closureOf);
  validateWorkflowOutputs(spec, nodeById);
  validateToolInputCoverage(spec.nodes);
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

/**
 * Detect cycles via Kahn's algorithm. Throws SPEC_DAG_CYCLE if the
 * processed-count doesn't equal the node count.
 */
function detectCycle(
  nodes: readonly CanonicalNode[],
  depsOf: Map<number, readonly number[]>,
): void {
  const indeg = new Map<number, number>();
  for (const n of nodes) indeg.set(n.id, depsOf.get(n.id)!.length);

  // Reverse adjacency: dependents[N] = nodes that have N in depends_on
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
 * Build the transitive `depends_on` closure for every node.
 * `closureOf.get(id)` contains every node id reachable by walking
 * depends_on edges from `id` (excluding `id` itself).
 *
 * Safe only after `detectCycle` — recursion assumes the graph is
 * acyclic. Memoised; each closure computed exactly once.
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
    memo.set(id, out); // defensive tombstone — should be unreachable post-cycle-check
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
 * Walk a JSON-ish value depth-first and call `visit` on every
 * string leaf. Object KEYS are not visited (refs only appear as
 * values per the spec).
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

/**
 * Extract refs from a single string in either of the two supported
 * forms: pure (whole string IS a ref) or embedded (refs appear
 * inside a larger string).
 */
function refsInString(s: string): WorkflowRef[] {
  const pure = parseRef(s);
  if (pure !== null) return [pure];
  return findEmbeddedRefs(s);
}

interface RefCheckCtx {
  fromNodeId: number | undefined;
  closure: Set<number> | undefined; // undefined → skip reachability check
  nodeById: Map<number, CanonicalNode>;
  workflowInputKeys: Set<string> | undefined; // undefined → skip key check
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
  if (target.outputs !== undefined && !target.outputs.includes(ref.field)) {
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
      return node.tool;
    case "agent":
      return node.agent;
    case "code":
      return `code:${node.language}`;
    case "sql":
      return `sql:${node.dataSourceName}`;
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
    // Walk every per-type string-bearing field where the engine
    // resolves refs at runtime. The set of fields differs by
    // bucket — only carriers the executor actually templates are
    // checked, otherwise validate.ts would treat a literal
    // `@nodes.0.foo` *inside* a Python string as a ref and reject
    // valid code.
    //
    //   - tool / agent: `input` map (executor calls resolveRefs
    //                   on node.input verbatim)
    //   - code:         `input` map only — `node.code` is passed
    //                   to the sandbox as opaque stdin, NOT
    //                   templated, so embedded ref-looking tokens
    //                   are user literals
    //   - sql:          `query`, `dataSourceName`, `name` —
    //                   executor templates each of these through
    //                   resolveRefs before calling
    //                   extract_dataset_by_sql
    const refCarriers: unknown[] = [];
    if (node.type === "tool" || node.type === "agent") {
      refCarriers.push(node.input);
    } else if (node.type === "code") {
      if (node.input !== undefined) refCarriers.push(node.input);
    } else if (node.type === "sql") {
      refCarriers.push(node.query);
      refCarriers.push(node.dataSourceName);
      if (node.name !== undefined) refCarriers.push(node.name);
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
    // Workflow outputs are workflow-scoped: there's no "editing
    // node" so the reachability check doesn't apply.
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
    const required = (node.input_schema as { required?: unknown }).required;
    if (!Array.isArray(required)) continue;
    for (const key of required) {
      if (typeof key !== "string") continue;
      if (!(key in node.input)) {
        throw new WorkflowError({
          errorCode: "TOOL_INPUT_SCHEMA_MISMATCH",
          message: `Node ${node.id}: tool '${node.tool}' requires input field '${key}'.`,
          nodeId: node.id,
          nodeName: node.tool,
        });
      }
    }
  }
}

// ─── Helpers ───────────────────────────────────────────────────────────

/**
 * Extract the top-level property keys from a JSON Schema. Returns
 * `undefined` (= skip @workflow.* key validation) when the schema
 * is absent or doesn't declare a `properties` object — the LLM may
 * ship a workflow without an explicit input schema, in which case
 * the runtime accepts any input shape.
 */
function extractInputSchemaKeys(
  schema: Record<string, unknown> | undefined,
): Set<string> | undefined {
  if (schema === undefined) return undefined;
  const properties = (schema as { properties?: unknown }).properties;
  if (properties === null || typeof properties !== "object") return undefined;
  return new Set(Object.keys(properties as Record<string, unknown>));
}
