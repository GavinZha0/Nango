import { describe, it, expect, vi, beforeEach } from "vitest";

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

import { POST } from "@/app/api/eval-cases/[id]/run/route";
import { ApiError } from "@/lib/http/route-handlers";
import { createMockRequest } from "tests/unit/helpers";
import { EDITOR_USER, createMockEvalSuite } from "tests/unit/fixtures";

function makeRequest(id: string = "42") {
  return createMockRequest(`/api/eval-cases/${id}/run`, {
    method: "POST",
  });
}

describe("POST /api/eval-cases/[id]/run", () => {
  const editorUser = EDITOR_USER;

  const otherUser = {
    id: "user-other-1",
    email: "other@example.com",
    name: "Other",
    role: "editor" as const,
  };

  const sampleSuite = createMockEvalSuite({
    id: "11111111-1111-4111-8111-111111111111",
    name: "Customer Support Quality Suite",
    agentId: "agent-target-1",
    agentSource: "builtin",
    evaluatorAgentId: "evaluator-agent-1",
    visibility: "private",
    createdBy: editorUser.id,
    dimensionIds: ["helpfulness", "clarity"],
    credentialId: null,
  });

  const sampleCase = {
    id: 42,
    suiteId: sampleSuite.id,
    name: "test_greeting_flow",
    description: "Evaluates standard greeting conversation",
    turns: [
      { userMessage: "Hello", expectedOutput: "Hi! How can I help you today?" },
    ],
    criteria: {
      constraints: ["Be polite and concise"],
    },
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

    const res = await POST(makeRequest("42"), { params: Promise.resolve({ id: "42" }) });
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

    const res = await POST(makeRequest("42"), { params: Promise.resolve({ id: "42" }) });
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

    const res = await POST(makeRequest("42"), { params: Promise.resolve({ id: "42" }) });
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
    const resInvalid = await POST(makeRequest("invalid-id"), { params: Promise.resolve({ id: "invalid-id" }) });
    expect(resInvalid.status).toBe(404);

    // Case not found in DB
    loadCaseMock.mockRejectedValue(new ApiError("NOT_FOUND", 404, "Eval case not found."));

    const resMissing = await POST(makeRequest("999"), { params: Promise.resolve({ id: "999" }) });
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

    const res = await POST(makeRequest("42"), { params: Promise.resolve({ id: "42" }) });
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
