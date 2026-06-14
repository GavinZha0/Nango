"use client";

/**
 * useDisplayTimezone — returns the IANA timezone to use for all
 * user-facing timestamp display.
 *
 * Resolution: user profile `timezone` → browser timezone → "UTC".
 *
 * The profile value is kept in sync with the browser by
 * WorkspaceProvider when `timezoneFollowBrowser` is true. When
 * false, the profile value is a fixed IANA name chosen by the user.
 * Either way this hook simply reads the stored value so every
 * component renders times consistently.
 */

import { authClient } from "@/lib/auth/client";

/** Stable fallback — evaluated once per page load. */
const BROWSER_TZ: string = (() => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
})();

export function useDisplayTimezone(): string {
  const { data: sessionData } = authClient.useSession();
  const tz =
    (sessionData?.user as { timezone?: string | null } | undefined)?.timezone
    ?? null;
  return tz || BROWSER_TZ;
}
