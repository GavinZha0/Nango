import { describe, it, expect, vi, beforeEach } from "vitest";

const { getSessionMock, inArrayMock } = vi.hoisted(() => ({
  getSessionMock: vi.fn(),
  inArrayMock: vi.fn(),
}));

vi.mock("@/lib/auth/auth-instance", () => ({
  getSession: getSessionMock,
}));

vi.mock("@/lib/db", async () => {
  const { createDrizzleMock } = await import("tests/unit/helpers");
  return { db: createDrizzleMock() };
});

vi.mock("drizzle-orm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("drizzle-orm")>();
  return {
    ...actual,
    inArray: inArrayMock.mockImplementation(actual.inArray),
  };
});

import { DELETE } from "@/app/api/verification-servers/[id]/route";
import { db } from "@/lib/db";
import { createMockRequest, type MockDrizzleDb } from "tests/unit/helpers";
import { ADMIN_USER, REGULAR_USER, createMockUser, createMockSession } from "tests/unit/fixtures";

const dbMock = db as unknown as MockDrizzleDb;

const SERVER_ID = "11111111-1111-4111-8111-111111111111";

const ownerUser = createMockUser({ id: "user-owner-1", email: "owner@example.com", name: "Owner", role: "editor" });
const otherUser = createMockUser({ id: "user-other-1", email: "other@example.com", name: "Other", role: "editor" });
const adminUser = ADMIN_USER;

const ownSuite = {
  id: "suite-own-1",
  createdBy: ownerUser.id,
  visibility: "private",
};

const foreignSuiteA = {
  id: "suite-foreign-a",
  createdBy: otherUser.id,
  visibility: "private",
};

const foreignSuiteB = {
  id: "suite-foreign-b",
  createdBy: otherUser.id,
  visibility: "public",
};

function mockSuites(suites: Array<typeof ownSuite>): void {
  dbMock._chain.where.mockResolvedValueOnce(suites);
}

function makeRequest() {
  return createMockRequest(`/api/verification-servers/${SERVER_ID}`, {
    method: "DELETE",
  });
}

describe("DELETE /api/verification-servers/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMock.$reset();
  });

  it("1. admin deletes all suites under the server (cascade is legal)", async () => {
    getSessionMock.mockResolvedValue(createMockSession(adminUser));
    mockSuites([ownSuite, foreignSuiteA, foreignSuiteB]);

    const res = await DELETE(makeRequest(), {
      params: Promise.resolve({ id: SERVER_ID }),
    });
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data).toEqual({ deleted: 3, skipped: 0 });
    expect(db.delete).toHaveBeenCalledTimes(1);
    expect(inArrayMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.arrayContaining([ownSuite.id, foreignSuiteA.id, foreignSuiteB.id]),
    );
  });

  it("2. editor deletes only own suites and reports skipped foreign suites", async () => {
    getSessionMock.mockResolvedValue(createMockSession(ownerUser));
    mockSuites([ownSuite, foreignSuiteA, foreignSuiteB]);

    const res = await DELETE(makeRequest(), {
      params: Promise.resolve({ id: SERVER_ID }),
    });
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data).toEqual({ deleted: 1, skipped: 2 });
    expect(inArrayMock).toHaveBeenCalledWith(
      expect.anything(),
      [ownSuite.id],
    );
  });

  it("3. editor owning no suites performs no deletion at all", async () => {
    getSessionMock.mockResolvedValue(createMockSession(otherUser));
    mockSuites([ownSuite]);

    const res = await DELETE(makeRequest(), {
      params: Promise.resolve({ id: SERVER_ID }),
    });
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data).toEqual({ deleted: 0, skipped: 1 });
    expect(db.delete).not.toHaveBeenCalled();
    expect(inArrayMock).not.toHaveBeenCalled();
  });

  it("4. rejects unauthenticated requests (401 Unauthorized)", async () => {
    getSessionMock.mockResolvedValue(null);

    const res = await DELETE(makeRequest(), {
      params: Promise.resolve({ id: SERVER_ID }),
    });
    expect(res.status).toBe(401);
    expect(db.delete).not.toHaveBeenCalled();
  });

  it("5. rejects non-editor roles (403 Forbidden)", async () => {
    getSessionMock.mockResolvedValue(createMockSession(REGULAR_USER));

    const res = await DELETE(makeRequest(), {
      params: Promise.resolve({ id: SERVER_ID }),
    });
    expect(res.status).toBe(403);
    expect(db.delete).not.toHaveBeenCalled();
  });

  it("6. rejects non-uuid ids (synthetic detached keys) with 404 instead of a Postgres 22P02", async () => {
    getSessionMock.mockResolvedValue(createMockSession(adminUser));

    const res = await DELETE(makeRequest(), {
      params: Promise.resolve({ id: "detached:Hugging Face" }),
    });
    expect(res.status).toBe(404);
    expect(db.select).not.toHaveBeenCalled();
    expect(db.delete).not.toHaveBeenCalled();
  });
});
