/**
 * Production `SaveArtifactDeps` — real DB-backed resolution for
 * canonicalize. Each method is on-demand (lazy): only the agents,
 * data sources, and tools actually referenced in the spec are
 * resolved.
 *
 * See docs/workflow.md.
 */

import "server-only";

import { and, eq, or } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/lib/db";
import { BuiltinAgentTable, CredentialTable, DataSourceTable } from "@/lib/db/schema";
import type { AgentRole } from "@/lib/db/schema";
import { EntityCatalog } from "@/lib/backends/entity-catalog";
import { computeDisplayName } from "@/lib/orchestration/display-name";
import { buildUserToolCatalog } from "@/lib/builtin-tools/build-user-catalog";
import { childLogger } from "@/lib/observability/logger";
import type { ToolMetadata } from "@/lib/workflows";
import type { SaveArtifactDeps } from "./save-artifact";

const log = childLogger({ component: "save-deps" });

// ─── Public factory ────────────────────────────────────────────────────

/**
 * Build production `SaveArtifactDeps` scoped to `ownerId`.
 *
 * Each dep resolves on demand — no pre-hydration. Internal caches
 * (tool catalog, agent catalog) are lazily built on first call and
 * reused within the same `saveArtifact` invocation.
 */
export function buildProductionSaveDeps(ownerId: string): SaveArtifactDeps {
  // Lazy-initialized caches (populated on first call, reused within
  // the same save invocation).
  let toolCatalogP: Promise<Map<string, { parameters: unknown }>> | undefined;
  let agentCatalogP: Promise<Map<string, string>> | undefined;

  return {
    async getToolMetadata(toolName: string): Promise<ToolMetadata | null> {
      toolCatalogP ??= buildUserToolCatalog(ownerId);
      const catalog = await toolCatalogP;
      const def = catalog.get(toolName);
      if (!def) return null;
      return {
        input_schema: extractInputJsonSchema(def.parameters),
      };
    },

    async resolveAgentId(displayString: string): Promise<string | null> {
      agentCatalogP ??= buildAgentCatalog(ownerId);
      const catalog = await agentCatalogP;
      return catalog.get(displayString) ?? null;
    },

    async resolveDataSourceId(name: string): Promise<string | null> {
      return resolveDataSourceBySlug(name);
    },
  };
}

// ─── Agent catalog ─────────────────────────────────────────────────────

/**
 * Build a Map<displayName, agentUUID> covering all agents the user
 * can see (builtin + backend). Mirrors the catalog-build logic in
 * `supervisor-tools.server.ts::buildCatalog` but returns a flat
 * lookup map instead of structured entries.
 */
async function buildAgentCatalog(
  ownerId: string,
): Promise<Map<string, string>> {
  const catalog = new Map<string, string>();

  // ── Builtin agents ──────────────────────────────────────────────
  // Query directly with the same visibility filter that
  // listVisibleAgentIds uses, avoiding a redundant DB round-trip.
  const rows: Array<{
    id: string;
    name: string;
    role: AgentRole | null;
    createdBy: string | null;
    visibility: string;
  }> = await db
    .select({
      id: BuiltinAgentTable.id,
      name: BuiltinAgentTable.name,
      role: BuiltinAgentTable.role,
      createdBy: BuiltinAgentTable.createdBy,
      visibility: BuiltinAgentTable.visibility,
    })
    .from(BuiltinAgentTable)
    .where(
      and(
        eq(BuiltinAgentTable.enabled, true),
        or(
          eq(BuiltinAgentTable.visibility, "public"),
          eq(BuiltinAgentTable.createdBy, ownerId),
        ),
      ),
    );

  for (const row of rows) {
    // System agents (role !== null) are never workflow-routable.
    if (row.role !== null) continue;

    const isPublicByOthers =
      row.visibility === "public" && row.createdBy !== ownerId;
    const displayName = computeDisplayName({
      source: "builtin",
      isPublicByOthers,
      name: row.name,
    });
    catalog.set(displayName, row.id);
  }

  // ── Backend agents ──────────────────────────────────────────────
  const credRows: Array<{ id: string; name: string }> = await db
    .select({ id: CredentialTable.id, name: CredentialTable.name })
    .from(CredentialTable)
    .where(
      and(
        eq(CredentialTable.serviceType, "agent"),
        eq(CredentialTable.enabled, true),
      ),
    );

  for (const cred of credRows) {
    let entities: Awaited<ReturnType<typeof EntityCatalog.list>>;
    try {
      entities = await EntityCatalog.list(cred.id);
    } catch (err) {
      log.warn(
        {
          event: "catalog_fetch_failed",
          credentialId: cred.id,
          err: err instanceof Error ? err.message : String(err),
        },
        "failed to fetch backend entity catalog during save; skipping credential",
      );
      continue;
    }
    if (!entities) continue;

    for (const e of entities) {
      const displayName = computeDisplayName({
        source: "backend",
        credentialName: cred.name,
        name: e.name ?? e.id,
      });
      catalog.set(displayName, e.id);
    }
  }

  return catalog;
}

// ─── Data source resolution ────────────────────────────────────────────

async function resolveDataSourceBySlug(
  name: string,
): Promise<string | null> {
  const rows = await db
    .select({ id: DataSourceTable.id })
    .from(DataSourceTable)
    .where(
      and(
        eq(DataSourceTable.name, name),
        eq(DataSourceTable.enabled, true),
      ),
    )
    .limit(1);
  return rows[0]?.id ?? null;
}

// ─── Tool schema extraction ────────────────────────────────────────────

/**
 * Extract JSON Schema from a tool's `parameters` field. In Nango all
 * builtin tools define parameters as Zod schemas — `z.toJSONSchema()`
 * converts them. Returns `undefined` when extraction fails (the
 * engine skips input validation for that tool).
 */
function extractInputJsonSchema(
  parameters: unknown,
): Record<string, unknown> | undefined {
  try {
    if (parameters instanceof z.ZodType) {
      const { $schema: _, ...rest } = z.toJSONSchema(parameters) as Record<string, unknown>;
      return rest;
    }
  } catch {
    // Schema conversion failed — fall through to undefined.
  }
  return undefined;
}
