import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  DEFAULT_SAFETY_POLICIES,
  getGuardrailConfigCache,
  getToolRiskOverride,
  invalidateGuardrailCache,
  loadAllGuardrailConfigs,
  recordInterceptionLog,
  seedSafetyPolicies,
} from "@/lib/agent-pipeline/guardrail-service";
import { db } from "@/lib/db";
import { SafetyPolicyTable, ToolRiskOverrideTable } from "@/lib/db/schema";

vi.mock("@/lib/db", () => {
  return {
    db: {
      select: vi.fn(),
      insert: vi.fn(),
    },
  };
});

describe("guardrail-service", () => {
  beforeEach(() => {
    invalidateGuardrailCache();
    vi.clearAllMocks();
  });

  it("defines 8 baseline seed policies", () => {
    expect(DEFAULT_SAFETY_POLICIES.length).toBe(8);
    const names = DEFAULT_SAFETY_POLICIES.map((p) => p.name);
    expect(names).toContain("llm_api_key_redact");
    expect(names).toContain("chinese_phone_redact");
    expect(names).toContain("system_tag_injection_block");
  });

  it("seeds policies when they do not exist", async () => {
    const mockFrom = vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue([]), // none exist
      }),
    });
    const mockValues = vi.fn().mockResolvedValue(undefined);

    vi.mocked(db.select).mockReturnValue({ from: mockFrom } as unknown as ReturnType<typeof db.select>);
    vi.mocked(db.insert).mockReturnValue({ values: mockValues } as unknown as ReturnType<typeof db.insert>);

    await seedSafetyPolicies();

    expect(db.insert).toHaveBeenCalledTimes(8);
  });

  it("loads and caches tool overrides and safety policies", async () => {
    const fakeOverride = {
      id: 10,
      source: "mcp",
      mcpServerId: "srv-1",
      toolName: "delete_db",
      riskLevel: "critical",
      requireApproval: "always",
      headlessAllowed: false,
      enabled: true,
    };
    const fakePolicy = {
      id: 20,
      name: "custom_rule_1",
      displayName: "Custom Rule 1",
      category: "output_redaction",
      policyType: "regex",
      action: "block",
      severity: "high",
      scope: "global",
      enabled: true,
      policyConfig: {},
    };

    vi.mocked(db.select).mockImplementation(() => ({
      from: vi.fn().mockImplementation((table: unknown) => {
        if (table === ToolRiskOverrideTable) {
          const res = [fakeOverride];
          return Object.assign(Promise.resolve(res), {
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([{ id: 1 }]),
            }),
          });
        }
        if (table === SafetyPolicyTable) {
          const res = [fakePolicy];
          return Object.assign(Promise.resolve(res), {
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([{ id: 1 }]),
            }),
          });
        }
        return {
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{ id: 1 }]),
          }),
        };
      }),
    } as unknown as ReturnType<typeof db.select>));

    await loadAllGuardrailConfigs();

    const cache = getGuardrailConfigCache();
    expect(cache.loaded).toBe(true);
    expect(cache.safetyPolicies.length).toBe(1);
    expect(cache.safetyPolicies[0].name).toBe("custom_rule_1");

    const override = getToolRiskOverride("mcp", "srv-1", "delete_db");
    expect(override).toBeDefined();
    expect(override?.requireApproval).toBe("always");
  });

  it("clears cache on invalidateGuardrailCache", () => {
    invalidateGuardrailCache();
    const cache = getGuardrailConfigCache();
    expect(cache.loaded).toBe(false);
    expect(cache.safetyPolicies.length).toBe(0);
    expect(cache.toolOverrides.size).toBe(0);
  });

  it("records interception audit log into SafetyInterceptionLogTable", async () => {
    const mockValues = vi.fn().mockResolvedValue(undefined);
    vi.mocked(db.insert).mockReturnValue({ values: mockValues } as unknown as ReturnType<typeof db.insert>);

    await recordInterceptionLog({
      stage: "output",
      category: "output_redaction",
      policyName: "chinese_phone_redact",
      policyType: "regex",
      action: "redact",
      severity: "medium",
      payload: { matchCount: 1 },
    });

    expect(db.insert).toHaveBeenCalledTimes(1);
    expect(mockValues).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: "output",
        category: "output_redaction",
        policyName: "chinese_phone_redact",
        action: "redact",
      }),
    );
  });
});
