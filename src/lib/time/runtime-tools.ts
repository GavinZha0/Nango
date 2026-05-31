/**
 * Server-side `get_current_datetime` agent tool — an AMBIENT tool
 * auto-mounted on every built-in agent (no binding, no user toggle).
 *
 * Why server-side (not a frontend tool): a frontend tool forces a
 * continuation `/run` round-trip (CopilotKit's recursive runAgent),
 * splitting one turn across two runs and breaking the agentic loop;
 * it is also unavailable in headless (async / scheduled) runs. A
 * server tool resolves inside the same run's loop and works headless.
 *
 * Why a tool (not a prompt injection): an injected timestamp is a
 * snapshot that goes stale within the conversation; a tool reads the
 * real "now" on demand.
 *
 * Timezone precedence: explicit `timezone` arg → user profile tz →
 * server tz. Profile lookup + IANA validation live in
 * `lib/time/user-timezone.ts` (the single source of truth shared
 * with `create_schedule` and the /api/schedules route).
 *
 * See docs/orchestrator.md and docs/builtin-runtime.md.
 */

import "server-only";

import { z } from "zod";

import { defineTool } from "@/lib/copilot/index.server";
import type { ToolDefinition } from "@/lib/copilot/index.server";
import { getUserTimezone, isValidTimeZone } from "@/lib/time/user-timezone";

/** Final fallback when neither an override nor a profile tz is usable. */
function serverTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

/** Minutes east of UTC for `date` in `timeZone` (e.g. +480 for
 *  Asia/Shanghai). Derived by formatting the instant into the zone's
 *  wall-clock parts and diffing against the UTC instant — correct
 *  across DST without a tz database dependency. */
function utcOffsetMinutes(date: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(date);
  const get = (t: string): number =>
    Number(parts.find((p) => p.type === t)?.value ?? "0");
  const asUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour"),
    get("minute"),
    get("second"),
  );
  return Math.round((asUtc - date.getTime()) / 60_000);
}

export interface GetCurrentDatetimeOptions {
  /** Run owner. Present on chat dispatch; absent for some programmatic
   *  builds — then the tool falls back to the server timezone. */
  userId?: string;
}

/**
 * Build the ambient `get_current_datetime` tool. `userId` is captured
 * in the closure (the `execute` signature only receives args), so the
 * tool can resolve the caller's profile timezone at invoke time.
 */
export function buildGetCurrentDatetimeTool(
  opts: GetCurrentDatetimeOptions = {},
): ToolDefinition {
  return defineTool({
    name: "get_current_datetime",
    description:
      "Return the current DATE and TIME with timezone. Use this whenever " +
      "you need to know 'now' — e.g. before computing a relative time " +
      "('tomorrow 9am', 'in 30 minutes') for create_schedule / " +
      "update_schedule, or to answer date/time questions. Defaults to the " +
      "user's own timezone; pass `timezone` only to report in a different " +
      "IANA zone.",
    parameters: z.object({
      timezone: z
        .string()
        .optional()
        .describe(
          "Optional IANA timezone to report in (e.g. 'America/New_York'). " +
            "Omit to use the user's own timezone.",
        ),
    }),
    execute: async ({ timezone }) => {
      const trimmed = timezone?.trim();
      const override = trimmed && isValidTimeZone(trimmed) ? trimmed : null;
      const tz =
        override
        ?? (await getUserTimezone(opts.userId))
        ?? serverTimeZone();

      const now = new Date();
      return {
        iso: now.toISOString(), // absolute instant (UTC), tz-independent
        timezone: tz, // IANA zone the human-readable fields below are in
        utcOffsetMinutes: utcOffsetMinutes(now, tz), // e.g. +480
        localized: new Intl.DateTimeFormat("en-US", {
          timeZone: tz,
          dateStyle: "full",
          timeStyle: "long",
        }).format(now),
        weekday: new Intl.DateTimeFormat("en-US", {
          timeZone: tz,
          weekday: "long",
        }).format(now),
      };
    },
  });
}
