/**
 * User-scoped server-tool catalog — the cross-subsystem assembly
 * point that both chat dispatch and workflow execution rely on.
 *
 * Why this file exists (per the D31 follow-up discussion):
 *   - Chat-time dispatch (`runner/dispatch/builtin.ts`) builds the
 *     tool set PER AGENT RUN, filtered by the agent's bindings.
 *   - Workflow execution has no agent context — it has only an
 *     OWNER (the artifact's `createdBy`). It needs the same tool
 *     builders, assembled to a flat lookup table.
 *   - Both consumers want the SAME `defineTool`-produced
 *     `ToolDefinition` objects so behaviour (validation, errors,
 *     side effects) stays identical across paths.
 *
 * `buildUserToolCatalog(ownerId)` is the seam. It returns every
 * server tool the owner has access to right now, keyed by tool
 * name. Workflow execution looks up by `node.tool`; chat dispatch
 * could (future cleanup) call this and then filter to the agent's
 * bindings.
 *
 * V1.7 surface (intentionally narrow):
 *   - All catalog tools from `BUILTIN_TOOLS` (run_code_in_sandbox,
 *     web_search) — zero binding required.
 *   - `extract_dataset_by_sql` — global by design (the slug is a
 *     parameter; permission check happens inside the tool via
 *     `resolveDataSourceByName`).
 *
 * Out of scope (future):
 *   - SSH (`run_ssh_command` / `list_ssh_hosts`) — binding-scoped
 *     by agent today; workflow-scoping needs a separate decision.
 *   - Skills (`get_skill` / `get_skill_file` / `run_skill_script`)
 *     — same.
 *   - MCP tools — separate dispatch path (mcp/provider-pool).
 *   - Supervisor tools — agent-context-specific, NOT relevant in
 *     workflow execution.
 *
 * `ownerId` is part of the signature even though V1 doesn't read
 * it — future tool builders (skills, ssh) WILL need it, and pinning
 * the signature now means workflow / chat callers don't change
 * when we expand the catalog.
 */

import "server-only";

import type { ToolDefinition } from "@/lib/copilot/index.server";

import { BUILTIN_TOOLS } from "./catalog";
import { buildExtractDatasetTool } from "@/lib/data-sources/runtime-tools";

/**
 * Assemble all server-side tools this user can invoke right now.
 * Pure factory — no DB writes, no side effects beyond the
 * lookups each tool builder performs at construction time.
 *
 * Returns a `Map<toolName, ToolDefinition>` so consumers can:
 *   - chat dispatch: filter to the agent's binding-allowed names
 *   - workflow execution: look up by spec node's `tool` field
 *
 * Unknown names returned by callers → null on `Map#get` →
 * workflow engine surfaces as `TOOL_NOT_FOUND` to the LLM caller.
 */
export async function buildUserToolCatalog(
  ownerId: string,
): Promise<Map<string, ToolDefinition>> {
  // Reserved for future tool builders (skills, ssh) that need the
  // owner's binding list. V1.7 catalog + extract_dataset_by_sql
  // are both zero-binding at construction time.
  void ownerId;

  const map = new Map<string, ToolDefinition>();

  // Catalog tools: each is a zero-arg factory producing a fresh
  // ToolDefinition per call. They are user-tickable global
  // capabilities (sandbox / search).
  for (const entry of BUILTIN_TOOLS) {
    map.set(entry.name, entry.build());
  }

  // Binding-implied global tools. `extract_dataset_by_sql` is the
  // dominant V1 path — chat-saved workflows almost always start
  // with a SQL extract. The tool is global by design (data source
  // slug is a parameter; permission check happens inside execute).
  map.set("extract_dataset_by_sql", buildExtractDatasetTool());

  return map;
}
