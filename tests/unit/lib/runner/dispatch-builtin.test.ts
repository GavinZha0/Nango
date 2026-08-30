import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

const { recordEventMock } = vi.hoisted(() => ({
  recordEventMock: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/runner/event-store", () => ({
  recordEvent: recordEventMock,
}));

const { mcpReleaseMock } = vi.hoisted(() => ({
  mcpReleaseMock: vi.fn(),
}));

vi.mock("@/lib/mcp", () => ({
  mcpProviderPool: {
    release: mcpReleaseMock,
    borrow: vi.fn(),
  },
}));

vi.mock("@/lib/builtin-agents/model-resolver", () => ({
  resolveLanguageModel: vi.fn().mockResolvedValue({
    model: "mock-model",
    temperature: 0.7,
  }),
}));

import {
  classifyBuiltinPath,
  releaseBuiltinBorrows,
  recordCapabilityDegradations,
  type BorrowRecord,
  type CapabilityDegradation,
} from "@/lib/runner/dispatch/builtin";
import type { childLogger } from "@/lib/observability/logger";
import type { GracefulMcpProvider } from "@/lib/mcp/client-providers";

const mockLogger = {
  warn: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
} as unknown as ReturnType<typeof childLogger>;

describe("Runner Dispatch — Builtin Agents Dispatcher", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("classifyBuiltinPath", () => {
    it("correctly extracts agentId and action for run/connect/stop endpoints", () => {
      expect(classifyBuiltinPath("/api/copilotkit/builtin/agent/agent-abc-123/run")).toEqual({
        agentId: "agent-abc-123",
        action: "run",
      });

      expect(classifyBuiltinPath("/api/copilotkit/builtin/agent/agent-xyz/connect")).toEqual({
        agentId: "agent-xyz",
        action: "connect",
      });

      expect(classifyBuiltinPath("/api/copilotkit/builtin/agent/agent-999/stop")).toEqual({
        agentId: "agent-999",
        action: "stop",
      });
    });

    it("returns null for non-agent bookkeeping endpoints", () => {
      expect(classifyBuiltinPath("/api/copilotkit/builtin/info")).toBeNull();
      expect(classifyBuiltinPath("/api/copilotkit/builtin")).toBeNull();
      expect(classifyBuiltinPath("/api/copilotkit/builtin/threads/t-1")).toBeNull();
    });
  });

  describe("releaseBuiltinBorrows", () => {
    it("safely releases all borrowed MCP providers in ledger", () => {
      const mockProviderA = { serverId: "mcp-server-1" } as unknown as GracefulMcpProvider;
      const mockProviderB = { serverId: "mcp-server-2" } as unknown as GracefulMcpProvider;

      const borrows: BorrowRecord[] = [
        { serverId: "mcp-server-1", provider: mockProviderA },
        { serverId: "mcp-server-2", provider: mockProviderB },
      ];

      releaseBuiltinBorrows(borrows);

      expect(mcpReleaseMock).toHaveBeenCalledTimes(2);
      expect(mcpReleaseMock).toHaveBeenNthCalledWith(1, "mcp-server-1", mockProviderA);
      expect(mcpReleaseMock).toHaveBeenNthCalledWith(2, "mcp-server-2", mockProviderB);
    });

    it("handles empty borrow ledger gracefully without errors", () => {
      expect(() => releaseBuiltinBorrows([])).not.toThrow();
      expect(mcpReleaseMock).not.toHaveBeenCalled();
    });
  });

  describe("recordCapabilityDegradations", () => {
    it("persists each degradation as a degraded event starting from given sequence number", async () => {
      const degradations: CapabilityDegradation[] = [
        {
          ref: "mcp-1",
          refName: "Fetch MCP",
          reason: "mcp_borrow_failed",
          message: "Connection timeout",
        },
        {
          ref: "skill-2",
          refName: "Python Exec",
          reason: "skill_parse_failed",
          message: "Invalid syntax",
        },
      ];

      const nextSeq = await recordCapabilityDegradations("run-xyz", degradations, mockLogger, 5);

      expect(nextSeq).toBe(7);
      expect(recordEventMock).toHaveBeenCalledTimes(2);
      expect(recordEventMock).toHaveBeenNthCalledWith(1, "run-xyz", 5, "degraded", degradations[0]);
      expect(recordEventMock).toHaveBeenNthCalledWith(2, "run-xyz", 6, "degraded", degradations[1]);
    });

    it("returns startSeq directly when degradations list is empty", async () => {
      const nextSeq = await recordCapabilityDegradations("run-xyz", [], mockLogger, 3);
      expect(nextSeq).toBe(3);
      expect(recordEventMock).not.toHaveBeenCalled();
    });
  });
});
