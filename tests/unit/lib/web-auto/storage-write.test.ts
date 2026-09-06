import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

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
