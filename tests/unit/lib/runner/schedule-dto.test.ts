import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db/schema", () => ({}));

// Mock the scheduler's nextFireAt — schedule-dto.ts imports it
vi.mock("@/lib/runner/scheduler", () => ({
  nextFireAt: (row: { enabled: boolean }) =>
    row.enabled ? new Date("2025-12-25T00:00:00Z") : null,
}));

import { toScheduleResponse } from "@/lib/runner/schedule-dto";

const baseRow = {
  id: "sched-1",
  name: "Daily report",
  entityId: "agent-1",
  entityKind: "agent",
  entitySource: "builtin",
  credentialId: "cred-1",
  sourceLabel: "Nango",
  task: "Generate report",
  startAt: new Date("2025-01-01T08:00:00Z"),
  endAt: null as Date | null,
  intervalValue: 1 as number | null,
  intervalUnit: "day" as string | null,
  timezone: "UTC",
  enabled: true,
  lastTriggeredAt: null as Date | null,
  lastError: null as string | null,
  ownerId: "user-1",
  createdBy: "user-1",
  createdAt: new Date("2025-01-01T00:00:00Z"),
  updatedAt: new Date("2025-01-01T00:00:00Z"),
};

describe("toScheduleResponse", () => {
  it("converts Date fields to ISO strings", () => {
    const resp = toScheduleResponse(baseRow);
    expect(resp.startAt).toBe("2025-01-01T08:00:00.000Z");
    expect(resp.createdAt).toBe("2025-01-01T00:00:00.000Z");
    expect(resp.updatedAt).toBe("2025-01-01T00:00:00.000Z");
  });

  it("sets nextRunAt when enabled", () => {
    const resp = toScheduleResponse(baseRow);
    expect(resp.nextRunAt).toBe("2025-12-25T00:00:00.000Z");
  });

  it("sets nextRunAt to null when disabled", () => {
    const resp = toScheduleResponse({ ...baseRow, enabled: false });
    expect(resp.nextRunAt).toBeNull();
  });

  it("handles null endAt and lastTriggeredAt", () => {
    const resp = toScheduleResponse(baseRow);
    expect(resp.endAt).toBeNull();
    expect(resp.lastTriggeredAt).toBeNull();
  });

  it("converts non-null endAt to ISO string", () => {
    const resp = toScheduleResponse({
      ...baseRow,
      endAt: new Date("2025-12-31T23:59:59Z"),
    });
    expect(resp.endAt).toBe("2025-12-31T23:59:59.000Z");
  });

  it("does NOT expose lastRunId on the wire", () => {
    // lastRunId was removed when entity_run.schedule_id replaced it.
    // Guard against accidental re-introduction.
    const resp = toScheduleResponse(baseRow);
    expect(resp).not.toHaveProperty("lastRunId");
  });
});
