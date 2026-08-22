import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

const mockSelectStrandedWebAutoRuns = vi.fn();
const mockListWrittenCaseIdsForWebAutoRun = vi.fn();
const mockListEnabledWebAutoCasesForRun = vi.fn();
const mockWriteErroredCaseResults = vi.fn().mockResolvedValue(undefined);
const mockMarkStrandedWebAutoRunsAsErrored = vi.fn().mockResolvedValue(undefined);

vi.mock("@/lib/web-auto/storage", () => ({
  selectStrandedWebAutoRuns: (...args: unknown[]) => mockSelectStrandedWebAutoRuns(...args),
  listWrittenCaseIdsForWebAutoRun: (...args: unknown[]) => mockListWrittenCaseIdsForWebAutoRun(...args),
  listEnabledWebAutoCasesForRun: (...args: unknown[]) => mockListEnabledWebAutoCasesForRun(...args),
  writeErroredCaseResults: (...args: unknown[]) => mockWriteErroredCaseResults(...args),
  markStrandedWebAutoRunsAsErrored: (...args: unknown[]) => mockMarkStrandedWebAutoRunsAsErrored(...args),
}));

vi.mock("@/lib/observability/logger", () => ({
  childLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

const { recoverStrandedWebAutoRuns } = await import("@/lib/web-auto/recovery");

beforeEach(() => {
  vi.clearAllMocks();
});

describe("recoverStrandedWebAutoRuns", () => {
  it("is a no-op when no stranded runs exist", async () => {
    mockSelectStrandedWebAutoRuns.mockResolvedValueOnce([]);
    await recoverStrandedWebAutoRuns(new Date());

    expect(mockListWrittenCaseIdsForWebAutoRun).not.toHaveBeenCalled();
    expect(mockMarkStrandedWebAutoRunsAsErrored).not.toHaveBeenCalled();
  });

  it("backfills missing case results and flips stranded runs to errored", async () => {
    mockSelectStrandedWebAutoRuns.mockResolvedValueOnce([
      { id: "run-1", suiteId: "suite-1" },
    ]);
    mockListWrittenCaseIdsForWebAutoRun.mockResolvedValueOnce(["case-1"]);
    mockListEnabledWebAutoCasesForRun.mockResolvedValueOnce([
      { id: "case-1", name: "Case 1" },
      { id: "case-2", name: "Case 2" },
      { id: "case-3", name: "Case 3" },
    ]);

    const bootTime = new Date();
    await recoverStrandedWebAutoRuns(bootTime);

    expect(mockWriteErroredCaseResults).toHaveBeenCalledWith("run-1", ["case-2", "case-3"]);
    expect(mockMarkStrandedWebAutoRunsAsErrored).toHaveBeenCalledWith(bootTime);
  });
});
