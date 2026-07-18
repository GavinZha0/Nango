/**
 * GET /api/entities — backend entity discovery for the UI.
 */

import "server-only";

import { NextRequest, NextResponse } from "next/server";
import { eq, and, inArray } from "drizzle-orm";

import { db } from "@/lib/db";
import { CredentialTable } from "@/lib/db/schema";
import { EntityCatalog } from "@/lib/backends/entity-catalog";
import { CREDENTIAL_ID_PATTERN } from "@/lib/http/chat-headers";
import { ApiError, withSession } from "@/lib/http/route-handlers";
import type { EntityDescriptor, EntityFetchError, EntityKind } from "@/lib/backends/types";
import { ALL_ENTITY_KINDS } from "@/lib/backends/types";

export const dynamic = "force-dynamic";

const ROUTE = "/api/entities";

function parseKinds(raw: string | null): readonly EntityKind[] | null {
  if (!raw) return null;
  const requested = raw.split(",").map((s) => s.trim()).filter(Boolean);
  if (requested.length === 0) return null;
  const valid: EntityKind[] = [];
  for (const k of requested) {
    if ((ALL_ENTITY_KINDS as readonly string[]).includes(k)) {
      valid.push(k as EntityKind);
    }
  }
  return valid;
}

/** SECURITY: malformed entry short-circuits with 400 to prevent
 *  silent partial behaviour. */
function parseCredentialIds(raw: string | null): string[] | null {
  if (!raw) return null;
  const ids = raw.split(",").map((s) => s.trim()).filter(Boolean);
  if (ids.length === 0) return null;
  for (const id of ids) {
    if (!CREDENTIAL_ID_PATTERN.test(id)) {
      throw new ApiError(
        "BAD_REQUEST",
        400,
        `credentialIds contains an invalid UUID: ${id}`,
      );
    }
  }
  return ids;
}

interface CredentialRow {
  id: string;
  name: string;
}

interface CredentialStatus {
  credentialId: string;
  name: string;
  ok: boolean;
  errors: EntityFetchError[];
}

interface EntitiesResponse {
  entities: EntityDescriptor[];
  credentials: CredentialStatus[];
}

export const GET = withSession(ROUTE, async ({ req }: { req: NextRequest }) => {
  const url = new URL(req.url);
  const credentialIds = parseCredentialIds(url.searchParams.get("credentialIds"));
  const kindsFilter = parseKinds(url.searchParams.get("kinds"));
  const force = url.searchParams.get("force") === "true";

  // SECURITY: always intersect with (enabled=true, serviceType=agent)
  // so an outdated UI can't sneak disabled / non-agent credentials in
  // via the URL.
  const baseConditions = [
    eq(CredentialTable.serviceType, "agent"),
    eq(CredentialTable.enabled, true),
  ];
  const credentials: CredentialRow[] = await db
    .select({
      id: CredentialTable.id,
      name: CredentialTable.name,
    })
    .from(CredentialTable)
    .where(and(...baseConditions, ...(credentialIds ? [inArray(CredentialTable.id, credentialIds)] : [])));

  const statuses: CredentialStatus[] = [];
  const tables = await Promise.all(
    credentials.map(async (cred): Promise<EntityDescriptor[]> => {
      if (force) EntityCatalog.invalidate(cred.id);
      try {
        const result = await EntityCatalog.listWithStatus(cred.id);
        const errors: EntityFetchError[] = result?.errors ?? [];
        statuses.push({ credentialId: cred.id, name: cred.name, ok: errors.length === 0, errors });
        if (result === null) return [];
        return result.entities.map((e) => ({ ...e, credentialName: cred.name }));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        statuses.push({ credentialId: cred.id, name: cred.name, ok: false, errors: [{ message }] });
        return [];
      }
    }),
  );
  let entities: EntityDescriptor[] = tables.flat();

  // QUIRK: kinds filter applied at the response edge — cache always
  // holds the full table (cheap to filter), so kinds requests don't
  // fragment the cache.
  if (kindsFilter !== null) {
    entities = entities.filter((e) => kindsFilter.includes(e.kind));
  }

  const response: EntitiesResponse = { entities, credentials: statuses };
  return NextResponse.json(response);
});
