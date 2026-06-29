/**
 * ICS calendar parser with in-memory LRU cache.
 *
 * Fetches an ICS URL, parses VEVENT entries, and returns
 * structured events filtered by date range. Results are cached
 * for 5 minutes per URL to avoid hammering upstream calendar
 * servers on repeated agent queries.
 */

import "server-only";

import ical, { type VEvent } from "node-ical";
import { LRUCache } from "lru-cache";

export interface CalendarEvent {
  summary: string;
  start: string;
  end: string;
  allDay: boolean;
  location?: string;
  description?: string;
}

interface CachedCalendar {
  events: ical.CalendarResponse;
  fetchedAt: number;
}

const cache = new LRUCache<string, CachedCalendar>({
  max: 50,
  ttl: 5 * 60 * 1000, // 5 minutes
});

const ICS_FETCH_TIMEOUT_MS = 15_000;

/**
 * Fetch and parse an ICS URL, returning events within the given
 * date range. Uses a 5-minute LRU cache keyed by URL.
 */
export async function fetchIcsEvents(
  icsUrl: string,
  startDate: string,
  endDate: string,
): Promise<CalendarEvent[]> {
  let parsed: ical.CalendarResponse;

  // SECURITY: only allow HTTPS URLs to prevent SSRF via file:// / http://internal etc.
  if (!icsUrl.startsWith("https://")) {
    throw new Error("Only HTTPS calendar URLs are supported.");
  }

  const cached = cache.get(icsUrl);
  if (cached) {
    parsed = cached.events;
  } else {
    // QUIRK: node-ical's type overloads mark (url, options) as void
    // (callback style) but the runtime returns a Promise when no
    // callback is provided. Cast to satisfy TS.
    parsed = await (ical.async.fromURL as (
      url: string,
      opts: RequestInit,
    ) => Promise<ical.CalendarResponse>)(icsUrl, {
      signal: AbortSignal.timeout(ICS_FETCH_TIMEOUT_MS),
    });
    cache.set(icsUrl, { events: parsed, fetchedAt: Date.now() });
  }

  const rangeStart = new Date(startDate);
  rangeStart.setHours(0, 0, 0, 0);
  const rangeEnd = new Date(endDate);
  rangeEnd.setHours(23, 59, 59, 999);

  const results: CalendarEvent[] = [];

  for (const key of Object.keys(parsed)) {
    const item = parsed[key];
    if (!item || item.type !== "VEVENT") continue;
    const event = item as VEvent;

    const eventStart = event.start instanceof Date ? event.start : new Date(String(event.start));
    const eventEnd = event.end instanceof Date ? event.end : new Date(String(event.end));

    if (isNaN(eventStart.getTime())) continue;

    // Filter: event overlaps with the requested range
    if (eventEnd < rangeStart || eventStart > rangeEnd) continue;

    const allDay = event.datetype === "date";

    const summary = typeof event.summary === "string"
      ? event.summary
      : (event.summary as { val: string } | undefined)?.val ?? "(no title)";
    const location = typeof event.location === "string"
      ? event.location
      : (event.location as { val: string } | undefined)?.val;
    const description = typeof event.description === "string"
      ? event.description
      : (event.description as { val: string } | undefined)?.val;

    results.push({
      summary,
      start: eventStart.toISOString(),
      end: isNaN(eventEnd.getTime()) ? eventStart.toISOString() : eventEnd.toISOString(),
      allDay,
      ...(location ? { location } : {}),
      ...(description ? { description: description.substring(0, 500) } : {}),
    });
  }

  // Sort by start time
  results.sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime());

  return results;
}
