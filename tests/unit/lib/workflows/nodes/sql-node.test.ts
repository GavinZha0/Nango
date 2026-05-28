/**
 * Unit tests for the sql-node executor (D36).
 *
 * Mirrors the per-attempt body documented in
 * `src/lib/workflows/nodes/sql-node.ts`:
 *
 *   1. Refs in `query` / `dataSourceName` / `name` resolve before
 *      the underlying `extract_dataset_by_sql` tool is invoked.
 *   2. `previewRows: 0` + `forceRefresh: false` are ALWAYS passed
 *      — chat-affordances are pinned, not exposed on the SQL node.
 *   3. Success envelope is stripped to `{ name, rowCount }` —
 *      operational fields (cacheHit / ttlHours / schema / preview)
 *      are intentionally NOT downstream-referenceable.
 *   4. Failed-result envelope (`{ ok: false, error: { code, ... } }`)
 *      → translated to precise WorkflowErrorCode values.
 *   5. Tool missing from catalog → TOOL_NOT_FOUND.
 *   6. Default dataset name derived when `node.name` is omitted.
 *   7. Non-string ref resolution → SPEC_SCHEMA_MISMATCH.
 *   8. Non-object tool result → TOOL_EXECUTION_FAILED.
 */

import { describe, expect, it } from "vitest";

import { WorkflowError } from "@/lib/workflows/error";
import type {
  ExecuteParams,
  ToolHandle,
  WorkflowEngineEvent,
} from "@/lib/workflows/engine";
import {
  createExecutionState,
  type ExecutionState,
} from "@/lib/workflows/engine/execution-context";
import {
  executeSqlNode,
  type SqlNodeDeps,
} from "@/lib/workflows/nodes/sql-node";
import type {
  CanonicalSqlNode,
  CanonicalWorkflowSpec,
} from "@/lib/workflows/spec/schema";

// ─── Fixtures ─────────────────────────────────────────────────────────

function sqlNode(
  overrides?: Partial<Omit<CanonicalSqlNode, "type">>,
): CanonicalSqlNode {
  return {
    type: "sql",
    id: 0,
    description: "extract orders",
    depends_on: [],
    dataSourceName: "prod_pg",
    query: "SELECT id, total FROM orders",
    name: "ds_orders",
    outputs: ["name", "rowCount"],
    ...overrides,
  };
}

function makeState(
  node: CanonicalSqlNode,
  init?: {
    input?: Record<string, unknown>;
    outputs?: Map<number, Record<string, unknown>>;
    nodes?: CanonicalWorkflowSpec["nodes"];
  },
): ExecutionState {
  const spec: CanonicalWorkflowSpec = {
    version: "1.0",
    name: "demo",
    refReconAlgorithm: "ref_recon_v1",
    nodes: init?.nodes ?? [node],
    outputs: { dummy: "@nodes.0.name" },
  };
  const params: ExecuteParams = {
    workflowId: "wf-1",
    runId: "run-abc123-deadbeef",
    spec,
    input: init?.input ?? {},
    context: {},
    abortController: new AbortController(),
  };
  const state = createExecutionState(params);
  if (init?.outputs) {
    for (const [id, out] of init.outputs) state.outputs.set(id, out);
  }
  return state;
}

interface ToolCall {
  input: Record<string, unknown>;
}

function makeDeps(
  toolResult: unknown,
): SqlNodeDeps & { calls: ToolCall[]; events: WorkflowEngineEvent[] } {
  const calls: ToolCall[] = [];
  const events: WorkflowEngineEvent[] = [];
  const handle: ToolHandle = {
    execute: async ({ input }) => {
      calls.push({ input: input as Record<string, unknown> });
      return toolResult;
    },
  };
  return {
    getTool: (name) => (name === "extract_dataset_by_sql" ? handle : null),
    emitEvent: (e) => {
      events.push(e);
    },
    calls,
    events,
  };
}

// ─── Happy paths ──────────────────────────────────────────────────────

describe("executeSqlNode — success path", () => {
  it("strips the tool envelope to { name, rowCount }", async () => {
    const node = sqlNode();
    const deps = makeDeps({
      cacheHit: true,
      name: "ds_orders",
      rowCount: 1234,
      schema: { columns: [] },
      ttlHours: 24,
    });
    const out = await executeSqlNode(node, makeState(node), deps);
    expect(out).toEqual({ name: "ds_orders", rowCount: 1234 });
    // No leakage of operational fields into the node output.
    expect(out).not.toHaveProperty("cacheHit");
    expect(out).not.toHaveProperty("ttlHours");
    expect(out).not.toHaveProperty("schema");
  });

  it("passes engine-pinned defaults previewRows=0 + forceRefresh=false", async () => {
    const node = sqlNode();
    const deps = makeDeps({ name: "ds_orders", rowCount: 0 });
    await executeSqlNode(node, makeState(node), deps);
    expect(deps.calls).toHaveLength(1);
    expect(deps.calls[0]!.input).toMatchObject({
      previewRows: 0,
      forceRefresh: false,
    });
  });

  it("forwards dataSourceName, query, name verbatim when no refs present", async () => {
    const node = sqlNode({
      dataSourceName: "warehouse",
      query: "SELECT 1",
      name: "ds_one",
    });
    const deps = makeDeps({ name: "ds_one", rowCount: 1 });
    await executeSqlNode(node, makeState(node), deps);
    expect(deps.calls[0]!.input).toMatchObject({
      name: "ds_one",
      dataSourceName: "warehouse",
      query: "SELECT 1",
    });
  });

  it("returns tool's reported name even when it differs from the spec slug", async () => {
    // Defensive — if the tool's L1 cache normalised the name, the
    // node output reflects what the tool ACTUALLY produced rather
    // than the spec hint.
    const node = sqlNode({ name: "spec_slug" });
    const deps = makeDeps({ name: "tool_slug", rowCount: 7 });
    const out = await executeSqlNode(node, makeState(node), deps);
    expect(out.name).toBe("tool_slug");
  });

  it("defaults rowCount to 0 when the tool result omits it", async () => {
    const node = sqlNode();
    const deps = makeDeps({ name: "ds_orders" });
    const out = await executeSqlNode(node, makeState(node), deps);
    expect(out).toEqual({ name: "ds_orders", rowCount: 0 });
  });
});

// ─── Ref resolution ────────────────────────────────────────────────────

describe("executeSqlNode — ref resolution", () => {
  it("resolves @workflow refs in query before invoking the tool", async () => {
    const node = sqlNode({
      query: "SELECT * FROM @workflow.tableName",
    });
    const deps = makeDeps({ name: "ds_orders", rowCount: 1 });
    await executeSqlNode(node, makeState(node, { input: { tableName: "orders" } }), deps);
    expect(deps.calls[0]!.input.query).toBe("SELECT * FROM orders");
  });

  it("resolves embedded @nodes refs in query", async () => {
    const upstream = sqlNode({
      id: 0,
      name: "upstream",
      query: "SELECT *",
      dataSourceName: "src",
    });
    const downstream = sqlNode({
      id: 1,
      depends_on: [0],
      query: "SELECT * FROM @nodes.0.name",
      dataSourceName: "src",
      name: "downstream",
    });
    const deps = makeDeps({ name: "downstream", rowCount: 5 });
    const state = makeState(downstream, {
      nodes: [upstream, downstream],
      outputs: new Map([[0, { name: "upstream_ds", rowCount: 10 }]]),
    });
    await executeSqlNode(downstream, state, deps);
    expect(deps.calls[0]!.input.query).toBe("SELECT * FROM upstream_ds");
  });

  it("resolves a pure-ref dataSourceName field", async () => {
    const node = sqlNode({
      dataSourceName: "@workflow.dataSourceSlug",
    });
    const deps = makeDeps({ name: "ds_orders", rowCount: 1 });
    await executeSqlNode(
      node,
      makeState(node, { input: { dataSourceSlug: "prod_replica" } }),
      deps,
    );
    expect(deps.calls[0]!.input.dataSourceName).toBe("prod_replica");
  });

  it("derives a deterministic default name when node.name is omitted", async () => {
    const node = sqlNode({ name: undefined });
    const deps = makeDeps({ name: "ds_orders", rowCount: 1 });
    await executeSqlNode(node, makeState(node), deps);
    // runId "run-abc123-deadbeef" → alphanumerics "runabc123deadbeef"
    // → first 8 = "runabc12" → "wf_runabc12_n0"
    expect(deps.calls[0]!.input.name).toBe("wf_runabc12_n0");
  });

  it("throws SPEC_SCHEMA_MISMATCH when a ref resolves to a non-string", async () => {
    const node = sqlNode({ name: "@workflow.numericName" });
    const deps = makeDeps({ name: "ds", rowCount: 0 });
    const state = makeState(node, { input: { numericName: 42 } });
    await expect(executeSqlNode(node, state, deps)).rejects.toMatchObject({
      errorCode: "SPEC_SCHEMA_MISMATCH",
    });
  });
});

// ─── Failure paths ─────────────────────────────────────────────────────

describe("executeSqlNode — tool envelope failure translation", () => {
  it("translates POLICY_VIOLATION to SQL_PERMISSION_DENIED", async () => {
    const node = sqlNode();
    const deps = makeDeps({
      ok: false,
      error: { code: "POLICY_VIOLATION", message: "read-only data source" },
    });
    await expect(executeSqlNode(node, makeState(node), deps)).rejects.toMatchObject({
      errorCode: "SQL_PERMISSION_DENIED",
      nodeId: 0,
    });
  });

  it("translates SQL_SYNTAX_ERROR to SQL_SYNTAX_ERROR", async () => {
    const node = sqlNode();
    const deps = makeDeps({
      ok: false,
      error: { code: "SQL_SYNTAX_ERROR", message: "near 'FORM'" },
    });
    await expect(executeSqlNode(node, makeState(node), deps)).rejects.toMatchObject({
      errorCode: "SQL_SYNTAX_ERROR",
    });
  });

  it("translates QUERY_HASH_MISMATCH to TOOL_INPUT_SCHEMA_MISMATCH", async () => {
    const node = sqlNode();
    const deps = makeDeps({
      ok: false,
      error: { code: "QUERY_HASH_MISMATCH", message: "name reused with different query" },
    });
    await expect(executeSqlNode(node, makeState(node), deps)).rejects.toMatchObject({
      errorCode: "TOOL_INPUT_SCHEMA_MISMATCH",
    });
  });

  it("translates DATA_SOURCE_NOT_FOUND to TOOL_NOT_FOUND", async () => {
    const node = sqlNode();
    const deps = makeDeps({
      ok: false,
      error: { code: "DATA_SOURCE_NOT_FOUND", message: "no such slug" },
    });
    await expect(executeSqlNode(node, makeState(node), deps)).rejects.toMatchObject({
      errorCode: "TOOL_NOT_FOUND",
    });
  });

  it("falls back to TOOL_EXECUTION_FAILED for unknown error codes", async () => {
    const node = sqlNode();
    const deps = makeDeps({
      ok: false,
      error: { code: "UNHEARD_OF_CODE", message: "what" },
    });
    await expect(executeSqlNode(node, makeState(node), deps)).rejects.toMatchObject({
      errorCode: "TOOL_EXECUTION_FAILED",
    });
  });

  it("preserves the original error code + message in the WorkflowError message", async () => {
    const node = sqlNode();
    const deps = makeDeps({
      ok: false,
      error: { code: "PARSE_ERROR", message: "unexpected token" },
    });
    let caught: WorkflowError | undefined;
    try {
      await executeSqlNode(node, makeState(node), deps);
    } catch (e) {
      caught = e as WorkflowError;
    }
    expect(caught?.message).toContain("PARSE_ERROR");
    expect(caught?.message).toContain("unexpected token");
  });
});

describe("executeSqlNode — defensive failures", () => {
  it("throws TOOL_NOT_FOUND when extract_dataset_by_sql is not in the catalog", async () => {
    const node = sqlNode();
    const deps: SqlNodeDeps = {
      getTool: () => null,
      emitEvent: () => {},
    };
    await expect(executeSqlNode(node, makeState(node), deps)).rejects.toMatchObject({
      errorCode: "TOOL_NOT_FOUND",
    });
  });

  it("throws TOOL_EXECUTION_FAILED on non-object tool result", async () => {
    const node = sqlNode();
    const deps = makeDeps("not an object");
    await expect(executeSqlNode(node, makeState(node), deps)).rejects.toMatchObject({
      errorCode: "TOOL_EXECUTION_FAILED",
    });
  });

  it("throws TOOL_EXECUTION_FAILED on null tool result", async () => {
    const node = sqlNode();
    const deps = makeDeps(null);
    await expect(executeSqlNode(node, makeState(node), deps)).rejects.toMatchObject({
      errorCode: "TOOL_EXECUTION_FAILED",
    });
  });

  it("throws TOOL_EXECUTION_FAILED on array tool result", async () => {
    const node = sqlNode();
    const deps = makeDeps([1, 2, 3]);
    await expect(executeSqlNode(node, makeState(node), deps)).rejects.toMatchObject({
      errorCode: "TOOL_EXECUTION_FAILED",
    });
  });
});
