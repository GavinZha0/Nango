import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  extractToolName,
  handleToolCallResultEvent,
} from "@/hooks/useTestMutationSubscriber";
import { invalidateTestModuleCache } from "@/lib/testing/cache-invalidation.client";

vi.mock("@/lib/testing/cache-invalidation.client", () => ({
  invalidateTestModuleCache: vi.fn(),
}));

describe("useTestMutationSubscriber", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("extractToolName", () => {
    it("extracts tool name from OpenAI style function tool calls", () => {
      const messages = [
        { role: "user", content: "hello" },
        {
          role: "assistant",
          toolCalls: [
            {
              id: "call-1",
              type: "function",
              function: { name: "create_test_cases" },
            },
          ],
        },
      ];

      expect(extractToolName(messages, "call-1")).toBe("create_test_cases");
      expect(extractToolName(messages, "unknown-id")).toBe("");
    });

    it("extracts tool name from flat name property", () => {
      const messages = [
        {
          role: "assistant",
          toolCalls: [{ id: "call-2", name: "delete_test_case" }],
        },
      ];

      expect(extractToolName(messages, "call-2")).toBe("delete_test_case");
    });
  });

  describe("handleToolCallResultEvent", () => {
    const createMessagesWithTool = (toolName: string, callId: string) => [
      {
        role: "assistant",
        toolCalls: [
          {
            id: callId,
            type: "function",
            function: { name: toolName },
          },
        ],
      },
    ];

    it("triggers invalidation when create_test_cases returns valid verification payload", () => {
      const messages = createMessagesWithTool("create_test_cases", "call-123");
      const event = {
        toolCallId: "call-123",
        content: JSON.stringify({
          category: "verification",
          suiteId: "suite-mcp-1",
          createdCount: 2,
          cases: [{ id: 1, name: "case-1" }],
        }),
      };

      handleToolCallResultEvent(event, messages);

      expect(invalidateTestModuleCache).toHaveBeenCalledWith({
        category: "verification",
        suiteId: "suite-mcp-1",
        toolName: "create_test_cases",
      });
    });

    it("triggers invalidation when create_test_suite returns suite.id", () => {
      const messages = createMessagesWithTool("create_test_suite", "call-suite-1");
      const event = {
        toolCallId: "call-suite-1",
        content: JSON.stringify({
          category: "evaluation",
          suite: { id: "eval-suite-99", name: "Agent Eval" },
        }),
      };

      handleToolCallResultEvent(event, messages);

      expect(invalidateTestModuleCache).toHaveBeenCalledWith({
        category: "evaluation",
        suiteId: "eval-suite-99",
        toolName: "create_test_suite",
      });
    });

    it("triggers invalidation when update_test_case returns case.suiteId", () => {
      const messages = createMessagesWithTool("update_test_case", "call-upd");
      const event = {
        toolCallId: "call-upd",
        content: JSON.stringify({
          category: "web-auto",
          updated: true,
          case: { id: 10, suiteId: "web-suite-44" },
        }),
      };

      handleToolCallResultEvent(event, messages);

      expect(invalidateTestModuleCache).toHaveBeenCalledWith({
        category: "web-auto",
        suiteId: "web-suite-44",
        toolName: "update_test_case",
      });
    });

    it("triggers invalidation when delete_test_case returns suiteId", () => {
      const messages = createMessagesWithTool("delete_test_case", "call-del");
      const event = {
        toolCallId: "call-del",
        content: JSON.stringify({
          category: "verification",
          deleted: true,
          caseId: 5,
          suiteId: "suite-mcp-2",
        }),
      };

      handleToolCallResultEvent(event, messages);

      expect(invalidateTestModuleCache).toHaveBeenCalledWith({
        category: "verification",
        suiteId: "suite-mcp-2",
        toolName: "delete_test_case",
      });
    });

    it("ignores non-mutation tools like web_search", () => {
      const messages = createMessagesWithTool("web_search", "call-search");
      const event = {
        toolCallId: "call-search",
        content: JSON.stringify({ query: "test", results: [] }),
      };

      handleToolCallResultEvent(event, messages);

      expect(invalidateTestModuleCache).not.toHaveBeenCalled();
    });

    it("ignores errors (isError: true)", () => {
      const messages = createMessagesWithTool("create_test_cases", "call-err");
      const event = {
        toolCallId: "call-err",
        content: JSON.stringify({
          isError: true,
          message: "Duplicate case name",
        }),
      };

      handleToolCallResultEvent(event, messages);

      expect(invalidateTestModuleCache).not.toHaveBeenCalled();
    });

    it("ignores unparseable or non-object content", () => {
      const messages = createMessagesWithTool("create_test_cases", "call-bad");
      const event = {
        toolCallId: "call-bad",
        content: "not json",
      };

      handleToolCallResultEvent(event, messages);

      expect(invalidateTestModuleCache).not.toHaveBeenCalled();
    });
  });
});
