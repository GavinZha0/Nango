/**
 * User profile timezone — single source of truth shared by:
 *   - `get_current_datetime` tool (lib/time/runtime-tools.ts)
 *   - `create_schedule` supervisor tool (lib/runner/supervisor-tools.server.ts)
 *   - `/api/schedules` POST handler (app/api/schedules/route.ts)
 *
 * Resolution policy: returns the stored IANA name when it is valid;
 * null when userId is missing, the column is empty, or the stored
 * value is not a recognised IANA zone (defence-in-depth — the normal
 * write paths only ever produce valid names, but we never trust the
 * DB blindly when feeding `Intl.DateTimeFormat`). Read failures fail
 * soft to null so callers can still pick their own fallback
 * (server tz / UTC).
 */

import "server-only";

import { eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { UserTable } from "@/lib/db/schema";
import { childLogger } from "@/lib/observability/logger";

const log = childLogger({ component: "user-timezone" });

/** True iff `tz` is an IANA zone the runtime can format with. Invalid
 *  names make the `Intl.DateTimeFormat` constructor throw RangeError. */
export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Look up the user's stored timezone. Returns null when absent /
 *  invalid / unknown user. Never throws. */
export async function getUserTimezone(
  userId: string | undefined,
): Promise<string | null> {
  if (!userId) return null;
  try {
    const [row] = await db
      .select({ timezone: UserTable.timezone })
      .from(UserTable)
      .where(eq(UserTable.id, userId))
      .limit(1);
    const tz = row?.timezone ?? null;
    return tz && isValidTimeZone(tz) ? tz : null;
  } catch (err) {
    log.warn(
      {
        event: "lookup_failed",
        userId,
        err: err instanceof Error ? err.message : String(err),
      },
      "user timezone lookup failed; caller will use its fallback",
    );
    return null;
  }
}
