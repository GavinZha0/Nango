import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  getSessionMock,
  startEvalSuiteRunMock,
  startEvalAgentAllRunsMock,
  loadSuiteMock,
  isAgentVisibleToMock,
} = vi.hoisted(() => ({
  getSessionMock: vi.fn(),
  startEvalSuiteRunMock: vi.fn(),
  startEvalAgentAllRunsMock: vi.fn(),
  loadSuiteMock: vi.fn(),
  isAgentVisibleToMock: vi.fn(),
}));

vi.mock("@/lib/auth/auth-instance", () => ({
  getSession: getSessionMock,
}));

vi.mock("@/lib/evaluation/run-orchestrator", () => ({
  startEvalSuiteRun: startEvalSuiteRunMock,
  startEvalAgentAllRuns: startEvalAgentAllRunsMock,
}));

vi.mock("@/lib/evaluation/access", () => ({
  loadSuite: loadSuiteMock,
}));

vi.mock("@/lib/access/agent-visibility", () => ({
  isAgentVisibleTo: isAgentVisibleToMock,
}));

import { POST } from "@/app/api/eval-runs/route";
import { createMockRequest } from "tests/unit/helpers";
import { EDITOR_USER, createMockUser, createMockSession, createMockEvalSuite } from "tests/unit/fixtures";

describe("POST /api/eval-runs", () => {
  const editorUser = {
    ...EDITOR_USER,
    id: "11111111-1111-4111-8111-111111111111",
  };

  const otherUser = createMockUser({
    id: "22222222-2222-4222-8222-222222222222",
    email: "other@example.com",
    name: "Other",
    role: "editor",
  });

  const sampleSuite = createMockEvalSuite({
    id: "33333333-3333-4333-8333-333333333333",
    name: "Customer Support Suite",
    agentId: "agent-support-1",
    agentSource: "builtin",
    enabled: true,
    visibility: "private",
    createdBy: editorUser.id,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    getSessionMock.mockResolvedValue(createMockSession(editorUser));
    loadSuiteMock.mockResolvedValue(sampleSuite);
    startEvalSuiteRunMock.mockResolvedValue({
      runId: "01918a3b-uuidv7",
      totalCount: 4,
    });
    isAgentVisibleToMock.mockResolvedValue(true);
    startEvalAgentAllRunsMock.mockResolvedValue(undefined);
  });

  it("successfully starts single suite evaluation (202 Accepted)", async () => {
    const req = createMockRequest("/api/eval-runs", {
      method: "POST",
      body: { suiteId: sampleSuite.id },
    });

    const res = await POST(req, { params: Promise.resolve({}) });
    expect(res.status).toBe(202);

    const body = (await res.json()) as { runId: string; totalCount: number };
    expect(body.runId).toBe("01918a3b-uuidv7");
    expect(body.totalCount).toBe(4);

    expect(startEvalSuiteRunMock).toHaveBeenCalledWith({
      suiteId: sampleSuite.id,
      ownerId: editorUser.id,
      triggeredBy: "manual",
    });
  });

  it("successfully starts agent-level batch evaluation (202 Accepted)", async () => {
    const req = createMockRequest("/api/eval-runs", {
      method: "POST",
      body: {
        agentId: "agent-support-1",
        agentSource: "builtin",
      },
    });

    const res = await POST(req, { params: Promise.resolve({}) });
    expect(res.status).toBe(202);

    const body = (await res.json()) as { message: string };
    expect(body.message).toContain("Agent evaluation started");

    expect(startEvalAgentAllRunsMock).toHaveBeenCalledWith({
      agentId: "agent-support-1",
      agentSource: "builtin",
      credentialId: undefined,
      ownerId: editorUser.id,
      isAdmin: false,
      triggeredBy: "manual",
    });
  });

  it.each([
    { scenario: "neither suiteId nor agentId", body: {} },
    {
      scenario: "both suiteId and agentId",
      body: { suiteId: sampleSuite.id, agentId: "agent-support-1" },
    },
  ])("rejects request if $scenario (400)", async ({ body }) => {
    const req = createMockRequest("/api/eval-runs", {
      method: "POST",
      body,
    });

    const res = await POST(req, { params: Promise.resolve({}) });
    expect(res.status).toBe(400);
  });

  it("rejects run on disabled suite with 400 Bad Request", async () => {
    loadSuiteMock.mockResolvedValueOnce({
      ...sampleSuite,
      enabled: false,
    });

    const req = createMockRequest("/api/eval-runs", {
      method: "POST",
      body: { suiteId: sampleSuite.id },
    });

    const res = await POST(req, { params: Promise.resolve({}) });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { message: string; code: string };
    expect(body.message).toBe("Evaluation suite is disabled.");
  });

  it("rejects run with 403 Forbidden when caller cannot edit the suite", async () => {
    loadSuiteMock.mockResolvedValueOnce({
      ...sampleSuite,
      createdBy: otherUser.id,
      visibility: "private",
    });

    const req = createMockRequest("/api/eval-runs", {
      method: "POST",
      body: { suiteId: sampleSuite.id },
    });

    const res = await POST(req, { params: Promise.resolve({}) });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { message: string; code: string };
    expect(body.message).toBe("You cannot run this evaluation suite.");
  });

  it("returns 404 when target builtin agent is not visible", async () => {
    isAgentVisibleToMock.mockResolvedValueOnce(false);

    const req = createMockRequest("/api/eval-runs", {
      method: "POST",
      body: {
        agentId: "private-agent-999",
        agentSource: "builtin",
      },
    });

    const res = await POST(req, { params: Promise.resolve({}) });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { message: string; code: string };
    expect(body.message).toBe("Agent not found.");
  });
});
