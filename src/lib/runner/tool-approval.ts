import "server-only";

import crypto from "crypto";
import { eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { SshServerTable } from "@/lib/db/schema";
import type { ToolDefinition } from "@/lib/copilot/index.server";
import type { GracefulMcpProvider } from "@/lib/mcp/client-providers";
import { recordEvent, readEvents } from "@/lib/runner/event-store";
import { subscribe, publish, type RunnerEvent } from "@/lib/runner/event-bus";
import { RunSequenceRegistry } from "./sequence-registry";
import { getConfigMs } from "@/lib/config";
import { childLogger } from "@/lib/observability/logger";

const log = childLogger({ component: "tool-approval" });

/** Default approval timeout fallback (seconds). Overridden by config key
 *  `agent.approval_timeout`. */
const DEFAULT_APPROVAL_TIMEOUT_S = 300;

interface ToolCallPayload {
  toolName?: string;
  toolCallId?: string;
  args?: Record<string, unknown>;
  content?: string;
}

interface SshArgs {
  serverName?: string;
  command?: string;
}

interface SqlArgs {
  sql?: string;
}

/**
 * Resolve the AG-UI toolCallId for the most recent call of `toolName`
 * within this run by reading the persisted `tool_call_chunk` events.
 *
 * CONTRACT: `TOOL_CALL_END` (which writes `tool_call_chunk`) fires
 * BEFORE the AI SDK invokes `execute`, so the record is guaranteed to
 * exist by the time this runs inside a wrapped `execute`.  Returns ""
 * when the event is not found (first-run warm-up race, test harness).
 */
async function resolveToolCallId(runId: string, toolName: string): Promise<string> {
  try {
    const events = await readEvents(runId);
    // Walk backwards — the most recent chunk for this tool is what we want.
    for (let i = events.length - 1; i >= 0; i--) {
      const ev = events[i];
      if (ev.type === "tool_call_chunk" && ev.payload && typeof ev.payload === "object") {
        const payload = ev.payload as ToolCallPayload;
        if (payload.toolName === toolName && payload.toolCallId) {
          return payload.toolCallId;
        }
      }
    }
  } catch (e) {
    log.warn({ runId, toolName, err: e }, "resolveToolCallId: failed to read events");
  }
  return "";
}

/**
 * Determine if approval is needed based on mode, toolName, and arguments.
 */
async function evaluateApprovalNeeded(
  toolName: string,
  args: unknown,
  approvalMode: "always" | "auto" | "never"
): Promise<boolean> {
  if (approvalMode === "never") return false;
  if (approvalMode === "always") return true;

  // Auto mode checks

  // 1. SSH Command checks
  if (toolName === "run_ssh_command" && args && typeof args === "object") {
    const sshArgs = args as SshArgs;
    const command = sshArgs.command;
    const serverName = sshArgs.serverName;
    if (typeof command === "string") {
      // (a) Global dangerous pattern checks
      const dangerousPatterns = [
        /\brm\b/i,
        /\bdelete\b/i,
        /\bdrop\b/i,
        /\bmv\b/i,
        /\btruncate\b/i,
        /\bformat\b/i,
        /\bshutdown\b/i,
        /\breboot\b/i,
        /\bkill\b/i,
      ];
      if (dangerousPatterns.some((pattern) => pattern.test(command))) {
        log.info({ toolName, command }, "auto approval triggered: global dangerous ssh pattern matched");
        return true;
      }

      // (b) Per-server commandApprove list matching
      if (typeof serverName === "string") {
        try {
          const servers = await db
            .select()
            .from(SshServerTable)
            .where(eq(SshServerTable.name, serverName))
            .limit(1);
          const server = servers[0] ?? null;
          if (server && server.commandApprove && Array.isArray(server.commandApprove)) {
            for (const pattern of server.commandApprove) {
              if (pattern && new RegExp(pattern, "i").test(command)) {
                log.info({ toolName, command, pattern }, "auto approval triggered: ssh server specific pattern matched");
                return true;
              }
            }
          }
        } catch (e) {
          log.error({ serverName, err: e }, "failed to read SshServerTable for commandApprove checks");
        }
      }
    }
  }

  // 2. Database writes (extract_dataset_by_sql)
  if (toolName === "extract_dataset_by_sql" && args && typeof args === "object") {
    const sqlArgs = args as SqlArgs;
    const sqlQuery = sqlArgs.sql;
    if (typeof sqlQuery === "string") {
      const writeSqlPatterns = [
        /\binsert\b/i,
        /\bupdate\b/i,
        /\bdelete\b/i,
        /\bdrop\b/i,
        /\balter\b/i,
        /\bcreate\b/i,
        /\btruncate\b/i,
        /\breplace\b/i,
      ];
      if (writeSqlPatterns.some((pattern) => pattern.test(sqlQuery))) {
        log.info({ toolName, sqlQuery }, "auto approval triggered: sql write operation detected");
        return true;
      }
    }
  }

  // 3. Generic write/destructive keyword checks (MCP tools, skills, etc.)
  const writeKeywords = ["write", "delete", "remove", "update", "create", "save", "upload", "drop", "destroy", "rm"];
  if (writeKeywords.some((kw) => toolName.toLowerCase().includes(kw))) {
    log.info({ toolName }, "auto approval triggered: tool name contains write keyword");
    return true;
  }

  return false;
}

/**
 * Suspend tool execution and wait for EventBus notification or timeout.
 * CONTRACT: resolves `false` on timeout (treat-as-rejected).
 */
async function waitForApproval(runId: string, approvalId: string, userId: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let resolved = false;

    const timeoutMs = getConfigMs("agent.approval_timeout", DEFAULT_APPROVAL_TIMEOUT_S);

    // Timeout fallback — treat-as-rejected
    const timer = setTimeout(async () => {
      if (resolved) return;
      resolved = true;
      unsubscribe();

      log.warn({ runId, approvalId }, "approval wait timed out; rejecting execution");
      try {
        // CONTRACT: use RunSequenceRegistry to avoid PK collision with concurrent writes.
        const seqNow = await RunSequenceRegistry.getAndIncrement(runId);
        await recordEvent(runId, seqNow, "tool_call_rejected", {
          approvalId,
          reason: "timeout",
        });
      } catch (err) {
        log.error({ runId, err }, "failed to write tool_call_rejected event on timeout");
      }
      resolve(false);
    }, timeoutMs);

    // Event Bus Subscription
    const unsubscribe = subscribe(userId, (event: RunnerEvent) => {
      if (resolved) return;
      if (event.kind === "tool_approval_resolved" && event.runId === runId && event.approvalId === approvalId) {
        resolved = true;
        clearTimeout(timer);
        unsubscribe();
        log.info({ runId, approvalId, approved: event.approved }, "approval event received");
        resolve(event.approved);
      }
    });
  });
}

/**
 * Wrap a tool definition with approval interception logic.
 *
 * CONTRACT: does nothing when `approvalMode === "never"`.
 * CONTRACT: caller is responsible for skipping system/exempt tools before
 * calling this — see `APPROVAL_EXEMPT_TOOLS` in `dispatch/builtin.ts`.
 */
export function wrapToolApproval(
  tool: ToolDefinition,
  toolName: string,
  approvalMode: "always" | "auto" | "never",
  runId: string,
  userId: string
): ToolDefinition {
  if (approvalMode === "never") return tool;
  const originalExecute = tool.execute;
  if (!originalExecute) return tool;

  const originalExecuteTyped = originalExecute as (...args: unknown[]) => unknown;

  return {
    ...tool,
    execute: async (...args: unknown[]) => {
      const toolArgs = args[0];

      // 1. Evaluate if this tool execution requires approval
      const needsApproval = await evaluateApprovalNeeded(toolName, toolArgs, approvalMode);
      if (!needsApproval) {
        return originalExecuteTyped.apply(tool, args);
      }

      // 2. Trigger manual approval flow
      const approvalId = crypto.randomUUID();
      
      // AI SDK passes { toolCallId, messages } as the second argument to `execute`.
      // Prefer this exact toolCallId to avoid race conditions with DB event flushing,
      // which causes old toolCallIds to be incorrectly matched on agent retries.
      const execOptions = args[1] as { toolCallId?: string } | undefined;
      const toolCallId = execOptions?.toolCallId || await resolveToolCallId(runId, toolName);

      try {
        const seqNow = await RunSequenceRegistry.getAndIncrement(runId);

        log.info({ runId, toolName, approvalId, toolCallId, seq: seqNow }, "triggering manual tool approval gate");
        await recordEvent(runId, seqNow, "approval_requested", {
          approvalId,
          toolName,
          arguments: toolArgs,
          toolCallId,
          message: `Approval required: Agent is requesting permission to execute tool '${toolName}'.`,
        });

        publish(userId, {
          kind: "tool_approval_requested",
          runId,
          approvalId,
          toolName,
          args: toolArgs,
          toolCallId,
          message: `Approval required for tool '${toolName}'`,
        });
      } catch (e) {
        log.error({ runId, toolName, err: e }, "failed to write approval_requested event or publish approval request");
        return { isError: true, message: `Tool approval registration failed: ${String(e)}` };
      }

      // Wait for user manual approval
      const approved = await waitForApproval(runId, approvalId, userId);
      if (!approved) {
        return { isError: true, message: `Tool execution was rejected or timed out by the user.` };
      }

      // 3. Continue execution if approved
      return originalExecuteTyped.apply(tool, args);
    },
  };
}

/**
 * Wrap a GracefulMcpProvider so every tool it exposes is subject to the
 * same approval gate as server-side tools.
 *
 * CONTRACT: only call when `approvalMode !== "never"` — the caller
 * (`dispatch/builtin.ts`) guards this.
 */
export function createApprovalWrappedMcpProvider(
  provider: GracefulMcpProvider,
  approvalMode: "always" | "auto",
  runId: string,
  userId: string,
): GracefulMcpProvider {
  return {
    ...provider,
    async tools() {
      const rawTools = (await provider.tools()) as Record<string, unknown>;
      const result: Record<string, unknown> = {};
      for (const [name, tool] of Object.entries(rawTools)) {
        result[name] = wrapToolApproval(
          tool as ToolDefinition,
          name,
          approvalMode,
          runId,
          userId,
        );
      }
      return result as never;
    },
  };
}
