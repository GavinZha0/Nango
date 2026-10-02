import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  getSessionMock,
  createSuiteMock,
  updateSuiteMock,
  loadSuiteMock,
  getCaseCountMock,
  isAgentVisibleToMock,
} = vi.hoisted(() => ({
  getSessionMock: vi.fn(),
  createSuiteMock: vi.fn(),
  updateSuiteMock: vi.fn(),
  loadSuiteMock: vi.fn(),
  getCaseCountMock: vi.fn(),
  isAgentVisibleToMock: vi.fn(),
}));

vi.mock("@/lib/auth/auth-instance", () => ({
  getSession: getSessionMock,
}));

vi.mock("@/lib/evaluation/storage", () => ({
  createSuite: createSuiteMock,
  updateSuite: updateSuiteMock,
  getCaseCount: getCaseCountMock,
  listSuitesByAgentWithCaseCount: vi.fn(),
}));

vi.mock("@/lib/evaluation/access", () => ({
  loadSuite: loadSuiteMock,
}));

vi.mock("@/lib/access/agent-visibility", () => ({
  isAgentVisibleTo: isAgentVisibleToMock,
}));

import { POST } from "@/app/api/eval-suites/route";
import { PATCH } from "@/app/api/eval-suites/[id]/route";
import { createMockRequest } from "tests/unit/helpers";
import { EDITOR_USER, createMockSession, createMockEvalSuite } from "tests/unit/fixtures";

describe("Evaluation Suites API - Visibility Controls", () => {
  const editorUser = {
    ...EDITOR_USER,
    id: "11111111-1111-4111-8111-111111111111",
  };

  const sampleSuite = createMockEvalSuite({
    id: "33333333-3333-4333-8333-333333333333",
    name: "Customer Support Suite",
    agentId: "agent-target-1",
    agentSource: "builtin",
    enabled: true,
    visibility: "private",
    createdBy: editorUser.id,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    getSessionMock.mockResolvedValue(createMockSession(editorUser));
    isAgentVisibleToMock.mockResolvedValue(true);
    createSuiteMock.mockResolvedValue(sampleSuite);
    loadSuiteMock.mockResolvedValue(sampleSuite);
    updateSuiteMock.mockResolvedValue(sampleSuite);
    getCaseCountMock.mockResolvedValue(0);
  });

  describe("POST /api/eval-suites", () => {
    it("rejects creation if target agent is not visible (404)", async () => {
      isAgentVisibleToMock.mockImplementation(async (id: string) => id !== "secret-agent");

      const req = createMockRequest("/api/eval-suites", {
        method: "POST",
        body: {
          name: "Test Suite",
          agentId: "secret-agent",
          agentSource: "builtin",
        },
      });

      const res = await POST(req, { params: Promise.resolve({}) });
      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.message).toContain("Target agent not found.");
      expect(createSuiteMock).not.toHaveBeenCalled();
    });

    it("rejects creation if evaluator agent is specified but not visible (404)", async () => {
      isAgentVisibleToMock.mockImplementation(async (id: string) => id === "agent-target-1");

      const req = createMockRequest("/api/eval-suites", {
        method: "POST",
        body: {
          name: "Test Suite",
          agentId: "agent-target-1",
          evaluatorAgentId: "44444444-4444-4444-8444-444444444444",
        },
      });

      const res = await POST(req, { params: Promise.resolve({}) });
      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.message).toContain("Evaluator agent not found.");
      expect(createSuiteMock).not.toHaveBeenCalled();
    });

    it("succeeds when target and evaluator agents are visible (201)", async () => {
      isAgentVisibleToMock.mockResolvedValue(true);

      const req = createMockRequest("/api/eval-suites", {
        method: "POST",
        body: {
          name: "Test Suite",
          agentId: "agent-target-1",
          evaluatorAgentId: "44444444-4444-4444-8444-444444444444",
        },
      });

      const res = await POST(req, { params: Promise.resolve({}) });
      expect(res.status).toBe(201);
      expect(createSuiteMock).toHaveBeenCalled();
    });
  });

  describe("PATCH /api/eval-suites/[id]", () => {
    it("rejects update if newly bound evaluator agent is not visible (404)", async () => {
      isAgentVisibleToMock.mockResolvedValue(false);

      const req = createMockRequest(`/api/eval-suites/${sampleSuite.id}`, {
        method: "PATCH",
        body: {
          evaluatorAgentId: "55555555-5555-4555-8555-555555555555",
        },
      });

      const res = await PATCH(req, { params: Promise.resolve({ id: sampleSuite.id }) });
      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.message).toContain("Evaluator agent not found.");
      expect(updateSuiteMock).not.toHaveBeenCalled();
    });
  });
});
