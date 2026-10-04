import { describe, it, expect, vi, beforeEach } from "vitest";

const { getSessionMock, runWebAutoCaseMock } = vi.hoisted(() => ({
  getSessionMock: vi.fn(),
  runWebAutoCaseMock: vi.fn(),
}));

vi.mock("@/lib/auth/auth-instance", () => ({
  getSession: getSessionMock,
}));

vi.mock("@/lib/db", async () => {
  const { createDrizzleMock } = await import("tests/unit/helpers");
  return { db: createDrizzleMock() };
});

vi.mock("@/lib/web-auto/orchestrator", () => ({
  runWebAutoCase: runWebAutoCaseMock,
}));

import { POST } from "@/app/api/web-auto-cases/[id]/run/route";
import { db } from "@/lib/db";
import { createMockRequest, type MockDrizzleDb } from "tests/unit/helpers";
import { EDITOR_USER, createMockSession, createMockWebAutoSuite } from "tests/unit/fixtures";

const dbMock = db as unknown as MockDrizzleDb;

const CASE_ID = 42;
const SUITE_ID = "a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d";
const SERVER_ID = "11111111-1111-4111-8111-111111111111";

const me = { ...EDITOR_USER, id: "user-me-1" };

const sampleSuite = createMockWebAutoSuite({
  id: SUITE_ID,
  name: "Playwright Suite",
  mcpServerId: SERVER_ID,
  visibility: "public",
  createdBy: me.id,
});

const sampleCase = {
  id: CASE_ID,
  suiteId: SUITE_ID,
  name: "Login test",
  input: { script: "page.goto('https://example.com');" },
  assertions: [],
};

describe("POST /api/web-auto-cases/[id]/run", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMock.$reset();
    getSessionMock.mockResolvedValue(createMockSession(me));
  });

  it("returns JSON outcome when streaming is not requested", async () => {
    dbMock._chain.where
      .mockResolvedValueOnce([sampleCase])
      .mockResolvedValueOnce([sampleSuite]);

    const mockOutcome = {
      status: "passed",
      executionOutput: { result: "ok" },
      durationMs: 400,
    };
    runWebAutoCaseMock.mockResolvedValueOnce(mockOutcome);

    const req = createMockRequest(`/api/web-auto-cases/${CASE_ID}/run`, {
      method: "POST",
    });

    const res = await POST(req, { params: Promise.resolve({ id: String(CASE_ID) }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual(mockOutcome);
    expect(runWebAutoCaseMock).toHaveBeenCalledWith(
      expect.objectContaining({
        caseId: CASE_ID,
        suiteId: SUITE_ID,
        ownerId: me.id,
      }),
    );
  });

  it("streams two-phase NDJSON when Accept header contains application/x-ndjson", async () => {
    dbMock._chain.where
      .mockResolvedValueOnce([sampleCase])
      .mockResolvedValueOnce([sampleSuite]);

    const mockOutcome = {
      status: "passed",
      executionOutput: { result: "ok" },
      verdict: { overall: { passed: true } },
      durationMs: 450,
    };

    runWebAutoCaseMock.mockImplementationOnce(async (input: { onExecutionComplete?: (d: unknown) => Promise<void> }) => {
      if (input.onExecutionComplete) {
        await input.onExecutionComplete({
          executionOutput: { result: "ok" },
          durationMs: 200,
        });
      }
      return mockOutcome;
    });

    const req = createMockRequest(`/api/web-auto-cases/${CASE_ID}/run`, {
      method: "POST",
      headers: {
        Accept: "application/x-ndjson",
      },
    });

    const res = await POST(req, { params: Promise.resolve({ id: String(CASE_ID) }) });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/x-ndjson");

    const text = await res.text();
    const lines = text.trim().split("\n").map((l) => JSON.parse(l));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toEqual({
      type: "execution_complete",
      executionOutput: { result: "ok" },
      durationMs: 200,
    });
    expect(lines[1]).toEqual({
      type: "verdict_complete",
      outcome: mockOutcome,
    });
  });

  it("returns 400 when suite has no Playwright MCP server configured", async () => {
    dbMock._chain.where
      .mockResolvedValueOnce([sampleCase])
      .mockResolvedValueOnce([{ ...sampleSuite, mcpServerId: null }]);

    const req = createMockRequest(`/api/web-auto-cases/${CASE_ID}/run`, {
      method: "POST",
    });

    const res = await POST(req, { params: Promise.resolve({ id: String(CASE_ID) }) });
    expect(res.status).toBe(400);
  });
});
