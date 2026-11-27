import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const { getSessionMock, dbMock } = vi.hoisted(() => {
  const selectLimitMock = vi.fn();
  const selectWhereMock = vi.fn(() => ({ limit: selectLimitMock }));
  const selectFromMock = vi.fn(() => ({ where: selectWhereMock }));
  const selectMock = vi.fn(() => ({ from: selectFromMock }));

  const onConflictDoUpdateMock = vi.fn();
  const insertValuesMock = vi.fn(() => ({
    onConflictDoUpdate: onConflictDoUpdateMock,
  }));
  const insertMock = vi.fn(() => ({ values: insertValuesMock }));

  const deleteWhereMock = vi.fn();
  const deleteMock = vi.fn(() => ({ where: deleteWhereMock }));

  const executeMock = vi.fn();

  const mock = {
    execute: executeMock,
    select: selectMock,
    insert: insertMock,
    delete: deleteMock,
    transaction: vi.fn(async (cb: (tx: typeof mock) => Promise<unknown>) =>
      cb(mock),
    ),
    _selectLimit: selectLimitMock,
    _insertValues: insertValuesMock,
    _onConflictDoUpdate: onConflictDoUpdateMock,
    _deleteWhere: deleteWhereMock,
  };

  return {
    getSessionMock: vi.fn(),
    dbMock: mock,
  };
});

vi.mock("@/lib/auth/auth-instance", () => ({
  getSession: getSessionMock,
}));

vi.mock("@/lib/db", () => ({
  db: dbMock,
}));

import { GET } from "@/app/api/threads/route";
import { PATCH, DELETE } from "@/app/api/threads/[threadId]/route";
import { EDITOR_USER, createMockSession } from "tests/unit/fixtures";

const VALID_THREAD_ID = "019a1111-2222-7333-8444-555555555555";
const OWNER_ID = "00000000-0000-4000-8000-000000000001";

function makeReq(
  url: string,
  init?: { method?: string; body?: unknown },
): NextRequest {
  const method = init?.method ?? "GET";
  return new NextRequest(url, {
    method,
    headers:
      init?.body !== undefined
        ? { "Content-Type": "application/json" }
        : undefined,
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
}

describe("threads API routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getSessionMock.mockResolvedValue(
      createMockSession({ ...EDITOR_USER, id: OWNER_ID }),
    );
  });

  describe("GET /api/threads", () => {
    it("projects custom_title and pinned_at metadata onto session descriptors", async () => {
      dbMock.execute.mockResolvedValueOnce({
        rows: [
          {
            thread_id: VALID_THREAD_ID,
            started_at: new Date("2026-11-01T10:00:00.000Z"),
            last_run_at: new Date("2026-11-20T12:00:00.000Z"),
            turn_count: 3,
            title: "Original user prompt",
            pinned_at: new Date("2026-11-21T08:00:00.000Z"),
            custom_title: "Renamed Sprint Thread",
          },
          {
            thread_id: "019a1111-2222-7333-8444-666666666666",
            started_at: new Date("2026-11-25T10:00:00.000Z"),
            last_run_at: new Date("2026-11-25T10:05:00.000Z"),
            turn_count: 1,
            title: "Fallback prompt title",
            pinned_at: null,
            custom_title: null,
          },
        ],
      });

      const res = await GET(
        makeReq("http://localhost:9300/api/threads?entityId=agent-1"),
        { params: Promise.resolve({}) },
      );

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data).toEqual([
        {
          session_id: VALID_THREAD_ID,
          session_name: "Renamed Sprint Thread",
          created_at: "2026-11-01T10:00:00.000Z",
          updated_at: "2026-11-20T12:00:00.000Z",
          pinned: true,
          pinned_at: "2026-11-21T08:00:00.000Z",
          custom_title: "Renamed Sprint Thread",
        },
        {
          session_id: "019a1111-2222-7333-8444-666666666666",
          session_name: "Fallback prompt title",
          created_at: "2026-11-25T10:00:00.000Z",
          updated_at: "2026-11-25T10:05:00.000Z",
          pinned: false,
          pinned_at: null,
          custom_title: null,
        },
      ]);
    });
  });

  describe("PATCH /api/threads/[threadId]", () => {
    it("rejects non-UUID threadId with 400", async () => {
      const res = await PATCH(
        makeReq("http://localhost:9300/api/threads/not-a-uuid", {
          method: "PATCH",
          body: { pinned: true },
        }),
        { params: Promise.resolve({ threadId: "not-a-uuid" }) },
      );
      expect(res.status).toBe(400);
    });

    it("rejects empty body and overly long titles with 400", async () => {
      const emptyRes = await PATCH(
        makeReq(`http://localhost:9300/api/threads/${VALID_THREAD_ID}`, {
          method: "PATCH",
          body: {},
        }),
        { params: Promise.resolve({ threadId: VALID_THREAD_ID }) },
      );
      expect(emptyRes.status).toBe(400);

      const longRes = await PATCH(
        makeReq(`http://localhost:9300/api/threads/${VALID_THREAD_ID}`, {
          method: "PATCH",
          body: { title: "a".repeat(121) },
        }),
        { params: Promise.resolve({ threadId: VALID_THREAD_ID }) },
      );
      expect(longRes.status).toBe(400);
    });

    it("returns 404 when the thread does not exist for the caller", async () => {
      dbMock.execute.mockResolvedValueOnce({ rows: [] });

      const res = await PATCH(
        makeReq(`http://localhost:9300/api/threads/${VALID_THREAD_ID}`, {
          method: "PATCH",
          body: { pinned: true },
        }),
        { params: Promise.resolve({ threadId: VALID_THREAD_ID }) },
      );
      expect(res.status).toBe(404);
      expect(dbMock.insert).not.toHaveBeenCalled();
    });

    it("upserts thread_metadata when pinning or renaming", async () => {
      dbMock.execute.mockResolvedValueOnce({
        rows: [{ title: "Initial user question" }],
      });
      dbMock._selectLimit.mockResolvedValueOnce([]);
      dbMock._onConflictDoUpdate.mockResolvedValueOnce(undefined);

      const res = await PATCH(
        makeReq(`http://localhost:9300/api/threads/${VALID_THREAD_ID}`, {
          method: "PATCH",
          body: { pinned: true, title: "  Architecture Review  " },
        }),
        { params: Promise.resolve({ threadId: VALID_THREAD_ID }) },
      );

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.session_id).toBe(VALID_THREAD_ID);
      expect(data.session_name).toBe("Architecture Review");
      expect(data.custom_title).toBe("Architecture Review");
      expect(data.pinned).toBe(true);
      expect(typeof data.pinned_at).toBe("string");
      expect(dbMock.insert).toHaveBeenCalledTimes(1);
      expect(dbMock.delete).not.toHaveBeenCalled();
    });

    it("preserves existing pin timestamp when only renaming", async () => {
      const existingPin = new Date("2026-11-10T09:00:00.000Z");
      dbMock.execute.mockResolvedValueOnce({
        rows: [{ title: "Initial user question" }],
      });
      dbMock._selectLimit.mockResolvedValueOnce([
        { pinnedAt: existingPin, customTitle: "Old Title" },
      ]);
      dbMock._onConflictDoUpdate.mockResolvedValueOnce(undefined);

      const res = await PATCH(
        makeReq(`http://localhost:9300/api/threads/${VALID_THREAD_ID}`, {
          method: "PATCH",
          body: { title: "New Title" },
        }),
        { params: Promise.resolve({ threadId: VALID_THREAD_ID }) },
      );

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.pinned).toBe(true);
      expect(data.pinned_at).toBe(existingPin.toISOString());
      expect(data.session_name).toBe("New Title");
    });

    it("deletes metadata row and restores derived title when both fields become null", async () => {
      dbMock.execute.mockResolvedValueOnce({
        rows: [{ title: "Restored prompt title" }],
      });
      dbMock._selectLimit.mockResolvedValueOnce([
        { pinnedAt: null, customTitle: "Temporary name" },
      ]);
      dbMock._deleteWhere.mockResolvedValueOnce(undefined);

      const res = await PATCH(
        makeReq(`http://localhost:9300/api/threads/${VALID_THREAD_ID}`, {
          method: "PATCH",
          body: { title: "   " },
        }),
        { params: Promise.resolve({ threadId: VALID_THREAD_ID }) },
      );

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data).toEqual({
        session_id: VALID_THREAD_ID,
        session_name: "Restored prompt title",
        pinned: false,
        pinned_at: null,
        custom_title: null,
      });
      expect(dbMock.delete).toHaveBeenCalledTimes(1);
      expect(dbMock.insert).not.toHaveBeenCalled();
    });
  });

  describe("DELETE /api/threads/[threadId]", () => {
    it("rejects non-UUID threadId with 400", async () => {
      const res = await DELETE(
        makeReq("http://localhost:9300/api/threads/bad-id", {
          method: "DELETE",
        }),
        { params: Promise.resolve({ threadId: "bad-id" }) },
      );
      expect(res.status).toBe(400);
    });

    it("deletes entity_run tree and thread_metadata in a transaction", async () => {
      dbMock.execute.mockResolvedValueOnce({ rows: [] });
      dbMock._deleteWhere.mockResolvedValueOnce(undefined);

      const res = await DELETE(
        makeReq(`http://localhost:9300/api/threads/${VALID_THREAD_ID}`, {
          method: "DELETE",
        }),
        { params: Promise.resolve({ threadId: VALID_THREAD_ID }) },
      );

      expect(res.status).toBe(204);
      expect(dbMock.transaction).toHaveBeenCalledTimes(1);
      expect(dbMock.execute).toHaveBeenCalledTimes(1);
      expect(dbMock.delete).toHaveBeenCalledTimes(1);
    });
  });
});
