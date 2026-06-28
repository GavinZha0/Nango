/**
 * Calendar prompt block — injects the list of available calendars
 * into the agent's system prompt so the LLM knows which calendars
 * it can query via `fetch_calendar_events`.
 *
 * Follows the same pattern as `data-sources/prompt-block.server.ts`
 * and `ssh/prompt-block.server.ts`.
 */

import "server-only";

import { listCalendarSourcesByIds } from "./lookup";

export interface CalendarPromptBlock {
  promptBlock: string;
}

/**
 * Build the calendar prompt block for an agent with the given
 * bound calendar credential IDs. Returns an empty string when
 * no calendars are bound (so the prompt composition can skip it).
 */
export async function buildCalendarPromptBlock(
  calendarCredentialIds: readonly string[],
): Promise<CalendarPromptBlock> {
  if (calendarCredentialIds.length === 0) return { promptBlock: "" };

  const rows = await listCalendarSourcesByIds([...calendarCredentialIds]);
  if (rows.length === 0) return { promptBlock: "" };

  const lines = rows.map((r) => {
    const desc = r.description ? ` — ${r.description}` : "";
    const provider = r.provider ? ` (${r.provider})` : "";
    return `  - ${r.name}${provider}${desc}`;
  });

  const intro =
    "Call `fetch_calendar_events(calendar_name, start_date?, end_date?)` " +
    "to retrieve events from these calendars. Dates are ISO 8601 " +
    "strings (e.g. '2026-06-27'). Omit dates to query today.";

  return {
    promptBlock: `## Available calendars\n\n${intro}\n${lines.join("\n")}`,
  };
}
