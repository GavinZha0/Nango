/**
 * KB read-path access checks: one place that turns a URL id into an
 * authorised `kb_collection` row.
 *
 * CONTRACT: hidden and missing are both 404, so private collection ids stay
 * opaque — the same policy `src/app/api/skills/[id]/route.ts` applies.
 */

import "server-only";

import { eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { KbCollectionTable, type KbCollectionEntity } from "@/lib/db/schema";
import {
  canDeleteResource,
  canEditResource,
  canViewResource,
} from "@/lib/auth/permissions";
import { ApiError, type Session } from "@/lib/http/route-handlers";
import { parseRowId } from "@/lib/kb/validation";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function rbacOf(row: KbCollectionEntity) {
  return {
    visibility: row.visibility as "private" | "public",
    createdBy: row.createdBy,
  };
}

async function loadCollection(id: string): Promise<KbCollectionEntity> {
  // A malformed segment can never match a uuid column, and letting Postgres
  // reject it would surface as a 500 instead of the 404 the client means.
  if (!UUID_RE.test(id)) {
    throw new ApiError("NOT_FOUND", 404, "Knowledge collection not found.");
  }
  const [row] = await db
    .select()
    .from(KbCollectionTable)
    .where(eq(KbCollectionTable.id, id))
    .limit(1);
  if (!row) throw new ApiError("NOT_FOUND", 404, "Knowledge collection not found.");
  return row;
}

/** Visible to the session (own, public, or admin). */
export async function loadVisibleCollection(
  id: string,
  session: Session,
): Promise<KbCollectionEntity> {
  const row: KbCollectionEntity = await loadCollection(id);
  if (!canViewResource(rbacOf(row), session)) {
    throw new ApiError("NOT_FOUND", 404, "Knowledge collection not found.");
  }
  return row;
}

/** Content writes: description, group, page mutations. */
export async function loadEditableCollection(
  id: string,
  session: Session,
): Promise<KbCollectionEntity> {
  const row: KbCollectionEntity = await loadCollection(id);
  if (!canEditResource(rbacOf(row), session)) {
    throw new ApiError("FORBIDDEN", 403, "You cannot edit this knowledge collection.");
  }
  return row;
}

/**
 * The strict gate — delete, `enabled`, and `visibility`. Stricter than edit:
 * a public collection another editor authored can be read and improved but not
 * unmounted or made private.
 */
export async function loadOwnedCollection(
  id: string,
  session: Session,
): Promise<KbCollectionEntity> {
  const row: KbCollectionEntity = await loadCollection(id);
  if (!canDeleteResource(rbacOf(row), session)) {
    throw new ApiError("FORBIDDEN", 403, "You do not own this knowledge collection.");
  }
  return row;
}

/** bigint group / page ids arrive as URL strings. */
export function requireRowId(raw: string, what: "group" | "page"): number {
  const id: number | null = parseRowId(raw);
  if (id === null) {
    throw new ApiError("BAD_REQUEST", 400, `${what} id must be a positive integer.`);
  }
  return id;
}
