/**
 * Unit tests for the sql-node executor.
 *
 * Mirrors the per-attempt body documented in
 * `src/lib/workflows/nodes/sql-node.ts`:
 *
 *   1. Refs in `inputs.sql_text` / `inputs.data_source_name` /
 *      `inputs.dataset_name` resolve before the underlying
 *      `extract_dataset_by_sql` tool is invoked.
 *   2. `row_limit` (per-node `inputs.row_limit`) +
 *      `force_refresh: false` are ALWAYS passed — chat affordances
 *      are pinned, not exposed on the SQL node.
 *   3. Success envelope is projected to `{ dataset_name,
 *      total_rows, returned_rows, rows, row_schema }` (matches
 *      `DEFAULT_SQL_NODE_OUTPUTS`). Operational fields
 *      (`cache_hit` / `ttl_hours` / `replaced_prior`) are NOT
 *      exposed.
 *   4. Failed-result envelope (`{ ok: false, error: { code, ... } }`)
 *      → translated to precise WorkflowErrorCode values.
 *   5. Tool missing from catalog → TOOL_NOT_FOUND.
 *   6. Default dataset name derived when `inputs.dataset_name` is
 *      omitted.
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

const DEFAULT_DS_ID = "11111111-1111-4111-8111-111111111111";

function sqlNode(
  overrides?: Partial<Omit<CanonicalSqlNode, "type" | "inputs">> & {
    // Caller must explicitly mark `inputs.dataset_name` as `null`
    // to suppress the default — otherwise the fixture stamps
    // "ds_orders" so the common case stays terse.
    inputs?: Partial<
      Omit<CanonicalSqlNode["inputs"], "dataset_name">
    > & { dataset_name?: string | null };
  },
): CanonicalSqlNode {
  const { inputs: inputsOverride, ...rest } = overrides ?? {};
  const datasetName: string | undefined =
    inputsOverride === undefined ||
    !("dataset_name" in inputsOverride)
      ? "ds_orders"
      : inputsOverride.dataset_name === null
        ? undefined
        : inputsOverride.dataset_name;
  return {
    type: "sql",
    schema_version: "1",
    id: 0,
    description: "extract orders",
    depends_on: [],
    ...rest,
    inputs: {
      data_source_name: inputsOverride?.data_source_name ?? "prod_pg",
      data_source_id: inputsOverride?.data_source_id ?? DEFAULT_DS_ID,
      sql_text:
        inputsOverride?.sql_text ?? "SELECT id, total FROM orders",
      ...(datasetName !== undefined && { dataset_name: datasetName }),
      ...(inputsOverride?.row_limit !== undefined && { row_limit: inputsOverride.row_limit }),
    },
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
    name: "demo",
    nodes: init?.nodes ?? [node],
    outputs: { dummy: "@nodes.0.dataset_name" },
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
  inputs: Record<string, unknown>;
}

function makeDeps(
  toolResult: unknown,
): SqlNodeDeps & { calls: ToolCall[]; events: WorkflowEngineEvent[] } {
  const calls: ToolCall[] = [];
  const events: WorkflowEngineEvent[] = [];
  const handle: ToolHandle = {
    execute: async ({ input }) => {
      calls.push({ inputs: input as Record<string, unknown> });
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
  it("projects the tool envelope onto the canonical output shape", async () => {
    const previewRows = [
      { id: 1, total: 100 },
      { id: 2, total: 200 },
    ];
    const node = sqlNode();
    const deps = makeDeps({
      cache_hit: true,
      dataset_name: "ds_orders",
      total_rows: 1234,
      returned_rows: 2,
      rows: previewRows,
      row_schema: { columns: [] },
      ttl_hours: 24,
    });
    const out = await executeSqlNode(node, makeState(node), deps);
    expect(out).toEqual({
      dataset_name: "ds_orders",
      total_rows: 1234,
      returned_rows: 2,
      rows: previewRows,
      row_schema: { columns: [] },
    });
    // No leakage of operational fields into the node output.
    expect(out).not.toHaveProperty("cache_hit");
    expect(out).not.toHaveProperty("ttl_hours");
    expect(out).not.toHaveProperty("replaced_prior");
  });

  it("requests row_limit (>=200 default) + force_refresh=false from the tool", async () => {
    const node = sqlNode();
    const deps = makeDeps({
      dataset_name: "ds_orders",
      total_rows: 0,
      returned_rows: 0,
      rows: [],
    });
    await executeSqlNode(node, makeState(node), deps);
    expect(deps.calls).toHaveLength(1);
    expect(deps.calls[0]!.inputs).toMatchObject({
      row_limit: 200,
      force_refresh: false,
    });
  });

  it("forwards data_source_name, sql_text, dataset_name verbatim when no refs present", async () => {
    const node = sqlNode({
      inputs: {
        data_source_name: "warehouse",
        sql_text: "SELECT 1",
        dataset_name: "ds_one",
      },
    });
    const deps = makeDeps({
      dataset_name: "ds_one",
      total_rows: 1,
      returned_rows: 1,
      rows: [{}],
    });
    await executeSqlNode(node, makeState(node), deps);
    expect(deps.calls[0]!.inputs).toMatchObject({
      dataset_name: "ds_one",
      data_source_name: "warehouse",
      sql_text: "SELECT 1",
    });
  });

  it("returns tool's reported dataset_name even when it differs from the spec slug", async () => {
    // Defensive — if the tool's cache normalised the name, the
    // node output reflects what the tool ACTUALLY produced rather
    // than the spec hint.
    const node = sqlNode({ inputs: { dataset_name: "spec_slug" } });
    const deps = makeDeps({
      dataset_name: "tool_slug",
      total_rows: 7,
      returned_rows: 0,
      rows: [],
    });
    const out = await executeSqlNode(node, makeState(node), deps);
    expect(out.dataset_name).toBe("tool_slug");
  });

  it("defaults total_rows to 0 / rows to [] when the tool result omits them", async () => {
    const node = sqlNode();
    const deps = makeDeps({ dataset_name: "ds_orders" });
    const out = await executeSqlNode(node, makeState(node), deps);
    expect(out).toEqual({
      dataset_name: "ds_orders",
      total_rows: 0,
      returned_rows: 0,
      rows: [],
      row_schema: { columns: [] },
    });
  });
});

// ─── Ref resolution ────────────────────────────────────────────────────

describe("executeSqlNode — ref resolution", () => {
  it("resolves @workflow refs in sql_text before invoking the tool", async () => {
    const node = sqlNode({
      inputs: { sql_text: "SELECT * FROM @workflow.tableName" },
    });
    const deps = makeDeps({
      dataset_name: "ds_orders",
      total_rows: 1,
      returned_rows: 0,
      rows: [],
    });
    await executeSqlNode(
      node,
      makeState(node, { input: { tableName: "orders" } }),
      deps,
    );
    expect(deps.calls[0]!.inputs.sql_text).toBe("SELECT * FROM orders");
  });

  it("resolves embedded @nodes refs in sql_text", async () => {
    const upstream = sqlNode({
      id: 0,
      inputs: {
        data_source_name: "src",
        sql_text: "SELECT *",
        dataset_name: "upstream",
      },
    });
    const downstream = sqlNode({
      id: 1,
      depends_on: [0],
      inputs: {
        data_source_name: "src",
        sql_text: "SELECT * FROM @nodes.0.dataset_name",
        dataset_name: "downstream",
      },
    });
    const deps = makeDeps({
      dataset_name: "downstream",
      total_rows: 5,
      returned_rows: 0,
      rows: [],
    });
    const state = makeState(downstream, {
      nodes: [upstream, downstream],
      outputs: new Map([[0, { dataset_name: "upstream_ds" }]]),
    });
    await executeSqlNode(downstream, state, deps);
    expect(deps.calls[0]!.inputs.sql_text).toBe(
      "SELECT * FROM upstream_ds",
    );
  });

  it("resolves a pure-ref data_source_name field", async () => {
    const node = sqlNode({
      inputs: { data_source_name: "@workflow.dataSourceSlug" },
    });
    const deps = makeDeps({
      dataset_name: "ds_orders",
      total_rows: 1,
      returned_rows: 0,
      rows: [],
    });
    await executeSqlNode(
      node,
      makeState(node, { input: { dataSourceSlug: "prod_replica" } }),
      deps,
    );
    expect(deps.calls[0]!.inputs.data_source_name).toBe("prod_replica");
  });

  it("derives a deterministic default name when inputs.dataset_name is omitted", async () => {
    // Pass `dataset_name: null` to the fixture so the factory skips
    // the default and emits a node without the slot — the executor
    // then derives the runId-based slug at runtime.
    const node = sqlNode({ inputs: { dataset_name: null } });
    const deps = makeDeps({
      dataset_name: "ds_orders",
      total_rows: 1,
      returned_rows: 0,
      rows: [],
    });
    await executeSqlNode(node, makeState(node), deps);
    // runId "run-abc123-deadbeef" → alphanumerics "runabc123deadbeef"
    // → first 8 = "runabc12" → "wf_runabc12_n0"
    expect(deps.calls[0]!.inputs.dataset_name).toBe("wf_runabc12_n0");
  });

  it("throws SPEC_SCHEMA_MISMATCH when a ref resolves to a non-string", async () => {
    const node = sqlNode({
      inputs: { dataset_name: "@workflow.numericName" },
    });
    const deps = makeDeps({
      dataset_name: "ds",
      total_rows: 0,
      returned_rows: 0,
      rows: [],
    });
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
