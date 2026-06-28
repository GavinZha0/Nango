import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// Mock subsystem builders so the catalog test does not transitively
// load Docker / sandbox bootstrapping or the web-search DB layer.
vi.mock("@/lib/sandbox/runtime-tools", () => ({
  buildRunInSandboxTool: () => ({
    name: "run_code_in_sandbox",
    description: "stub",
    parameters: { _def: {} },
    execute: async () => ({}),
  }),
}));

vi.mock("@/lib/web-search/runtime-tools", () => ({
  buildWebSearchTool: () => ({
    name: "web_search",
    description: "stub",
    parameters: { _def: {} },
    execute: async () => ({}),
  }),
}));

import {
  BUILTIN_TOOLS,
  buildBuiltinTools,
  findBuiltinTool,
  isKnownBuiltinTool,
  listBuiltinToolDescriptors,
} from "@/lib/builtin-tools";

describe("BUILTIN_TOOLS catalog", () => {
  it("exposes the V1 entries with stable slugs", () => {
    // CONTRACT: catalog only holds zero-arg tools that have no
    // per-agent binding dependency. Binding-bound tools
    // (extract_dataset_by_sql, run_ssh_command, get_skill, …) live in
    // their respective domain modules and are auto-mounted by
    // dispatch/builtin.ts when their binding is present.
    const names = BUILTIN_TOOLS.map((t) => t.name).sort();
    expect(names).toEqual(["generate_echarts_config", "generate_html_page", "run_code_in_sandbox", "web_search"]);
  });

  it("each entry has a displayName, description, and category", () => {
    for (const t of BUILTIN_TOOLS) {
      expect(t.displayName.length).toBeGreaterThan(0);
      expect(t.description.length).toBeGreaterThan(20);
      expect(["sandbox", "search", "outcomes"]).toContain(t.category);
      expect(typeof t.build).toBe("function");
    }
  });

  it("findBuiltinTool returns the entry by slug", () => {
    expect(findBuiltinTool("run_code_in_sandbox")?.name).toBe("run_code_in_sandbox");
    expect(findBuiltinTool("nope")).toBeNull();
  });

  it("isKnownBuiltinTool guards against typos", () => {
    expect(isKnownBuiltinTool("run_code_in_sandbox")).toBe(true);
    expect(isKnownBuiltinTool("RUN_CODE_IN_SANDBOX")).toBe(false);
    expect(isKnownBuiltinTool("")).toBe(false);
  });

  it("legacy 'extract_dataset_by_sql' slug is not in this catalog", () => {
    // The tool itself still exists in lib/data-sources/runtime-tools.ts;
    // it just doesn't go through the user-tickable catalog any more —
    // dispatch/builtin.ts auto-mounts it when a data_source is bound.
    expect(isKnownBuiltinTool("extract_dataset_by_sql")).toBe(false);
    expect(findBuiltinTool("extract_dataset_by_sql")).toBeNull();
  });

  it("listBuiltinToolDescriptors returns a serialisable shape (no `build`)", () => {
    const ds = listBuiltinToolDescriptors();
    expect(ds).toHaveLength(BUILTIN_TOOLS.length);
    for (const d of ds) {
      expect(d).not.toHaveProperty("build");
      expect(d).toHaveProperty("name");
      expect(d).toHaveProperty("displayName");
      expect(d).toHaveProperty("description");
      expect(d).toHaveProperty("category");
    }
  });
});

describe("buildBuiltinTools", () => {
  it("returns [] for an empty list", () => {
    expect(buildBuiltinTools([])).toEqual([]);
  });

  it("resolves known slugs to ToolDefinition objects", () => {
    const tools = buildBuiltinTools(["run_code_in_sandbox"]);
    expect(tools.map((t) => t.name)).toEqual(["run_code_in_sandbox"]);
  });

  it("drops unknown slugs silently (forward-compat)", () => {
    // 'extract_dataset_by_sql' used to be in the catalog; legacy DB
    // rows referencing it should drop through this branch (the actual
    // tool is auto-mounted by data_source binding now).
    const tools = buildBuiltinTools([
      "run_code_in_sandbox",
      "extract_dataset_by_sql",
      "retired_tool",
    ]);
    expect(tools.map((t) => t.name)).toEqual(["run_code_in_sandbox"]);
  });

  it("dedupes repeated slugs", () => {
    const tools = buildBuiltinTools([
      "run_code_in_sandbox",
      "run_code_in_sandbox",
    ]);
    expect(tools.map((t) => t.name)).toEqual(["run_code_in_sandbox"]);
  });
});
