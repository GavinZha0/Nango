import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  getAgentSpecSchema,
  buildGetAgentSpecTool,
} from "@/lib/testing/tools/get-agent-spec";
import type { GetAgentSpecResult } from "@/lib/testing/types";

// Mock db
const mockSelect = vi.fn();
const mockFrom = vi.fn();
const mockLeftJoin = vi.fn();
const mockWhere = vi.fn();
const mockLimit = vi.fn();
const mockOrderBy = vi.fn();

vi.mock("@/lib/db", () => ({
  db: {
    select: (args: unknown) => mockSelect(args),
  },
}));

// Mock visibility
const mockIsAgentVisibleTo = vi.fn();
vi.mock("@/lib/access/agent-visibility", () => ({
  isAgentVisibleTo: (agentId: string, userId: string) =>
    mockIsAgentVisibleTo(agentId, userId),
}));

describe("get_agent_spec tool", () => {
  const validAgentId = "b2c3d4e5-f6a7-4b8c-9d0e-2f3a4b5c6d7e";

  beforeEach(() => {
    vi.clearAllMocks();

    mockSelect.mockReturnValue({ from: mockFrom });
    mockFrom.mockReturnValue({
      leftJoin: mockLeftJoin,
      where: mockWhere,
      orderBy: mockOrderBy,
    });
    mockLeftJoin.mockReturnValue({ where: mockWhere });
    mockWhere.mockReturnValue({ limit: mockLimit, orderBy: mockOrderBy });
    mockLimit.mockResolvedValue([]);
    mockOrderBy.mockResolvedValue([]);
  });

  describe("Schema Validation", () => {
    it("accepts valid agentId", () => {
      const parsed = getAgentSpecSchema.safeParse({
        agentId: validAgentId,
      });
      expect(parsed.success).toBe(true);
    });

    it("rejects missing agentId", () => {
      const parsed = getAgentSpecSchema.safeParse({});
      expect(parsed.success).toBe(false);
    });

    it("rejects invalid UUID strings", () => {
      const parsed = getAgentSpecSchema.safeParse({
        agentId: "invalid-uuid",
      });
      expect(parsed.success).toBe(false);
    });
  });

  describe("Execution", () => {
    it("throws error if agent is not visible to the user", async () => {
      mockIsAgentVisibleTo.mockResolvedValueOnce(false);

      const tool = buildGetAgentSpecTool({ userId: "user-1" });
      await expect(
        tool.execute!({ agentId: validAgentId }),
      ).rejects.toThrow(/not found or access denied/i);
    });

    it("throws error if agent row does not exist", async () => {
      mockIsAgentVisibleTo.mockResolvedValueOnce(true);
      mockLimit.mockResolvedValueOnce([]);

      const tool = buildGetAgentSpecTool({ userId: "user-1" });
      await expect(
        tool.execute!({ agentId: validAgentId }),
      ).rejects.toThrow(/Target agent .* not found/i);
    });

    it("returns agent specification with system prompt, bound tools, and skills", async () => {
      mockIsAgentVisibleTo.mockResolvedValueOnce(true);

      mockLimit.mockResolvedValueOnce([
        {
          id: validAgentId,
          name: "SupportAgent",
          description: "Handles customer support queries",
          role: null,
          model: "gpt-4o",
          modelProvider: "openai",
          prompt: "You are a customer support agent. Always be polite.",
        },
      ]);

      mockOrderBy.mockResolvedValueOnce([
        {
          toolType: "builtin_tool",
          builtinTool: "web_search",
          mcpToolName: null,
          skillSlug: null,
        },
        {
          toolType: "skill",
          builtinTool: null,
          mcpToolName: null,
          skillSlug: "refund-processing",
        },
        {
          toolType: "mcp_tool",
          builtinTool: null,
          mcpToolName: "query_order",
          skillSlug: null,
        },
      ]);

      const tool = buildGetAgentSpecTool({ userId: "user-1" });
      const result = (await tool.execute!({
        agentId: validAgentId,
      })) as GetAgentSpecResult;

      expect(result.agentId).toBe(validAgentId);
      expect(result.name).toBe("SupportAgent");
      expect(result.systemPrompt).toBe(
        "You are a customer support agent. Always be polite.",
      );
      expect(result.model).toBe("gpt-4o");
      expect(result.tools).toEqual(["web_search", "query_order"]);
      expect(result.skills).toEqual(["refund-processing"]);
    });
  });
});
