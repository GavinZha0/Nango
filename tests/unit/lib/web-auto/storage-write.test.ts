import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => ({
  db: {
    insert: vi.fn(),
  },
}));

import { writeErroredCaseResults } from "@/lib/web-auto/storage";
import { db } from "@/lib/db";

describe("writeErroredCaseResults — F17 column fix", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("writes the real columns (no legacy verdict key) for stranded cases", async () => {
    const valuesFn = vi.fn().mockReturnValue({
      onConflictDoNothing: vi.fn().mockResolvedValue(undefined),
    });
    vi.mocked(db.insert).mockReturnValue({
      values: valuesFn,
    } as unknown as ReturnType<typeof db.insert>);

    await writeErroredCaseResults("run-1", [101, 102]);

    expect(db.insert).toHaveBeenCalledTimes(1);
    const rows = valuesFn.mock.calls[0][0] as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(2);

    for (const row of rows) {
      expect(row).not.toHaveProperty("verdict");
      expect(row.status).toBe("errored");
      expect(row.assertionResults).toEqual([]);
      expect(row.score).toBeNull();
      expect(row.feedback).toBeNull();
      expect(row.executionOutput).toBeNull();
      expect((row.error as { source: string }).source).toBe("crashed");
    }
    expect(rows.map((r) => r.caseId)).toEqual([101, 102]);
  });

  it("is a no-op when no case ids are given", async () => {
    await writeErroredCaseResults("run-1", []);
    expect(db.insert).not.toHaveBeenCalled();
  });
});

describe("writeWebAutoCaseResult — score normalization and fallback prevention (W8)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("persists score as null for errored status even if verdict.llm has score", async () => {
    const returningFn = vi.fn().mockResolvedValue([{ id: 1 }]);
    const valuesFn = vi.fn().mockReturnValue({ returning: returningFn });
    vi.mocked(db.insert).mockReturnValue({
      values: valuesFn,
    } as unknown as ReturnType<typeof db.insert>);

    const { writeWebAutoCaseResult } = await import("@/lib/web-auto/storage");

    await writeWebAutoCaseResult({
      runId: "11111111-1111-4111-8111-111111111111",
      caseId: 101,
      status: "errored",
      executionOutput: null,
      score: undefined,
      verdict: {
        deterministic: { passed: true, results: [] },
        overall: { passed: false, reason: "Evaluator failed" },
        llm: {
          passed: false,
          score: 0,
          expectationResults: [],
        },
      },
      error: { source: "internal", message: "Judge crashed" },
      startedAt: Date.now(),
      durationMs: 100,
    });

    expect(db.insert).toHaveBeenCalledTimes(1);
    const row = valuesFn.mock.calls[0][0] as Record<string, unknown>;
    expect(row.status).toBe("errored");
    // W8: Must be null, never fallback to verdict.llm.score (0)
    expect(row.score).toBeNull();
  });

  it("persists score as null for deterministic failure without judge evaluation", async () => {
    const returningFn = vi.fn().mockResolvedValue([{ id: 2 }]);
    const valuesFn = vi.fn().mockReturnValue({ returning: returningFn });
    vi.mocked(db.insert).mockReturnValue({
      values: valuesFn,
    } as unknown as ReturnType<typeof db.insert>);

    const { writeWebAutoCaseResult } = await import("@/lib/web-auto/storage");

    await writeWebAutoCaseResult({
      runId: "11111111-1111-4111-8111-111111111111",
      caseId: 102,
      status: "failed",
      executionOutput: null,
      score: undefined,
      error: null,
      startedAt: Date.now(),
      durationMs: 150,
    });

    expect(db.insert).toHaveBeenCalledTimes(1);
    const row = valuesFn.mock.calls[0][0] as Record<string, unknown>;
    expect(row.status).toBe("failed");
    // W8: Pure deterministic failure has no 1-5 score, must be null
    expect(row.score).toBeNull();
  });

  it("persists valid Likert score (1-5) when evaluation succeeded", async () => {
    const returningFn = vi.fn().mockResolvedValue([{ id: 3 }]);
    const valuesFn = vi.fn().mockReturnValue({ returning: returningFn });
    vi.mocked(db.insert).mockReturnValue({
      values: valuesFn,
    } as unknown as ReturnType<typeof db.insert>);

    const { writeWebAutoCaseResult } = await import("@/lib/web-auto/storage");

    await writeWebAutoCaseResult({
      runId: "11111111-1111-4111-8111-111111111111",
      caseId: 103,
      status: "passed",
      executionOutput: null,
      score: 4,
      error: null,
      startedAt: Date.now(),
      durationMs: 300,
    });

    expect(db.insert).toHaveBeenCalledTimes(1);
    const row = valuesFn.mock.calls[0][0] as Record<string, unknown>;
    expect(row.status).toBe("passed");
    expect(row.score).toBe(4);
  });
});
