/**
 * RBAC × visibility × ownership permission utilities.
 */

import "server-only";

import { sql, type SQL } from "drizzle-orm";

import type { Session } from "@/lib/http/route-handlers";
import type {
  AnyPgColumn,
  PgColumn,
} from "drizzle-orm/pg-core";

// Roles

export type UserRole = "admin" | "editor" | "user";
export const VALID_ROLES: readonly UserRole[] = ["admin", "editor", "user"] as const;

export function isValidRole(value: unknown): value is UserRole {
  return typeof value === "string" && (VALID_ROLES as readonly string[]).includes(value);
}

export function isAdmin(session: Session): boolean {
  return session.user.role === "admin";
}

/** True for both `admin` and `editor`. */
export function isEditor(session: Session): boolean {
  const r = session.user.role;
  return r === "admin" || r === "editor";
}

// Resource shape (subset of skill / mcp_server / builtin_agent rows)

export interface ResourceWithRBAC {
  source?: "builtin" | "local";
  visibility: "private" | "public";
  createdBy: string | null;
}

// Per-row predicates

/** Can the session see this row at all? */
export function canViewResource(
  resource: ResourceWithRBAC,
  session: Session,
): boolean {
  if (isAdmin(session)) return true;
  if (resource.visibility === "public") return true;
  return resource.createdBy === session.user.id;
}

/**
 * Can the session edit the row's content?
 * `source = 'builtin'` is an absolute write barrier — no role can pass it.
 */
export function canEditResource(
  resource: ResourceWithRBAC,
  session: Session,
): boolean {
  if (resource.source === "builtin") return false;
  if (!isEditor(session)) return false;
  if (isAdmin(session)) return true;
  return resource.createdBy === session.user.id;
}

/**
 * Can the session delete the row?
 * Stricter than edit: only original author or admin, and never builtin.
 */
export function canDeleteResource(
  resource: ResourceWithRBAC,
  session: Session,
): boolean {
  if (resource.source === "builtin") return false;
  if (isAdmin(session)) return true;
  if (!isEditor(session)) return false;
  return resource.createdBy === session.user.id;
}

/** Same gate as delete — change visibility / toggle enabled. */
export function canChangeVisibility(
  resource: ResourceWithRBAC,
  session: Session,
): boolean {
  return canDeleteResource(resource, session);
}

export const canToggleEnabled = canChangeVisibility;

// Drizzle SQL fragment for visibility-aware list queries

/**
 * Build the `WHERE` clause that selects rows visible to the session:
 *   visibility = 'public' OR created_by = $userId OR $isAdmin
 *
 * Use in list endpoints to filter at the database level.
 *
 *     const rows = await db
 *       .select(...)
 *       .from(SkillTable)
 *       .where(visibilitySql(session, SkillTable.visibility, SkillTable.createdBy));
 */
export function visibilitySql(
  session: Session,
  visibilityCol: AnyPgColumn | PgColumn,
  createdByCol: AnyPgColumn | PgColumn,
): SQL {
  if (isAdmin(session)) {
    return sql`true`;
  }
  return sql`(${visibilityCol} = 'public' OR ${createdByCol} = ${session.user.id})`;
}
