import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

const { visibilitySqlSpy } = vi.hoisted(() => ({
  visibilitySqlSpy: vi.fn(),
}));

vi.mock("@/lib/auth/permissions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/permissions")>();
  return {
    ...actual,
    visibilitySql: visibilitySqlSpy.mockImplementation(actual.visibilitySql),
  };
});

const mockFrom = vi.fn();
vi.mock("@/lib/db", () => ({
  db: {
    select: vi.fn(() => ({ from: mockFrom })),
  },
}));

import {
  listEnabledCasesForServerRun,
  listResultsByRun,
  listResultsByRunForViewer,
  type VerificationViewer,
} from "@/lib/verification/storage";

const editorViewer: VerificationViewer = {
  userId: "user-me-1",
  isAdmin: false,
  isEditor: true,
};
const adminViewer: VerificationViewer = {
  userId: "user-admin-1",
  isAdmin: true,
  isEditor: true,
};

function mockJoinChain(rows: unknown[] = []): void {
  const orderBy = vi.fn().mockReturnValue(rows);
  const where = vi.fn().mockReturnValue({ orderBy });
  const innerJoin = vi.fn();
  innerJoin.mockImplementation(() => ({ where, innerJoin }));
  mockFrom.mockReturnValue({ innerJoin });
}

function mockPlainChain(rows: unknown[] = []): void {
  const orderBy = vi.fn().mockReturnValue(rows);
  const where = vi.fn().mockReturnValue({ orderBy });
  mockFrom.mockReturnValue({ where });
}

describe("server-run visibility scoping (F6)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("listEnabledCasesForServerRun", () => {
    it("1. user-triggered runs apply the viewer visibility predicate", async () => {
      mockJoinChain([]);
      await listEnabledCasesForServerRun("server-1", editorViewer);

      expect(visibilitySqlSpy).toHaveBeenCalledTimes(1);
      const [, visibilityCol, createdByCol] = visibilitySqlSpy.mock.calls[0];
      expect(visibilityCol).toBeDefined();
      expect(createdByCol).toBeDefined();
    });

    it("2. recovery context (no viewer) sees all cases — no predicate", async () => {
      mockJoinChain([]);
      await listEnabledCasesForServerRun("server-1");

      expect(visibilitySqlSpy).not.toHaveBeenCalled();
    });

    it("3. admin viewer still passes through visibilitySql (which yields true)", async () => {
      mockJoinChain([]);
      await listEnabledCasesForServerRun("server-1", adminViewer);

      expect(visibilitySqlSpy).toHaveBeenCalledWith(
        adminViewer,
        expect.anything(),
        expect.anything(),
      );
    });
  });

  describe("listResultsByRunForViewer", () => {
    it("4. applies the viewer visibility predicate over case→suite join", async () => {
      mockJoinChain([{ id: "result-1" }]);
      const rows = await listResultsByRunForViewer("run-1", editorViewer);

      expect(visibilitySqlSpy).toHaveBeenCalledTimes(1);
      expect(rows).toEqual([{ id: "result-1" }]);
    });

    it("5. selects only the result entity columns (flat shape despite joins)", async () => {
      mockJoinChain([]);
      const { db } = await import("@/lib/db");
      await listResultsByRunForViewer("run-1", editorViewer);

      const projection = vi.mocked(db.select).mock.calls[0][0] as Record<
        string,
        unknown
      >;
      expect(Object.keys(projection)).toEqual(
        expect.arrayContaining(["runId", "caseId", "status", "assertionResults"]),
      );
    });
  });

  describe("listResultsByRun (unfiltered)", () => {
    it("6. suite-scoped reads stay unfiltered — no viewer predicate", async () => {
      mockPlainChain([{ id: "result-1" }]);
      const rows = await listResultsByRun("run-1");

      expect(visibilitySqlSpy).not.toHaveBeenCalled();
      expect(rows).toEqual([{ id: "result-1" }]);
    });
  });
});
