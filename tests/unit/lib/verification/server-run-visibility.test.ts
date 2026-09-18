import { describe, it, expect, vi, beforeEach } from "vitest";

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
  listEnabledSuitesByGroup,
  listGroupsWithActiveSuites,
  listResultsByRun,
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

function mockWhereOrderByChain(rows: unknown[] = []): void {
  const orderBy = vi.fn().mockResolvedValue(rows);
  const where = vi.fn().mockReturnValue({ orderBy });
  mockFrom.mockReturnValue({ where });
}

function mockJoinGroupByChain(rows: unknown[] = []): void {
  const orderBy = vi.fn().mockResolvedValue(rows);
  const groupBy = vi.fn().mockReturnValue({ orderBy });
  const where = vi.fn().mockReturnValue({ groupBy });
  const innerJoin = vi.fn().mockReturnValue({ where });
  mockFrom.mockReturnValue({ innerJoin });
}

describe("group-run visibility scoping (F6)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("listEnabledSuitesByGroup", () => {
    it("1. non-admin viewer applies the viewer visibility predicate", async () => {
      mockWhereOrderByChain([]);
      await listEnabledSuitesByGroup("group-1", editorViewer);

      expect(visibilitySqlSpy).toHaveBeenCalledTimes(1);
      const [, visibilityCol, createdByCol] = visibilitySqlSpy.mock.calls[0];
      expect(visibilityCol).toBeDefined();
      expect(createdByCol).toBeDefined();
    });

    it("2. admin viewer does not apply visibility predicate (sees all suites in group)", async () => {
      mockWhereOrderByChain([]);
      await listEnabledSuitesByGroup("group-1", adminViewer);

      expect(visibilitySqlSpy).not.toHaveBeenCalled();
    });
  });

  describe("listGroupsWithActiveSuites", () => {
    it("3. non-admin viewer applies visibility predicate over joined suites", async () => {
      mockJoinGroupByChain([]);
      await listGroupsWithActiveSuites(editorViewer);

      expect(visibilitySqlSpy).toHaveBeenCalledTimes(1);
    });

    it("4. admin viewer does not apply visibility predicate over joined suites", async () => {
      mockJoinGroupByChain([]);
      await listGroupsWithActiveSuites(adminViewer);

      expect(visibilitySqlSpy).not.toHaveBeenCalled();
    });
  });

  describe("listResultsByRun (unfiltered)", () => {
    it("5. suite-scoped reads stay unfiltered — no viewer predicate", async () => {
      mockWhereOrderByChain([{ id: "result-1" }]);
      const rows = await listResultsByRun("run-1");

      expect(visibilitySqlSpy).not.toHaveBeenCalled();
      expect(rows).toEqual([{ id: "result-1" }]);
    });
  });
});
