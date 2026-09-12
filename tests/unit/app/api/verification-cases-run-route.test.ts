import { describe, it, expect, vi, beforeEach } from "vitest";

const { getSessionMock, runMcpCaseMock, loadVisibleCaseMock } = vi.hoisted(() => ({
  getSessionMock: vi.fn(),
  runMcpCaseMock: vi.fn(),
  loadVisibleCaseMock: vi.fn(),
}));

vi.mock("@/lib/auth/auth-instance", () => ({
  getSession: getSessionMock,
}));

vi.mock("@/lib/verification/runner-mcp", () => ({
  runMcpCase: runMcpCaseMock,
}));

vi.mock("@/lib/verification/access", () => ({
  loadVisibleCase: loadVisibleCaseMock,
}));

import { POST } from "@/app/api/verification-cases/[id]/run/route";
import { createMockRequest } from "tests/unit/helpers";
import { EDITOR_USER, createMockVerificationSuite } from "tests/unit/fixtures";

function makeRequest(id: string = "42") {
  return createMockRequest(`/api/verification-cases/${id}/run`, {
    method: "POST",
  });
}

describe("POST /api/verification-cases/[id]/run", () => {
  const editorUser = EDITOR_USER;

  const sampleSuite = createMockVerificationSuite({
    id: "11111111-1111-4111-8111-111111111111",
    name: "Search MCP Suite",
    mcpServerId: "mcp-server-1",
    visibility: "private",
    createdBy: editorUser.id,
  });

  const sampleCase = {
    id: 42,
    suiteId: sampleSuite.id,
    name: "test_search_query",
    toolName: "web_search",
    input: { query: "test" },
    assertions: [],
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("passes literal variables from suite to runMcpCase", async () => {
    getSessionMock.mockResolvedValue({
      user: editorUser,
      session: { id: "sess-1", userId: editorUser.id },
    });

    loadVisibleCaseMock.mockResolvedValue({
      caseRow: sampleCase,
      suite: {
        ...sampleSuite,
        variables: {
          API_URL: { type: "literal", value: "https://api.example.com" },
        },
      },
    });

    runMcpCaseMock.mockResolvedValue({
      status: "passed",
      resolvedInput: { query: "test" },
      resultPayload: { count: 5 },
      resultTruncated: false,
      assertionResults: [],
      error: null,
      startedAt: Date.now(),
      durationMs: 10,
    });

    const res = await POST(makeRequest("42"), { params: Promise.resolve({ id: "42" }) });
    expect(res.status).toBe(200);
    expect(runMcpCaseMock).toHaveBeenCalledWith(
      expect.objectContaining({
        mcpServerId: "mcp-server-1",
        toolName: "web_search",
      }),
      { variables: { API_URL: "https://api.example.com" } },
    );
  });

  it("fails closed with status errored and error.source = config if suite contains credential variable", async () => {
    getSessionMock.mockResolvedValue({
      user: editorUser,
      session: { id: "sess-1", userId: editorUser.id },
    });

    loadVisibleCaseMock.mockResolvedValue({
      caseRow: sampleCase,
      suite: {
        ...sampleSuite,
        variables: {
          ILLEGAL_CRED: { type: "credential", credentialId: "cred-1", field: "key" },
        },
      },
    });

    const res = await POST(makeRequest("42"), { params: Promise.resolve({ id: "42" }) });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe("errored");
    expect(data.error?.source).toBe("config");
    expect(data.error?.message).toContain("Credential variables are not permitted in this suite type");
    expect(runMcpCaseMock).not.toHaveBeenCalled();
  });
});
