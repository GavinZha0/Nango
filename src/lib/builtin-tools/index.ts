/**
 * Built-in tool catalog + dispatch-side builder.
 *
 * @see ./catalog.ts
 */

import "server-only";

import type { ToolDefinition } from "@/lib/copilot/index.server";

import { buildCreateFolderTool, buildEditFileTool } from "@/lib/host-files/runtime-tools";

import { BUILTIN_TOOLS, findBuiltinTool } from "./catalog";

export {
  BUILTIN_TOOLS,
  findBuiltinTool,
  isKnownBuiltinTool,
  listBuiltinToolDescriptors,
  listWorkflowToolDescriptors,
  type BuiltinToolEntry,
  type BuiltinToolCategory,
  type BuiltinToolDescriptor,
} from "./catalog";

/**
 * Toggles that grant write reach into the host folder. `create_folder`
 * exists because `write_file` and `download_file` both require the parent
 * directory to pre-exist and had no way to make one.
 */
const HOST_WRITE_TOOLS = new Set(["write_file", "download_file"]);

/**
 * CONTRACT: these ride along with a capability instead of being ticked,
 * so they are deliberately absent from `BUILTIN_TOOLS` — they never show
 * up in the editor checkbox list (`/api/builtin-tools`) and cannot be
 * switched off independently. An agent that can write files can always
 * create a directory inside the same mount and edit a file it could
 * already overwrite; nothing wider is granted.
 */
const AUXILIARY_TOOLS: Record<string, () => ToolDefinition> = {
  create_folder: buildCreateFolderTool,
  edit_file: buildEditFileTool,
};

function auxiliaryTools(names: readonly string[]): string[] {
  const out: string[] = [];
  if (names.some((name) => HOST_WRITE_TOOLS.has(name))) out.push("create_folder");
  // `edit_file` follows write_file only: download_file brings bytes in, it
  // does not make the agent a text editor.
  if (names.includes("write_file")) out.push("edit_file");
  return out;
}

/**
 * Resolve a list of bound built-in-tool slugs into actual
 * `ToolDefinition`s. Unknown slugs are dropped silently (a junction
 * row pointing at a retired tool name should not crash the run).
 */
export function buildBuiltinTools(names: readonly string[]): ToolDefinition[] {
  if (names.length === 0) return [];
  const seen = new Set<string>();
  const out: ToolDefinition[] = [];
  for (const name of [...names, ...auxiliaryTools(names)]) {
    if (seen.has(name)) continue;
    seen.add(name);
    const auxiliary = AUXILIARY_TOOLS[name];
    if (auxiliary) {
      out.push(auxiliary());
      continue;
    }
    const entry = findBuiltinTool(name);
    if (!entry) continue;
    const built = entry.build();
    if (Array.isArray(built)) {
      out.push(...built);
    } else {
      out.push(built);
    }
  }
  return out;
}

/** Force-import for side-effect modules that should not be tree-shaken. */
void BUILTIN_TOOLS;
