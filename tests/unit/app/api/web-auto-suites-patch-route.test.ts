import { describe, it, expect, vi, beforeEach } from "vitest";

const { getSessionMock } = vi.hoisted(() => ({
  getSessionMock: vi.fn(),
}));

vi.mock("@/lib/auth/auth-instance", () => ({
  getSession: getSessionMock,
}));

vi.mock("@/lib/db", () => ({
  db: {
    select: vi.fn(),
    update: vi.fn(),
  },
}));

import { NextRequest } from "next/server";
import { PATCH } from "@/app/api/web-auto-suites/[id]/route";
import { db } from "@/lib/db";
import { ADMIN_USER, EDITOR_USER, createMockSession } from "tests/unit/fixtures";

const SUITE_ID = "a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d";

const me = { ...EDITOR_USER, id: "user-me-1" };

// A collaborator-visible suite: editors can edit its content but may not
// flip visibility/enabled — that gate belongs to the author or an admin.
const foreignPublicSuite = { visibility: "public", createdBy: "user-other-1" };
const ownSuite = { visibility: "private", createdBy: me.id };

function mockDbSuite(suite: { visibility: string; createdBy: string }): void {
  vi.mocked(db.select).mockReturnValue({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue([suite]),
    }),
  } as unknown as ReturnType<typeof db.select>);
  vi.mocked(db.update).mockReturnValue({
    set: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([{ id: SUITE_ID, ...suite }]),
      }),
    }),
  } as unknown as ReturnType<typeof db.update>);
}

function makeRequest(body: Record<string, unknown>): NextRequest {
  return new NextRequest(`http://localhost/api/web-auto-suites/${SUITE_ID}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("PATCH /api/web-auto-suites/[id] — content vs visibility gates", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
