import { describe, expect, it } from "vitest";

import {
  buildWorkflowSpecFromRunEvents,
  type ToolInvocation,
} from "@/lib/workflows/build-from-events";
import { LLMWorkflowSpecSchema } from "@/lib/workflows/spec/schema";

// ─── Fixtures ─────────────────────────────────────────────────────────

function inv(
  overrides: Partial<ToolInvocation> & {
    callId: string;
    toolName: string;
    seq: number;
  },
): ToolInvocation {
  return {
    inputs: {},
    result: { ok: true },
    ok: true,
    ...overrides,
  };
}

// ─── Step 2 / 3: locate artifact creator + filter chain ───────────────

describe("buildWorkflowSpecFromRunEvents — chain filtering", () => {
  it("throws when artifactCreatingCallId is not in the list", () => {
    expect(() =>
      buildWorkflowSpecFromRunEvents({
        invocations: [
          inv({ callId: "c1", toolName: "fetch_data_table", seq: 1 }),
        ],
        artifactCreatingCallId: "missing",
      }),
    ).toThrow(/not found/);
  });

  it("does NOT enumerate frontend_tool names — trusts the supplied callId", () => {
    // Per the redesign (W1.7.x — user's pushback): the user's click
    // identifies the artifact creator. We don't keep a registry of
    // "which tools are frontend". The supplied callId IS by
    // definition the artifact creator.
    const out = buildWorkflowSpecFromRunEvents({
      invocations: [
        inv({
          callId: "c1",
          toolName: "fetch_data_table",
          seq: 1,
          inputs: { sql: "select 1" },
        }),
      ],
      artifactCreatingCallId: "c1",
    });
    // c1 (fetch_data_table) is treated as the artifact creator;
    // its input becomes strippedFrontendConfig; no other data nodes
    // → placeholder no-op node fills the spec.
    expect(out.strippedFrontendConfig).toEqual({ sql: "select 1" });
    expect(out.spec.nodes).toHaveLength(1);
    expect((out.spec.nodes[0] as { inputs: { name: string } }).inputs.name).toBe("noop");
  });

  it("prunes failed invocations", () => {
    const out = buildWorkflowSpecFromRunEvents({
      invocations: [
        inv({
          callId: "c1",
          toolName: "fetch_data_table",
          seq: 1,
          inputs: { sql: "select 1" },
          result: { dataset: "ds_abc" },
        }),
        inv({
          callId: "c2",
          toolName: "transform",
          seq: 2,
          ok: false,
          result: null,
        }),
        inv({
          callId: "c3",
          toolName: "chart_renderer",
          seq: 3,
          inputs: { data: "ds_abc", type: "bar" },
        }),
      ],
      artifactCreatingCallId: "c3",
    });
    // Only one data node — the failed transform is excluded.
    expect(out.spec.nodes).toHaveLength(1);
    expect((out.spec.nodes[0] as { inputs: { name: string } }).inputs.name).toBe(
      "fetch_data_table",
    );
  });

  it("drops invocations that came AFTER the artifact creator", () => {
    const out = buildWorkflowSpecFromRunEvents({
      invocations: [
        inv({ callId: "c1", toolName: "fetch_data_table", seq: 1 }),
        inv({ callId: "c2", toolName: "chart_renderer", seq: 2 }),
        // a later call after the artifact was created — should be ignored
        inv({ callId: "c3", toolName: "fetch_data_table", seq: 3 }),
      ],
      artifactCreatingCallId: "c2",
    });
    expect(out.spec.nodes).toHaveLength(1); // c1 only
  });
});

// ─── Step 4: strip frontend_tools ─────────────────────────────────────

describe("buildWorkflowSpecFromRunEvents — frontend_tool stripping", () => {
  it("extracts the artifact creator's input as strippedFrontendConfig", () => {
    const out = buildWorkflowSpecFromRunEvents({
      invocations: [
        inv({ callId: "c1", toolName: "fetch_data_table", seq: 1 }),
        inv({
          callId: "c2",
          toolName: "chart_renderer",
          seq: 2,
          inputs: { data: "ds_abc", type: "bar", title: "Sales" },
        }),
      ],
      artifactCreatingCallId: "c2",
    });
    expect(out.strippedFrontendConfig).toEqual({
      data: "ds_abc",
      type: "bar",
      title: "Sales",
    });
  });

  it("keeps every successful call except the artifact creator as a workflow node", () => {
    // After the FRONTEND_TOOL_NAMES enumeration was retired, this
    // means a stray earlier rendering call WILL show up in the
    // workflow. That's acceptable (lineage report records it; a
    // refresh would re-run it; not silent corruption) and matches
    // the simpler "trust the supplied id" contract.
    const out = buildWorkflowSpecFromRunEvents({
      invocations: [
        inv({ callId: "c1", toolName: "fetch_data_table", seq: 1 }),
        inv({ callId: "c2", toolName: "render_markdown", seq: 2 }),
        inv({ callId: "c3", toolName: "render_chart", seq: 3 }),
      ],
      artifactCreatingCallId: "c3",
    });
    // Only c3 (the artifact creator) is stripped; c1 + c2 BOTH
    // become workflow nodes.
    expect(out.spec.nodes).toHaveLength(2);
    expect(out.spec.nodes.map((n) => (n as { inputs: { name: string } }).inputs.name)).toEqual([
      "fetch_data_table",
      "render_markdown",
    ]);
  });

  it("emits a placeholder no-op node when there are no data invocations", () => {
    const out = buildWorkflowSpecFromRunEvents({
      invocations: [
        inv({ callId: "c1", toolName: "render_markdown", seq: 1, inputs: { markdown: "Hello" } }),
      ],
      artifactCreatingCallId: "c1",
    });
    // Spec requires ≥ 1 node; placeholder is the fallback.
    expect(out.spec.nodes).toHaveLength(1);
    expect((out.spec.nodes[0] as { inputs: { name: string } }).inputs.name).toBe("noop");
  });
});

// ─── Step 7: bucket tag + numeric id + agent display string ───────────

describe("buildWorkflowSpecFromRunEvents — node bucket + ids", () => {
  it("assigns monotonic numeric ids in chronological order (D29)", () => {
    const out = buildWorkflowSpecFromRunEvents({
      invocations: [
        inv({ callId: "c1", toolName: "fetch_data_table", seq: 1 }),
        inv({ callId: "c2", toolName: "transform_dataset", seq: 2 }),
        inv({ callId: "c3", toolName: "chart_renderer", seq: 3 }),
      ],
      artifactCreatingCallId: "c3",
    });
    expect(out.spec.nodes.map((n) => n.id)).toEqual([0, 1]);
  });

  it("emits a tool node for ordinary invocations", () => {
    const out = buildWorkflowSpecFromRunEvents({
      invocations: [
        inv({
          callId: "c1",
          toolName: "fetch_data_table",
          seq: 1,
          inputs: { sql: "select 1" },
        }),
        inv({ callId: "c2", toolName: "chart_renderer", seq: 2 }),
      ],
      artifactCreatingCallId: "c2",
    });
    const node = out.spec.nodes[0]!;
    if (node.type !== "tool") throw new Error("expected tool node");
    expect(node.inputs.name).toBe("fetch_data_table");
    expect(node.inputs.arguments).toEqual({ sql: "select 1" });
  });

  it("emits an agent node for delegate_to_agent invocations", () => {
    const out = buildWorkflowSpecFromRunEvents({
      invocations: [
        inv({
          callId: "c1",
          toolName: "delegate_to_agent",
          seq: 1,
          inputs: {
            agent: "Builtin / DataAnalyst",
            task: "Summarise the dataset",
          },
          result: { summary: "5 rows" },
        }),
        inv({ callId: "c2", toolName: "render_markdown", seq: 2 }),
      ],
      artifactCreatingCallId: "c2",
    });
    const node = out.spec.nodes[0]!;
    if (node.type !== "agent") throw new Error("expected agent node");
    expect(node.inputs.name).toBe("Builtin / DataAnalyst");
    expect(node.inputs.task).toBe("Summarise the dataset");
    // LLM-emit agent nodes do NOT carry `output_schema`; the
    // canonical wrapper stamps it. Verify the field is absent
    // pre-canonicalize.
    expect("output_schema" in node).toBe(false);
  });

  it("throws when an agent invocation is missing the 'agent' field", () => {
    expect(() =>
      buildWorkflowSpecFromRunEvents({
        invocations: [
          inv({
            callId: "c1",
            toolName: "delegate_to_agent",
            seq: 1,
            inputs: { input: {} }, // no 'agent'
          }),
          inv({ callId: "c2", toolName: "render_markdown", seq: 2 }),
        ],
        artifactCreatingCallId: "c2",
      }),
    ).toThrow(/no 'agent' field/);
  });

  it("all nodes have depends_on: [] in W1.5.A (Strategy Z+ fills in W1.5.B)", () => {
    const out = buildWorkflowSpecFromRunEvents({
      invocations: [
        inv({ callId: "c1", toolName: "fetch_data_table", seq: 1 }),
        inv({ callId: "c2", toolName: "transform", seq: 2, inputs: { from: "ds_abc" } }),
        inv({ callId: "c3", toolName: "chart_renderer", seq: 3 }),
      ],
      artifactCreatingCallId: "c3",
    });
    for (const node of out.spec.nodes) {
      expect(node.depends_on).toEqual([]);
    }
  });
});

// ─── Step 8: descriptions ─────────────────────────────────────────────

describe("buildWorkflowSpecFromRunEvents — descriptions", () => {
  it("includes a short input snippet in node.description", () => {
    const out = buildWorkflowSpecFromRunEvents({
      invocations: [
        inv({
          callId: "c1",
          toolName: "fetch_data_table",
          seq: 1,
          inputs: { sql: "select * from orders", limit: 100 },
        }),
        inv({ callId: "c2", toolName: "chart_renderer", seq: 2 }),
      ],
      artifactCreatingCallId: "c2",
    });
    const desc = out.spec.nodes[0]!.description;
    expect(desc).toContain("fetch_data_table");
    expect(desc).toContain("sql=");
    expect(desc).toContain("limit=100");
  });

  it("truncates very long input string values", () => {
    const longSql = "select * from orders ".repeat(20);
    const out = buildWorkflowSpecFromRunEvents({
      invocations: [
        inv({
          callId: "c1",
          toolName: "fetch_data_table",
          seq: 1,
          inputs: { sql: longSql },
        }),
        inv({ callId: "c2", toolName: "chart_renderer", seq: 2 }),
      ],
      artifactCreatingCallId: "c2",
    });
    const desc = out.spec.nodes[0]!.description;
    expect(desc).toMatch(/…$/); // ends with ellipsis
    expect(desc.length).toBeLessThan(longSql.length + 40);
  });

  it("falls back to bare tool name when input has no scalar fields", () => {
    const out = buildWorkflowSpecFromRunEvents({
      invocations: [
        inv({
          callId: "c1",
          toolName: "complex_tool",
          seq: 1,
          inputs: { nested: { x: 1 } }, // only object values
        }),
        inv({ callId: "c2", toolName: "chart_renderer", seq: 2 }),
      ],
      artifactCreatingCallId: "c2",
    });
    expect(out.spec.nodes[0]!.description).toBe("complex_tool");
  });
});

// ─── Step 9: spec.outputs (refined contract) ───────────────────────────
//
// V1.1 contract:
//   - Only keys that Strategy Z+ rewrote to a real @nodes ref make
//     it into spec.outputs. Static literals (title, description,
//     optionJson, …) live in artifact.content, NOT here.
//   - When Strategy Z+ produced zero refs, a single sentinel
//     `result: @nodes.<lastNodeId>.<observedKey>` is emitted so
//     the spec satisfies the non-empty-outputs schema rule.
//     `observedKey` is taken from the actual result of the last
//     data invocation — never a guess based on the artifact
//     creator's own input field names.

describe("buildWorkflowSpecFromRunEvents — spec.outputs (V1.1 refined contract)", () => {
  it("emits sentinel when no artifact-input field could be rewritten", () => {
    // Artifact creator's only ref-shaped input ("ds_abc") happens
    // NOT to match any upstream output → Strategy Z+ produces zero
    // refs; the sentinel uses the last invocation's observed
    // result.dataset.
    const out = buildWorkflowSpecFromRunEvents({
      invocations: [
        inv({
          callId: "c1",
          toolName: "fetch_data_table",
          seq: 1,
          result: { dataset: "ds_other_q1" },
        }),
        inv({
          callId: "c2",
          toolName: "chart_renderer",
          seq: 2,
          inputs: { data: "ds_abc", type: "bar" },
        }),
      ],
      artifactCreatingCallId: "c2",
    });
    expect(out.spec.outputs).toEqual({ result: "@nodes.0.dataset" });
  });

  it("sentinel uses last invocation's first observed result key", () => {
    // c1's result is { ok: true } (from the inv() default) → the
    // sentinel ref points at @nodes.0.ok. Validate.ts will accept
    // this iff the canonicalize step's registry lookup declares
    // 'ok' as a known output for the tool; if not, save time
    // catches the mismatch as SPEC_REF_UNKNOWN_FIELD — far more
    // useful than the V1's blind '@nodes.0.result' fabrication.
    const out = buildWorkflowSpecFromRunEvents({
      invocations: [
        inv({ callId: "c1", toolName: "fetch_data_table", seq: 1 }),
        inv({ callId: "c2", toolName: "chart_renderer", seq: 2, inputs: {} }),
      ],
      artifactCreatingCallId: "c2",
    });
    expect(out.spec.outputs).toEqual({ result: "@nodes.0.ok" });
  });

  it("sentinel falls back to literal 'result' when last invocation has no result", () => {
    const out = buildWorkflowSpecFromRunEvents({
      invocations: [
        inv({
          callId: "c1",
          toolName: "fetch_data_table",
          seq: 1,
          ok: false,
          result: null,
        }),
        inv({ callId: "c2", toolName: "chart_renderer", seq: 2, inputs: {} }),
      ],
      artifactCreatingCallId: "c2",
    });
    // c1 is not successful, so dataInvocations is empty → no nodes,
    // pipeline emits a placeholder no-op node and the
    // hard-coded "@nodes.0.result" sentinel.
    expect(out.spec.outputs).toEqual({ result: "@nodes.0.result" });
  });
});

// ─── Overall shape: Zod LLMWorkflowSpecSchema accepts the output ──────

describe("buildWorkflowSpecFromRunEvents — output passes LLMWorkflowSpecSchema", () => {
  it("end-to-end linear: tool → tool → chart", () => {
    const out = buildWorkflowSpecFromRunEvents({
      invocations: [
        inv({
          callId: "c1",
          toolName: "fetch_data_table",
          seq: 1,
          inputs: { sql: "select 1" },
          result: { dataset: "ds_abc" },
        }),
        inv({
          callId: "c2",
          toolName: "sandbox_step",
          seq: 2,
          inputs: { code: "df.head()" },
          result: { dataset: "ds_xyz" },
        }),
        inv({
          callId: "c3",
          toolName: "chart_renderer",
          seq: 3,
          inputs: { data: "ds_xyz", type: "bar" },
        }),
      ],
      artifactCreatingCallId: "c3",
    });
    const parsed = LLMWorkflowSpecSchema.safeParse(out.spec);
    expect(parsed.success).toBe(true);
  });

  it("end-to-end with agent: extract → delegate → render", () => {
    const out = buildWorkflowSpecFromRunEvents({
      invocations: [
        inv({
          callId: "c1",
          toolName: "fetch_data_table",
          seq: 1,
          inputs: { sql: "select 1" },
          result: { dataset: "ds_abc" },
        }),
        inv({
          callId: "c2",
          toolName: "delegate_to_agent",
          seq: 2,
          inputs: {
            agent: "Builtin / DataAnalyst",
            task: "Summarise the dataset",
          },
          result: { summary: "5 rows" },
        }),
        inv({
          callId: "c3",
          toolName: "render_markdown",
          seq: 3,
          inputs: { markdown: "5 rows" },
        }),
      ],
      artifactCreatingCallId: "c3",
    });
    const parsed = LLMWorkflowSpecSchema.safeParse(out.spec);
    expect(parsed.success).toBe(true);
    expect(out.spec.nodes).toHaveLength(2);
    expect(out.spec.nodes[1]!.type).toBe("agent");
  });
});

// ─── Strategy Z+ ref reconstruction (W1.5.B) ──────────────────────────

describe("buildWorkflowSpecFromRunEvents — Strategy Z+ unique-match", () => {
  it("rewrites a top-level scalar input to @nodes.X.Y when uniquely matched", () => {
    const out = buildWorkflowSpecFromRunEvents({
      invocations: [
        inv({
          callId: "c1",
          toolName: "fetch_data_table",
          seq: 1,
          inputs: { sql: "select 1" },
          result: { dataset: "ds_orders_2025" },
        }),
        inv({
          callId: "c2",
          toolName: "sandbox_step",
          seq: 2,
          inputs: { code: "df.head()", source_dataset: "ds_orders_2025" },
          result: { dataset: "ds_summary_001" },
        }),
        inv({
          callId: "c3",
          toolName: "chart_renderer",
          seq: 3,
          inputs: { data: "ds_summary_001", type: "bar" },
        }),
      ],
      artifactCreatingCallId: "c3",
    });
    const node1 = out.spec.nodes[1] as { inputs: { arguments: Record<string, unknown> }; depends_on: number[]  };
    expect(node1.inputs.arguments.source_dataset).toBe("@nodes.0.dataset");
    expect(node1.inputs.arguments.code).toBe("df.head()"); // not ref-candidate; preserved
    expect(node1.depends_on).toEqual([0]);
  });

  it("derives depends_on from the union of all unique-match refs", () => {
    // c2 references c0's dataset; c3 references both c0 and c2 outputs.
    // ID fixtures use ≥6-char tokens so they pass the V1.1
    // isRefCandidate length floor.
    const out = buildWorkflowSpecFromRunEvents({
      invocations: [
        inv({
          callId: "c1",
          toolName: "extract",
          seq: 1,
          inputs: { sql: "x" },
          result: { dataset: "ds_orders_q1", reportId: "tmp_report1" },
        }),
        inv({
          callId: "c2",
          toolName: "transform_a",
          seq: 2,
          inputs: { from: "ds_orders_q1" },
          result: { dataset: "ds_orders_q2" },
        }),
        inv({
          callId: "c3",
          toolName: "join",
          seq: 3,
          inputs: {
            left: "ds_orders_q1",
            right: "ds_orders_q2",
            report: "tmp_report1",
          },
        }),
        inv({ callId: "c4", toolName: "chart_renderer", seq: 4 }),
      ],
      artifactCreatingCallId: "c4",
    });
    const node3 = out.spec.nodes[2] as { inputs: { arguments: Record<string, unknown> }; depends_on: number[]  };
    expect(node3.inputs.arguments.left).toBe("@nodes.0.dataset");
    expect(node3.inputs.arguments.right).toBe("@nodes.1.dataset");
    expect(node3.inputs.arguments.report).toBe("@nodes.0.reportId");
    expect(node3.depends_on).toEqual([0, 1]); // sorted, deduplicated
  });

  it("preserves the discriminator + agent-specific fields after rewrite", () => {
    const out = buildWorkflowSpecFromRunEvents({
      invocations: [
        inv({
          callId: "c1",
          toolName: "extract",
          seq: 1,
          inputs: { sql: "x" },
          result: { dataset: "ds_orders_q4" },
        }),
        inv({
          callId: "c2",
          toolName: "delegate_to_agent",
          seq: 2,
          inputs: {
            agent: "Builtin / DataAnalyst",
            // Whole-field ref into upstream dataset string.
            task: "ds_orders_q4",
          },
          result: { summary: "5 rows" },
        }),
        inv({ callId: "c3", toolName: "render_markdown", seq: 3 }),
      ],
      artifactCreatingCallId: "c3",
    });
    const agentNode = out.spec.nodes[1];
    if (agentNode!.type !== "agent") throw new Error("expected agent node");
    expect(agentNode.inputs.name).toBe("Builtin / DataAnalyst");
    // Strategy Z+ promotes the `task` literal into the matching
    // upstream ref.
    expect(agentNode.inputs.task).toBe("@nodes.0.dataset");
    expect(agentNode.depends_on).toEqual([0]);
    // Output schema is canonical-fixed; LLM-emit nodes do not
    // carry it.
    expect("output_schema" in agentNode).toBe(false);
  });

  it("populates lineageReport.resolved_refs with the unique match", () => {
    const out = buildWorkflowSpecFromRunEvents({
      invocations: [
        inv({
          callId: "c1",
          toolName: "extract",
          seq: 1,
          inputs: { sql: "x" },
          result: { dataset: "ds_orders_q4" },
        }),
        inv({
          callId: "c2",
          toolName: "transform",
          seq: 2,
          inputs: { from: "ds_orders_q4" },
        }),
        inv({ callId: "c3", toolName: "chart_renderer", seq: 3 }),
      ],
      artifactCreatingCallId: "c3",
    });
    expect(out.lineageReport.resolved_refs).toHaveLength(1);
    expect(out.lineageReport.resolved_refs[0]).toEqual({
      nodeId: 1,
      field: "from",
      resolved_to: "@nodes.0.dataset",
      confidence: "unique-match",
    });
  });
});

describe("buildWorkflowSpecFromRunEvents — Strategy Z+ ambiguous-match", () => {
  it("keeps literal + logs ambiguous_matches when multiple sources produce the same value", () => {
    const out = buildWorkflowSpecFromRunEvents({
      invocations: [
        inv({
          callId: "c1",
          toolName: "extractA",
          seq: 1,
          inputs: {},
          result: { dataset: "ds_shared_id" },
        }),
        inv({
          callId: "c2",
          toolName: "extractB",
          seq: 2,
          inputs: {},
          result: { dataset: "ds_shared_id" }, // SAME value
        }),
        inv({
          callId: "c3",
          toolName: "consumer",
          seq: 3,
          inputs: { from: "ds_shared_id" },
        }),
        inv({ callId: "c4", toolName: "chart_renderer", seq: 4 }),
      ],
      artifactCreatingCallId: "c4",
    });
    const node3 = out.spec.nodes[2] as {
      inputs: { arguments: Record<string, unknown> };
      depends_on: number[];
    };
    expect(node3.inputs.arguments.from).toBe("ds_shared_id"); // kept literal
    expect(node3.depends_on).toEqual([]); // no deps added
    expect(out.lineageReport.ambiguous_matches).toHaveLength(1);
    expect(out.lineageReport.ambiguous_matches[0]!.value).toBe("ds_shared_id");
    expect(out.lineageReport.ambiguous_matches[0]!.possible_sources).toEqual([
      { nodeId: 0, fieldPath: "dataset" },
      { nodeId: 1, fieldPath: "dataset" },
    ]);
  });
});

describe("buildWorkflowSpecFromRunEvents — Strategy Z+ candidate_values_no_match", () => {
  it("logs ref-candidate values with no producing source", () => {
    // 'ds_unknown_99' looks ID-shaped but no node produces it
    // (e.g. came from workflow input or external context).
    const out = buildWorkflowSpecFromRunEvents({
      invocations: [
        inv({
          callId: "c1",
          toolName: "consumer",
          seq: 1,
          inputs: { dataset: "ds_unknown_99" },
        }),
        inv({ callId: "c2", toolName: "chart_renderer", seq: 2 }),
      ],
      artifactCreatingCallId: "c2",
    });
    const node0 = out.spec.nodes[0] as { inputs: { arguments: Record<string, unknown> }; depends_on: number[]  };
    expect(node0.inputs.arguments.dataset).toBe("ds_unknown_99"); // literal preserved
    expect(node0.depends_on).toEqual([]);
    expect(out.lineageReport.candidate_values_no_match).toHaveLength(1);
    expect(out.lineageReport.candidate_values_no_match[0]).toEqual({
      nodeId: 0,
      field: "dataset",
      value: "ds_unknown_99",
    });
  });
});

describe("buildWorkflowSpecFromRunEvents — Strategy Z+ non-candidate values", () => {
  it("does not touch values that fail isRefCandidate (short / non-regex)", () => {
    const out = buildWorkflowSpecFromRunEvents({
      invocations: [
        inv({
          callId: "c1",
          toolName: "extract",
          seq: 1,
          inputs: { sql: "select 1", limit: 100 },
          result: { dataset: "ds_orders_q4" },
        }),
        inv({
          callId: "c2",
          toolName: "consumer",
          seq: 2,
          inputs: {
            sql: "another sql",      // not ref-candidate
            tag: "US",                // too short (< 6)
            short_id: "ds_xy",        // 6-char prefix+_+2 — fails namespaced regex `{6,}` token
            n: 42,                    // non-string
            flag: true,               // non-string
            dataset: "ds_orders_q4",  // IS ref-candidate → rewritten
          },
        }),
        inv({ callId: "c3", toolName: "chart_renderer", seq: 3 }),
      ],
      artifactCreatingCallId: "c3",
    });
    const node1 = out.spec.nodes[1] as { inputs: { arguments: Record<string, unknown> } };
    expect(node1.inputs.arguments.sql).toBe("another sql");
    expect(node1.inputs.arguments.tag).toBe("US");
    expect(node1.inputs.arguments.short_id).toBe("ds_xy"); // fails namespaced regex
    expect(node1.inputs.arguments.n).toBe(42);
    expect(node1.inputs.arguments.flag).toBe(true);
    expect(node1.inputs.arguments.dataset).toBe("@nodes.0.dataset");
  });
});

describe("buildWorkflowSpecFromRunEvents — Strategy Z+ nested object (M1)", () => {
  it("rewrites a long value inside a one-level-deep nested object", () => {
    // Customer ID comes from an upstream SQL result and is passed as a
    // nested argument: tool.inputs.filter.customer_id = "<upstream value>".
    // Strategy Z+ should recurse into `filter` and produce a ref.
    const customerId = "cust_abc_xyz_123_q1_2026"; // 24 chars — passes nested threshold
    const out = buildWorkflowSpecFromRunEvents({
      invocations: [
        inv({
          callId: "c0",
          toolName: "extract_customers",
          seq: 1,
          inputs: { sql: "SELECT id FROM customers LIMIT 1" },
          result: { customer_id: customerId },
        }),
        inv({
          callId: "c1",
          toolName: "run_report",
          seq: 2,
          inputs: {
            filter: { customer_id: customerId },
            format: "json",
          },
        }),
        inv({ callId: "c2", toolName: "chart_renderer", seq: 3 }),
      ],
      artifactCreatingCallId: "c2",
    });
    const node1 = out.spec.nodes[1] as unknown as {
      inputs: { arguments: { filter: Record<string, unknown>; format: string } };
      depends_on: number[];
    };
    // Nested value was rewritten to a ref
    expect(node1.inputs.arguments.filter.customer_id).toBe("@nodes.0.customer_id");
    // Non-candidate short value is untouched
    expect(node1.inputs.arguments.format).toBe("json");
    // depends_on includes the upstream node
    expect(node1.depends_on).toContain(0);
  });

  it("does NOT rewrite nested values shorter than 12 chars (stricter threshold)", () => {
    const shortId = "cust_abc"; // 8 chars — below nested threshold but above top-level
    const out = buildWorkflowSpecFromRunEvents({
      invocations: [
        inv({
          callId: "c0",
          toolName: "extract",
          seq: 1,
          inputs: { sql: "SELECT 1" },
          result: { id: shortId },
        }),
        inv({
          callId: "c1",
          toolName: "consumer",
          seq: 2,
          inputs: { filter: { id: shortId } },
        }),
        inv({ callId: "c2", toolName: "chart_renderer", seq: 3 }),
      ],
      artifactCreatingCallId: "c2",
    });
    const node1 = out.spec.nodes[1] as unknown as {
      inputs: { arguments: { filter: Record<string, unknown> } };
    };
    // 8 chars: above top-level threshold but below nested threshold → NOT rewritten
    expect(node1.inputs.arguments.filter.id).toBe(shortId);
  });

  it("does NOT recurse into objects at depth 2 (only one level deep)", () => {
    const deepId = "cust_abc_xyz_deep_123456"; // 23 chars — would match if walked
    const out = buildWorkflowSpecFromRunEvents({
      invocations: [
        inv({
          callId: "c0",
          toolName: "extract",
          seq: 1,
          inputs: { sql: "x" },
          result: { customer_id: deepId },
        }),
        inv({
          callId: "c1",
          toolName: "consumer",
          seq: 2,
          inputs: {
            // depth 0: a → object at depth 1
            //           b → object at depth 2 — must NOT be recursed
            a: { b: { id: deepId } },
          },
        }),
        inv({ callId: "c2", toolName: "chart_renderer", seq: 3 }),
      ],
      artifactCreatingCallId: "c2",
    });
    const node1 = out.spec.nodes[1] as unknown as {
      inputs: { arguments: { a: { b: { id: string } } } };
    };
    // depth 2 is not walked → value stays literal
    expect(node1.inputs.arguments.a.b.id).toBe(deepId);
  });

  it("still rewrites top-level values normally when the same input also has a nested object", () => {
    const topId = "top_level_id_xyz_2026"; // 21 chars — top-level, threshold 6
    const out = buildWorkflowSpecFromRunEvents({
      invocations: [
        inv({
          callId: "c0",
          toolName: "extract",
          seq: 1,
          inputs: { sql: "x" },
          result: { report_id: topId },
        }),
        inv({
          callId: "c1",
          toolName: "consumer",
          seq: 2,
          inputs: {
            report_id: topId,              // top-level: rewritten
            options: { format: "json" },   // nested object: format is short, not rewritten
          },
        }),
        inv({ callId: "c2", toolName: "chart_renderer", seq: 3 }),
      ],
      artifactCreatingCallId: "c2",
    });
    const node1 = out.spec.nodes[1] as unknown as {
      inputs: { arguments: { report_id: unknown; options: { format: unknown } } };
    };
    expect(node1.inputs.arguments.report_id).toBe("@nodes.0.report_id");
    expect(node1.inputs.arguments.options.format).toBe("json");
  });
});

describe("buildWorkflowSpecFromRunEvents — Strategy Z+ embedded_suspects", () => {
  it("collects long string values (>= 50 chars) for V2 analysis", () => {
    const longSql =
      "SELECT * FROM orders WHERE created_at >= '2024-01-01' AND tenant_id = 'ds_inline_123_long' ORDER BY id";
    const out = buildWorkflowSpecFromRunEvents({
      invocations: [
        inv({
          callId: "c1",
          toolName: "extract",
          seq: 1,
          inputs: { sql: longSql },
          result: { dataset: "ds_a" },
        }),
        inv({ callId: "c2", toolName: "chart_renderer", seq: 2 }),
      ],
      artifactCreatingCallId: "c2",
    });
    expect(out.lineageReport.embedded_suspects).toHaveLength(1);
    expect(out.lineageReport.embedded_suspects[0]).toEqual({
      nodeId: 0,
      field: "sql",
      full_value: longSql,
    });
  });
});

describe("buildWorkflowSpecFromRunEvents — spec.outputs refined via Strategy Z+", () => {
  it("only the keys Strategy Z+ rewrote appear in spec.outputs", () => {
    // 'data' = "ds_orders_final" matches an upstream output → ref.
    // 'type' = "bar" is a static literal — it stays in
    // strippedFrontendConfig (artifact.content) and is intentionally
    // NOT projected into spec.outputs (it has no workflow-execution
    // semantics; the renderer reads it from artifact.content).
    const out = buildWorkflowSpecFromRunEvents({
      invocations: [
        inv({
          callId: "c1",
          toolName: "extract",
          seq: 1,
          inputs: {},
          result: { dataset: "ds_orders_final" },
        }),
        inv({
          callId: "c2",
          toolName: "chart_renderer",
          seq: 2,
          inputs: { data: "ds_orders_final", type: "bar" },
        }),
      ],
      artifactCreatingCallId: "c2",
    });
    expect(out.spec.outputs).toEqual({ data: "@nodes.0.dataset" });
    expect(out.strippedFrontendConfig.type).toBe("bar");
  });
});

describe("buildWorkflowSpecFromRunEvents — temporal ordering invariant", () => {
  it("a later node's output does NOT match an earlier node's input", () => {
    // c0's input contains 'ds_x', and c1 (LATER) produces 'ds_x' too.
    // The input scan for c0 happens BEFORE c1's output is indexed, so
    // 'ds_x' must NOT be rewritten as @nodes.1.<field>.
    const out = buildWorkflowSpecFromRunEvents({
      invocations: [
        inv({
          callId: "c1",
          toolName: "first",
          seq: 1,
          inputs: { dataset: "ds_x_initial" },
          result: { dataset: "ds_x_initial" }, // self-referential: same value in input and output
        }),
        inv({ callId: "c2", toolName: "chart_renderer", seq: 2 }),
      ],
      artifactCreatingCallId: "c2",
    });
    const node0 = out.spec.nodes[0] as { inputs: { arguments: Record<string, unknown> }; depends_on: number[]  };
    // The input scan happened BEFORE the output was indexed → no match
    expect(node0.inputs.arguments.dataset).toBe("ds_x_initial");
    expect(node0.depends_on).toEqual([]);
    // No resolved_refs for this — temporal invariant holds.
    expect(out.lineageReport.resolved_refs).toHaveLength(0);
    // But there IS a candidate-no-match record (the input was ref-shaped)
    expect(out.lineageReport.candidate_values_no_match).toHaveLength(1);
  });
});

describe("buildWorkflowSpecFromRunEvents — Strategy Z+ array recursion (V1.1)", () => {
  it("rewrites a string element of a top-level array as a ref + sets depends_on", () => {
    // Real-world shape: fetch_data_table produces a name;
    // run_code_in_sandbox consumes it via `datasets: [name]`.
    const out = buildWorkflowSpecFromRunEvents({
      invocations: [
        inv({
          callId: "c1",
          toolName: "fetch_data_table",
          seq: 1,
          inputs: { sql: "select 1", name: "latency-trend-20250127" },
          result: { name: "latency-trend-20250127", rowCount: 42 },
        }),
        inv({
          callId: "c2",
          toolName: "sandbox_step",
          seq: 2,
          inputs: {
            command: ["python3", "-"],
            datasets: ["latency-trend-20250127"],
            timeoutSeconds: 30,
          },
        }),
        inv({ callId: "c3", toolName: "chart_renderer", seq: 3 }),
      ],
      artifactCreatingCallId: "c3",
    });
    const sandboxNode = out.spec.nodes[1] as { inputs: { arguments: Record<string, unknown> }; depends_on: number[]  };
    expect(sandboxNode.inputs.arguments.datasets).toEqual(["@nodes.0.name"]);
    // `command` is also an array but its elements aren't ref-candidates
    // ("python3" < 6 chars after stripping; "-" too short) → array passes through unchanged.
    expect(sandboxNode.inputs.arguments.command).toEqual(["python3", "-"]);
    expect(sandboxNode.depends_on).toEqual([0]);
  });

  it("handles arrays with mixed ref-candidate + literal elements", () => {
    const out = buildWorkflowSpecFromRunEvents({
      invocations: [
        inv({
          callId: "c1",
          toolName: "extract_a",
          seq: 1,
          inputs: {},
          result: { name: "dataset-alpha-2025-q1" },
        }),
        inv({
          callId: "c2",
          toolName: "extract_b",
          seq: 2,
          inputs: {},
          result: { name: "dataset-beta-2025-q1" },
        }),
        inv({
          callId: "c3",
          toolName: "sandbox_step",
          seq: 3,
          inputs: {
            datasets: [
              "dataset-alpha-2025-q1",
              "static-literal-bar",
              "dataset-beta-2025-q1",
            ],
          },
        }),
        inv({ callId: "c4", toolName: "chart_renderer", seq: 4 }),
      ],
      artifactCreatingCallId: "c4",
    });
    const node = out.spec.nodes[2] as { inputs: { arguments: Record<string, unknown> }; depends_on: number[]  };
    expect(node.inputs.arguments.datasets).toEqual([
      "@nodes.0.name",
      "static-literal-bar", // not in index → stays literal
      "@nodes.1.name",
    ]);
    expect(node.depends_on).toEqual([0, 1]);
  });

  it("recurses into nested arrays (array-of-arrays)", () => {
    const out = buildWorkflowSpecFromRunEvents({
      invocations: [
        inv({
          callId: "c1",
          toolName: "extract",
          seq: 1,
          inputs: {},
          result: { name: "ds-inner-12345" },
        }),
        inv({
          callId: "c2",
          toolName: "complex_tool",
          seq: 2,
          inputs: { groups: [["ds-inner-12345"], ["unrelated"]] },
        }),
        inv({ callId: "c3", toolName: "chart_renderer", seq: 3 }),
      ],
      artifactCreatingCallId: "c3",
    });
    const node = out.spec.nodes[1] as { inputs: { arguments: Record<string, unknown> }; depends_on: number[]  };
    expect(node.inputs.arguments.groups).toEqual([["@nodes.0.name"], ["unrelated"]]);
    expect(node.depends_on).toEqual([0]);
  });

  it("emits lineage entries with field[i] notation for array elements", () => {
    const out = buildWorkflowSpecFromRunEvents({
      invocations: [
        inv({
          callId: "c1",
          toolName: "extract",
          seq: 1,
          inputs: {},
          result: { name: "primary-dataset-q1" },
        }),
        inv({
          callId: "c2",
          toolName: "sandbox",
          seq: 2,
          inputs: { datasets: ["primary-dataset-q1"] },
        }),
        inv({ callId: "c3", toolName: "chart_renderer", seq: 3 }),
      ],
      artifactCreatingCallId: "c3",
    });
    expect(out.lineageReport.resolved_refs).toContainEqual({
      nodeId: 1,
      field: "datasets[0]",
      resolved_to: "@nodes.0.name",
      confidence: "unique-match",
    });
  });

  it("records ambiguous_matches against array elements", () => {
    const out = buildWorkflowSpecFromRunEvents({
      invocations: [
        inv({
          callId: "c1",
          toolName: "extract_v1",
          seq: 1,
          inputs: {},
          result: { name: "shared-dataset-id" },
        }),
        inv({
          callId: "c2",
          toolName: "extract_v2",
          seq: 2,
          inputs: {},
          result: { name: "shared-dataset-id" }, // same id from two sources
        }),
        inv({
          callId: "c3",
          toolName: "sandbox",
          seq: 3,
          inputs: { datasets: ["shared-dataset-id"] },
        }),
        inv({ callId: "c4", toolName: "chart_renderer", seq: 4 }),
      ],
      artifactCreatingCallId: "c4",
    });
    const node = out.spec.nodes[2] as { inputs: { arguments: Record<string, unknown> }; depends_on: number[]  };
    // Multi-source → stay literal, depends_on unchanged
    expect(node.inputs.arguments.datasets).toEqual(["shared-dataset-id"]);
    expect(node.depends_on).toEqual([]);
    expect(out.lineageReport.ambiguous_matches).toContainEqual({
      nodeId: 2,
      field: "datasets[0]",
      value: "shared-dataset-id",
      possible_sources: [
        { nodeId: 0, fieldPath: "name" },
        { nodeId: 1, fieldPath: "name" },
      ],
    });
  });

  it("non-string scalars in nested positions pass through", () => {
    // Numbers / booleans inside arrays don't trigger candidate logic.
    const out = buildWorkflowSpecFromRunEvents({
      invocations: [
        inv({ callId: "c1", toolName: "tool_a", seq: 1, result: {} }),
        inv({
          callId: "c2",
          toolName: "tool_b",
          seq: 2,
          inputs: { weights: [0.5, 1.5, 2.5], flags: [true, false] },
        }),
        inv({ callId: "c3", toolName: "chart_renderer", seq: 3 }),
      ],
      artifactCreatingCallId: "c3",
    });
    const node = out.spec.nodes[1] as { inputs: { arguments: Record<string, unknown> } };
    expect(node.inputs.arguments.weights).toEqual([0.5, 1.5, 2.5]);
    expect(node.inputs.arguments.flags).toEqual([true, false]);
  });

  it("multiple ref-candidates in one array contribute multiple deps", () => {
    const out = buildWorkflowSpecFromRunEvents({
      invocations: [
        inv({
          callId: "c1",
          toolName: "extract",
          seq: 1,
          inputs: {},
          result: { name: "dataset-aa-2025" },
        }),
        inv({
          callId: "c2",
          toolName: "transform",
          seq: 2,
          inputs: { source: "dataset-aa-2025" },
          result: { name: "dataset-bb-2026" },
        }),
        inv({
          callId: "c3",
          toolName: "sandbox",
          seq: 3,
          inputs: { datasets: ["dataset-aa-2025", "dataset-bb-2026"] },
        }),
        inv({ callId: "c4", toolName: "chart_renderer", seq: 4 }),
      ],
      artifactCreatingCallId: "c4",
    });
    const node = out.spec.nodes[2] as { inputs: { arguments: Record<string, unknown> }; depends_on: number[]  };
    expect(node.inputs.arguments.datasets).toEqual(["@nodes.0.name", "@nodes.1.name"]);
    expect(node.depends_on).toEqual([0, 1]);
  });

  it("array recursion in the artifact-creator's input (synthetic nodeId = -1)", () => {
    // The artifact creator's input goes through the same walker
    // (with placeholder nodeId = -1) so spec.outputs sees rewritten
    // refs inside arrays too — even though V1 chart artifacts
    // typically don't have array-valued args.
    const out = buildWorkflowSpecFromRunEvents({
      invocations: [
        inv({
          callId: "c1",
          toolName: "extract",
          seq: 1,
          inputs: {},
          result: { name: "dataset-cc-2025" },
        }),
        inv({
          callId: "c2",
          toolName: "chart_renderer",
          seq: 2,
          inputs: { datasetRefs: ["dataset-cc-2025"] },
        }),
      ],
      artifactCreatingCallId: "c2",
    });
    // The artifact-input array was rewritten in place.
    // strippedFrontendConfig is the RAW artifact-creator input — kept
    // unmodified for content rendering. Lineage entries record the
    // rewrite under nodeId=-1 (artifact-input sentinel).
    expect(out.strippedFrontendConfig.datasetRefs).toEqual([
      "dataset-cc-2025",
    ]);
    expect(out.lineageReport.resolved_refs).toContainEqual({
      nodeId: -1,
      field: "datasetRefs[0]",
      resolved_to: "@nodes.0.name",
      confidence: "unique-match",
    });
  });
});

// ─── D35: run_code_in_sandbox → LLMCodeNode ───────────────────────────

describe("buildWorkflowSpecFromRunEvents — assembleCodeNode (D35)", () => {
  it("rewrites a run_code_in_sandbox invocation as type: 'code'", () => {
    const out = buildWorkflowSpecFromRunEvents({
      invocations: [
        inv({
          callId: "c1",
          toolName: "run_code_in_sandbox",
          seq: 1,
          inputs: {
            language: "python",
            code_text: "import pandas as pd\nprint(pd.__version__)",
            datasets: [],
            timeout_seconds: 30,
          },
          result: { stdout: "1.4.2\n", exitCode: 0 },
        }),
        inv({ callId: "c2", toolName: "render_chart", seq: 2 }),
      ],
      artifactCreatingCallId: "c2",
    });
    expect(out.spec.nodes).toHaveLength(1);
    const node = out.spec.nodes[0]!;
    expect(node.type).toBe("code");
    if (node.type !== "code") return; // narrow
    expect(node.inputs.language).toBe("python");
    expect(node.inputs.code_text).toContain("import pandas");
    expect(node.timeout_seconds).toBe(30);
    // Empty `datasets` is dropped — assembleCodeNode only carries
    // forward non-empty arrays.
    expect(node.inputs.datasets).toBeUndefined();
    expect(node.inputs.params).toBeUndefined();
  });

  it("preserves datasets in `input.datasets` for Strategy Z+", () => {
    // The dataset ref scenario: extract produces a name, sandbox
    // consumes it via datasets:[name]. assembleCodeNode keeps the
    // array intact so Strategy Z+ array recursion (W1.7.6) rewrites
    // the element to @nodes.0.name and derives depends_on.
    const out = buildWorkflowSpecFromRunEvents({
      invocations: [
        inv({
          callId: "c1",
          toolName: "fetch_data_table",
          seq: 1,
          inputs: { sql: "select 1" },
          result: { name: "latency-trend-20250127", rowCount: 42 },
        }),
        inv({
          callId: "c2",
          toolName: "run_code_in_sandbox",
          seq: 2,
          inputs: {
            language: "python",
            code_text: "import glob; print(glob.glob('./data/*'))",
            datasets: ["latency-trend-20250127"],
          },
          result: { stdout: "[...]", exitCode: 0 },
        }),
        inv({ callId: "c3", toolName: "render_chart", seq: 3 }),
      ],
      artifactCreatingCallId: "c3",
    });
    const codeNode = out.spec.nodes[1]!;
    if (codeNode.type !== "code") throw new Error("expected code node");
    expect(codeNode.inputs?.datasets).toEqual(["@nodes.0.name"]);
    expect(codeNode.depends_on).toEqual([0]);
  });

  it("throws when code_text is missing", () => {
    expect(() =>
      buildWorkflowSpecFromRunEvents({
        invocations: [
          inv({
            callId: "c1",
            toolName: "run_code_in_sandbox",
            seq: 1,
            inputs: { language: "python", datasets: [] },
          }),
          inv({ callId: "c2", toolName: "render_chart", seq: 2 }),
        ],
        artifactCreatingCallId: "c2",
      }),
    ).toThrow(/no 'code_text' field/);
  });

  it("envelope failure (exitCode != 0) is filtered out of workflow", () => {
    // W1.7.6 envelope-aware coalesce treats exitCode!=0 as
    // failure; build-from-events filters via `i.ok`. A failed
    // sandbox invocation therefore doesn't become a code node.
    // Pure unit test on the build pipeline — feed the
    // ToolInvocation directly with `ok: false`.
    const out = buildWorkflowSpecFromRunEvents({
      invocations: [
        inv({
          callId: "c1",
          toolName: "run_code_in_sandbox",
          seq: 1,
          inputs: { language: "python", code_text: "import duckdb" },
          ok: false,
          result: null,
        }),
        inv({
          callId: "c2",
          toolName: "run_code_in_sandbox",
          seq: 2,
          inputs: {
            language: "python",
            code_text: "print('ok')",
            datasets: [],
          },
          result: { stdout: "ok\n", exitCode: 0 },
        }),
        inv({ callId: "c3", toolName: "render_chart", seq: 3 }),
      ],
      artifactCreatingCallId: "c3",
    });
    // Only the successful node — c2 → id 0 (the failed c1 was
    // filtered before id assignment).
    expect(out.spec.nodes).toHaveLength(1);
    const node = out.spec.nodes[0]!;
    if (node.type !== "code") throw new Error("expected code node");
    expect(node.inputs.code_text).toContain("print('ok')");
  });
});

// ─── JavaScript code node ─────────────────────────────────────────────

describe("buildWorkflowSpecFromRunEvents — assembleCodeNode (JavaScript)", () => {
  it("infers language='javascript' from tool arg", () => {
    const out = buildWorkflowSpecFromRunEvents({
      invocations: [
        inv({
          callId: "c1",
          toolName: "run_code_in_sandbox",
          seq: 1,
          inputs: {
            language: "javascript",
            code_text: "const x = 1; console.log(JSON.stringify({x}));",
          },
          result: { stdout: '{"x":1}\n', exitCode: 0 },
        }),
        inv({ callId: "c2", toolName: "render_chart", seq: 2 }),
      ],
      artifactCreatingCallId: "c2",
    });
    const node = out.spec.nodes[0]!;
    expect(node.type).toBe("code");
    if (node.type !== "code") return;
    expect(node.inputs.language).toBe("javascript");
    expect(node.inputs.code_text).toContain("console.log");
  });

  it("defaults to python when language field is absent", () => {
    const out = buildWorkflowSpecFromRunEvents({
      invocations: [
        inv({
          callId: "c1",
          toolName: "run_code_in_sandbox",
          seq: 1,
          inputs: { code_text: "print('hi')" },
          result: { stdout: "hi\n", exitCode: 0 },
        }),
        inv({ callId: "c2", toolName: "render_chart", seq: 2 }),
      ],
      artifactCreatingCallId: "c2",
    });
    const node = out.spec.nodes[0]!;
    if (node.type !== "code") return;
    expect(node.inputs.language).toBe("python");
  });
});

// ─── D36: extract_dataset_by_sql → LLMSqlNode ─────────────────────────

describe("buildWorkflowSpecFromRunEvents — assembleSqlNode (D36)", () => {
  it("rewrites extract_dataset_by_sql invocation to type:'sql' node", () => {
    const out = buildWorkflowSpecFromRunEvents({
      invocations: [
        inv({
          callId: "c1",
          toolName: "extract_dataset_by_sql",
          seq: 1,
          inputs: {
            dataset_name: "ds_orders",
            data_source_name: "prod_pg",
            sql_text: "SELECT id, total FROM orders",
            row_limit: 200,
            force_refresh: false,
          },
          result: { cache_hit: false, dataset_name: "ds_orders", total_rows: 1234 },
        }),
        inv({ callId: "c2", toolName: "chart_renderer", seq: 2 }),
      ],
      artifactCreatingCallId: "c2",
    });
    expect(out.spec.nodes).toHaveLength(1);
    const node = out.spec.nodes[0]!;
    if (node.type !== "sql") throw new Error("expected sql node");
    expect(node.inputs.data_source_name).toBe("prod_pg");
    expect(node.inputs.sql_text).toBe("SELECT id, total FROM orders");
    expect(node.inputs.dataset_name).toBe("ds_orders");
  });

  it("drops row_limit + force_refresh — chat-affordances not workflow-relevant", () => {
    const out = buildWorkflowSpecFromRunEvents({
      invocations: [
        inv({
          callId: "c1",
          toolName: "extract_dataset_by_sql",
          seq: 1,
          inputs: {
            dataset_name: "ds_x",
            data_source_name: "src",
            sql_text: "SELECT 1",
            row_limit: 200,
            force_refresh: true,
          },
          result: { dataset_name: "ds_x", total_rows: 1 },
        }),
        inv({ callId: "c2", toolName: "chart_renderer", seq: 2 }),
      ],
      artifactCreatingCallId: "c2",
    });
    const node = out.spec.nodes[0]!;
    if (node.type !== "sql") throw new Error("expected sql node");
    // The discriminated union ensures these aren't valid keys on
    // the SQL node — the test just confirms the shape stays
    // closed by asserting the only surviving keys.
    expect(Object.keys(node).sort()).toEqual(
      ["depends_on", "description", "id", "inputs", "type"].sort(),
    );
    expect(Object.keys(node.inputs).sort()).toEqual(
      ["data_source_name", "dataset_name", "sql_text"].sort(),
    );
  });

  it("omits inputs.dataset_name when invocation has no dataset_name field", () => {
    const out = buildWorkflowSpecFromRunEvents({
      invocations: [
        inv({
          callId: "c1",
          toolName: "extract_dataset_by_sql",
          seq: 1,
          inputs: { data_source_name: "src", sql_text: "SELECT 1" },
          result: { dataset_name: "auto", total_rows: 0 },
        }),
        inv({ callId: "c2", toolName: "chart_renderer", seq: 2 }),
      ],
      artifactCreatingCallId: "c2",
    });
    const node = out.spec.nodes[0]!;
    if (node.type !== "sql") throw new Error("expected sql node");
    expect(node.inputs.dataset_name).toBeUndefined();
  });

  it("throws when invocation lacks data_source_name", () => {
    expect(() =>
      buildWorkflowSpecFromRunEvents({
        invocations: [
          inv({
            callId: "c1",
            toolName: "extract_dataset_by_sql",
            seq: 1,
            inputs: { sql_text: "SELECT 1" },
          }),
          inv({ callId: "c2", toolName: "chart_renderer", seq: 2 }),
        ],
        artifactCreatingCallId: "c2",
      }),
    ).toThrow(/no 'data_source_name' field/);
  });

  it("throws when invocation lacks sql_text", () => {
    expect(() =>
      buildWorkflowSpecFromRunEvents({
        invocations: [
          inv({
            callId: "c1",
            toolName: "extract_dataset_by_sql",
            seq: 1,
            inputs: { data_source_name: "src" },
          }),
          inv({ callId: "c2", toolName: "chart_renderer", seq: 2 }),
        ],
        artifactCreatingCallId: "c2",
      }),
    ).toThrow(/no 'sql_text' field/);
  });

  it("threads result.dataset_name into the value-source index for downstream datasets ref rewrite", () => {
    // SQL produces a dataset; downstream code consumes it via
    // `inputs.datasets: [<name>]`. Strategy Z+ rewrites the
    // literal name to `@nodes.0.dataset_name` AND sets depends_on.
    const out = buildWorkflowSpecFromRunEvents({
      invocations: [
        inv({
          callId: "c1",
          toolName: "extract_dataset_by_sql",
          seq: 1,
          inputs: {
            dataset_name: "orders_q4",
            data_source_name: "prod",
            sql_text: "SELECT * FROM orders",
          },
          result: { dataset_name: "orders_q4", total_rows: 1000 },
        }),
        inv({
          callId: "c2",
          toolName: "run_code_in_sandbox",
          seq: 2,
          inputs: {
            language: "python",
            code_text: "import pandas",
            datasets: ["orders_q4"],
          },
          result: { stdout: "ok", exit_code: 0 },
        }),
        inv({ callId: "c3", toolName: "chart_renderer", seq: 3 }),
      ],
      artifactCreatingCallId: "c3",
    });
    expect(out.spec.nodes).toHaveLength(2);
    const codeNode = out.spec.nodes[1]!;
    if (codeNode.type !== "code") throw new Error("expected code node");
    expect(codeNode.depends_on).toEqual([0]);
    expect(codeNode.inputs.datasets).toEqual(["@nodes.0.dataset_name"]);
  });

  it("envelope failure (ok: false) is filtered before node assembly", () => {
    // A failed SQL invocation can't become a node — it would
    // re-fail on refresh. Same invariant as code-node.
    const out = buildWorkflowSpecFromRunEvents({
      invocations: [
        inv({
          callId: "c1",
          toolName: "extract_dataset_by_sql",
          seq: 1,
          inputs: { data_source_name: "src", sql_text: "SELECT 1" },
          ok: false,
          result: null,
        }),
        inv({
          callId: "c2",
          toolName: "extract_dataset_by_sql",
          seq: 2,
          inputs: {
            dataset_name: "ok_ds",
            data_source_name: "src",
            sql_text: "SELECT 2",
          },
          result: { dataset_name: "ok_ds", total_rows: 1 },
        }),
        inv({ callId: "c3", toolName: "chart_renderer", seq: 3 }),
      ],
      artifactCreatingCallId: "c3",
    });
    expect(out.spec.nodes).toHaveLength(1);
    const node = out.spec.nodes[0]!;
    if (node.type !== "sql") throw new Error("expected sql node");
    expect(node.inputs.sql_text).toBe("SELECT 2");
  });

  it("SQL node description includes the tool name + input snippet", () => {
    const out = buildWorkflowSpecFromRunEvents({
      invocations: [
        inv({
          callId: "c1",
          toolName: "extract_dataset_by_sql",
          seq: 1,
          inputs: {
            dataset_name: "ds_x",
            data_source_name: "src",
            sql_text: "SELECT 1",
          },
          result: { dataset_name: "ds_x", total_rows: 1 },
        }),
        inv({ callId: "c2", toolName: "chart_renderer", seq: 2 }),
      ],
      artifactCreatingCallId: "c2",
    });
    const node = out.spec.nodes[0]!;
    expect(node.description).toContain("extract_dataset_by_sql");
  });

  it("output spec still parses LLMWorkflowSpecSchema after SQL rewrite", () => {
    const out = buildWorkflowSpecFromRunEvents({
      invocations: [
        inv({
          callId: "c1",
          toolName: "extract_dataset_by_sql",
          seq: 1,
          inputs: {
            dataset_name: "ds_x",
            data_source_name: "src",
            sql_text: "SELECT 1",
          },
          result: { dataset_name: "ds_x", total_rows: 1 },
        }),
        inv({ callId: "c2", toolName: "chart_renderer", seq: 2 }),
      ],
      artifactCreatingCallId: "c2",
    });
    const parsed = LLMWorkflowSpecSchema.safeParse(out.spec);
    expect(parsed.success).toBe(true);
  });
});

// ─── Chart artifact creator (Phase 1.4) ───────────────────────────────

describe("buildWorkflowSpecFromRunEvents — chart artifact creator", () => {
  /** Captured `generate_echarts_config` invocation with data-bearing option. */
  function chartInvocation(opts: {
    callId: string;
    seq: number;
    source: unknown[];
  }): ToolInvocation {
    return inv({
      callId: opts.callId,
      toolName: "generate_echarts_config",
      seq: opts.seq,
      inputs: {
        chart_id: "monthly-sales",
        title: "Monthly Sales",
        option: {
          xAxis: { type: "category" },
          yAxis: { type: "value" },
          series: [
            {
              type: "bar",
              encode: { x: "month", y: "sales" },
            },
          ],
          dataset: { source: opts.source },
        },
      },
      result: {
        ok: true,
        chart_id: "monthly-sales",
        title: "Monthly Sales",
      },
    });
  }

  const ROWS = [
    { month: "2026-01", sales: 12500 },
    { month: "2026-02", sales: 13200 },
  ];

  it("emits a chart node (NOT a stripped artifact) when artifact creator is generate_echarts_config", () => {
    const out = buildWorkflowSpecFromRunEvents({
      invocations: [
        inv({
          callId: "c0",
          toolName: "run_code_in_sandbox",
          seq: 1,
          inputs: { language: "python", code_text: "print('hi')" },
          result: { stdout: '{"rows":[...]}\n', rows: ROWS },
        }),
        chartInvocation({ callId: "c1", seq: 2, source: ROWS }),
      ],
      artifactCreatingCallId: "c1",
    });
    expect(out.spec.nodes).toHaveLength(2);
    const chart = out.spec.nodes.find((n) => n.type === "chart");
    expect(chart).toBeDefined();
    expect(chart!.id).toBe(1);
    if (chart!.type !== "chart") throw new Error();
    expect(chart!.inputs.renderer).toBe("echarts");
  });

  it("Strategy Z+ matches dataset.source against upstream array output and produces inputs.dataset ref", () => {
    const out = buildWorkflowSpecFromRunEvents({
      invocations: [
        inv({
          callId: "c0",
          toolName: "run_code_in_sandbox",
          seq: 1,
          inputs: { language: "python", code_text: "p" },
          result: { stdout: "ok", rows: ROWS },
        }),
        chartInvocation({ callId: "c1", seq: 2, source: ROWS }),
      ],
      artifactCreatingCallId: "c1",
    });
    const chart = out.spec.nodes.find((n) => n.type === "chart")!;
    if (chart.type !== "chart") throw new Error();
    expect(chart.inputs.dataset).toBe("@nodes.0.rows");
    expect(chart.depends_on).toEqual([0]);
  });

  it("strips inputs.config.dataset.source after a successful unique match", () => {
    const out = buildWorkflowSpecFromRunEvents({
      invocations: [
        inv({
          callId: "c0",
          toolName: "run_code_in_sandbox",
          seq: 1,
          inputs: { language: "python", code_text: "p" },
          result: { stdout: "ok", rows: ROWS },
        }),
        chartInvocation({ callId: "c1", seq: 2, source: ROWS }),
      ],
      artifactCreatingCallId: "c1",
    });
    const chart = out.spec.nodes.find((n) => n.type === "chart")!;
    if (chart.type !== "chart") throw new Error();
    const dataset = chart.inputs.config.dataset as
      | Record<string, unknown>
      | undefined;
    expect(dataset).toBeDefined();
    expect((dataset as Record<string, unknown>).source).toBeUndefined();
  });

  it("D39.C fallback: keeps literal dataset.source + omits inputs.dataset when no upstream array matches", () => {
    const out = buildWorkflowSpecFromRunEvents({
      invocations: [
        inv({
          callId: "c0",
          toolName: "fetch_data_table",
          seq: 1,
          inputs: { dataSourceId: "x", sql: "select 1" },
          result: { dataset: "ds_orders" },
        }),
        chartInvocation({
          callId: "c1",
          seq: 2,
          // Data not present in any upstream result.
          source: [{ month: "fictional", sales: 999 }],
        }),
      ],
      artifactCreatingCallId: "c1",
    });
    const chart = out.spec.nodes.find((n) => n.type === "chart")!;
    if (chart.type !== "chart") throw new Error();
    expect(chart.inputs.dataset).toBeUndefined();
    const dataset = chart.inputs.config.dataset as Record<string, unknown>;
    expect(dataset.source).toEqual([{ month: "fictional", sales: 999 }]);
  });

  it("ambiguous match (two upstream nodes produce equal arrays) falls back to D39.C", () => {
    const out = buildWorkflowSpecFromRunEvents({
      invocations: [
        inv({
          callId: "c0",
          toolName: "run_code_in_sandbox",
          seq: 1,
          inputs: { language: "python", code_text: "p1" },
          result: { stdout: "ok", rows: ROWS },
        }),
        inv({
          callId: "c1",
          toolName: "run_code_in_sandbox",
          seq: 2,
          inputs: { language: "python", code_text: "p2" },
          result: { stdout: "ok", rows: ROWS },
        }),
        chartInvocation({ callId: "c2", seq: 3, source: ROWS }),
      ],
      artifactCreatingCallId: "c2",
    });
    const chart = out.spec.nodes.find((n) => n.type === "chart")!;
    if (chart.type !== "chart") throw new Error();
    expect(chart.inputs.dataset).toBeUndefined();
    expect(out.lineageReport.ambiguous_matches).toHaveLength(1);
  });

  it("spec.outputs points to the chart node's option field", () => {
    const out = buildWorkflowSpecFromRunEvents({
      invocations: [
        inv({
          callId: "c0",
          toolName: "run_code_in_sandbox",
          seq: 1,
          inputs: { language: "python", code_text: "p" },
          result: { stdout: "ok", rows: ROWS },
        }),
        chartInvocation({ callId: "c1", seq: 2, source: ROWS }),
      ],
      artifactCreatingCallId: "c1",
    });
    expect(out.spec.outputs).toEqual({ option: "@nodes.1.option" });
  });

  it("derives renderer from tool-name suffix (generate_<lib>_config)", () => {
    const out = buildWorkflowSpecFromRunEvents({
      invocations: [
        chartInvocation({ callId: "c0", seq: 1, source: ROWS }),
      ],
      artifactCreatingCallId: "c0",
    });
    const chart = out.spec.nodes.find((n) => n.type === "chart")!;
    if (chart.type !== "chart") throw new Error();
    expect(chart.inputs.renderer).toBe("echarts");
  });

  it("preserves chart node's depends_on = [] when there is no upstream", () => {
    const out = buildWorkflowSpecFromRunEvents({
      invocations: [
        // Chart is the only invocation — data is purely literal.
        chartInvocation({ callId: "c0", seq: 1, source: ROWS }),
      ],
      artifactCreatingCallId: "c0",
    });
    const chart = out.spec.nodes.find((n) => n.type === "chart")!;
    if (chart.type !== "chart") throw new Error();
    expect(chart.depends_on).toEqual([]);
    expect(chart.inputs.dataset).toBeUndefined();
  });

  it("artifactCreatorToolName remains the tool name (for save-artifact dispatch)", () => {
    const out = buildWorkflowSpecFromRunEvents({
      invocations: [
        chartInvocation({ callId: "c0", seq: 1, source: ROWS }),
      ],
      artifactCreatingCallId: "c0",
    });
    expect(out.artifactCreatorToolName).toBe("generate_echarts_config");
  });

  it("end-to-end output passes LLMWorkflowSpecSchema (refreshable)", () => {
    const out = buildWorkflowSpecFromRunEvents({
      invocations: [
        inv({
          callId: "c0",
          toolName: "run_code_in_sandbox",
          seq: 1,
          inputs: { language: "python", code_text: "p" },
          result: { stdout: "ok", rows: ROWS },
        }),
        chartInvocation({ callId: "c1", seq: 2, source: ROWS }),
      ],
      artifactCreatingCallId: "c1",
    });
    const parsed = LLMWorkflowSpecSchema.safeParse(out.spec);
    expect(parsed.success).toBe(true);
  });

  it("end-to-end output passes LLMWorkflowSpecSchema (D39.C fallback)", () => {
    const out = buildWorkflowSpecFromRunEvents({
      invocations: [
        chartInvocation({ callId: "c0", seq: 1, source: ROWS }),
      ],
      artifactCreatingCallId: "c0",
    });
    const parsed = LLMWorkflowSpecSchema.safeParse(out.spec);
    expect(parsed.success).toBe(true);
  });

  it("Strategy Z+ matches the SQL tool's `rows` field directly", () => {
    // Real-world chat shape (after D40.D — the tool returns
    // `rows` directly as a row-of-objects array, no more
    // `preview` column-oriented block):
    //   extract_dataset_by_sql.result.rows = [<rows>]
    //   generate_echarts_config.option.dataset.source = <same rows>
    // The save pipeline matches the captured `rows` against the
    // chart's data binding and produces an `@nodes.X.rows` ref.
    const out = buildWorkflowSpecFromRunEvents({
      invocations: [
        inv({
          callId: "c0",
          toolName: "extract_dataset_by_sql",
          seq: 1,
          inputs: {
            dataset_name: "monthly_sales",
            data_source_name: "prod_pg",
            sql_text: "SELECT month, sales FROM orders GROUP BY 1",
          },
          result: {
            cache_hit: false,
            dataset_name: "monthly_sales",
            total_rows: 2,
            returned_rows: 2,
            ttl_hours: 24,
            row_schema: { columns: [] },
            rows: ROWS,
          },
        }),
        chartInvocation({ callId: "c1", seq: 2, source: ROWS }),
      ],
      artifactCreatingCallId: "c1",
    });
    const chart = out.spec.nodes.find((n) => n.type === "chart")!;
    if (chart.type !== "chart") throw new Error();
    expect(chart.inputs.dataset).toBe("@nodes.0.rows");
    expect(chart.depends_on).toEqual([0]);
    expect(out.lineageReport.resolved_refs).toContainEqual(
      expect.objectContaining({
        nodeId: chart.id,
        field: "inputs.config.dataset.source",
        resolved_to: "@nodes.0.rows",
        confidence: "unique-match",
      }),
    );
  });

  // ── Multi-dataset reconciliation (H1) ─────────────────────────────

  /** Build a chart invocation with option.dataset as an ARRAY (multi-dataset). */
  function multiChartInvocation(opts: {
    callId: string;
    seq: number;
    sources: unknown[][];
    extraDatasetKeys?: Record<string, unknown>[];
  }): ToolInvocation {
    const datasetArray = opts.sources.map((source, i) => ({
      ...(opts.extraDatasetKeys?.[i] ?? {}),
      source,
    }));
    return inv({
      callId: opts.callId,
      toolName: "generate_echarts_config",
      seq: opts.seq,
      inputs: {
        option: {
          series: [
            { type: "line", datasetIndex: 0 },
            { type: "line", datasetIndex: 1 },
          ],
          dataset: datasetArray,
        },
      },
      result: { ok: true },
    });
  }

  const ROWS_A = [
    { month: "2026-01", sales: 12500 },
    { month: "2026-02", sales: 13200 },
  ];
  const ROWS_B = [
    { month: "2026-01", profit: 4200 },
    { month: "2026-02", profit: 5100 },
  ];

  it("multi-dataset: all elements match → inputs.dataset is array of refs, config.dataset stripped", () => {
    const out = buildWorkflowSpecFromRunEvents({
      invocations: [
        inv({
          callId: "c0",
          toolName: "extract_dataset_by_sql",
          seq: 1,
          inputs: { data_source_name: "pg", sql_text: "SELECT …", dataset_name: "sales_ds" },
          result: { dataset_name: "sales_ds", total_rows: 2, returned_rows: 2, rows: ROWS_A, row_schema: {} },
        }),
        inv({
          callId: "c1",
          toolName: "extract_dataset_by_sql",
          seq: 2,
          inputs: { data_source_name: "pg", sql_text: "SELECT …", dataset_name: "profit_ds" },
          result: { dataset_name: "profit_ds", total_rows: 2, returned_rows: 2, rows: ROWS_B, row_schema: {} },
        }),
        multiChartInvocation({ callId: "c2", seq: 3, sources: [ROWS_A, ROWS_B] }),
      ],
      artifactCreatingCallId: "c2",
    });
    const chart = out.spec.nodes.find((n) => n.type === "chart")!;
    if (chart.type !== "chart") throw new Error();

    // Both datasets matched → array of refs
    expect(chart.inputs.dataset).toEqual([
      "@nodes.0.rows",
      "@nodes.1.rows",
    ]);
    // depends_on covers both upstream nodes
    expect(chart.depends_on).toEqual([0, 1]);
    // source is stripped from config.dataset entries
    const configDataset = chart.inputs.config.dataset as Array<Record<string, unknown>>;
    expect(Array.isArray(configDataset)).toBe(true);
    expect(configDataset[0]!.source).toBeUndefined();
    expect(configDataset[1]!.source).toBeUndefined();
  });

  it("multi-dataset: preserves extra dataset keys (dimensions, …) after stripping source", () => {
    const out = buildWorkflowSpecFromRunEvents({
      invocations: [
        inv({
          callId: "c0", toolName: "run_code_in_sandbox", seq: 1,
          inputs: { language: "python", code_text: "p" },
          result: { stdout: "ok", rows: ROWS_A },
        }),
        inv({
          callId: "c1", toolName: "run_code_in_sandbox", seq: 2,
          inputs: { language: "python", code_text: "p2" },
          result: { stdout: "ok", rows: ROWS_B },
        }),
        multiChartInvocation({
          callId: "c2", seq: 3,
          sources: [ROWS_A, ROWS_B],
          extraDatasetKeys: [
            { dimensions: ["month", "sales"] },
            { dimensions: ["month", "profit"] },
          ],
        }),
      ],
      artifactCreatingCallId: "c2",
    });
    const chart = out.spec.nodes.find((n) => n.type === "chart")!;
    if (chart.type !== "chart") throw new Error();

    const configDataset = chart.inputs.config.dataset as Array<Record<string, unknown>>;
    expect(configDataset[0]!.dimensions).toEqual(["month", "sales"]);
    expect(configDataset[0]!.source).toBeUndefined();
    expect(configDataset[1]!.dimensions).toEqual(["month", "profit"]);
    expect(configDataset[1]!.source).toBeUndefined();
  });

  it("multi-dataset: both datasets match the SAME upstream node → depends_on deduplicated", () => {
    // A chart where two series use the same data source with different
    // ECharts transforms — both datasets reference @nodes.0.rows.
    const out = buildWorkflowSpecFromRunEvents({
      invocations: [
        inv({
          callId: "c0", toolName: "run_code_in_sandbox", seq: 1,
          inputs: { language: "python", code_text: "p" },
          result: { stdout: "ok", rows: ROWS_A },
        }),
        multiChartInvocation({ callId: "c1", seq: 2, sources: [ROWS_A, ROWS_A] }),
      ],
      artifactCreatingCallId: "c1",
    });
    const chart = out.spec.nodes.find((n) => n.type === "chart")!;
    if (chart.type !== "chart") throw new Error();

    expect(chart.inputs.dataset).toEqual(["@nodes.0.rows", "@nodes.0.rows"]);
    // depends_on deduplicated — only one node referenced
    expect(chart.depends_on).toEqual([0]);
  });

  it("multi-dataset: partial match (one element has no upstream) → falls back to not-refreshable", () => {
    const UNMATCHED = [{ x: 999 }];
    const out = buildWorkflowSpecFromRunEvents({
      invocations: [
        inv({
          callId: "c0", toolName: "run_code_in_sandbox", seq: 1,
          inputs: { language: "python", code_text: "p" },
          result: { stdout: "ok", rows: ROWS_A },
        }),
        multiChartInvocation({ callId: "c1", seq: 2, sources: [ROWS_A, UNMATCHED] }),
      ],
      artifactCreatingCallId: "c1",
    });
    const chart = out.spec.nodes.find((n) => n.type === "chart")!;
    if (chart.type !== "chart") throw new Error();

    // Second element has no upstream match → entire chart is not-refreshable
    expect(chart.inputs.dataset).toBeUndefined();
    expect(chart.depends_on).toEqual([]);
    // Lineage records the miss
    expect(out.lineageReport.candidate_values_no_match.some(
      (m) => m.field.includes("dataset[1]"),
    )).toBe(true);
  });

  it("multi-dataset: output passes LLMWorkflowSpecSchema (refreshable)", () => {
    const out = buildWorkflowSpecFromRunEvents({
      invocations: [
        inv({
          callId: "c0", toolName: "run_code_in_sandbox", seq: 1,
          inputs: { language: "python", code_text: "p" },
          result: { stdout: "ok", rows: ROWS_A },
        }),
        inv({
          callId: "c1", toolName: "run_code_in_sandbox", seq: 2,
          inputs: { language: "python", code_text: "p2" },
          result: { stdout: "ok", rows: ROWS_B },
        }),
        multiChartInvocation({ callId: "c2", seq: 3, sources: [ROWS_A, ROWS_B] }),
      ],
      artifactCreatingCallId: "c2",
    });
    const parsed = LLMWorkflowSpecSchema.safeParse(out.spec);
    expect(parsed.success).toBe(true);
  });
});
