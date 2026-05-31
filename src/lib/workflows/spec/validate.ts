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
    // Walk only per-type string-bearing fields where the engine
    // resolves refs at runtime. Otherwise validate.ts would treat a
    // literal `@nodes.0.foo` *inside* a Python string as a ref and
    // reject valid code.
    //
    //   - tool / agent: `input` map
    //   - code:         `input` map only — `node.code` is passed to
    //                   the sandbox as opaque stdin, NOT templated
    //   - sql:          `query`, `dataSourceName`, `name` — each is
    //                   templated through resolveRefs before calling
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
