import { describe, expect, it } from "vitest";
import {
  isWebAutoEnvelope,
  applyWebAutoFrame,
  IDLE_WEB_AUTO_RUN_STATE,
  type WebAutoRunLiveState,
} from "@/hooks/useWebAutoRunStream";

describe("useWebAutoRunStream helpers", () => {
  describe("isWebAutoEnvelope", () => {
    it("recognizes web_auto envelopes", () => {
      expect(
        isWebAutoEnvelope({
          kind: "web_auto",
          ownerId: "user-1",
          frame: { topic: "web_auto_run", kind: "run_started", runId: "r-1" },
        })
      ).toBe(true);
    });

    it("rejects non-web_auto envelopes", () => {
      expect(isWebAutoEnvelope(null)).toBe(false);
      expect(isWebAutoEnvelope({})).toBe(false);
      expect(isWebAutoEnvelope({ kind: "verification" })).toBe(false);
    });
  });

  describe("applyWebAutoFrame", () => {
    it("handles run_started frame", () => {
      const state = applyWebAutoFrame(IDLE_WEB_AUTO_RUN_STATE, {
        topic: "web_auto_run",
        kind: "run_started",
        runId: "run-1",
      });

      expect(state.runId).toBe("run-1");
      expect(state.phase).toBe("running");
      expect(state.caseResults.size).toBe(0);
    });

    it("handles case_finished frame and accumulates results", () => {
      const base: WebAutoRunLiveState = {
        runId: "run-1",
        phase: "running",
        caseResults: new Map(),
      };

      const next = applyWebAutoFrame(base, {
        topic: "web_auto_run",
        kind: "case_finished",
        runId: "run-1",
        caseId: "case-uuid-1",
        status: "passed",
        durationMs: 1500,
      });

      expect(next.caseResults.size).toBe(1);
      expect(next.caseResults.get("case-uuid-1")).toEqual({
        caseId: "case-uuid-1",
        status: "passed",
        durationMs: 1500,
        error: undefined,
      });
    });

    it("handles run_finished frame with summary counts", () => {
      const base: WebAutoRunLiveState = {
        runId: "run-1",
        phase: "running",
        caseResults: new Map(),
      };

      const next = applyWebAutoFrame(base, {
        topic: "web_auto_run",
        kind: "run_finished",
        runId: "run-1",
        suiteId: "suite-1",
        status: "passed",
        totalCount: 3,
        passedCount: 3,
        failedCount: 0,
        erroredCount: 0,
      });

      expect(next.phase).toBe("passed");
      expect(next.totals).toEqual({
        totalCount: 3,
        passedCount: 3,
        failedCount: 0,
        erroredCount: 0,
      });
    });
  });
});