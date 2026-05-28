import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

const selectWhere = vi.fn();
const updateWhere = vi.fn().mockResolvedValue(undefined);

vi.mock("@/lib/db", () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn().mockReturnValue({
        where: selectWhere,
      }),
    })),
    update: vi.fn(() => ({
      set: vi.fn().mockReturnValue({
        where: updateWhere,
      }),
    })),
  },
}));

vi.mock("@/lib/db/schema", () => ({
  EntityRunTable: {
    id: "id",
    ownerId: "owner_id",
    entityId: "entity_id",
    inputTask: "input_task",
    status: "status",
    startedAt: "started_at",
  },
}));

vi.mock("@/lib/observability/logger", () => ({
  childLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn() }),
}));

const mockRecordNotification = vi.fn().mockResolvedValue(null);
vi.mock("@/lib/runner/notifications", () => ({
  recordRunNotification: (...args: unknown[]) => mockRecordNotification(...args),
}));

const { recoverStrandedRuns } = await import("@/lib/runner/recovery");

beforeEach(() => {
  vi.clearAllMocks();
});

describe("recoverStrandedRuns", () => {
  it("is a no-op when no stranded runs exist", async () => {
    selectWhere.mockResolvedValueOnce([]);
    await recoverStrandedRuns(new Date());
    expect(mockRecordNotification).not.toHaveBeenCalled();
  });

  it("flips stranded runs to failed and sends notifications", async () => {
    selectWhere.mockResolvedValueOnce([
      { id: "r-1", ownerId: "u-1", entityId: "agent-1", inputTask: "task 1" },
      { id: "r-2", ownerId: "u-2", entityId: "agent-2", inputTask: "task 2" },
    ]);

    await recoverStrandedRuns(new Date());

    // One notification per stranded run
    expect(mockRecordNotification).toHaveBeenCalledTimes(2);
    expect(mockRecordNotification.mock.calls[0][0]).toMatchObject({
      runId: "r-1",
      kind: "run_failed",
    });
    expect(mockRecordNotification.mock.calls[1][0]).toMatchObject({
      runId: "r-2",
      kind: "run_failed",
    });
  });
});
