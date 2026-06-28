/**
 * Server-side `fetch_calendar_events` agent tool.
 *
 * Auto-mounted when one or more calendar credentials are bound to
 * the agent. Resolves the calendar name to its ICS URL, fetches
 * and parses the ICS data, and returns events within the requested
 * date range.
 */

import "server-only";

import { z } from "zod";

import { defineTool, type ToolDefinition } from "@/lib/copilot/index.server";

import { resolveCalendarByName } from "./lookup";
import { fetchIcsEvents, type CalendarEvent } from "./ics-parser";

const fetchCalendarEventsSchema = z.object({
  calendar_name: z
    .string()
    .min(1)
    .describe(
      "Slug of a registered calendar source (see the Available calendars list in your prompt).",
    ),
  start_date: z
    .string()
    .optional()
    .describe(
      "Start date filter, ISO 8601 date string (e.g. '2026-06-27'). Defaults to today.",
    ),
  end_date: z
    .string()
    .optional()
    .describe(
      "End date filter, ISO 8601 date string. Defaults to start_date (single day query).",
    ),
});

type FetchCalendarEventsArgs = z.infer<typeof fetchCalendarEventsSchema>;

interface FetchCalendarEventsSuccess {
  ok: true;
  calendar_name: string;
  range: { start: string; end: string };
  event_count: number;
  events: CalendarEvent[];
}

interface FetchCalendarEventsFailure {
  ok: false;
  error: string;
  message: string;
}

type FetchCalendarEventsResult =
  | FetchCalendarEventsSuccess
  | FetchCalendarEventsFailure;

/**
 * Build the `fetch_calendar_events` tool.
 *
 * @param opts.agentCalendarCredentialIds — IDs of calendar credentials
 *   bound to this agent. Used for authorization: the tool rejects
 *   calendar names that resolve to credentials not in this set.
 */
export function buildFetchCalendarEventsTool(opts: {
  agentCalendarCredentialIds: readonly string[];
}): ToolDefinition {
  const allowedIds = new Set(opts.agentCalendarCredentialIds);

  return defineTool({
    name: "fetch_calendar_events",
    description:
      "Fetch events from a calendar source within a date range. " +
      "Returns structured event data (summary, start, end, location). " +
      "Use this when the user asks about schedules, appointments, " +
      "leave/vacation, meetings, or deadlines that are tracked in a " +
      "calendar. See the Available calendars list for registered sources.",
    parameters: fetchCalendarEventsSchema,
    execute: async (
      args: FetchCalendarEventsArgs,
    ): Promise<FetchCalendarEventsResult> => {
      // Resolve calendar name to ICS URL
      const lookup = await resolveCalendarByName(args.calendar_name);
      if (!lookup.ok) {
        return { ok: false, error: lookup.error, message: lookup.message };
      }

      // Authorization: only calendars bound to this agent
      if (!allowedIds.has(lookup.resolved.id)) {
        return {
          ok: false,
          error: "CALENDAR_NOT_BOUND",
          message:
            `Calendar '${args.calendar_name}' exists but is not bound to this agent.`,
        };
      }

      // Default date range to today
      const today = new Date().toISOString().slice(0, 10);
      const startDate = args.start_date ?? today;
      const endDate = args.end_date ?? startDate;

      try {
        const events = await fetchIcsEvents(
          lookup.resolved.icsUrl,
          startDate,
          endDate,
        );

        return {
          ok: true,
          calendar_name: args.calendar_name,
          range: { start: startDate, end: endDate },
          event_count: events.length,
          events,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          ok: false,
          error: "CALENDAR_FETCH_FAILED",
          message: `Failed to fetch calendar '${args.calendar_name}': ${message}`,
        };
      }
    },
  });
}
