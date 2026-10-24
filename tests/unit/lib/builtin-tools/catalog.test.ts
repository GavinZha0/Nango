import { describe, expect, it, vi } from "vitest";

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

vi.mock("@/lib/host-files/runtime-tools", () => ({
  buildReadFileTool: () => ({
    name: "read_file",
    description: "stub",
    parameters: { _def: {} },
    execute: async () => ({}),
  }),
  buildWriteFileTool: () => ({
    name: "write_file",
    description: "stub",
    parameters: { _def: {} },
    execute: async () => ({}),
  }),
  buildEditFileTool: () => ({
    name: "edit_file",
    description: "stub",
    parameters: { _def: {} },
    execute: async () => ({}),
  }),
  buildCreateFolderTool: () => ({
    name: "create_folder",
    description: "stub",
    parameters: { _def: {} },
    execute: async () => ({}),
  }),
}));

vi.mock("@/lib/host-files/download-runtime-tools", () => ({
  buildDownloadFileTool: () => ({
    name: "download_file",
    description: "stub",
    parameters: { _def: {} },
    execute: async () => ({}),
  }),
}));

vi.mock("@/lib/repeater/runtime-tools", () => ({
  buildRepeatTool: () => ({
    name: "repeat_tool",
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
  listWorkflowToolDescriptors,
} from "@/lib/builtin-tools";
import { WORKFLOW_AMBIENT_TOOLS } from "@/lib/builtin-tools/catalog";

describe("BUILTIN_TOOLS catalog", () => {
  it("exposes the V1 entries with stable slugs", () => {
    // CONTRACT: catalog only holds zero-arg tools that have no
    // per-agent binding dependency. Binding-bound tools
    // (extract_dataset_by_sql, run_ssh_command, get_skill, …) live in
    // their respective domain modules and are auto-mounted by
    // dispatch/builtin.ts when their binding is present.
    // `read_file` / `write_file` are gated by operator config, not by a
    // per-agent binding, so they belong here; they simply fail their
    // calls when no shared folder is mounted. `download_file` is the same
    // kind of toggle. `create_folder` and `edit_file` are deliberately NOT
    // here — they are synthesized by buildBuiltinTools alongside a
    // write-capable mount, so they can never be ticked on their own.
    const names = BUILTIN_TOOLS.map((t) => t.name).sort();
    expect(names).toEqual([
      "download_file",
      "generate_bento_slides",
      "generate_echarts_config",
      "generate_html_page",
      "read_file",
      "repeat_tool",
      "run_code_in_sandbox",
      "web_search",
      "write_file",
    ]);
    expect(findBuiltinTool("create_folder")).toBeNull();
    expect(findBuiltinTool("edit_file")).toBeNull();
  });

  it("each entry has a displayName, description, and category", () => {
    for (const t of BUILTIN_TOOLS) {
      expect(t.displayName.length).toBeGreaterThan(0);
      expect(t.description.length).toBeGreaterThan(20);
      expect(["sandbox", "search", "outcomes", "files"]).toContain(t.category);
      expect(typeof t.build).toBe("function");
    }
  });

  it("read_file and write_file are separate toggles", () => {
    // CONTRACT: the read/write split IS the per-agent permission model —
    // bundling them would make a read-only agent writable.
    const read = findBuiltinTool("read_file");
    const write = findBuiltinTool("write_file");
    expect(read?.category).toBe("files");
    expect(write?.category).toBe("files");
    expect(read?.bundled).toBeUndefined();
    expect(write?.bundled).toBeUndefined();
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

  it("listWorkflowToolDescriptors includes edit_bento_slides with full input_schema via bundled expansion", () => {    const descriptors = listWorkflowToolDescriptors();
    const editEntry = descriptors.find((d) => d.name === "edit_bento_slides");
    expect(editEntry).toBeDefined();
    expect(editEntry?.displayName).toBe("edit_bento_slides");
    expect(editEntry?.category).toBe("outcomes");
    expect(editEntry?.input_schema).toBeDefined();

    const schema = editEntry?.input_schema as {
      type: string;
      properties: Record<string, unknown>;
      required: string[];
    };
    expect(schema.type).toBe("object");
    expect(schema.properties).toHaveProperty("outcome_id");
    expect(schema.properties).toHaveProperty("action");
    expect(schema.properties).toHaveProperty("target_slide_ids");
    expect(schema.properties).toHaveProperty("slides");
    expect(schema.required).toEqual(["outcome_id", "action"]);

    // CONTRACT: edit_bento_slides must NOT be in WORKFLOW_AMBIENT_TOOLS
    // to prevent accidental global auto-mounting without user opt-in.
    const ambientEdit = WORKFLOW_AMBIENT_TOOLS.find((t) => t.name === "edit_bento_slides");
    expect(ambientEdit).toBeUndefined();

    // CONTRACT: edit_bento_slides is declared on generate_bento_slides.bundled
    const bentoEntry = BUILTIN_TOOLS.find((t) => t.name === "generate_bento_slides");
    expect(bentoEntry?.bundled).toHaveLength(1);
    expect(bentoEntry?.bundled?.[0]?.name).toBe("edit_bento_slides");
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

  it("expands generate_bento_slides slug into both generate and edit tools", () => {
    const tools = buildBuiltinTools(["generate_bento_slides"]);
    expect(tools.map((t) => t.name)).toEqual([
      "generate_bento_slides",
      "edit_bento_slides",
    ]);
  });

  it("mounts create_folder automatically for a write-capable agent", () => {
    // CONTRACT: create_folder is not tickable, so the only way an agent
    // gets it is by holding write_file or download_file.
    expect(buildBuiltinTools(["write_file"]).map((t) => t.name)).toEqual([
      "write_file",
      "create_folder",
      "edit_file",
    ]);
    expect(buildBuiltinTools(["download_file"]).map((t) => t.name)).toEqual([
      "download_file",
      "create_folder",
    ]);
  });

  it("never mounts create_folder for a read-only agent", () => {
    // CONTRACT: the read/write split is the permission model — a read-only
    // agent must not gain any write-side tool, including mkdir.
    expect(buildBuiltinTools(["read_file"]).map((t) => t.name)).toEqual(["read_file"]);
  });

  it("mounts edit_file only beside write_file", () => {
    // CONTRACT: edit_file rewrites text the agent could already overwrite
    // wholesale, so it follows write_file and nothing else — a
    // download-only agent gets no text editor.
    expect(
      buildBuiltinTools(["read_file", "download_file"])
        .map((t) => t.name)
        .filter((n) => n === "edit_file"),
    ).toEqual([]);

    const both = buildBuiltinTools(["write_file", "download_file"]).map((t) => t.name);
    expect(both).toEqual(["write_file", "download_file", "create_folder", "edit_file"]);
    expect(both.filter((n) => n === "edit_file")).toHaveLength(1);

    // Explicitly listing it in a legacy row must not double-mount either.
    expect(buildBuiltinTools(["write_file", "edit_file"]).map((t) => t.name)).toEqual([
      "write_file",
      "edit_file",
      "create_folder",
    ]);
  });

  it("mounts create_folder exactly once when both write tools are bound", () => {
    const explicit = buildBuiltinTools(["write_file", "create_folder"]);
    expect(explicit.map((t) => t.name)).toEqual([
      "write_file",
      "create_folder",
      "edit_file",
    ]);
  });
});
