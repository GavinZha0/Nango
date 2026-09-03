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

export interface AuthContext {
  userId: string;
  isAdmin?: boolean;
  isEditor?: boolean;
}

export type SessionOrAuth = Session | AuthContext;

function resolveAuth(auth: SessionOrAuth): {
  userId: string;
  isAdmin: boolean;
  isEditor: boolean;
} {
  if ("user" in auth) {
    const r = auth.user.role;
    return {
      userId: auth.user.id,
      isAdmin: r === "admin",
      isEditor: r === "admin" || r === "editor",
    };
  }
  return {
    userId: auth.userId,
    isAdmin: Boolean(auth.isAdmin),
    isEditor: Boolean(auth.isAdmin || auth.isEditor),
  };
}

export function isAdmin(session: SessionOrAuth): boolean {
  return resolveAuth(session).isAdmin;
}

/** True for both `admin` and `editor`. */
export function isEditor(session: SessionOrAuth): boolean {
  return resolveAuth(session).isEditor;
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
  session: SessionOrAuth,
): boolean {
  const auth = resolveAuth(session);
  if (auth.isAdmin) return true;
  if (resource.visibility === "public") return true;
  return resource.createdBy === auth.userId;
}

/**
 * Can the session edit the row's content?
 * `source = 'builtin'` is an absolute write barrier — no role can pass it.
 */
export function canEditResource(
  resource: ResourceWithRBAC,
  session: SessionOrAuth,
): boolean {
  const auth = resolveAuth(session);
  if (resource.source === "builtin") return false;
  if (!auth.isEditor) return false;
  if (auth.isAdmin) return true;
  if (resource.visibility === "public") return true;
  return resource.createdBy === auth.userId;
}

/**
 * Can the session delete the row?
 * Stricter than edit: only original author or admin, and never builtin.
 */
export function canDeleteResource(
  resource: ResourceWithRBAC,
  session: SessionOrAuth,
): boolean {
  const auth = resolveAuth(session);
  if (resource.source === "builtin") return false;
  if (auth.isAdmin) return true;
  if (!auth.isEditor) return false;
  return resource.createdBy === auth.userId;
}

/** Same gate as delete — change visibility / toggle enabled. */
export function canChangeVisibility(
  resource: ResourceWithRBAC,
  session: SessionOrAuth,
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
  session: SessionOrAuth,
  visibilityCol: AnyPgColumn | PgColumn,
  createdByCol: AnyPgColumn | PgColumn,
): SQL {
  const auth = resolveAuth(session);
  if (auth.isAdmin) {
    return sql`true`;
  }
  return sql`(${visibilityCol} = 'public' OR ${createdByCol} = ${auth.userId})`;
}
