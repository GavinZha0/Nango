import { describe, expect, it } from "vitest";

import {
  appendTaskPollRecord,
  buildFailedTaskViewFromPollError,
  DEFAULT_TASK_POLL_HISTORY_LIMIT,
  getTotalPollCount,
  isTerminalTaskStatus,
  MAX_CONSECUTIVE_POLL_FAILURES,
  normalizePollHistoryLimit,
  shouldStopPollingOnFailure,
  type TaskPollRecord,
  type TaskStatus,
  type TaskView,
} from "@/lib/mcp/task-poll-utils";

function makeTaskView(overrides: Partial<TaskView> = {}): TaskView {
  return {
    taskId: "task-1",
    status: "working",
    statusMessage: "Running...",
    retentionMs: null,
    ttl: null,
    raw: { taskId: "task-1", status: overrides.status ?? "working" },
    extensions: {},
    ...overrides,
  };
}

describe("task-poll-utils", () => {
  describe("isTerminalTaskStatus", () => {
    it.each<[TaskStatus, boolean]>([
      ["working", false],
      ["input_required", false],
      ["completed", true],
      ["failed", true],
      ["cancelled", true],
    ])("returns %s for status %s", (status, expected) => {
      expect(isTerminalTaskStatus(status)).toBe(expected);
    });
  });

  describe("normalizePollHistoryLimit", () => {
    it("defaults to 5 and clamps invalid or non-positive values", () => {
      expect(DEFAULT_TASK_POLL_HISTORY_LIMIT).toBe(5);
      expect(normalizePollHistoryLimit(undefined)).toBe(5);
      expect(normalizePollHistoryLimit(0)).toBe(5);
      expect(normalizePollHistoryLimit(-3)).toBe(5);
      expect(normalizePollHistoryLimit("nan")).toBe(5);
      expect(normalizePollHistoryLimit(7.9)).toBe(7);
      expect(normalizePollHistoryLimit("10")).toBe(10);
    });
  });

  describe("appendTaskPollRecord & getTotalPollCount", () => {
    it("retains only the last N snapshots while keeping monotonic seq and unbounded total poll count", () => {
      const limit = 5;
      let history: TaskPollRecord[] = [];

      for (let i = 1; i <= 12; i++) {
        history = appendTaskPollRecord(
          history,
          makeTaskView({ statusMessage: `step ${i}` }),
          limit,
          `2026-11-07T00:00:${String(i).padStart(2, "0")}Z`,
        );
      }

      // Display/retention is capped at N = 5
      expect(history).toHaveLength(5);
      expect(history.map((r) => r.seq)).toEqual([8, 9, 10, 11, 12]);
      expect(history.map((r) => r.statusMessage)).toEqual([
        "step 8",
        "step 9",
        "step 10",
        "step 11",
        "step 12",
      ]);

      // Total poll count next to taskId is unaffected by N
      expect(getTotalPollCount(history)).toBe(12);
    });

    it("returns 1 for an empty or uninitialized history", () => {
      expect(getTotalPollCount(undefined)).toBe(1);
      expect(getTotalPollCount([])).toBe(1);
    });

    it("does not append duplicate terminal snapshots once terminal", () => {
      let history: TaskPollRecord[] = [];
      history = appendTaskPollRecord(history, makeTaskView({ status: "working" }), 5);
      history = appendTaskPollRecord(history, makeTaskView({ status: "completed", statusMessage: "Done" }), 5);
      // Subsequent poll after terminal state must be ignored
      const afterDuplicate = appendTaskPollRecord(
        history,
        makeTaskView({ status: "completed", statusMessage: "Done again" }),
        5,
      );

      expect(afterDuplicate).toHaveLength(2);
      expect(getTotalPollCount(afterDuplicate)).toBe(2);
      expect(afterDuplicate[1].statusMessage).toBe("Done");
    });
  });

  describe("shouldStopPollingOnFailure", () => {
    it.each([400, 401, 403, 404, 410])(
      "stops immediately on first unrecoverable HTTP %i error",
      (status) => {
        expect(shouldStopPollingOnFailure(status, 1)).toBe(true);
      },
    );

    it("retries transient 502/503/network errors until reaching MAX_CONSECUTIVE_POLL_FAILURES", () => {
      expect(MAX_CONSECUTIVE_POLL_FAILURES).toBe(3);
      expect(shouldStopPollingOnFailure(502, 1)).toBe(false);
      expect(shouldStopPollingOnFailure(502, 2)).toBe(false);
      expect(shouldStopPollingOnFailure(502, 3)).toBe(true);

      expect(shouldStopPollingOnFailure(null, 1)).toBe(false);
      expect(shouldStopPollingOnFailure(null, 2)).toBe(false);
      expect(shouldStopPollingOnFailure(null, 3)).toBe(true);
    });
  });

  describe("buildFailedTaskViewFromPollError", () => {
    it("constructs a terminal failed TaskView preserving prior metadata and embedding error details", () => {
      const prev = makeTaskView({
        taskId: "t-42",
        createdAt: "2026-11-07T10:00:00Z",
        retentionMs: 60_000,
        suggestedPollIntervalMs: 2000,
      });

      const failed = buildFailedTaskViewFromPollError(
        prev,
        "t-42",
        "Task expired upstream",
        "2026-11-07T10:01:00Z",
      );

      expect(failed.status).toBe("failed");
      expect(failed.statusMessage).toBe("Task expired upstream");
      expect(failed.createdAt).toBe("2026-11-07T10:00:00Z");
      expect(failed.lastUpdatedAt).toBe("2026-11-07T10:01:00Z");
      expect(failed.retentionMs).toBe(60_000);
      expect(failed.raw).toEqual(
        expect.objectContaining({
          taskId: "t-42",
          status: "failed",
          error: { message: "Task expired upstream" },
        }),
      );
    });
  });
});
