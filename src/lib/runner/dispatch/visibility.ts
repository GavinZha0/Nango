/**
 * Dispatch-time visibility filter for agent bindings.
 *
 * The runtime is RBAC-free by design — the binding is the grant — but a grant
 * must not outlive the audience the binder could see: a public agent run by
 * another user must not serve a private skill, SSH server, data source, or MCP
 * server bound by its author. Each bound id set is re-filtered against the
 * runner's identity once per dispatch (no per-call RBAC), and fails closed
 * when no runner identity exists.
 *
 * See docs/skills.md, docs/ssh.md, docs/data-sources.md.
 */

import "server-only";

import { and, eq, inArray } from "drizzle-orm";
import type { AnyPgColumn, AnyPgTable } from "drizzle-orm/pg-core";

import { db } from "@/lib/db";
import { visibilitySql, type AuthContext } from "@/lib/auth/permissions";
import {
  DataSourceTable,
  McpServerTable,
  SkillTable,
  SshServerTable,
} from "@/lib/db/schema";

interface VisibilityColumns {
  id: AnyPgColumn;
  enabled: AnyPgColumn;
  visibility: AnyPgColumn;
  createdBy: AnyPgColumn;
}

async function filterVisibleResourceIds(
  ids: readonly string[],
  auth: AuthContext | undefined,
  table: AnyPgTable,
  columns: VisibilityColumns,
): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  if (!auth) return new Set();
  const unique = [...new Set(ids)];
  const rows = await db
    .select({ id: columns.id })
    .from(table)
    .where(
      and(
        inArray(columns.id, unique),
        eq(columns.enabled, true),
        visibilitySql(auth, columns.visibility, columns.createdBy),
      ),
    );
  return new Set(rows.map((row) => String(row.id)));
}

export function filterVisibleSkillIds(
  ids: readonly string[],
  auth: AuthContext | undefined,
): Promise<Set<string>> {
  return filterVisibleResourceIds(ids, auth, SkillTable, {
    id: SkillTable.id,
    enabled: SkillTable.enabled,
    visibility: SkillTable.visibility,
    createdBy: SkillTable.createdBy,
  });
}

export function filterVisibleSshServerIds(
  ids: readonly string[],
  auth: AuthContext | undefined,
): Promise<Set<string>> {
  return filterVisibleResourceIds(ids, auth, SshServerTable, {
    id: SshServerTable.id,
    enabled: SshServerTable.enabled,
    visibility: SshServerTable.visibility,
    createdBy: SshServerTable.createdBy,
  });
}

export function filterVisibleDataSourceIds(
  ids: readonly string[],
  auth: AuthContext | undefined,
): Promise<Set<string>> {
  return filterVisibleResourceIds(ids, auth, DataSourceTable, {
    id: DataSourceTable.id,
    enabled: DataSourceTable.enabled,
    visibility: DataSourceTable.visibility,
    createdBy: DataSourceTable.createdBy,
  });
}

export function filterVisibleMcpServerIds(
  ids: readonly string[],
  auth: AuthContext | undefined,
): Promise<Set<string>> {
  return filterVisibleResourceIds(ids, auth, McpServerTable, {
    id: McpServerTable.id,
    enabled: McpServerTable.enabled,
    visibility: McpServerTable.visibility,
    createdBy: McpServerTable.createdBy,
  });
}
