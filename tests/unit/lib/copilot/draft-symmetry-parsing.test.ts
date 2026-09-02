import { describe, it, expect } from "vitest";

describe("Draft Symmetry and Normalization Logic", () => {
  describe("Verification Target Case Extraction", () => {
    function extractTargetCase(draft: Record<string, unknown>, currentCaseId?: number | string | null): Record<string, unknown> {
      if (draft.selectedCase && typeof draft.selectedCase === "object" && !Array.isArray(draft.selectedCase)) {
        return draft.selectedCase as Record<string, unknown>;
      }
      if (draft.case && typeof draft.case === "object" && !Array.isArray(draft.case)) {
        return draft.case as Record<string, unknown>;
      }
      const searchInCases = (casesList: unknown[]): Record<string, unknown> | null => {
        if (!Array.isArray(casesList) || casesList.length === 0) return null;
        if (currentCaseId != null) {
          const match = casesList.find((c) => (c as Record<string, unknown>)?.id == currentCaseId);
          if (match && typeof match === "object") return match as Record<string, unknown>;
        }
        const first = casesList[0];
        if (first && typeof first === "object") return first as Record<string, unknown>;
        return null;
      };
      if (Array.isArray(draft.cases)) {
        const found = searchInCases(draft.cases);
        if (found) return found;
      }
      if (Array.isArray(draft.suites)) {
        for (const s of draft.suites) {
          if (s && typeof s === "object" && Array.isArray((s as Record<string, unknown>).cases)) {
            const found = searchInCases((s as Record<string, unknown>).cases as unknown[]);
            if (found) return found;
          }
        }
      }
      if (draft.suite && typeof draft.suite === "object" && !Array.isArray(draft.suite)) {
        const s = draft.suite as Record<string, unknown>;
        if (Array.isArray(s.cases)) {
          const found = searchInCases(s.cases);
          if (found) return found;
        }
      }
      return draft;
    }

    it("extracts from symmetric selectedCase root key", () => {
      const draft = {
        _schema: { version: "1.0", resourceType: "verification" },
        suite: { id: "suite-1", name: "MCP Tests" },
        selectedCase: {
          id: 42,
          name: "Search test",
          args: { query: "weather" },
          assertions: [{ type: "jsonpath", path: "$.status", expected: 200 }],
        },
      };

      const extracted = extractTargetCase(draft, 42);
      expect(extracted.id).toBe(42);
      expect(extracted.name).toBe("Search test");
      expect(extracted.args).toEqual({ query: "weather" });
    });

    it("falls back to nested suites.cases by matching currentCaseId", () => {
      const draft = {
        suites: [
          {
            cases: [
              { id: 10, name: "Case 10" },
              { id: 20, name: "Case 20 Target" },
            ],
          },
        ],
      };

      const extracted = extractTargetCase(draft, 20);
      expect(extracted.id).toBe(20);
      expect(extracted.name).toBe("Case 20 Target");
    });
  });

  describe("Schedule Draft Normalization", () => {
    function normalizeScheduleDraft(draft: Partial<Record<string, unknown>>) {
      const next: Record<string, unknown> = {};
      if (typeof draft.name === "string") next.name = draft.name;
      if (typeof draft.task === "string") next.task = draft.task;
      if (typeof draft.agentKey === "string") next.agentKey = draft.agentKey;
      if (typeof draft.timezone === "string") next.timezone = draft.timezone;
      if (draft.triggerMode === "one_shot" || draft.triggerMode === "recurring") {
        next.triggerMode = draft.triggerMode;
      }
      if (draft.intervalValue !== undefined && draft.intervalValue !== null) {
        next.intervalValue = String(draft.intervalValue);
      }
      if (
        typeof draft.intervalUnit === "string" &&
        ["minute", "hour", "day", "week", "month"].includes(draft.intervalUnit)
      ) {
        next.intervalUnit = draft.intervalUnit;
      }
      return next;
    }

    it("converts numeric intervalValue to string and preserves triggerMode", () => {
      const result = normalizeScheduleDraft({
        intervalValue: 12,
        triggerMode: "recurring",
        intervalUnit: "hour",
        task: "Generate digest",
      });

      expect(result.intervalValue).toBe("12");
      expect(result.triggerMode).toBe("recurring");
      expect(result.intervalUnit).toBe("hour");
      expect(result.task).toBe("Generate digest");
    });
  });

  describe("MCP Test Draft Normalization", () => {
    function extractMcpArgs(draft: Record<string, unknown>): Record<string, unknown> | null {
      if (draft.selectedTool && typeof draft.selectedTool === "object" && !Array.isArray(draft.selectedTool)) {
        const st = draft.selectedTool as Record<string, unknown>;
        if (st.args && typeof st.args === "object" && !Array.isArray(st.args)) {
          return st.args as Record<string, unknown>;
        }
      }
      if (draft.args && typeof draft.args === "object" && !Array.isArray(draft.args)) {
        return draft.args as Record<string, unknown>;
      }
      if (typeof draft.jsonInput === "string") {
        try {
          const parsed = JSON.parse(draft.jsonInput);
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            return parsed as Record<string, unknown>;
          }
        } catch {
          return null;
        }
      }
      return null;
    }

    it("extracts structured args from selectedTool.args", () => {
      const draft = {
        selectedTool: {
          name: "fetch_news",
          args: { topic: "AI", limit: 5 },
        },
      };

      const args = extractMcpArgs(draft);
      expect(args).toEqual({ topic: "AI", limit: 5 });
    });

    it("extracts and parses jsonInput string fallback", () => {
      const draft = {
        jsonInput: JSON.stringify({ url: "https://example.com", timeout: 5000 }),
      };

      const args = extractMcpArgs(draft);
      expect(args).toEqual({ url: "https://example.com", timeout: 5000 });
    });
  });

  describe("Skills Builtin Write Barrier", () => {
    function canApplySkillDraft(isReadOnly: boolean, source: string): boolean {
      if (isReadOnly || source === "builtin") {
        return false;
      }
      return true;
    }

    it("blocks modifications to builtin immutable skills", () => {
      expect(canApplySkillDraft(true, "builtin")).toBe(false);
      expect(canApplySkillDraft(false, "builtin")).toBe(false);
    });

    it("permits modifications to local custom skills", () => {
      expect(canApplySkillDraft(false, "local")).toBe(true);
    });
  });
});
