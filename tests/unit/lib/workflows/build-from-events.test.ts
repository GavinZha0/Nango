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
    expect((out.spec.nodes[0] as { tool: string }).tool).toBe("noop");
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
    expect((out.spec.nodes[0] as { tool: string }).tool).toBe(
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
    expect(out.spec.nodes.map((n) => (n as { tool: string }).tool)).toEqual([
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
    expect((out.spec.nodes[0] as { tool: string }).tool).toBe("noop");
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
    if (!("tool" in node)) throw new Error("expected tool node");
    expect(node.tool).toBe("fetch_data_table");
    expect(node.inputs).toEqual({ sql: "select 1" });
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
            input: { dataset: "ds_xyz" },
          },
          result: { summary: "5 rows" },
        }),
        inv({ callId: "c2", toolName: "render_markdown", seq: 2 }),
      ],
      artifactCreatingCallId: "c2",
    });
    const node = out.spec.nodes[0]!;
    if (!("agent" in node)) throw new Error("expected agent node");
    expect(node.agent).toBe("Builtin / DataAnalyst");
    expect(node.inputs).toEqual({ dataset: "ds_xyz" });
    expect(node.output_schema).toEqual({
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    });
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
            input: { dataset: "ds_abc" },
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
    expect("agent" in out.spec.nodes[1]!).toBe(true);
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
    const node1 = out.spec.nodes[1] as { inputs: Record<string, unknown>; depends_on: number[] };
    expect(node1.inputs.source_dataset).toBe("@nodes.0.dataset");
    expect(node1.inputs.code).toBe("df.head()"); // not ref-candidate; preserved
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
    const node3 = out.spec.nodes[2] as { inputs: Record<string, unknown>; depends_on: number[] };
    expect(node3.inputs.left).toBe("@nodes.0.dataset");
    expect(node3.inputs.right).toBe("@nodes.1.dataset");
    expect(node3.inputs.report).toBe("@nodes.0.reportId");
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
            input: { dataset: "ds_orders_q4" },
          },
          result: { summary: "5 rows" },
        }),
        inv({ callId: "c3", toolName: "render_markdown", seq: 3 }),
      ],
      artifactCreatingCallId: "c3",
    });
    const agentNode = out.spec.nodes[1];
    if (!("agent" in agentNode!)) throw new Error("expected agent node");
    expect(agentNode.agent).toBe("Builtin / DataAnalyst");
    expect(agentNode.inputs).toEqual({ dataset: "@nodes.0.dataset" });
    expect(agentNode.depends_on).toEqual([0]);
    // D30 output_schema still present:
    expect(agentNode.output_schema).toEqual({
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    });
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
      inputs: Record<string, unknown>;
      depends_on: number[];
    };
    expect(node3.inputs.from).toBe("ds_shared_id"); // kept literal
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
    const node0 = out.spec.nodes[0] as { inputs: Record<string, unknown>; depends_on: number[] };
    expect(node0.inputs.dataset).toBe("ds_unknown_99"); // literal preserved
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
    const node1 = out.spec.nodes[1] as { inputs: Record<string, unknown> };
    expect(node1.inputs.sql).toBe("another sql");
    expect(node1.inputs.tag).toBe("US");
    expect(node1.inputs.short_id).toBe("ds_xy"); // fails namespaced regex
    expect(node1.inputs.n).toBe(42);
    expect(node1.inputs.flag).toBe(true);
    expect(node1.inputs.dataset).toBe("@nodes.0.dataset");
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
    const node0 = out.spec.nodes[0] as { inputs: Record<string, unknown>; depends_on: number[] };
    // The input scan happened BEFORE the output was indexed → no match
    expect(node0.inputs.dataset).toBe("ds_x_initial");
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
    const sandboxNode = out.spec.nodes[1] as { inputs: Record<string, unknown>; depends_on: number[] };
    expect(sandboxNode.inputs.datasets).toEqual(["@nodes.0.name"]);
    // `command` is also an array but its elements aren't ref-candidates
    // ("python3" < 6 chars after stripping; "-" too short) → array passes through unchanged.
    expect(sandboxNode.inputs.command).toEqual(["python3", "-"]);
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
    const node = out.spec.nodes[2] as { inputs: Record<string, unknown>; depends_on: number[] };
    expect(node.inputs.datasets).toEqual([
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
    const node = out.spec.nodes[1] as { inputs: Record<string, unknown>; depends_on: number[] };
    expect(node.inputs.groups).toEqual([["@nodes.0.name"], ["unrelated"]]);
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
    const node = out.spec.nodes[2] as { inputs: Record<string, unknown>; depends_on: number[] };
    // Multi-source → stay literal, depends_on unchanged
    expect(node.inputs.datasets).toEqual(["shared-dataset-id"]);
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
    const node = out.spec.nodes[1] as { inputs: Record<string, unknown> };
    expect(node.inputs.weights).toEqual([0.5, 1.5, 2.5]);
    expect(node.inputs.flags).toEqual([true, false]);
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
    const node = out.spec.nodes[2] as { inputs: Record<string, unknown>; depends_on: number[] };
    expect(node.inputs.datasets).toEqual(["@nodes.0.name", "@nodes.1.name"]);
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
            command: ["python3", "-"],
            stdin: "import pandas as pd\nprint(pd.__version__)",
            datasets: [],
            timeoutSeconds: 30,
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
    expect(node.language).toBe("python");
    expect(node.code).toContain("import pandas");
    expect(node.timeout_seconds).toBe(30);
    // `command` + `stdin` keys do NOT survive on the canonical
    // node — they're modeling artefacts. Other passthrough keys
    // (including empty arrays like `datasets: []`) stay verbatim
    // — filtering empty containers would be magic that surprises
    // the engine's "if datasets present, mount it" code path.
    expect(node.inputs).toEqual({ datasets: [] });
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
            command: ["python3", "-"],
            stdin: "import glob; print(glob.glob('./data/*'))",
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

  it("strips command + stdin from input (promoted to language + code)", () => {
    const out = buildWorkflowSpecFromRunEvents({
      invocations: [
        inv({
          callId: "c1",
          toolName: "run_code_in_sandbox",
          seq: 1,
          inputs: {
            command: ["python3", "-"],
            stdin: "print(1+1)",
            datasets: ["ds_xxxxxx"],
            timeoutSeconds: 60,
          },
          result: { stdout: "2\n", exitCode: 0 },
        }),
        inv({ callId: "c2", toolName: "render_chart", seq: 2 }),
      ],
      artifactCreatingCallId: "c2",
    });
    const node = out.spec.nodes[0]!;
    if (node.type !== "code") throw new Error("expected code node");
    expect(node.inputs).toBeDefined();
    expect(node.inputs).not.toHaveProperty("command");
    expect(node.inputs).not.toHaveProperty("stdin");
    expect(node.inputs).not.toHaveProperty("timeoutSeconds");
    // datasets stays
    expect(node.inputs?.datasets).toEqual(["ds_xxxxxx"]);
  });

  it("throws when stdin is missing or empty (no usable code body)", () => {
    expect(() =>
      buildWorkflowSpecFromRunEvents({
        invocations: [
          inv({
            callId: "c1",
            toolName: "run_code_in_sandbox",
            seq: 1,
            inputs: { command: ["python3", "-"], datasets: [] },
          }),
          inv({ callId: "c2", toolName: "render_chart", seq: 2 }),
        ],
        artifactCreatingCallId: "c2",
      }),
    ).toThrow(/no usable 'stdin'/);
  });

  it("non-modelling extra keys pass through on input", () => {
    // Future-proof: any non-stdin/command/timeoutSeconds key the
    // LLM supplies (env, files, …) lands on the canonical
    // `input` record verbatim. Strategy Z+ + the engine read
    // those by convention.
    const out = buildWorkflowSpecFromRunEvents({
      invocations: [
        inv({
          callId: "c1",
          toolName: "run_code_in_sandbox",
          seq: 1,
          inputs: {
            command: ["python3", "-"],
            stdin: "print('hi')",
            datasets: [],
            // Hypothetical extras — LLM might emit these even
            // though V1 sandbox tool schema doesn't ack them.
            env: { THRESHOLD: "0.5" },
            customKey: "custom-value",
          },
          result: { stdout: "hi\n", exitCode: 0 },
        }),
        inv({ callId: "c2", toolName: "render_chart", seq: 2 }),
      ],
      artifactCreatingCallId: "c2",
    });
    const node = out.spec.nodes[0]!;
    if (node.type !== "code") throw new Error("expected code node");
    expect(node.inputs).toMatchObject({
      env: { THRESHOLD: "0.5" },
      customKey: "custom-value",
    });
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
          inputs: {
            command: ["python3", "-"],
            stdin: "import duckdb",
          },
          ok: false,
          result: null,
        }),
        inv({
          callId: "c2",
          toolName: "run_code_in_sandbox",
          seq: 2,
          inputs: {
            command: ["python3", "-"],
            stdin: "print('ok')",
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
    expect(node.code).toContain("print('ok')");
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
            name: "ds_orders",
            dataSourceName: "prod_pg",
            query: "SELECT id, total FROM orders",
            previewRows: 5,
            forceRefresh: false,
          },
          result: { cacheHit: false, name: "ds_orders", rowCount: 1234 },
        }),
        inv({ callId: "c2", toolName: "chart_renderer", seq: 2 }),
      ],
      artifactCreatingCallId: "c2",
    });
    expect(out.spec.nodes).toHaveLength(1);
    const node = out.spec.nodes[0]!;
    if (node.type !== "sql") throw new Error("expected sql node");
    expect(node.data_source_name).toBe("prod_pg");
    expect(node.query).toBe("SELECT id, total FROM orders");
    expect(node.name).toBe("ds_orders");
  });

  it("drops previewRows + forceRefresh — chat-affordances not workflow-relevant", () => {
    const out = buildWorkflowSpecFromRunEvents({
      invocations: [
        inv({
          callId: "c1",
          toolName: "extract_dataset_by_sql",
          seq: 1,
          inputs: {
            name: "ds_x",
            dataSourceName: "src",
            query: "SELECT 1",
            previewRows: 200,
            forceRefresh: true,
          },
          result: { name: "ds_x", rowCount: 1 },
        }),
        inv({ callId: "c2", toolName: "chart_renderer", seq: 2 }),
      ],
      artifactCreatingCallId: "c2",
    });
    const node = out.spec.nodes[0]!;
    if (node.type !== "sql") throw new Error("expected sql node");
    // The discriminated union ensures these aren't valid keys on
    // the SQL node — the test just confirms the shape stays
    // closed by asserting type discrimination + the only
    // surviving keys.
    expect(Object.keys(node).sort()).toEqual(
      ["data_source_name", "depends_on", "description", "id", "name", "query", "type"].sort(),
    );
  });

  it("omits node.name when invocation has no name field", () => {
    const out = buildWorkflowSpecFromRunEvents({
      invocations: [
        inv({
          callId: "c1",
          toolName: "extract_dataset_by_sql",
          seq: 1,
          inputs: { dataSourceName: "src", query: "SELECT 1" },
          result: { name: "auto", rowCount: 0 },
        }),
        inv({ callId: "c2", toolName: "chart_renderer", seq: 2 }),
      ],
      artifactCreatingCallId: "c2",
    });
    const node = out.spec.nodes[0]!;
    if (node.type !== "sql") throw new Error("expected sql node");
    expect(node.name).toBeUndefined();
  });

  it("throws when invocation lacks dataSourceName", () => {
    expect(() =>
      buildWorkflowSpecFromRunEvents({
        invocations: [
          inv({
            callId: "c1",
            toolName: "extract_dataset_by_sql",
            seq: 1,
            inputs: { query: "SELECT 1" },
          }),
          inv({ callId: "c2", toolName: "chart_renderer", seq: 2 }),
        ],
        artifactCreatingCallId: "c2",
      }),
    ).toThrow(/no 'dataSourceName' field/);
  });

  it("throws when invocation lacks query", () => {
    expect(() =>
      buildWorkflowSpecFromRunEvents({
        invocations: [
          inv({
            callId: "c1",
            toolName: "extract_dataset_by_sql",
            seq: 1,
            inputs: { dataSourceName: "src" },
          }),
          inv({ callId: "c2", toolName: "chart_renderer", seq: 2 }),
        ],
        artifactCreatingCallId: "c2",
      }),
    ).toThrow(/no 'query' field/);
  });

  it("threads result.name into the value-source index for downstream datasets ref rewrite", () => {
    // SQL produces a dataset; downstream code consumes it via
    // `datasets: [<name>]`. Strategy Z+ should rewrite the
    // literal name to `@nodes.0.name` AND set depends_on.
    const out = buildWorkflowSpecFromRunEvents({
      invocations: [
        inv({
          callId: "c1",
          toolName: "extract_dataset_by_sql",
          seq: 1,
          inputs: {
            name: "orders_q4",
            dataSourceName: "prod",
            query: "SELECT * FROM orders",
          },
          result: { name: "orders_q4", rowCount: 1000 },
        }),
        inv({
          callId: "c2",
          toolName: "run_code_in_sandbox",
          seq: 2,
          inputs: {
            command: ["python3", "-"],
            stdin: "import pandas",
            datasets: ["orders_q4"],
          },
          result: { stdout: "ok", exitCode: 0 },
        }),
        inv({ callId: "c3", toolName: "chart_renderer", seq: 3 }),
      ],
      artifactCreatingCallId: "c3",
    });
    expect(out.spec.nodes).toHaveLength(2);
    const codeNode = out.spec.nodes[1]!;
    if (codeNode.type !== "code") throw new Error("expected code node");
    expect(codeNode.depends_on).toEqual([0]);
    expect(codeNode.inputs?.datasets).toEqual(["@nodes.0.name"]);
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
          inputs: { dataSourceName: "src", query: "SELECT 1" },
          ok: false,
          result: null,
        }),
        inv({
          callId: "c2",
          toolName: "extract_dataset_by_sql",
          seq: 2,
          inputs: {
            name: "ok_ds",
            dataSourceName: "src",
            query: "SELECT 2",
          },
          result: { name: "ok_ds", rowCount: 1 },
        }),
        inv({ callId: "c3", toolName: "chart_renderer", seq: 3 }),
      ],
      artifactCreatingCallId: "c3",
    });
    expect(out.spec.nodes).toHaveLength(1);
    const node = out.spec.nodes[0]!;
    if (node.type !== "sql") throw new Error("expected sql node");
    expect(node.query).toBe("SELECT 2");
  });

  it("SQL node description includes the tool name + input snippet", () => {
    const out = buildWorkflowSpecFromRunEvents({
      invocations: [
        inv({
          callId: "c1",
          toolName: "extract_dataset_by_sql",
          seq: 1,
          inputs: {
            name: "ds_x",
            dataSourceName: "src",
            query: "SELECT 1",
          },
          result: { name: "ds_x", rowCount: 1 },
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
            name: "ds_x",
            dataSourceName: "src",
            query: "SELECT 1",
          },
          result: { name: "ds_x", rowCount: 1 },
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
          inputs: { command: ["python3", "-"], stdin: "print('hi')" },
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
          inputs: { command: ["python3", "-"], stdin: "p" },
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
          inputs: { command: ["python3", "-"], stdin: "p" },
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
          inputs: { command: ["python3", "-"], stdin: "p1" },
          result: { stdout: "ok", rows: ROWS },
        }),
        inv({
          callId: "c1",
          toolName: "run_code_in_sandbox",
          seq: 2,
          inputs: { command: ["python3", "-"], stdin: "p2" },
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
          inputs: { command: ["python3", "-"], stdin: "p" },
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
          inputs: { command: ["python3", "-"], stdin: "p" },
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

  it("Strategy Z+ projects SQL `preview` → spec `rows` and produces @nodes.X.rows ref", () => {
    // Real-world chat shape:
    //   extract_dataset_by_sql.result.preview = [<rows>]
    //   generate_echarts_config.option.dataset.source = <same rows>
    // The save pipeline must recognise the captured `preview` as
    // the spec's `rows` field and produce a validating ref.
    const out = buildWorkflowSpecFromRunEvents({
      invocations: [
        inv({
          callId: "c0",
          toolName: "extract_dataset_by_sql",
          seq: 1,
          inputs: {
            name: "monthly_sales",
            dataSourceName: "prod_pg",
            query: "SELECT month, sales FROM orders GROUP BY 1",
          },
          result: {
            cacheHit: false,
            name: "monthly_sales",
            rowCount: 2,
            ttlHours: 24,
            schema: { columns: [] },
            preview: ROWS,
          },
        }),
        chartInvocation({ callId: "c1", seq: 2, source: ROWS }),
      ],
      artifactCreatingCallId: "c1",
    });
    const chart = out.spec.nodes.find((n) => n.type === "chart")!;
    if (chart.type !== "chart") throw new Error();
    // Critical: the ref uses the SPEC field name `rows`, NOT the
    // captured tool field name `preview`.
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
});
