import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

const { getSessionMock, inArrayMock } = vi.hoisted(() => ({
  getSessionMock: vi.fn(),
  inArrayMock: vi.fn(),
}));

vi.mock("@/lib/auth/auth-instance", () => ({
  getSession: getSessionMock,
}));

vi.mock("@/lib/observability/logger", () => ({
  newRequestId: () => "req-verification-servers-123",
  childLogger: () => ({
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    fatal: () => {},
    trace: () => {},
    child: () => ({
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
      fatal: () => {},
      trace: () => {},
    }),
  }),
}));

vi.mock("@/lib/db", () => ({
  db: {
    select: vi.fn(),
    delete: vi.fn(),
  },
}));

vi.mock("drizzle-orm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("drizzle-orm")>();
  return {
    ...actual,
    inArray: inArrayMock.mockImplementation(actual.inArray),
  };
});

import { NextRequest } from "next/server";
import { DELETE } from "@/app/api/verification-servers/[id]/route";
import { db } from "@/lib/db";

const SERVER_ID = "11111111-1111-4111-8111-111111111111";

const ownerUser = {
  id: "user-owner-1",
  email: "owner@example.com",
  name: "Owner",
  role: "editor",
};

const otherUser = {
  id: "user-other-1",
  email: "other@example.com",
  name: "Other",
  role: "editor",
};

const adminUser = {
  id: "user-admin-1",
  email: "admin@example.com",
  name: "Admin",
  role: "admin",
};

function sessionFor(user: {
  id: string;
  role: string;
}): { user: { id: string; role: string } } | null {
  return { user };
}

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
  vi.mocked(db.select).mockReturnValue({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(suites),
    }),
  } as unknown as ReturnType<typeof db.select>);
  vi.mocked(db.delete).mockReturnValue({
    where: vi.fn().mockResolvedValue(undefined),
  } as unknown as ReturnType<typeof db.delete>);
}

function makeRequest(): NextRequest {
  return new NextRequest(`http://localhost/api/verification-servers/${SERVER_ID}`, {
    method: "DELETE",
  });
}

describe("DELETE /api/verification-servers/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("1. admin deletes all suites under the server (cascade is legal)", async () => {
    getSessionMock.mockResolvedValue(sessionFor(adminUser));
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
    getSessionMock.mockResolvedValue(sessionFor(ownerUser));
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
    getSessionMock.mockResolvedValue(sessionFor(otherUser));
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
    getSessionMock.mockResolvedValue(
      sessionFor({ id: "user-basic-1", role: "user" }),
    );

    const res = await DELETE(makeRequest(), {
      params: Promise.resolve({ id: SERVER_ID }),
    });
    expect(res.status).toBe(403);
    expect(db.delete).not.toHaveBeenCalled();
  });

  it("6. rejects non-uuid ids (synthetic detached keys) with 404 instead of a Postgres 22P02", async () => {
    getSessionMock.mockResolvedValue(sessionFor(adminUser));

    const res = await DELETE(makeRequest(), {
      params: Promise.resolve({ id: "detached:Hugging Face" }),
    });
    expect(res.status).toBe(404);
    expect(db.select).not.toHaveBeenCalled();
    expect(db.delete).not.toHaveBeenCalled();
  });
});
