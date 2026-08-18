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
import { buildGenerateEchartsConfigTool, buildGenerateHtmlPageTool } from "@/lib/outcomes/runtime-tools";

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
  readonly input_schema?: Record<string, unknown>;
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
    input_schema: {
      type: "object",
      properties: {
        option: {
          type: "string",
          description: "ECharts option configuration object or JSON string.",
        },
        title: {
          type: "string",
          description: "Optional chart title.",
        },
      },
      required: ["option"],
    },
    build: buildGenerateEchartsConfigTool,
  },
  {
    name: "run_code_in_sandbox",
    displayName: "Run code in sandbox",
    description:
      "Execute Python/JavaScript in an isolated sandbox with read-only datasets at ./tmp/data/<name>/.",
    category: "sandbox",
    input_schema: {
      type: "object",
      properties: {
        language: {
          type: "string",
          enum: ["python", "javascript"],
          default: "python",
          description: "Interpreter to run code in ('python' or 'javascript').",
        },
        code_text: {
          type: "string",
          description: "Source code body to execute in the sandbox.",
        },
        datasets: {
          type: "array",
          items: { type: "string" },
          description: "Optional dataset handles exposed at ./tmp/data/<name>/.",
        },
        timeout_seconds: {
          type: "integer",
          minimum: 1,
          maximum: 300,
          default: 30,
          description: "Execution timeout in seconds.",
        },
      },
      required: ["language", "code_text"],
    },
    build: buildRunInSandboxTool,
  },
  {
    name: "generate_html_page",
    displayName: "Generate HTML page",
    description:
      "Generate a complete HTML page and render it in a sandboxed iframe for rich visual content.",
    category: "outcomes",
    input_schema: {
      type: "object",
      properties: {
        html: {
          type: "string",
          description: "Complete HTML source body to render.",
        },
        title: {
          type: "string",
          description: "Document title.",
        },
      },
      required: ["html"],
    },
    build: buildGenerateHtmlPageTool,
  },
  {
    name: "web_search",
    displayName: "Web search",
    description:
      "Search the public web via a configured search engine (Exa today; Tavily / Brave).",
    category: "search",
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search engine query string.",
        },
        num_results: {
          type: "integer",
          default: 5,
          description: "Number of search results to return.",
        },
      },
      required: ["query"],
    },
    build: buildWebSearchTool,
  },
];

export const WORKFLOW_AMBIENT_TOOLS: readonly BuiltinToolDescriptor[] = [
  {
    name: "get_current_datetime",
    displayName: "get_current_datetime",
    description: "Get current system date and time",
    category: "outcomes",
    input_schema: {
      type: "object",
      properties: {
        timezone: {
          type: "string",
          description:
            "Optional IANA timezone to report in (e.g. 'America/New_York'). Omit to use default.",
        },
      },
    },
  },
  {
    name: "extract_dataset_by_sql",
    displayName: "extract_dataset_by_sql",
    description: "Execute SQL query and extract dataset",
    category: "outcomes",
    input_schema: {
      type: "object",
      properties: {
        dataSourceName: {
          type: "string",
          description: "Target database data source identifier.",
        },
        sql: {
          type: "string",
          description: "SQL query to execute for dataset extraction.",
        },
        datasetName: {
          type: "string",
          description: "Optional dataset handle name for downstream referencing.",
        },
      },
      required: ["dataSourceName", "sql"],
    },
  },
  {
    name: "run_skill_script",
    displayName: "run_skill_script",
    description: "Execute a skill script",
    category: "outcomes",
    input_schema: {
      type: "object",
      properties: {
        skillName: {
          type: "string",
          description: "Name of the skill.",
        },
        scriptName: {
          type: "string",
          description: "Filename of the script under scripts/.",
        },
        args: {
          type: "array",
          items: { type: "string" },
          description: "Arguments passed to the script.",
        },
      },
      required: ["skillName", "scriptName"],
    },
  },
  {
    name: "get_skill",
    displayName: "get_skill",
    description: "Retrieve skill content and metadata",
    category: "outcomes",
    input_schema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Skill identifier.",
        },
      },
      required: ["name"],
    },
  },
  {
    name: "get_skill_file",
    displayName: "get_skill_file",
    description: "Retrieve a specific skill file",
    category: "outcomes",
    input_schema: {
      type: "object",
      properties: {
        skillName: {
          type: "string",
          description: "Skill identifier.",
        },
        filePath: {
          type: "string",
          description: "Relative file path inside the skill directory.",
        },
      },
      required: ["skillName", "filePath"],
    },
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
  input_schema?: Record<string, unknown>;
}

export function listBuiltinToolDescriptors(): BuiltinToolDescriptor[] {
  return BUILTIN_TOOLS.map((t) => ({
    name: t.name,
    displayName: t.displayName,
    description: t.description,
    category: t.category,
    input_schema: t.input_schema,
  }));
}

export function listWorkflowToolDescriptors(): BuiltinToolDescriptor[] {
  return [...listBuiltinToolDescriptors(), ...WORKFLOW_AMBIENT_TOOLS];
}
