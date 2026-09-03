"use client";

import { useEffect } from "react";
import type { CopilotAgent } from "@/lib/copilot/client";
import { invalidateTestModuleCache } from "@/lib/testing/cache-invalidation.client";

export const TEST_MUTATION_TOOLS = new Set([
  "create_test_cases",
  "create_test_suite",
  "update_test_case",
  "delete_test_case",
]);

interface ToolCallItem {
  id?: string;
  name?: string;
  function?: {
    name?: string;
  };
}

export function extractToolName(messages: readonly unknown[], toolCallId: string): string {
  for (const msg of messages) {
    if (!msg || typeof msg !== "object") continue;
    const m = msg as Record<string, unknown>;
    if (Array.isArray(m.toolCalls)) {
      for (const tc of m.toolCalls) {
        if (!tc || typeof tc !== "object") continue;
        const call = tc as ToolCallItem;
        if (call.id === toolCallId) {
          return call.function?.name ?? call.name ?? "";
        }
      }
    }
  }
  return "";
}

/**
 * Pure handler for AG-UI onToolCallResultEvent.
 * Decoupled from React for deterministic testing and reuse.
 */
export function handleToolCallResultEvent(
  event: { toolCallId: string; content: unknown },
  messages: readonly unknown[],
): void {
  const toolName = extractToolName(messages, event.toolCallId);
  if (toolName && !TEST_MUTATION_TOOLS.has(toolName)) {
    return;
  }

  let payload: Record<string, unknown> | null = null;
  if (typeof event.content === "string") {
    try {
      payload = JSON.parse(event.content);
    } catch {
      return;
    }
  } else if (event.content && typeof event.content === "object") {
    payload = event.content as Record<string, unknown>;
  }

  if (!payload || payload.isError === true) return;

  const category = payload.category as
    | "verification"
    | "evaluation"
    | "web-auto"
    | undefined;

  if (
    category !== "verification" &&
    category !== "evaluation" &&
    category !== "web-auto"
  ) {
    return;
  }

  const suiteId = (
    payload.suiteId ??
    (payload.suite as { id?: string } | undefined)?.id ??
    (payload.case as { suiteId?: string } | undefined)?.suiteId
  ) as string | undefined;

  invalidateTestModuleCache({ category, suiteId, toolName });
}

/**
 * Protocol-level subscriber that listens to AG-UI TOOL_CALL_RESULT events
 * on the active Agent and triggers cache invalidation for testing resources.
 */
export function useTestMutationSubscriber(agent: CopilotAgent | undefined): void {
  useEffect(() => {
    if (!agent) return;

    const sub = agent.subscribe({
      onToolCallResultEvent: ({ event, messages }) => {
        handleToolCallResultEvent(event, messages);
      },
    });

    return () => {
      sub.unsubscribe();
    };
  }, [agent]);
}
