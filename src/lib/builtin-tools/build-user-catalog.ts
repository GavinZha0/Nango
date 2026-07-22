/**
 * User-scoped server-tool catalog shared by chat dispatch and
 * workflow execution. See docs/builtin-runtime.md.
 */

import "server-only";

import { and, eq, or } from "drizzle-orm";

import type { ToolDefinition } from "@/lib/copilot/index.server";
import { db } from "@/lib/db";
import { DataSourceTable } from "@/lib/db/schema";

import { BUILTIN_TOOLS } from "./catalog";
import { buildExtractDatasetTool } from "@/lib/data-sources/runtime-tools";

/**
 * Returns `Map<toolName, ToolDefinition>`. Unknown tool names surface
 * as `TOOL_NOT_FOUND` to the LLM caller via the workflow engine.
 */
export async function buildUserToolCatalog(
  ownerId: string,
): Promise<Map<string, ToolDefinition>> {
  const map = new Map<string, ToolDefinition>();
  for (const entry of BUILTIN_TOOLS) {
    map.set(entry.name, entry.build());
  }

  // SECURITY (BUG-1): workflow SQL nodes may only reach data sources
  // visible to the workflow owner (enabled + public | owned). This is
  // the run-time authorization boundary; save-time validation in
  // canonicalize (owner-scoped name→id resolution) is follow-up
  // hardening. Admin-owned workflow refresh is scoped to the owner too.
  const visibleRows = await db
    .select({ id: DataSourceTable.id })
    .from(DataSourceTable)
    .where(
      and(
        eq(DataSourceTable.enabled, true),
        or(
          eq(DataSourceTable.visibility, "public"),
          eq(DataSourceTable.createdBy, ownerId),
        ),
      ),
    );
  map.set(
    "extract_dataset_by_sql",
    buildExtractDatasetTool(visibleRows.map((r) => r.id)),
  );
  return map;
}
