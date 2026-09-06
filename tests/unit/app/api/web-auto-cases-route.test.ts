import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

const { getSessionMock } = vi.hoisted(() => ({
  getSessionMock: vi.fn(),
}));

vi.mock("@/lib/auth/auth-instance", () => ({
  getSession: getSessionMock,
}));

vi.mock("@/lib/observability/logger", () => ({
  newRequestId: () => "req-web-auto-cases-123",
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
    update: vi.fn(),
    delete: vi.fn(),
  },
}));

import { NextRequest } from "next/server";
import { PATCH, DELETE } from "@/app/api/web-auto-cases/[id]/route";
import { db } from "@/lib/db";

const CASE_ID = 42;
const SUITE_A = "a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d";
const SUITE_B = "b2c3d4e5-f6a7-4b9c-8d1e-2f3a4b5c6d7e";
const SERVER_1 = "11111111-1111-4111-8111-111111111111";
const SERVER_2 = "22222222-2222-4222-8222-222222222222";

const me = { id: "user-me-1", email: "me@example.com", name: "Me", role: "editor" };

// A collaborator-owned public suite: editors may edit content and move
// cases within it, but the delete gate below still applies per-case.
const existingInForeignPublicSuite = {
  suiteId: SUITE_A,
  suiteVisibility: "public",
  suiteCreatedBy: "user-other-1",
  suiteMcpServerId: SERVER_1,
};

function mockExisting(row: Record<string, unknown>): void {
  vi.mocked(db.select).mockReturnValueOnce({
    from: vi.fn().mockReturnValue({
      innerJoin: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([row]),
      }),
    }),
  } as unknown as ReturnType<typeof db.select>);
}

function mockTarget(row: Record<string, unknown> | null): void {
  vi.mocked(db.select).mockReturnValueOnce({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue(row ? [row] : []),
      }),
    }),
  } as unknown as ReturnType<typeof db.select>);
}

function mockUpdate(): void {
  vi.mocked(db.update).mockReturnValue({
    set: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([{ id: CASE_ID }]),
      }),
    }),
  } as unknown as ReturnType<typeof db.update>);
}

function mockDelete(): void {
  vi.mocked(db.delete).mockReturnValue({
    where: vi.fn().mockReturnValue({
      returning: vi.fn().mockResolvedValue([{ id: CASE_ID }]),
    }),
  } as unknown as ReturnType<typeof db.delete>);
}

function patchRequest(body: Record<string, unknown>): NextRequest {
  return new NextRequest(`http://localhost/api/web-auto-cases/${CASE_ID}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function deleteRequest(): NextRequest {
  return new NextRequest(`http://localhost/api/web-auto-cases/${CASE_ID}`, {
    method: "DELETE",
  });
}

describe("PATCH /api/web-auto-cases/[id] — suiteId move validation (F7-2)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getSessionMock.mockResolvedValue({ user: me });
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
    getSessionMock.mockResolvedValue({ user: me });
  });

  it("1. the case author can delete their own case in someone else's public suite", async () => {
    mockExisting({ ...existingInForeignPublicSuite, caseCreatedBy: me.id });
    mockDelete();

    const res = await DELETE(deleteRequest(), {
      params: Promise.resolve({ id: String(CASE_ID) }),
    });
    expect(res.status).toBe(200);
    expect(db.delete).toHaveBeenCalledTimes(1);
  });

  it("2. the suite author can delete a foreign case in their own suite", async () => {
    getSessionMock.mockResolvedValue({
      user: { id: "user-other-1", email: "o@example.com", name: "Other", role: "editor" },
    });
    mockExisting({ ...existingInForeignPublicSuite, caseCreatedBy: me.id });
    mockDelete();

    const res = await DELETE(deleteRequest(), {
      params: Promise.resolve({ id: String(CASE_ID) }),
    });
    expect(res.status).toBe(200);
    expect(db.delete).toHaveBeenCalledTimes(1);
  });

  it("3. an unrelated editor is forbidden (403)", async () => {
    mockExisting({ ...existingInForeignPublicSuite, caseCreatedBy: "user-other-2" });

    const res = await DELETE(deleteRequest(), {
      params: Promise.resolve({ id: String(CASE_ID) }),
    });
    expect(res.status).toBe(403);
    expect(db.delete).not.toHaveBeenCalled();
  });

  it("4. private foreign suites are opaque 404 regardless of authorship", async () => {
    mockExisting({
      suiteId: SUITE_A,
      suiteVisibility: "private",
      suiteCreatedBy: "user-other-1",
      suiteMcpServerId: SERVER_1,
      caseCreatedBy: me.id,
    });

    const res = await DELETE(deleteRequest(), {
      params: Promise.resolve({ id: String(CASE_ID) }),
    });
    expect(res.status).toBe(404);
    expect(db.delete).not.toHaveBeenCalled();
  });

  it("5. admin can delete any visible case", async () => {
    getSessionMock.mockResolvedValue({
      user: { id: "user-admin-1", email: "a@example.com", name: "Admin", role: "admin" },
    });
    mockExisting({ ...existingInForeignPublicSuite, caseCreatedBy: "user-other-2" });
    mockDelete();

    const res = await DELETE(deleteRequest(), {
      params: Promise.resolve({ id: String(CASE_ID) }),
    });
    expect(res.status).toBe(200);
    expect(db.delete).toHaveBeenCalledTimes(1);
  });
});
