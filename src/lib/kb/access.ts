/**
 * KB access checks: one place that turns a URL id into an authorised
 * `kb_collection` row, plus the bind-time grant gate for agent routes.
 *
 * CONTRACT: `loadVisibleCollection` answers 404 for both hidden and missing, so
 * private collection ids stay opaque on the read routes. The write gates load by
 * id and then check the right, so on those routes a hidden-but-existing id is
 * 403 while a missing id is 404 — unlike `src/app/api/skills/[id]/route.ts`,
 * which runs its visibility check first on every method.
 */

import "server-only";

import { and, eq, inArray } from "drizzle-orm";

import { db } from "@/lib/db";
import { KbCollectionTable, type KbCollectionEntity } from "@/lib/db/schema";
import {
  canDeleteResource,
  canEditResource,
  canViewResource,
  visibilitySql,
  type SessionOrAuth,
} from "@/lib/auth/permissions";
import { ApiError, type Session } from "@/lib/http/route-handlers";

/** One query runner: the pool client, or a transaction's connection. */
type KbQueryRunner =
  | typeof db
  | Parameters<Parameters<typeof db.transaction>[0]>[0];

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

/** Content writes: collection prose, page and folder mutations. */
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

/**
 * Visibility + enabled filter over a set of collection ids, used at two
 * moments with the same predicate:
 *
 *  - bind-time — the built-in-agent routes call it before writing each
 *    `knowledge` tool row, so the grant's write path validates what the editor
 *    picker only filters client-side.
 *  - dispatch-time — the runner calls it before building the prompt block and
 *    the two tools, so a grant never outlives the audience the binder could
 *    see (docs/kb.md).
 *
 * CONTRACT: the runtime is RBAC-free — the binding is the grant (`lookup.ts`)
 * — so both call sites must re-check server-side. Only ids visible to `auth`
 * AND enabled are returned. An id that no longer resolves — deleted, hidden,
 * or disabled — is dropped rather than rejected. Dropping is safe: an
 * unreturned id is never written (bind) or never mounted (dispatch), so the
 * runtime only ever sees grants `auth` could see. At bind time the picker can
 * only render what `GET /api/kb` returns, so a collection that turned private
 * or disabled after it was bound would otherwise be impossible to uncheck and
 * every save of that agent would fail.
 *
 * `runner` lets a bind-time caller run the read on the same transaction
 * connection as the write, so the visibility check and the tool-row insert are
 * one atomic unit. Dispatch passes no runner and reads from the pool.
 */
export async function filterVisibleKbCollectionIds(
  ids: readonly string[],
  auth: SessionOrAuth | undefined,
  runner: KbQueryRunner = db,
): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  if (!auth) return new Set();
  const unique = [...new Set(ids)];
  const rows: Array<{ id: string }> = await runner
    .select({ id: KbCollectionTable.id })
    .from(KbCollectionTable)
    .where(
      and(
        inArray(KbCollectionTable.id, unique),
        eq(KbCollectionTable.enabled, true),
        visibilitySql(auth, KbCollectionTable.visibility, KbCollectionTable.createdBy),
      ),
    );
  return new Set(rows.map((row) => row.id));
}
