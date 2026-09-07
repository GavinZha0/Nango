import { describe, it, expect, vi, beforeEach } from "vitest";

const { getSessionMock } = vi.hoisted(() => ({
  getSessionMock: vi.fn(),
}));

vi.mock("@/lib/auth/auth-instance", () => ({
  getSession: getSessionMock,
}));


vi.mock("@/lib/db", async () => {
  const { createDrizzleMock } = await import("tests/unit/helpers");
  return { db: createDrizzleMock() };
});

vi.mock("@/lib/agent-pipeline/guardrail-service", () => ({
  loadAllGuardrailConfigs: vi.fn().mockResolvedValue(undefined),
  getGuardrailConfigCache: vi.fn().mockReturnValue({
    toolOverrides: new Map(),
    safetyPolicies: [],
    loaded: true,
  }),
  getToolRiskOverride: vi.fn().mockReturnValue(undefined),
  invalidateGuardrailCache: vi.fn(),
  generateCustomRuleName: vi.fn().mockReturnValue("custom_rule_abc123"),
  DEFAULT_SAFETY_POLICIES: [],
}));

vi.mock("@/lib/config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/config")>();
  return {
    ...actual,
    updateConfig: vi.fn().mockResolvedValue(undefined),
    invalidateConfigCache: vi.fn(),
  };
});

import { GET, PATCH } from "@/app/api/admin/guardrails/route";
import { db } from "@/lib/db";
import { createMockRequest, type MockDrizzleDb } from "tests/unit/helpers";
import { ADMIN_USER, createMockSession } from "tests/unit/fixtures";

const dbMock = db as unknown as MockDrizzleDb;

describe("API /api/admin/guardrails", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMock.$reset();
    getSessionMock.mockResolvedValue(createMockSession(ADMIN_USER));
  });

  it("GET returns posture, builtin tools, and interception logs", async () => {
    const interceptionLogs = [
      {
        id: 1,
        runId: "run-123",
        stage: "tool_call",
        category: "tool_risk",
        action: "require_approval",
        severity: "high",
        toolName: "run_ssh_command",
        payload: { command: "rm -rf /" },
        createdAt: new Date(),
        agentName: "Search Agent",
        userName: "Admin",
      },
    ];

    // First query resolves [] on from(); second query resolves interceptionLogs on limit()
    dbMock._chain.from.mockResolvedValueOnce([]);
    dbMock._chain.limit.mockResolvedValueOnce(interceptionLogs);

    const req = createMockRequest("/api/admin/guardrails");
    const res = await GET(req, { params: Promise.resolve({}) });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.builtinTools).toBeDefined();
    expect(data.builtinTools.length).toBeGreaterThan(0);
    expect(data.interceptionLogs).toHaveLength(1);
    expect(data.interceptionLogs[0].category).toBe("tool_risk");
  });

  it("PATCH creates/updates tool overrides and safety policies", async () => {
    dbMock._chain.limit.mockResolvedValueOnce([]);

    const req = createMockRequest("/api/admin/guardrails", {
      method: "PATCH",
      body: {
        toolOverride: {
          source: "mcp",
          mcpServerId: "00000000-0000-0000-0000-000000000000",
          toolName: "danger_tool",
          riskLevel: "critical",
          requireApproval: "always",
          headlessAllowed: false,
        },
        safetyPolicy: {
          displayName: "My Custom Regex",
          category: "output_redaction",
          policyType: "regex",
          action: "redact",
          severity: "high",
        },
      },
    });

    const res = await PATCH(req, { params: Promise.resolve({}) });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);

    expect(db.insert).toHaveBeenCalledTimes(2);
  });
});
