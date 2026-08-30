import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

const { fromURLMock } = vi.hoisted(() => ({
  fromURLMock: vi.fn(),
}));

vi.mock("node-ical", () => {
  return {
    default: {
      async: {
        fromURL: fromURLMock,
      },
    },
  };
});

import { fetchIcsEvents } from "@/lib/calendar/ics-parser";

describe("ICS Calendar Parser — Security & Robustness", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("SSRF Protection & URL Scheme Enforcement", () => {
    it("rejects non-https URLs to prevent SSRF and local file access", async () => {
      await expect(
        fetchIcsEvents("http://internal.service/cal.ics", "2026-08-01", "2026-08-31"),
      ).rejects.toThrow(/Only HTTPS calendar URLs are supported/i);

      await expect(
        fetchIcsEvents("file:///etc/passwd", "2026-08-01", "2026-08-31"),
      ).rejects.toThrow(/Only HTTPS calendar URLs are supported/i);

      await expect(
        fetchIcsEvents("ftp://example.com/cal.ics", "2026-08-01", "2026-08-31"),
      ).rejects.toThrow(/Only HTTPS calendar URLs are supported/i);
    });
  });

  describe("Date Filtering & Event Transformation", () => {
    it("parses valid VEVENT entries and filters by date range", async () => {
      const mockCalendarResponse = {
        "event-1": {
          type: "VEVENT",
          summary: "Team Standup",
          start: new Date("2026-08-15T10:00:00Z"),
          end: new Date("2026-08-15T10:30:00Z"),
          location: "Room 404",
          description: "Daily synchronization",
          datetype: "date-time",
        },
        "event-out-of-range": {
          type: "VEVENT",
          summary: "Future Conference",
          start: new Date("2026-09-15T09:00:00Z"),
          end: new Date("2026-09-15T17:00:00Z"),
          datetype: "date-time",
        },
        "non-vevent-item": {
          type: "VTIMEZONE",
        },
      };

      fromURLMock.mockResolvedValueOnce(mockCalendarResponse);

      const events = await fetchIcsEvents(
        "https://example.com/unique-calendar-1.ics",
        "2026-08-01",
        "2026-08-31",
      );

      expect(events).toHaveLength(1);
      expect(events[0].summary).toBe("Team Standup");
      expect(events[0].location).toBe("Room 404");
      expect(events[0].allDay).toBe(false);
      expect(events[0].start).toBe("2026-08-15T10:00:00.000Z");
    });

    it("handles allDay events and truncates overly long descriptions", async () => {
      const longDescription = "A".repeat(800);
      const mockCalendarResponse = {
        "event-allday": {
          type: "VEVENT",
          summary: { val: "Company Holiday" },
          start: new Date("2026-08-10T00:00:00Z"),
          end: new Date("2026-08-10T23:59:59Z"),
          description: longDescription,
          datetype: "date",
        },
      };

      fromURLMock.mockResolvedValueOnce(mockCalendarResponse);

      const events = await fetchIcsEvents(
        "https://example.com/unique-calendar-2.ics",
        "2026-08-01",
        "2026-08-31",
      );

      expect(events).toHaveLength(1);
      expect(events[0].summary).toBe("Company Holiday");
      expect(events[0].allDay).toBe(true);
      expect(events[0].description?.length).toBe(500);
    });

    it("ignores malformed events with invalid dates without crashing", async () => {
      const mockCalendarResponse = {
        "corrupted-event": {
          type: "VEVENT",
          summary: "Broken Event",
          start: "INVALID_DATE_STRING",
          end: "INVALID_DATE_STRING",
        },
      };

      fromURLMock.mockResolvedValueOnce(mockCalendarResponse);

      const events = await fetchIcsEvents(
        "https://example.com/unique-calendar-3.ics",
        "2026-08-01",
        "2026-08-31",
      );

      expect(events).toEqual([]);
    });

    it("uses in-memory LRU cache on consecutive requests with same URL", async () => {
      const mockCalendarResponse = {
        "cached-event": {
          type: "VEVENT",
          summary: "Cached Meeting",
          start: new Date("2026-08-20T14:00:00Z"),
          end: new Date("2026-08-20T15:00:00Z"),
          datetype: "date-time",
        },
      };

      fromURLMock.mockResolvedValueOnce(mockCalendarResponse);

      const url = "https://example.com/unique-cached-calendar.ics";
      const events1 = await fetchIcsEvents(url, "2026-08-01", "2026-08-31");
      const events2 = await fetchIcsEvents(url, "2026-08-01", "2026-08-31");

      expect(events1).toHaveLength(1);
      expect(events2).toHaveLength(1);
      expect(fromURLMock).toHaveBeenCalledTimes(1);
    });
  });
});
