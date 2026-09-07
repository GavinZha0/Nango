import { describe, it, expect, vi, beforeEach } from "vitest";

const { getSessionMock } = vi.hoisted(() => ({
  getSessionMock: vi.fn(),
}));

vi.mock("@/lib/auth/auth-instance", () => ({
  getSession: getSessionMock,
}));

vi.mock("@/lib/db", async () => {
  const { createDrizzleMock } = await import("tests/unit/helpers");
  return { db: createDrizzleMock() };
});

import { PATCH, DELETE } from "@/app/api/web-auto-cases/[id]/route";
import { db } from "@/lib/db";
import { createMockRequest, type MockDrizzleDb } from "tests/unit/helpers";
import { ADMIN_USER, EDITOR_USER, createMockSession } from "tests/unit/fixtures";

const dbMock = db as unknown as MockDrizzleDb;

const CASE_ID = 42;
const SUITE_A = "a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d";
const SUITE_B = "b2c3d4e5-f6a7-4b9c-8d1e-2f3a4b5c6d7e";
const SERVER_1 = "11111111-1111-4111-8111-111111111111";
const SERVER_2 = "22222222-2222-4222-8222-222222222222";

const me = { ...EDITOR_USER, id: "user-me-1" };

// A collaborator-owned public suite: editors may edit content and move
// cases within it, but the delete gate below still applies per-case.
const existingInForeignPublicSuite = {
  suiteId: SUITE_A,
  suiteVisibility: "public",
  suiteCreatedBy: "user-other-1",
  suiteMcpServerId: SERVER_1,
};

function mockExisting(row: Record<string, unknown>): void {
  dbMock._chain.where.mockResolvedValueOnce([row]);
}

function mockTarget(row: Record<string, unknown> | null): void {
  dbMock._chain.limit.mockResolvedValueOnce(row ? [row] : []);
}

function mockUpdate(): void {
  dbMock._chain.returning.mockResolvedValueOnce([{ id: CASE_ID }]);
}

function mockDelete(): void {
  dbMock._chain.returning.mockResolvedValueOnce([{ id: CASE_ID }]);
}

function patchRequest(body: Record<string, unknown>) {
  return createMockRequest(`/api/web-auto-cases/${CASE_ID}`, {
    method: "PATCH",
    body,
  });
}

function deleteRequest() {
  return createMockRequest(`/api/web-auto-cases/${CASE_ID}`, {
    method: "DELETE",
  });
}

describe("PATCH /api/web-auto-cases/[id] — suiteId move validation (F7-2)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMock.$reset();
    getSessionMock.mockResolvedValue(createMockSession(me));
  });

  it("1. moving into a foreign private suite is forbidden (403)", async () => {
    mockExisting(existingInForeignPublicSuite);
    mockTarget({ visibility: "private", createdBy: "user-other-2", mcpServerId: SERVER_1 });

    const res = await PATCH(patchRequest({ suiteId: SUITE_B }), {
      params: Promise.resolve({ id: String(CASE_ID) }),
    });
    expect(res.status).toBe(403);
    expect(db.update).not.toHaveBeenCalled();
  });

  it("2. missing target suite is rejected with 400", async () => {
    mockExisting(existingInForeignPublicSuite);
    mockTarget(null);

    const res = await PATCH(patchRequest({ suiteId: SUITE_B }), {
      params: Promise.resolve({ id: String(CASE_ID) }),
    });
    expect(res.status).toBe(400);
    expect(db.update).not.toHaveBeenCalled();
  });

  it("3. cross-Playwright-server moves are blocked with 400", async () => {
    mockExisting(existingInForeignPublicSuite);
    mockTarget({ visibility: "public", createdBy: "user-other-1", mcpServerId: SERVER_2 });

    const res = await PATCH(patchRequest({ suiteId: SUITE_B }), {
      params: Promise.resolve({ id: String(CASE_ID) }),
    });
    expect(res.status).toBe(400);
    expect(db.update).not.toHaveBeenCalled();
  });

  it("4. normal move within the same Playwright server succeeds (200)", async () => {
    mockExisting(existingInForeignPublicSuite);
    mockTarget({ visibility: "public", createdBy: "user-other-1", mcpServerId: SERVER_1 });
    mockUpdate();

    const res = await PATCH(patchRequest({ suiteId: SUITE_B }), {
      params: Promise.resolve({ id: String(CASE_ID) }),
    });
    expect(res.status).toBe(200);
    expect(db.update).toHaveBeenCalledTimes(1);
  });

  it("5. non-move patches stay ungated by target validation", async () => {
    mockExisting(existingInForeignPublicSuite);
    mockUpdate();

    const res = await PATCH(patchRequest({ name: "Renamed" }), {
      params: Promise.resolve({ id: String(CASE_ID) }),
    });
    expect(res.status).toBe(200);
    expect(db.update).toHaveBeenCalledTimes(1);
  });
});

describe("DELETE /api/web-auto-cases/[id] — unified delete rule (F7-3)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getSessionMock.mockResolvedValue(createMockSession(me));
  });

  it.each([
    {
      scenario: "case author can delete their own case in someone else's public suite",
      caller: me,
      caseAuthor: me.id,
      suiteVisibility: "public",
      expectedStatus: 200,
    },
    {
      scenario: "suite author can delete a foreign case in their own suite",
      caller: { id: "user-other-1", email: "o@example.com", name: "Other", role: "editor" as const },
      caseAuthor: me.id,
      suiteVisibility: "public",
      expectedStatus: 200,
    },
    {
      scenario: "an unrelated editor is forbidden (403)",
      caller: me,
      caseAuthor: "user-other-2",
      suiteVisibility: "public",
      expectedStatus: 403,
    },
    {
      scenario: "private foreign suites are opaque 404 regardless of authorship",
      caller: me,
      caseAuthor: me.id,
      suiteVisibility: "private",
      expectedStatus: 404,
    },
    {
      scenario: "admin can delete any visible case",
      caller: ADMIN_USER,
      caseAuthor: "user-other-2",
      suiteVisibility: "public",
      expectedStatus: 200,
    },
  ])("$scenario", async ({ caller, caseAuthor, suiteVisibility, expectedStatus }) => {
    getSessionMock.mockResolvedValue(createMockSession(caller));
    mockExisting({
      suiteId: SUITE_A,
      suiteVisibility,
      suiteCreatedBy: "user-other-1",
      suiteMcpServerId: SERVER_1,
      caseCreatedBy: caseAuthor,
    });
    if (expectedStatus === 200) {
      mockDelete();
    }

    const res = await DELETE(deleteRequest(), {
      params: Promise.resolve({ id: String(CASE_ID) }),
    });
    expect(res.status).toBe(expectedStatus);
    if (expectedStatus === 200) {
      expect(db.delete).toHaveBeenCalledTimes(1);
    } else {
      expect(db.delete).not.toHaveBeenCalled();
    }
  });
});
