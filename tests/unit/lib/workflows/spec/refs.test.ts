import { describe, expect, it } from "vitest";

import {
  findEmbeddedRefs,
  isRefCandidate,
  parseRef,
  serializeRef,
  type ContextRef,
  type NodeOutputRef,
  type WorkflowInputRef,
  type WorkflowRef,
} from "@/lib/workflows/spec/refs";

// ─── parseRef ─────────────────────────────────────────────────────────

describe("parseRef — valid forms", () => {
  it("parses @nodes.<id>.<field>", () => {
    expect(parseRef("@nodes.0.dataset")).toEqual<NodeOutputRef>({
      kind: "node",
      nodeId: 0,
      field: "dataset",
    });
    expect(parseRef("@nodes.42.result_df")).toEqual<NodeOutputRef>({
      kind: "node",
      nodeId: 42,
      field: "result_df",
    });
  });

  it("parses @workflow.<key>", () => {
    expect(parseRef("@workflow.date_start")).toEqual<WorkflowInputRef>({
      kind: "workflow",
      key: "date_start",
    });
  });

  it("parses @context.<single>", () => {
    expect(parseRef("@context.today")).toEqual<ContextRef>({
      kind: "context",
      path: ["today"],
    });
  });

  it("parses @context.<nested.path>", () => {
    expect(parseRef("@context.user.id")).toEqual<ContextRef>({
      kind: "context",
      path: ["user", "id"],
    });
    expect(parseRef("@context.secrets.api_token")).toEqual<ContextRef>({
      kind: "context",
      path: ["secrets", "api_token"],
    });
    expect(parseRef("@context.deeply.nested.path.value")).toEqual<ContextRef>({
      kind: "context",
      path: ["deeply", "nested", "path", "value"],
    });
  });

  it("preserves field-name case", () => {
    expect(parseRef("@nodes.0.RowCount")).toEqual<NodeOutputRef>({
      kind: "node",
      nodeId: 0,
      field: "RowCount",
    });
  });

  it("accepts hyphens and underscores in segment names", () => {
    expect(parseRef("@nodes.0.my-field_v2")).toEqual<NodeOutputRef>({
      kind: "node",
      nodeId: 0,
      field: "my-field_v2",
    });
  });
});

describe("parseRef — invalid / null cases", () => {
  it("returns null for non-string", () => {
    expect(parseRef(undefined as unknown as string)).toBeNull();
    expect(parseRef(42 as unknown as string)).toBeNull();
    expect(parseRef(null as unknown as string)).toBeNull();
  });

  it("returns null for strings not starting with @", () => {
    expect(parseRef("nodes.0.foo")).toBeNull();
    expect(parseRef("SELECT * FROM t")).toBeNull();
    expect(parseRef("")).toBeNull();
  });

  it("returns null for unknown sigils", () => {
    expect(parseRef("@unknown.foo.bar")).toBeNull();
    expect(parseRef("@NODES.0.foo")).toBeNull(); // case-sensitive
  });

  it("returns null when @nodes has wrong segment count", () => {
    expect(parseRef("@nodes")).toBeNull();
    expect(parseRef("@nodes.0")).toBeNull(); // only id, no field
    expect(parseRef("@nodes.0.field.extra")).toBeNull(); // too many segments
  });

  it("returns null when @nodes id is not a non-negative integer", () => {
    expect(parseRef("@nodes.abc.field")).toBeNull();
    expect(parseRef("@nodes.-1.field")).toBeNull(); // hyphen splits, "-1" segment, but nodeId raw is "" — failed
    expect(parseRef("@nodes.1.5.field")).toBeNull(); // floats
    expect(parseRef("@nodes.01.field")).toBeNull(); // leading zero (non-canonical)
  });

  it("returns null when @workflow has wrong segment count", () => {
    expect(parseRef("@workflow")).toBeNull();
    expect(parseRef("@workflow.a.b")).toBeNull();
  });

  it("returns null when @context has zero segments", () => {
    expect(parseRef("@context")).toBeNull();
  });

  it("returns null for empty segments (consecutive dots / trailing dot)", () => {
    expect(parseRef("@nodes..field")).toBeNull();
    expect(parseRef("@nodes.0.")).toBeNull();
    expect(parseRef("@workflow.")).toBeNull();
  });

  it("returns null for segments with disallowed characters", () => {
    expect(parseRef("@nodes.0.foo.bar")).toBeNull(); // dot in field would create 3 segments → rejected
    expect(parseRef("@nodes.0.foo bar")).toBeNull(); // space
    expect(parseRef("@nodes.0.foo+bar")).toBeNull(); // plus
  });
});

// ─── serializeRef ─────────────────────────────────────────────────────

describe("serializeRef + round-trip with parseRef", () => {
  const cases: WorkflowRef[] = [
    { kind: "node", nodeId: 0, field: "dataset" },
    { kind: "node", nodeId: 100, field: "result_df" },
    { kind: "workflow", key: "date_start" },
    { kind: "context", path: ["today"] },
    { kind: "context", path: ["user", "id"] },
    { kind: "context", path: ["a", "b", "c", "d"] },
  ];

  it.each(cases)(
    "round-trips $kind ref → string → parsed",
    (ref) => {
      const s = serializeRef(ref);
      expect(parseRef(s)).toEqual(ref);
    },
  );

  it("produces canonical @nodes form (no leading zeros)", () => {
    expect(serializeRef({ kind: "node", nodeId: 7, field: "f" })).toBe(
      "@nodes.7.f",
    );
  });
});

// ─── findEmbeddedRefs ─────────────────────────────────────────────────

describe("findEmbeddedRefs", () => {
  it("finds a single embedded ref in a SQL string", () => {
    const sql =
      "SELECT * FROM orders WHERE date >= @workflow.date_start AND status='paid'";
    expect(findEmbeddedRefs(sql)).toEqual([
      { kind: "workflow", key: "date_start" },
    ]);
  });

  it("finds multiple refs in one string in order", () => {
    const url =
      "Bearer @context.secrets.api_token sent from @workflow.tenant for @nodes.3.org_id";
    expect(findEmbeddedRefs(url)).toEqual([
      { kind: "context", path: ["secrets", "api_token"] },
      { kind: "workflow", key: "tenant" },
      { kind: "node", nodeId: 3, field: "org_id" },
    ]);
  });

  it("stops a ref at punctuation / whitespace boundaries", () => {
    const url = "https://api.com/orgs/@nodes.1.org_id/items?x=1";
    expect(findEmbeddedRefs(url)).toEqual([
      { kind: "node", nodeId: 1, field: "org_id" },
    ]);
  });

  it("returns [] for a plain string with no refs", () => {
    expect(findEmbeddedRefs("SELECT * FROM foo")).toEqual([]);
    expect(findEmbeddedRefs("")).toEqual([]);
  });

  it("returns [] for non-string input", () => {
    expect(findEmbeddedRefs(42 as unknown as string)).toEqual([]);
    expect(findEmbeddedRefs(undefined as unknown as string)).toEqual([]);
  });

  it("skips ref-shaped tokens with invalid sigils or ids", () => {
    // @nodes.abc.foo has a non-integer id → regex matches but parseRef fails
    // @unknown.foo.bar has an unknown sigil → regex doesn't even match it
    const s = "test @nodes.abc.foo and @unknown.foo.bar but @nodes.0.dataset works";
    expect(findEmbeddedRefs(s)).toEqual([
      { kind: "node", nodeId: 0, field: "dataset" },
    ]);
  });

  it("is reentrant across multiple calls (no shared lastIndex)", () => {
    // Calling findEmbeddedRefs twice on the same input must return
    // the same result — regression guard against accidentally reusing
    // a stateful regex with `g` flag.
    const s = "use @nodes.0.dataset and @workflow.tenant";
    const first = findEmbeddedRefs(s);
    const second = findEmbeddedRefs(s);
    expect(first).toEqual(second);
    expect(first).toHaveLength(2);
  });
});

// ─── isRefCandidate (D14 Strategy Z+) ─────────────────────────────────

describe("isRefCandidate", () => {
  // V1.1 rule: typeof string + length >= 6 + no whitespace. The
  // older V1 regex whitelist (UUID / nanoid / `prefix_token`) is
  // gone; those formats still pass under the new rule because they
  // happen to be whitespace-free and long enough. The change
  // intentionally also admits LLM-emitted kebab-case names and
  // URL-like values which the old whitelist rejected.
  it("accepts canonical UUIDs", () => {
    expect(isRefCandidate("550e8400-e29b-41d4-a716-446655440000")).toBe(true);
    expect(isRefCandidate("01935b6b-7d8e-7c12-a8f4-2c3a4d5e6f70")).toBe(true);
    expect(isRefCandidate("550E8400-E29B-41D4-A716-446655440000")).toBe(true);
  });

  it("accepts nanoid-style URL-safe ids", () => {
    expect(isRefCandidate("V1StGXR8_Z5jdHi6B-myT")).toBe(true);
    expect(isRefCandidate("abc-def_ghi_jklmnopqr")).toBe(true);
  });

  it("accepts namespaced ids like dataset_abc123 / tool_call_xyz", () => {
    expect(isRefCandidate("dataset_abc123de")).toBe(true);
    expect(isRefCandidate("tool_call_pZL3PRFN6R8")).toBe(true);
    expect(isRefCandidate("run_AbC123XyZ")).toBe(true);
  });

  it("accepts LLM-emitted kebab-case names (V1.1 broadening)", () => {
    // The original failure that motivated the broadening: a chart
    // outcomeId picked by the LLM that doubles as the dataset name.
    expect(isRefCandidate("latency-trend-2025-01-27")).toBe(true);
    expect(isRefCandidate("sales-q4-by-region")).toBe(true);
  });

  it("accepts URL / path / colon-separated id shapes", () => {
    expect(isRefCandidate("s3://bucket/raw/2025.parquet")).toBe(true);
    expect(isRefCandidate("postgres://prod/orders")).toBe(true);
    expect(isRefCandidate("/var/log/app.log")).toBe(true);
  });

  it("accepts plain words ≥ 6 chars without whitespace", () => {
    // The V1.1 rule favours recall: a downstream literal that
    // coincidentally happens to be a single word still becomes
    // a candidate. The safety net is that no upstream node
    // typically produces such bare words as a string-valued
    // result field — Strategy Z+'s index lookup returns
    // sources.length === 0 and the literal is preserved.
    expect(isRefCandidate("warehouse_prod")).toBe(true);
    expect(isRefCandidate("completed")).toBe(true);
  });

  it("rejects non-strings", () => {
    expect(isRefCandidate(42)).toBe(false);
    expect(isRefCandidate(null)).toBe(false);
    expect(isRefCandidate(undefined)).toBe(false);
    expect(isRefCandidate({})).toBe(false);
    expect(isRefCandidate(["abc"])).toBe(false);
  });

  it("rejects strings shorter than 6 characters", () => {
    expect(isRefCandidate("abc12")).toBe(false); // 5 chars
    expect(isRefCandidate("ok")).toBe(false); // common status word
    expect(isRefCandidate("USD")).toBe(false); // currency code
    expect(isRefCandidate("")).toBe(false);
  });

  it("rejects strings containing any whitespace", () => {
    // Spaces, tabs, and newlines all disqualify a value — this
    // is what keeps SQL, Python code, Markdown content out of
    // the value→source index.
    expect(isRefCandidate("SELECT * FROM orders")).toBe(false);
    expect(isRefCandidate("Hello world")).toBe(false);
    expect(isRefCandidate("import pandas\nimport numpy")).toBe(false);
    expect(isRefCandidate("a\tb\tc def")).toBe(false);
  });
});
