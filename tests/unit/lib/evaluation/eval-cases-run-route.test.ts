import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

const { getSessionMock, runEvalCaseMock, loadCaseMock } = vi.hoisted(() => ({
  getSessionMock: vi.fn(),
  runEvalCaseMock: vi.fn(),
  loadCaseMock: vi.fn(),
}));

vi.mock("@/lib/auth/auth-instance", () => ({
  getSession: getSessionMock,
}));

vi.mock("@/lib/evaluation/eval-runner", () => ({
  runEvalCase: runEvalCaseMock,
}));

vi.mock("@/lib/evaluation/access", () => ({
  loadCase: loadCaseMock,
}));

vi.mock("@/lib/observability/logger", () => ({
  newRequestId: () => "req-eval-run-123",
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

import { NextRequest } from "next/server";
import { POST } from "@/app/api/eval-cases/[id]/run/route";
import { ApiError } from "@/lib/http/route-handlers";

describe("POST /api/eval-cases/[id]/run", () => {
  const editorUser = {
    id: "user-editor-1",
    email: "editor@example.com",
    name: "Editor",
    role: "editor",
  };

  const otherUser = {
    id: "user-other-1",
    email: "other@example.com",
    name: "Other",
    role: "editor",
  };

  const sampleCase = {
    id: 42,
    suiteId: "suite-uuid-1",
    name: "test_greeting_flow",
    description: "Evaluates standard greeting conversation",
    turns: [
      { userMessage: "Hello", expectedOutput: "Hi! How can I help you today?" },
    ],
    criteria: {
      constraints: ["Be polite and concise"],
    },
  };

  const sampleSuite = {
    id: "suite-uuid-1",
    name: "Customer Support Agent Eval",
    agentId: "agent-target-1",
    agentSource: "builtin",
    evaluatorAgentId: "evaluator-agent-1",
    visibility: "private",
    createdBy: "user-editor-1",
    dimensionIds: ["helpfulness", "clarity"],
    credentialId: null,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("1. runs case successfully in playground mode (200 OK)", async () => {
    getSessionMock.mockResolvedValue({
      user: editorUser,
      session: { id: "sess-1", userId: editorUser.id },
    });

    loadCaseMock.mockResolvedValue({
      caseRow: sampleCase,
      suite: sampleSuite,
    });

    const expectedOutcome = {
      score: 95,
      dimensionScores: { helpfulness: 90, clarity: 100 },
      assertionScore: 100,
      feedback: "Agent response was clear, polite, and aligned with constraints.",
      assertionResults: [],
      status: "passed",
      durationMs: 1450,
      outputTokens: 86,
    };

    runEvalCaseMock.mockResolvedValue(expectedOutcome);

    const req = new NextRequest("http://localhost/api/eval-cases/42/run", {
      method: "POST",
    });

    const res = await POST(req, { params: Promise.resolve({ id: "42" }) });
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data).toEqual(expectedOutcome);

    expect(runEvalCaseMock).toHaveBeenCalledWith(
      expect.objectContaining({
        caseId: 42,
        targetAgentId: "agent-target-1",
        evaluatorAgentId: "evaluator-agent-1",
        dimensionIds: ["helpfulness", "clarity"],
        ownerId: editorUser.id,
      }),
    );
  });

  it("2. rejects unauthenticated requests (401 Unauthorized)", async () => {
    getSessionMock.mockResolvedValue(null);

    const req = new NextRequest("http://localhost/api/eval-cases/42/run", {
      method: "POST",
    });

    const res = await POST(req, { params: Promise.resolve({ id: "42" }) });
    expect(res.status).toBe(401);
  });

  it("3. forbids non-owners from running private suites (403 Forbidden)", async () => {
    getSessionMock.mockResolvedValue({
      user: otherUser,
      session: { id: "sess-other", userId: otherUser.id },
    });

    loadCaseMock.mockResolvedValue({
      caseRow: sampleCase,
      suite: sampleSuite, // owned by editorUser, private
    });

    const req = new NextRequest("http://localhost/api/eval-cases/42/run", {
      method: "POST",
    });

    const res = await POST(req, { params: Promise.resolve({ id: "42" }) });
    expect(res.status).toBe(403);
    const data = await res.json();
    expect(data.message).toContain("You cannot run cases in this evaluation suite");
  });

  it("4. returns 404 when case is not found or invalid id format", async () => {
    getSessionMock.mockResolvedValue({
      user: editorUser,
      session: { id: "sess-1", userId: editorUser.id },
    });

    // Invalid string ID
    const reqInvalid = new NextRequest("http://localhost/api/eval-cases/invalid-id/run", {
      method: "POST",
    });
    const resInvalid = await POST(reqInvalid, { params: Promise.resolve({ id: "invalid-id" }) });
    expect(resInvalid.status).toBe(404);

    // Case not found in DB
    loadCaseMock.mockRejectedValue(new ApiError("NOT_FOUND", 404, "Eval case not found."));

    const reqMissing = new NextRequest("http://localhost/api/eval-cases/999/run", {
      method: "POST",
    });
    const resMissing = await POST(reqMissing, { params: Promise.resolve({ id: "999" }) });
    expect(resMissing.status).toBe(404);
  });

  it("5. succeeds running suite with null evaluator agent (deterministic-only run)", async () => {
    getSessionMock.mockResolvedValue({
      user: editorUser,
      session: { id: "sess-1", userId: editorUser.id },
    });

    loadCaseMock.mockResolvedValue({
      caseRow: sampleCase,
      suite: { ...sampleSuite, evaluatorAgentId: null },
    });

    runEvalCaseMock.mockResolvedValue({
      status: "passed",
      score: 100,
      assertionScore: 100,
      feedback: "All deterministic assertions passed.",
    });

    const req = new NextRequest("http://localhost/api/eval-cases/42/run", {
      method: "POST",
    });

    const res = await POST(req, { params: Promise.resolve({ id: "42" }) });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe("passed");
    expect(runEvalCaseMock).toHaveBeenCalledWith(
      expect.objectContaining({
        evaluatorAgentId: null,
      }),
    );
  });
});
