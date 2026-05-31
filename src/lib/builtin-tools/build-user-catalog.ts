/**
 * User-scoped server-tool catalog shared by chat dispatch and
 * workflow execution. See docs/builtin-runtime.md.
 */

import "server-only";

import type { ToolDefinition } from "@/lib/copilot/index.server";

import { BUILTIN_TOOLS } from "./catalog";
import { buildExtractDatasetTool } from "@/lib/data-sources/runtime-tools";

/**
 * Returns `Map<toolName, ToolDefinition>`. Pure factory — no DB
 * writes, no side effects beyond the lookups each tool builder
 * performs at construction time. Unknown tool names surface as
 * `TOOL_NOT_FOUND` to the LLM caller via the workflow engine.
 */
export async function buildUserToolCatalog(
  ownerId: string,
): Promise<Map<string, ToolDefinition>> {
  // Reserved for binding-aware tool builders.
  void ownerId;

  const map = new Map<string, ToolDefinition>();
  for (const entry of BUILTIN_TOOLS) {
    map.set(entry.name, entry.build());
  }
  map.set("extract_dataset_by_sql", buildExtractDatasetTool());
  return map;
}
