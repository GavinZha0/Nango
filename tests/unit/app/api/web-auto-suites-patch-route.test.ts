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

import { PATCH } from "@/app/api/web-auto-suites/[id]/route";
import { db } from "@/lib/db";
import { createMockRequest, type MockDrizzleDb } from "tests/unit/helpers";
import { ADMIN_USER, EDITOR_USER, createMockSession } from "tests/unit/fixtures";

const dbMock = db as unknown as MockDrizzleDb;

const SUITE_ID = "a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d";

const me = { ...EDITOR_USER, id: "user-me-1" };

// A collaborator-visible suite: editors can edit its content but may not
// flip visibility/enabled — that gate belongs to the author or an admin.
const foreignPublicSuite = { visibility: "public", createdBy: "user-other-1" };
const ownSuite = { visibility: "private", createdBy: me.id };

function mockDbSuite(suite: { visibility: string; createdBy: string }): void {
  dbMock._chain.where.mockResolvedValueOnce([suite]);
  dbMock._chain.returning.mockResolvedValueOnce([{ id: SUITE_ID, ...suite }]);
}

function makeRequest(body: Record<string, unknown>) {
  return createMockRequest(`/api/web-auto-suites/${SUITE_ID}`, {
    method: "PATCH",
    body,
  });
}

describe("PATCH /api/web-auto-suites/[id] — content vs visibility gates", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMock.$reset();
    getSessionMock.mockResolvedValue(createMockSession(me));
  });

  it("1. non-author cannot flip visibility on a public suite (403, no update)", async () => {
    mockDbSuite(foreignPublicSuite);

    const res = await PATCH(makeRequest({ visibility: "private" }), {
      params: Promise.resolve({ id: SUITE_ID }),
    });
    expect(res.status).toBe(403);
    expect(db.update).not.toHaveBeenCalled();
  });

  it("2. non-author cannot toggle enabled on a public suite (403)", async () => {
    mockDbSuite(foreignPublicSuite);

    const res = await PATCH(makeRequest({ enabled: false }), {
      params: Promise.resolve({ id: SUITE_ID }),
    });
    expect(res.status).toBe(403);
    expect(db.update).not.toHaveBeenCalled();
  });

  it("3. non-author CAN edit content of a public suite (collaboration preserved)", async () => {
    mockDbSuite(foreignPublicSuite);

    const res = await PATCH(makeRequest({ name: "Renamed by peer" }), {
      params: Promise.resolve({ id: SUITE_ID }),
    });
    expect(res.status).toBe(200);
    expect(db.update).toHaveBeenCalledTimes(1);
  });

  it("4. author can change visibility of their own suite", async () => {
    mockDbSuite(ownSuite);

    const res = await PATCH(makeRequest({ visibility: "public" }), {
      params: Promise.resolve({ id: SUITE_ID }),
    });
    expect(res.status).toBe(200);
    expect(db.update).toHaveBeenCalledTimes(1);
  });

  it("5. admin can change visibility of any suite", async () => {
    getSessionMock.mockResolvedValue(createMockSession(ADMIN_USER));
    mockDbSuite(foreignPublicSuite);

    const res = await PATCH(makeRequest({ visibility: "private" }), {
      params: Promise.resolve({ id: SUITE_ID }),
    });
    expect(res.status).toBe(200);
    expect(db.update).toHaveBeenCalledTimes(1);
  });
});
