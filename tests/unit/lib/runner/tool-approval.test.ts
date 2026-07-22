import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

import { wrapToolApproval } from "@/lib/runner/tool-approval";
import type { ToolDefinition } from "@/lib/copilot/index.server";

// Mock the dependencies
const mockReadEvents = vi.fn().mockResolvedValue([]);
const mockRecordEvent = vi.fn().mockResolvedValue(undefined);

vi.mock("@/lib/runner/event-store", () => ({
  readEvents: (...args: unknown[]) => mockReadEvents(...args),
  recordEvent: (...args: unknown[]) => mockRecordEvent(...args),
}));

let subscribers: ((event: unknown) => void)[] = [];
const mockSubscribe = vi.fn().mockImplementation((_userId: string, fn: (event: unknown) => void) => {
  subscribers.push(fn);
  return () => {
    subscribers = subscribers.filter((s) => s !== fn);
  };
});
const mockPublish = vi.fn().mockImplementation((_userId: string, event: unknown) => {
  for (const sub of subscribers) {
    sub(event);
  }
});

vi.mock("@/lib/runner/event-bus", () => ({
  subscribe: (...args: unknown[]) => mockSubscribe(...args),
  publish: (...args: unknown[]) => mockPublish(...args),
}));

vi.mock("@/lib/db", () => ({
  db: {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([
            {
              commandApprove: ["^dangerous-cmd.*"],
            },
          ]),
        }),
      }),
    }),
  },
}));

describe("wrapToolApproval", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    subscribers = [];
  });

  it("passes through if approvalMode is 'never'", async () => {
    const originalExecute = vi.fn().mockResolvedValue("success");
    const tool: ToolDefinition = {
      name: "some_tool",
      description: "test tool",
      parameters: { type: "object", properties: {} } as unknown as ToolDefinition["parameters"],
      execute: originalExecute,
    };

    const wrapped = wrapToolApproval(tool, "some_tool", "never", "run123", "user123");
    const res = await wrapped.execute!({});
    
    expect(res).toBe("success");
    expect(originalExecute).toHaveBeenCalled();
    expect(mockRecordEvent).not.toHaveBeenCalled();
  });

  it("gates execution in 'always' mode and resolves if user approves", async () => {
    const originalExecute = vi.fn().mockResolvedValue("executed_safely");
    const tool: ToolDefinition = {
      name: "delete_user",
      description: "sensitive tool",
      parameters: { type: "object", properties: {} } as unknown as ToolDefinition["parameters"],
      execute: originalExecute,
    };

    const wrapped = wrapToolApproval(tool, "delete_user", "always", "run123", "user123");

    // Start execution
    const execPromise = wrapped.execute!({ id: "user_555" });

    // Wait slightly to let the event register and promise suspend
    await new Promise((r) => setTimeout(r, 10));

    // Verify approval_requested event was written and published
    expect(mockRecordEvent).toHaveBeenCalled();
    const eventPayload = mockRecordEvent.mock.calls[0][3] as Record<string, unknown>;
    expect(eventPayload.toolName).toBe("delete_user");

    const approvalId = eventPayload.approvalId as string;
    expect(approvalId).toBeDefined();

    // Simulate user approving via EventBus
    mockPublish("user123", {
      kind: "tool_approval_resolved",
      runId: "run123",
      approvalId,
      approved: true,
    });

    const res = await execPromise;
    expect(res).toBe("executed_safely");
    expect(originalExecute).toHaveBeenCalledWith({ id: "user_555" });
  });

  it("intercepts in 'auto' mode if destructive command is detected", async () => {
    const originalExecute = vi.fn().mockResolvedValue("deleted_files");
    const tool: ToolDefinition = {
      name: "run_ssh_command",
      description: "ssh tool",
      parameters: { type: "object", properties: {} } as unknown as ToolDefinition["parameters"],
      execute: originalExecute,
    };

    // run_ssh_command with rm command triggers global regex check
    const wrapped = wrapToolApproval(tool, "run_ssh_command", "auto", "run123", "user123");
    
    const execPromise = wrapped.execute!({ serverName: "prod", command: "rm -rf /tmp/data" });
    
    await new Promise((r) => setTimeout(r, 10));
    expect(mockRecordEvent).toHaveBeenCalled();
    
    const eventPayload = mockRecordEvent.mock.calls[0][3] as Record<string, unknown>;
    const approvalId = eventPayload.approvalId as string;
    
    // User rejects the command
    mockPublish("user123", {
      kind: "tool_approval_resolved",
      runId: "run123",
      approvalId,
      approved: false,
    });
    
    const res = await execPromise;
    expect(res).toEqual({
      isError: true,
      message: "Tool execution was rejected or timed out by the user.",
    });
    expect(originalExecute).not.toHaveBeenCalled();
  });

  // BUG-9 regression: write-SQL detection must read the real tool param
  // `sql_text`. A previous version read `sql`, so this check never fired.
  it("intercepts a write SQL in 'auto' mode via the sql_text param", async () => {
    const originalExecute = vi.fn().mockResolvedValue({ total_rows: 0 });
    const tool: ToolDefinition = {
      name: "extract_dataset_by_sql",
      description: "sql tool",
      parameters: { type: "object", properties: {} } as unknown as ToolDefinition["parameters"],
      execute: originalExecute,
    };

    const wrapped = wrapToolApproval(tool, "extract_dataset_by_sql", "auto", "run123", "user123");
    const execPromise = wrapped.execute!({ sql_text: "DELETE FROM users WHERE id = 1" });

    await new Promise((r) => setTimeout(r, 10));
    expect(mockRecordEvent).toHaveBeenCalled();
    const approvalId = (mockRecordEvent.mock.calls[0][3] as Record<string, unknown>).approvalId as string;

    mockPublish("user123", { kind: "tool_approval_resolved", runId: "run123", approvalId, approved: false });

    const res = await execPromise;
    expect(res).toEqual({
      isError: true,
      message: "Tool execution was rejected or timed out by the user.",
    });
    expect(originalExecute).not.toHaveBeenCalled();
  });

  it("passes through a read-only SELECT in 'auto' mode without approval", async () => {
    const originalExecute = vi.fn().mockResolvedValue({ total_rows: 3 });
    const tool: ToolDefinition = {
      name: "extract_dataset_by_sql",
      description: "sql tool",
      parameters: { type: "object", properties: {} } as unknown as ToolDefinition["parameters"],
      execute: originalExecute,
    };

    const wrapped = wrapToolApproval(tool, "extract_dataset_by_sql", "auto", "run123", "user123");
    const res = await wrapped.execute!({ sql_text: "SELECT id, name FROM users" });

    expect(res).toEqual({ total_rows: 3 });
    expect(originalExecute).toHaveBeenCalled();
    expect(mockRecordEvent).not.toHaveBeenCalled();
  });

});
