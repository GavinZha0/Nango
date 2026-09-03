import { describe, it, expect, vi, beforeEach } from "vitest";
import { invalidateTestModuleCache } from "@/lib/testing/cache-invalidation.client";
import { mutate } from "swr";
import { caseActions } from "@/store/verification-cases";
import { evalCaseActions } from "@/store/evaluation-cases";

vi.mock("swr", () => ({
  mutate: vi.fn(),
}));

vi.mock("@/store/verification-cases", () => ({
  caseActions: {
    refresh: vi.fn(),
  },
}));

vi.mock("@/store/evaluation-cases", () => ({
  evalCaseActions: {
    refresh: vi.fn(),
  },
}));

describe("invalidateTestModuleCache", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("verification", () => {
    it("invalidates suite list and servers when no suiteId is provided", () => {
      invalidateTestModuleCache({ category: "verification" });

      expect(mutate).toHaveBeenCalledWith("/api/verification-suites");
      expect(mutate).toHaveBeenCalledWith("/api/verification-servers");
      expect(caseActions.refresh).not.toHaveBeenCalled();
    });

    it("invalidates specific suite and refreshes verification cases store when suiteId is provided", () => {
      invalidateTestModuleCache({ category: "verification", suiteId: "suite-123" });

      expect(mutate).toHaveBeenCalledWith("/api/verification-suites");
      expect(mutate).toHaveBeenCalledWith("/api/verification-servers");
      expect(mutate).toHaveBeenCalledWith("/api/verification-suites/suite-123");
      expect(caseActions.refresh).toHaveBeenCalledWith("suite-123");
    });
  });

  describe("evaluation", () => {
    it("invalidates eval suite list and agent tree when no suiteId is provided", () => {
      invalidateTestModuleCache({ category: "evaluation" });

      expect(mutate).toHaveBeenCalledWith("/api/eval-suites");
      expect(mutate).toHaveBeenCalledWith("/api/eval-suites/agents");
      expect(evalCaseActions.refresh).not.toHaveBeenCalled();
    });

    it("invalidates specific suite and refreshes evaluation cases store when suiteId is provided", () => {
      invalidateTestModuleCache({ category: "evaluation", suiteId: "eval-suite-456" });

      expect(mutate).toHaveBeenCalledWith("/api/eval-suites");
      expect(mutate).toHaveBeenCalledWith("/api/eval-suites/agents");
      expect(mutate).toHaveBeenCalledWith("/api/eval-suites/eval-suite-456");
      expect(evalCaseActions.refresh).toHaveBeenCalledWith("eval-suite-456");
    });
  });

  describe("web-auto", () => {
    it("invalidates web-auto suite list when no suiteId is provided", () => {
      invalidateTestModuleCache({ category: "web-auto" });

      expect(mutate).toHaveBeenCalledWith("/api/web-auto-suites");
    });

    it("invalidates specific suite and cases list SWR key when suiteId is provided", () => {
      invalidateTestModuleCache({ category: "web-auto", suiteId: "web-auto-789" });

      expect(mutate).toHaveBeenCalledWith("/api/web-auto-suites");
      expect(mutate).toHaveBeenCalledWith("/api/web-auto-suites/web-auto-789");
      expect(mutate).toHaveBeenCalledWith("/api/web-auto-suites/web-auto-789/cases");
    });
  });
});
