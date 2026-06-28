/**
 * Calendar credential lookup — resolve a calendar name (slug) to
 * its ICS URL for fetching.
 *
 * Calendar sources are stored as regular `credential` rows with
 * `serviceType = "calendar"`. The `restUrl` column carries the ICS
 * subscription URL; the `name` column is the LLM-facing slug.
 */

import "server-only";

import { and, eq, inArray } from "drizzle-orm";

import { db } from "@/lib/db";
import { CredentialTable } from "@/lib/db/schema";

export interface CalendarSourceRow {
  id: string;
  name: string;
  provider: string | null;
  restUrl: string | null;
  description: string | null;
}

/**
 * List all enabled calendar credentials. Used by the prompt block
 * builder and the agent editor's Calendars section.
 */
export async function listCalendarSources(): Promise<CalendarSourceRow[]> {
  return db
    .select({
      id: CredentialTable.id,
      name: CredentialTable.name,
      provider: CredentialTable.provider,
      restUrl: CredentialTable.restUrl,
      description: CredentialTable.metadata,
    })
    .from(CredentialTable)
    .where(
      and(
        eq(CredentialTable.serviceType, "calendar"),
        eq(CredentialTable.enabled, true),
      ),
    )
    .then((rows) =>
      rows.map((r) => ({
        id: r.id,
        name: r.name,
        provider: r.provider,
        restUrl: r.restUrl,
        description: extractDescription(r.description),
      })),
    );
}

/**
 * List calendar sources by IDs. Used by the prompt block builder
 * to render only the calendars bound to a specific agent.
 */
export async function listCalendarSourcesByIds(
  ids: string[],
): Promise<CalendarSourceRow[]> {
  if (ids.length === 0) return [];
  return db
    .select({
      id: CredentialTable.id,
      name: CredentialTable.name,
      provider: CredentialTable.provider,
      restUrl: CredentialTable.restUrl,
      description: CredentialTable.metadata,
    })
    .from(CredentialTable)
    .where(
      and(
        inArray(CredentialTable.id, ids),
        eq(CredentialTable.serviceType, "calendar"),
        eq(CredentialTable.enabled, true),
      ),
    )
    .then((rows) =>
      rows.map((r) => ({
        id: r.id,
        name: r.name,
        provider: r.provider,
        restUrl: r.restUrl,
        description: extractDescription(r.description),
      })),
    );
}

export interface ResolvedCalendar {
  id: string;
  name: string;
  icsUrl: string;
}

/**
 * Resolve a calendar name (LLM-facing slug) to its ICS URL.
 * Returns `null` when the name doesn't match any enabled calendar
 * credential or the credential has no `restUrl`.
 */
export async function resolveCalendarByName(
  name: string,
): Promise<
  | { ok: true; resolved: ResolvedCalendar }
  | { ok: false; error: string; message: string }
> {
  const rows = await db
    .select({
      id: CredentialTable.id,
      name: CredentialTable.name,
      restUrl: CredentialTable.restUrl,
    })
    .from(CredentialTable)
    .where(
      and(
        eq(CredentialTable.name, name),
        eq(CredentialTable.serviceType, "calendar"),
        eq(CredentialTable.enabled, true),
      ),
    )
    .limit(1);

  const row = rows[0];
  if (!row) {
    return {
      ok: false,
      error: "CALENDAR_NOT_FOUND",
      message: `No enabled calendar named '${name}'. Check Available calendars in your prompt.`,
    };
  }
  if (!row.restUrl || row.restUrl.trim().length === 0) {
    return {
      ok: false,
      error: "CALENDAR_NO_URL",
      message: `Calendar '${name}' has no ICS URL configured.`,
    };
  }
  return {
    ok: true,
    resolved: { id: row.id, name: row.name, icsUrl: row.restUrl },
  };
}

/** Extract description from credential metadata.extra.description or
 *  fall back to keyPreview. Returns null when absent. */
function extractDescription(
  metadata: unknown,
): string | null {
  if (metadata === null || typeof metadata !== "object") return null;
  const m = metadata as Record<string, unknown>;
  if (m.extra && typeof m.extra === "object") {
    const extra = m.extra as Record<string, unknown>;
    if (typeof extra.description === "string" && extra.description.length > 0) {
      return extra.description;
    }
  }
  return null;
}
