/**
 * Built-in tool catalog + dispatch-side builder.
 *
 * @see ./catalog.ts
 */

import "server-only";

import type { ToolDefinition } from "@/lib/copilot/index.server";

import { BUILTIN_TOOLS, findBuiltinTool } from "./catalog";

export {
  BUILTIN_TOOLS,
  findBuiltinTool,
  isKnownBuiltinTool,
  listBuiltinToolDescriptors,
  type BuiltinToolEntry,
  type BuiltinToolCategory,
  type BuiltinToolDescriptor,
} from "./catalog";

/**
 * Resolve a list of bound built-in-tool slugs into actual
 * `ToolDefinition`s. Unknown slugs are dropped silently (a junction
 * row pointing at a retired tool name should not crash the run).
 */
export function buildBuiltinTools(names: readonly string[]): ToolDefinition[] {
  if (names.length === 0) return [];
  const seen = new Set<string>();
  const out: ToolDefinition[] = [];
  for (const name of names) {
    if (seen.has(name)) continue;
    seen.add(name);
    const entry = findBuiltinTool(name);
    if (!entry) continue;
    out.push(entry.build());
  }
  return out;
}

/** Force-import for side-effect modules that should not be tree-shaken. */
void BUILTIN_TOOLS;
