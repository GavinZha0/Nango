import { describe, it, expect } from "vitest";
import type { SessionDescriptor } from "@/lib/backends/types";
import {
  classifyHistorySession,
  groupHistorySessions,
  pickThreadTitle,
  resolveThreadDisplayTitle,
} from "@/lib/threads/helpers";

describe("thread helpers", () => {
  describe("pickThreadTitle & resolveThreadDisplayTitle", () => {
    it("returns short trimmed prompts verbatim", () => {
      expect(pickThreadTitle("  Plan Q4 roadmap  ")).toBe("Plan Q4 roadmap");
      expect(pickThreadTitle(null)).toBe("");
    });

    it("clips long prompts on a word boundary when possible", () => {
      const prompt =
        "Investigate why the nightly billing sync job timed out on cluster alpha after the schema rollout yesterday";
      const clipped = pickThreadTitle(prompt);
      expect(clipped.endsWith("…")).toBe(true);
      expect(clipped.length).toBeLessThanOrEqual(81);
      expect(clipped).not.toContain("rollou…");
    });

    it("prefers custom_title over derived prompt and falls back cleanly", () => {
      expect(resolveThreadDisplayTitle("My Custom Name", "Original prompt")).toBe(
        "My Custom Name",
      );
      expect(resolveThreadDisplayTitle("   ", "Original prompt")).toBe(
        "Original prompt",
      );
      expect(resolveThreadDisplayTitle(null, null)).toBe("Untitled conversation");
    });
  });

  describe("classifyHistorySession", () => {
    const now = new Date(2026, 10, 30, 15, 30, 0); // 2026-11-30 15:30 local

    it("classifies today, yesterday, last 7 days, last 30 days, and older", () => {
      expect(
        classifyHistorySession(new Date(2026, 10, 30, 0, 5, 0).toISOString(), now),
      ).toBe("today");
      expect(
        classifyHistorySession(new Date(2026, 10, 29, 23, 55, 0).toISOString(), now),
      ).toBe("yesterday");
      // 6 calendar days before today is still within Last 7 days (inclusive of today)
      expect(
        classifyHistorySession(new Date(2026, 10, 24, 0, 0, 0).toISOString(), now),
      ).toBe("last7days");
      // 7 calendar days before today moves to Last 30 days
      expect(
        classifyHistorySession(new Date(2026, 10, 23, 23, 59, 0).toISOString(), now),
      ).toBe("last30days");
      // 29 calendar days before today is still within Last 30 days (inclusive of today)
      expect(
        classifyHistorySession(new Date(2026, 10, 1, 0, 0, 0).toISOString(), now),
      ).toBe("last30days");
      // 30 calendar days before today is outside the 30-day window
      expect(
        classifyHistorySession(new Date(2026, 9, 31, 23, 59, 0).toISOString(), now),
      ).toBeNull();
      expect(classifyHistorySession("not-a-date", now)).toBeNull();
    });
  });

  describe("groupHistorySessions", () => {
    const now = new Date(2026, 10, 30, 15, 0, 0);

    it("keeps old pinned sessions, sorts pinned by pinned_at desc, and buckets unpinned up to 30 days", () => {
      const sessions: SessionDescriptor[] = [
        {
          session_id: "pinned-old",
          session_name: "Ancient Pinned",
          created_at: new Date(2025, 0, 1).toISOString(),
          updated_at: new Date(2025, 0, 1).toISOString(),
          pinned: true,
          pinned_at: new Date(2026, 10, 10).toISOString(),
        },
        {
          session_id: "pinned-newer",
          session_name: "Recently Pinned",
          created_at: new Date(2026, 10, 20).toISOString(),
          updated_at: new Date(2026, 10, 20).toISOString(),
          pinned: true,
          pinned_at: new Date(2026, 10, 29).toISOString(),
        },
        {
          session_id: "today-1",
          session_name: "Today Chat",
          created_at: new Date(2026, 10, 30, 10, 0).toISOString(),
          updated_at: new Date(2026, 10, 30, 10, 0).toISOString(),
          pinned: false,
        },
        {
          session_id: "month-1",
          session_name: "Two Weeks Ago",
          created_at: new Date(2026, 10, 15, 10, 0).toISOString(),
          updated_at: new Date(2026, 10, 15, 10, 0).toISOString(),
          pinned: false,
        },
        {
          session_id: "expired-1",
          session_name: "Over 30 Days",
          created_at: new Date(2026, 9, 1, 10, 0).toISOString(),
          updated_at: new Date(2026, 9, 1, 10, 0).toISOString(),
          pinned: false,
        },
      ];

      const grouped = groupHistorySessions(sessions, now);
      expect(grouped.pinned?.map((s) => s.session_id)).toEqual([
        "pinned-newer",
        "pinned-old",
      ]);
      expect(grouped.today?.map((s) => s.session_id)).toEqual(["today-1"]);
      expect(grouped.last30days?.map((s) => s.session_id)).toEqual(["month-1"]);
      expect(grouped.yesterday).toBeUndefined();
      expect(grouped.last7days).toBeUndefined();
    });
  });
});
