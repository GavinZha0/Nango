import { describe, expect, it } from "vitest";

import { WorkflowError, type WorkflowErrorCode } from "@/lib/workflows/error";
import { validate } from "@/lib/workflows/spec/validate";
import type {
  CanonicalNode,
  CanonicalWorkflowSpec,
} from "@/lib/workflows/spec/schema";

// ─── Fixtures ─────────────────────────────────────────────────────────

const AGENT_UUID = "11111111-1111-4111-8111-111111111111";

function toolNode(
  overrides: Partial<Omit<Extract<CanonicalNode, { type: "tool" }>, "type">> & {
    id: number;
  },
): CanonicalNode {
  return {
    type: "tool",
    description: "n",
    depends_on: [],
    tool: "fetch_data_table",
    input: { dataSourceId: "x", sql: "select 1" },
    input_schema: {
      type: "object",
      properties: {
        dataSourceId: { type: "string" },
        sql: { type: "string" },
      },
      required: ["dataSourceId", "sql"],
    },
    outputs: ["dataset", "rowCount"],
    output_schema: {
      type: "object",
      properties: { dataset: { type: "string" }, rowCount: { type: "number" } },
      required: ["dataset", "rowCount"],
    },
    ...overrides,
  };
}

function agentNode(
  overrides: Partial<Omit<Extract<CanonicalNode, { type: "agent" }>, "type">> & {
    id: number;
  },
): CanonicalNode {
  return {
    type: "agent",
    description: "n",
    depends_on: [],
    agent: "Builtin / DataAnalyst",
    agentId: AGENT_UUID,
    input: {},
    output_schema: {
      type: "object",
      properties: { summary: { type: "string" } },
      required: ["summary"],
    },
    outputs: ["summary"],
    ...overrides,
  };
}

function spec(
  nodes: CanonicalNode[],
  outputs: Record<string, string> = { dataset: "@nodes.0.dataset" },
  extra?: Partial<CanonicalWorkflowSpec>,
): CanonicalWorkflowSpec {
  return {
    version: "1.0",
    name: "demo",
    refReconAlgorithm: "ref_recon_v1",
    nodes,
    outputs,
    ...extra,
  };
}

function expectError(
  fn: () => void,
  code: WorkflowErrorCode,
  match?: RegExp,
): WorkflowError {
  try {
    fn();
  } catch (e) {
    if (!(e instanceof WorkflowError)) throw e;
    expect(e.errorCode).toBe(code);
    if (match !== undefined) expect(e.message).toMatch(match);
    return e;
  }
  throw new Error(`Expected throw with code ${code}`);
}

// ─── Happy paths ──────────────────────────────────────────────────────

describe("validate — happy paths", () => {
  it("accepts a single-node workflow", () => {
    expect(() => validate(spec([toolNode({ id: 0 })]))).not.toThrow();
  });

  it("accepts a linear two-node DAG with ref + depends_on", () => {
    const s = spec([
      toolNode({ id: 0 }),
      toolNode({
        id: 1,
        depends_on: [0],
        tool: "run_code_in_sandbox",
        input_schema: {
          type: "object",
          properties: { dataset: { type: "string" } },
          required: ["dataset"],
        },
        input: { dataset: "@nodes.0.dataset" },
        outputs: ["result"],
        output_schema: {
          type: "object",
          properties: { result: { type: "string" } },
          required: ["result"],
        },
      }),
    ], { result: "@nodes.1.result" });
    expect(() => validate(s)).not.toThrow();
  });

  it("accepts diamond DAG with multiple paths to a leaf", () => {
    const s = spec([
      toolNode({ id: 0 }),
      toolNode({
        id: 1,
        depends_on: [0],
        tool: "minimal_tool",
        input_schema: undefined,
        input: { x: "@nodes.0.dataset" },
        outputs: ["a"],
      }),
      toolNode({
        id: 2,
        depends_on: [0],
        tool: "minimal_tool",
        input_schema: undefined,
        input: { x: "@nodes.0.dataset" },
        outputs: ["b"],
      }),
      toolNode({
        id: 3,
        depends_on: [1, 2],
        tool: "minimal_tool",
        input_schema: undefined,
        input: { x: "@nodes.1.a", y: "@nodes.2.b" },
        outputs: ["final"],
      }),
    ], { final: "@nodes.3.final" });
    expect(() => validate(s)).not.toThrow();
  });

  it("accepts embedded refs in SQL strings", () => {
    const s = spec([
      toolNode({
        id: 0,
        tool: "fetch_data_table",
        input: {
          dataSourceId: "orders",
          sql: "SELECT * FROM o WHERE created >= @workflow.date_start",
        },
      }),
    ], { dataset: "@nodes.0.dataset" }, {
      input_schema: {
        type: "object",
        properties: { date_start: { type: "string" } },
      },
    });
    expect(() => validate(s)).not.toThrow();
  });

  it("accepts @context.* refs without validation", () => {
    const s = spec([
      toolNode({
        id: 0,
        input: { dataSourceId: "@context.tenant", sql: "select 1" },
      }),
    ]);
    expect(() => validate(s)).not.toThrow();
  });

  it("accepts agent nodes wired by ref", () => {
    const s = spec([
      toolNode({ id: 0 }),
      agentNode({
        id: 1,
        depends_on: [0],
        input: { dataset: "@nodes.0.dataset" },
      }),
    ], { summary: "@nodes.1.summary" });
    expect(() => validate(s)).not.toThrow();
  });

  it("skips field validation when target node has no declared outputs[]", () => {
    const s = spec([
      toolNode({ id: 0, outputs: undefined, output_schema: undefined }),
      toolNode({
        id: 1,
        depends_on: [0],
        tool: "minimal_tool",
        input_schema: undefined,
        input: { anything: "@nodes.0.unknown_field" },
        outputs: undefined,
      }),
    ], { x: "@nodes.0.also_unknown" });
    expect(() => validate(s)).not.toThrow();
  });

  it("skips @workflow.* key validation when input_schema is absent", () => {
    const s = spec([
      toolNode({
        id: 0,
        input: { dataSourceId: "@workflow.anything", sql: "select 1" },
      }),
    ]);
    // No input_schema declared → @workflow.* refs are permissive.
    expect(() => validate(s)).not.toThrow();
  });
});

// ─── Empty / outputs ──────────────────────────────────────────────────

describe("validate — empty spec / outputs", () => {
  it("throws SPEC_SCHEMA_MISMATCH when nodes[] is empty", () => {
    expectError(
      () => validate(spec([])),
      "SPEC_SCHEMA_MISMATCH",
      /at least one node/i,
    );
  });

  it("throws SPEC_NO_OUTPUTS when spec.outputs is empty", () => {
    expectError(
      () => validate(spec([toolNode({ id: 0 })], {})),
      "SPEC_NO_OUTPUTS",
    );
  });
});

// ─── DAG / depends_on ─────────────────────────────────────────────────

describe("validate — DAG invariants", () => {
  it("throws SPEC_SCHEMA_MISMATCH on duplicate node ids", () => {
    const e = expectError(
      () => validate(spec([toolNode({ id: 0 }), toolNode({ id: 0 })])),
      "SPEC_SCHEMA_MISMATCH",
      /duplicate node id 0/i,
    );
    expect(e.nodeId).toBe(0);
  });

  it("throws SPEC_REF_UNKNOWN_NODE on depends_on referencing missing id", () => {
    const e = expectError(
      () =>
        validate(
          spec([toolNode({ id: 0, depends_on: [99] })]),
        ),
      "SPEC_REF_UNKNOWN_NODE",
      /depends_on references unknown node id 99/i,
    );
    expect(e.nodeId).toBe(0);
  });

  it("throws SPEC_DAG_CYCLE on self-dependency", () => {
    const e = expectError(
      () => validate(spec([toolNode({ id: 0, depends_on: [0] })])),
      "SPEC_DAG_CYCLE",
      /self-dependency/i,
    );
    expect(e.nodeId).toBe(0);
  });

  it("throws SPEC_DAG_CYCLE on 2-node cycle", () => {
    expectError(
      () =>
        validate(
          spec([
            toolNode({ id: 0, depends_on: [1] }),
            toolNode({ id: 1, depends_on: [0] }),
          ]),
        ),
      "SPEC_DAG_CYCLE",
    );
  });

  it("throws SPEC_DAG_CYCLE on 3-node cycle", () => {
    expectError(
      () =>
        validate(
          spec([
            toolNode({ id: 0, depends_on: [2] }),
            toolNode({ id: 1, depends_on: [0] }),
            toolNode({ id: 2, depends_on: [1] }),
          ]),
        ),
      "SPEC_DAG_CYCLE",
    );
  });
});

// ─── Node-input refs ──────────────────────────────────────────────────

describe("validate — node input refs", () => {
  it("throws SPEC_REF_UNKNOWN_NODE on @nodes.<unknown>.field", () => {
    const e = expectError(
      () =>
        validate(
          spec([
            toolNode({
              id: 0,
              tool: "minimal_tool",
              input_schema: undefined,
              input: { x: "@nodes.99.field" },
              outputs: ["a"],
            }),
          ], { a: "@nodes.0.a" }),
        ),
      "SPEC_REF_UNKNOWN_NODE",
      /@nodes\.99\.field/,
    );
    expect(e.nodeId).toBe(0);
  });

  it("throws SPEC_REF_UNREACHABLE when ref target isn't in depends_on closure", () => {
    // Node 1 references node 0, but doesn't list it in depends_on
    const e = expectError(
      () =>
        validate(
          spec([
            toolNode({ id: 0, outputs: ["dataset"] }),
            toolNode({
              id: 1,
              depends_on: [], // ← missing dep on 0
              tool: "minimal_tool",
              input_schema: undefined,
              input: { x: "@nodes.0.dataset" },
              outputs: ["a"],
            }),
          ], { a: "@nodes.1.a" }),
        ),
      "SPEC_REF_UNREACHABLE",
      /not in the transitive depends_on closure/i,
    );
    expect(e.nodeId).toBe(1);
  });

  it("accepts ref to grandparent (transitive closure)", () => {
    // 2 depends on 1 depends on 0; 2's input references node 0 — OK.
    const s = spec([
      toolNode({ id: 0 }),
      toolNode({
        id: 1,
        depends_on: [0],
        tool: "minimal_tool",
        input_schema: undefined,
        input: { x: "@nodes.0.dataset" },
        outputs: ["b"],
      }),
      toolNode({
        id: 2,
        depends_on: [1],
        tool: "minimal_tool",
        input_schema: undefined,
        input: { y: "@nodes.0.dataset", z: "@nodes.1.b" },
        outputs: ["c"],
      }),
    ], { c: "@nodes.2.c" });
    expect(() => validate(s)).not.toThrow();
  });

  it("throws SPEC_REF_UNKNOWN_FIELD when field isn't in target outputs[]", () => {
    const e = expectError(
      () =>
        validate(
          spec([
            toolNode({ id: 0, outputs: ["dataset"] }),
            toolNode({
              id: 1,
              depends_on: [0],
              tool: "minimal_tool",
              input_schema: undefined,
              input: { x: "@nodes.0.no_such_field" },
              outputs: ["a"],
            }),
          ], { a: "@nodes.1.a" }),
        ),
      "SPEC_REF_UNKNOWN_FIELD",
      /no_such_field/,
    );
    expect(e.nodeId).toBe(1);
  });

  it("detects embedded refs inside SQL strings", () => {
    const e = expectError(
      () =>
        validate(
          spec([
            toolNode({
              id: 0,
              tool: "fetch_data_table",
              input: {
                dataSourceId: "orders",
                sql: "SELECT * FROM o WHERE x = @nodes.99.field",
              },
            }),
          ]),
        ),
      "SPEC_REF_UNKNOWN_NODE",
    );
    expect(e.nodeId).toBe(0);
  });

  it("detects refs nested inside arrays/objects of node.input", () => {
    expectError(
      () =>
        validate(
          spec([
            toolNode({
              id: 0,
              tool: "minimal_tool",
              input_schema: undefined,
              input: {
                deep: {
                  items: ["@nodes.99.bad"],
                },
              },
              outputs: ["x"],
            }),
          ], { x: "@nodes.0.x" }),
        ),
      "SPEC_REF_UNKNOWN_NODE",
    );
  });
});

// ─── @workflow.* refs ──────────────────────────────────────────────────

describe("validate — workflow input refs", () => {
  it("throws SPEC_REF_UNKNOWN_FIELD when @workflow.key isn't in input_schema.properties", () => {
    const e = expectError(
      () =>
        validate(
          spec([
            toolNode({
              id: 0,
              tool: "fetch_data_table",
              input: {
                dataSourceId: "@workflow.missing_key",
                sql: "select 1",
              },
            }),
          ], { dataset: "@nodes.0.dataset" }, {
            input_schema: {
              type: "object",
              properties: { date_start: { type: "string" } },
            },
          }),
        ),
      "SPEC_REF_UNKNOWN_FIELD",
      /missing_key/,
    );
    expect(e.nodeId).toBe(0);
  });

  it("accepts @workflow.key when it's declared in input_schema.properties", () => {
    const s = spec([
      toolNode({
        id: 0,
        tool: "fetch_data_table",
        input: {
          dataSourceId: "@workflow.tenant",
          sql: "select 1",
        },
      }),
    ], { dataset: "@nodes.0.dataset" }, {
      input_schema: {
        type: "object",
        properties: { tenant: { type: "string" } },
      },
    });
    expect(() => validate(s)).not.toThrow();
  });
});

// ─── spec.outputs ──────────────────────────────────────────────────────

describe("validate — workflow-level outputs", () => {
  it("throws SPEC_SCHEMA_MISMATCH when an output value isn't a valid ref", () => {
    expectError(
      () =>
        validate(
          spec(
            [toolNode({ id: 0 })],
            { dataset: "not-a-ref-string" },
          ),
        ),
      "SPEC_SCHEMA_MISMATCH",
      /not a valid ref string/,
    );
  });

  it("throws SPEC_REF_UNKNOWN_NODE when an output points to a missing node", () => {
    expectError(
      () =>
        validate(
          spec(
            [toolNode({ id: 0 })],
            { dataset: "@nodes.99.dataset" },
          ),
        ),
      "SPEC_REF_UNKNOWN_NODE",
    );
  });

  it("throws SPEC_REF_UNKNOWN_FIELD when an output points to an undeclared field", () => {
    expectError(
      () =>
        validate(
          spec(
            [toolNode({ id: 0, outputs: ["dataset"] })],
            { dataset: "@nodes.0.bogus" },
          ),
        ),
      "SPEC_REF_UNKNOWN_FIELD",
    );
  });

  it("does NOT enforce reachability for workflow-level outputs", () => {
    // spec.outputs is workflow-scoped — no "editing node" so no
    // transitive closure check applies.
    const s = spec([
      toolNode({ id: 0 }),
      toolNode({
        id: 1,
        // independent path
        tool: "minimal_tool",
        input_schema: undefined,
        outputs: ["x"],
      }),
    ], { dataset: "@nodes.0.dataset", x: "@nodes.1.x" });
    expect(() => validate(s)).not.toThrow();
  });
});

// ─── Tool input coverage ───────────────────────────────────────────────

describe("validate — tool input coverage (cheap key check)", () => {
  it("throws TOOL_INPUT_SCHEMA_MISMATCH when a required key is missing", () => {
    const e = expectError(
      () =>
        validate(
          spec([
            toolNode({
              id: 0,
              input: { dataSourceId: "x" /* sql missing */ },
            }),
          ]),
        ),
      "TOOL_INPUT_SCHEMA_MISMATCH",
      /requires input field 'sql'/,
    );
    expect(e.nodeId).toBe(0);
    expect(e.nodeName).toBe("fetch_data_table");
  });

  it("accepts when all required keys are provided (refs count as present)", () => {
    const s = spec([
      toolNode({
        id: 0,
        input: {
          dataSourceId: "@workflow.tenant",
          sql: "@workflow.sql_template",
        },
      }),
    ], { dataset: "@nodes.0.dataset" }, {
      input_schema: {
        type: "object",
        properties: {
          tenant: { type: "string" },
          sql_template: { type: "string" },
        },
      },
    });
    expect(() => validate(s)).not.toThrow();
  });

  it("skips coverage check when input_schema is absent", () => {
    const s = spec([
      toolNode({
        id: 0,
        tool: "minimal_tool",
        input_schema: undefined,
        input: {},
        outputs: ["x"],
      }),
    ], { x: "@nodes.0.x" });
    expect(() => validate(s)).not.toThrow();
  });

  it("does NOT enforce required-key check on agent nodes", () => {
    const s = spec([
      agentNode({
        id: 0,
        input: {}, // empty agent input — allowed
      }),
    ], { summary: "@nodes.0.summary" });
    expect(() => validate(s)).not.toThrow();
  });
});

// ─── D36: SQL node ref validation ─────────────────────────────────────

function sqlNode(
  overrides: Partial<Omit<Extract<CanonicalNode, { type: "sql" }>, "type">> & {
    id: number;
  },
): CanonicalNode {
  return {
    type: "sql",
    description: "extract",
    depends_on: [],
    dataSourceName: "prod_pg",
    query: "SELECT 1",
    outputs: ["name", "rowCount"],
    ...overrides,
  };
}

describe("validate — SQL node ref carriers (D36)", () => {
  it("accepts a SQL node with no refs in its string fields", () => {
    expect(() => validate(spec([sqlNode({ id: 0 })], { ds: "@nodes.0.name" }))).not.toThrow();
  });

  it("walks query for embedded @nodes refs and rejects unknown node id", () => {
    expectError(
      () =>
        validate(
          spec(
            [sqlNode({ id: 0, query: "SELECT * FROM @nodes.99.name" })],
            { ds: "@nodes.0.name" },
          ),
        ),
      "SPEC_REF_UNKNOWN_NODE",
    );
  });

  it("walks query for embedded @nodes refs and rejects unreachable target", () => {
    // Two independent nodes; node 1's query refers to node 0 but
    // depends_on is empty → unreachable.
    expectError(
      () =>
        validate(
          spec(
            [
              sqlNode({ id: 0, name: "upstream" }),
              sqlNode({
                id: 1,
                depends_on: [],
                query: "SELECT * FROM @nodes.0.name",
                dataSourceName: "src",
              }),
            ],
            { ds: "@nodes.1.name" },
          ),
        ),
      "SPEC_REF_UNREACHABLE",
    );
  });

  it("walks query and rejects refs to fields not in target.outputs", () => {
    expectError(
      () =>
        validate(
          spec(
            [
              sqlNode({ id: 0, name: "upstream" }),
              sqlNode({
                id: 1,
                depends_on: [0],
                query: "SELECT * FROM @nodes.0.no_such_field",
                dataSourceName: "src",
              }),
            ],
            { ds: "@nodes.1.name" },
          ),
        ),
      "SPEC_REF_UNKNOWN_FIELD",
    );
  });

  it("walks dataSourceName for refs and rejects unknown workflow input key", () => {
    expectError(
      () =>
        validate(
          spec(
            [
              sqlNode({
                id: 0,
                dataSourceName: "@workflow.dsKey",
              }),
            ],
            { ds: "@nodes.0.name" },
            {
              input_schema: {
                type: "object",
                properties: { otherKey: { type: "string" } },
              },
            },
          ),
        ),
      "SPEC_REF_UNKNOWN_FIELD",
    );
  });

  it("accepts a @workflow ref when key is declared in input_schema.properties", () => {
    expect(() =>
      validate(
        spec(
          [
            sqlNode({
              id: 0,
              dataSourceName: "@workflow.dsKey",
            }),
          ],
          { ds: "@nodes.0.name" },
          {
            input_schema: {
              type: "object",
              properties: { dsKey: { type: "string" } },
            },
          },
        ),
      ),
    ).not.toThrow();
  });

  it("walks the optional name field for refs", () => {
    expectError(
      () =>
        validate(
          spec(
            [
              sqlNode({
                id: 0,
                name: "@nodes.99.name",
              }),
            ],
            { ds: "@nodes.0.name" },
          ),
        ),
      "SPEC_REF_UNKNOWN_NODE",
    );
  });

  it("allows downstream code node to ref the SQL node's name output", () => {
    // The canonical SQL node declares outputs ["name", "rowCount"];
    // a code node downstream consuming @nodes.0.name should be
    // accepted.
    const sqlOut: CanonicalNode = sqlNode({
      id: 0,
      name: "ds_orders",
    });
    const codeNode: CanonicalNode = {
      type: "code",
      id: 1,
      description: "analyse",
      depends_on: [0],
      language: "python",
      code: "import pandas",
      input: { datasets: ["@nodes.0.name"] },
      outputs: ["stdout", "stderr", "exitCode", "durationMs"],
    };
    expect(() =>
      validate(spec([sqlOut, codeNode], { ds: "@nodes.1.stdout" })),
    ).not.toThrow();
  });

  it("rejects downstream ref to a non-existent SQL output field", () => {
    const sqlOut: CanonicalNode = sqlNode({ id: 0, name: "ds_orders" });
    const codeNode: CanonicalNode = {
      type: "code",
      id: 1,
      description: "analyse",
      depends_on: [0],
      language: "python",
      code: "import pandas",
      input: { datasets: ["@nodes.0.schema"] }, // schema isn't a SQL node output
      outputs: ["stdout"],
    };
    expectError(
      () => validate(spec([sqlOut, codeNode], { ds: "@nodes.1.stdout" })),
      "SPEC_REF_UNKNOWN_FIELD",
    );
  });
});
