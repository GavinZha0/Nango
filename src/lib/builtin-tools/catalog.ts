/**
 * Catalog of user-selectable built-in tools.
 *
 * SCOPE: entries here are global capability toggles — zero-arg
 * factories (`() => ToolDefinition`) that produce a tool meaningful
 * on its own, without any per-agent binding to enumerate against.
 * Admins surface them through `BuiltinAgentEditor`'s "Built-in Tools"
 * checkbox section.
 *
 * Tools that depend on a binding (data source / SSH host / skill /
 * supervisor flag) do NOT live here — they are constructed alongside
 * their binding in the corresponding domain module and auto-mounted
 * by `runner/dispatch/builtin.ts`.
 */

import "server-only";

import type { ToolDefinition } from "@/lib/copilot/index.server";

import { buildRunInSandboxTool } from "@/lib/sandbox/runtime-tools";
import { buildWebSearchTool } from "@/lib/web-search/runtime-tools";
import { buildGenerateEchartsConfigTool } from "@/lib/outcomes/runtime-tools";

/** Coarse grouping for the UI's section headings. */
export type BuiltinToolCategory = "sandbox" | "search" | "outcomes";

export interface BuiltinToolEntry {
  /** Tool name as registered with `defineTool`; ALSO the slug stored in
   *  `builtin_agent_tool.builtin_tool`. Single source of truth. */
  readonly name: string;
  readonly displayName: string;
  /** Short description for the editor checkbox label. The full
   *  `description` shown to the LLM lives on the `defineTool` call. */
  readonly description: string;
  readonly category: BuiltinToolCategory;
  /** Factory called once per agent run when this tool is bound. */
  readonly build: () => ToolDefinition;
}

export const BUILTIN_TOOLS: readonly BuiltinToolEntry[] = [
  {
    name: "generate_echarts_config",
    displayName: "Generate Echarts config",
    description:
      "Generate a chart configuration based on ECharts for data visualization.",
    category: "outcomes",
    build: buildGenerateEchartsConfigTool,
  },
  {
    name: "run_code_in_sandbox",
    displayName: "Run code in sandbox",
    description:
      "Execute Python/JavaScript in an isolated sandbox with read-only datasets at ./data/<name>/.",
    category: "sandbox",
    build: buildRunInSandboxTool,
  },
  {
    name: "web_search",
    displayName: "Web search",
    description:
      "Search the public web via a configured search engine (Exa today; Tavily / Brave).",
    category: "search",
    build: buildWebSearchTool,
  },
];

const BY_NAME: ReadonlyMap<string, BuiltinToolEntry> = new Map(
  BUILTIN_TOOLS.map((t) => [t.name, t]),
);

/** Look up an entry by slug. Returns null when the slug is unknown
 *  (forward-compat: an old DB row pointing to a removed tool just gets
 *  dropped on dispatch instead of crashing the run — including the
 *  legacy `extract_dataset_by_sql` rows from before that tool moved
 *  to auto-mount). */
export function findBuiltinTool(name: string): BuiltinToolEntry | null {
  return BY_NAME.get(name) ?? null;
}

/** True iff `name` corresponds to a registered built-in tool. */
export function isKnownBuiltinTool(name: string): boolean {
  return BY_NAME.has(name);
}

/** Public, client-safe projection of the catalog (no `build` factories
 *  to avoid bundling server-only modules into the editor). */
export interface BuiltinToolDescriptor {
  name: string;
  displayName: string;
  description: string;
  category: BuiltinToolCategory;
}

export function listBuiltinToolDescriptors(): BuiltinToolDescriptor[] {
  return BUILTIN_TOOLS.map((t) => ({
    name: t.name,
    displayName: t.displayName,
    description: t.description,
    category: t.category,
  }));
}
