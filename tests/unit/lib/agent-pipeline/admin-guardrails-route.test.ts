import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

const { getSessionMock } = vi.hoisted(() => ({
  getSessionMock: vi.fn(),
}));

vi.mock("@/lib/auth/auth-instance", () => ({
  getSession: getSessionMock,
}));

vi.mock("@/lib/observability/logger", () => ({
  newRequestId: () => "req-123",
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
import { GET, PATCH } from "@/app/api/admin/guardrails/route";
import { db } from "@/lib/db";

vi.mock("@/lib/db", () => {
  return {
    db: {
      select: vi.fn(),
      insert: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
  };
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
}));

vi.mock("@/lib/config", () => ({
  updateConfig: vi.fn().mockResolvedValue(undefined),
}));

describe("API /api/admin/guardrails", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getSessionMock.mockResolvedValue({
      user: { id: "admin-user-id", role: "admin" },
      session: { id: "sess-1" },
    });
  });

  it("GET returns posture, builtin tools, and interception logs", async () => {
    const mockSelectChain = {
      from: vi.fn().mockReturnValue({
        orderBy: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([
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
            },
          ]),
        }),
      }),
    };

    vi.mocked(db.select).mockReturnValue(mockSelectChain as unknown as ReturnType<typeof db.select>);

    const req = new NextRequest("http://localhost:9300/api/admin/guardrails");
    const res = await GET(req, { params: Promise.resolve({}) });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.builtinTools).toBeDefined();
    expect(data.builtinTools.length).toBeGreaterThan(0);
    expect(data.interceptionLogs).toHaveLength(1);
    expect(data.interceptionLogs[0].category).toBe("tool_risk");
  });

  it("PATCH creates/updates tool overrides and safety policies", async () => {
    const mockSelectChain = {
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([]), // insert new override
        }),
      }),
    };
    const mockInsertChain = {
      values: vi.fn().mockResolvedValue(undefined),
    };

    vi.mocked(db.select).mockReturnValue(mockSelectChain as unknown as ReturnType<typeof db.select>);
    vi.mocked(db.insert).mockReturnValue(mockInsertChain as unknown as ReturnType<typeof db.insert>);

    const req = new NextRequest("http://localhost:9300/api/admin/guardrails", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
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
      }),
    });

    const res = await PATCH(req, { params: Promise.resolve({}) });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);

    expect(db.insert).toHaveBeenCalledTimes(2);
  });
});
