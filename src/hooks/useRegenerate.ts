"use client";

import { useCallback, useEffect, useRef } from "react";

import { useCopilotKit, type CopilotAgent } from "@/lib/copilot/client";

/**
 * Truncates history to the user prompt preceding `message` and re-runs
 * the agent. v2 `onRegenerate` is a notification slot — it doesn't
 * reload messages, so the rerun is driven here.
 *
 * `message` may be an assistant message (toolbar) or a synthetic
 * `error_card` activity message; the target and everything after it is
 * dropped, so a retried failure isn't suppressed by the error-card
 * dedupe. Caller must pass the live per-thread agent (typically via
 * `useAgent` inside the chatView slot). Ref-captured for referential
 * stability.
 */
export function useRegenerate(agent: CopilotAgent | undefined) {
  const { copilotkit } = useCopilotKit();

  // Ref-capture for stability; assignment in useEffect avoids lint noise.
  const agentRef = useRef(agent);
  const copilotKitRef = useRef(copilotkit);
  useEffect(() => {
    agentRef.current = agent;
    copilotKitRef.current = copilotkit;
  });

  return useCallback((message: { id: string }) => {
    const currentAgent = agentRef.current;
    const ck = copilotKitRef.current;
    if (!currentAgent) return;

    const messages = [...currentAgent.messages];
    if (currentAgent.isRunning || messages.length === 0) return;

    const targetIdx = messages.findIndex((m) => m.id === message.id);
    if (targetIdx === -1) return;

    // Truncate to the preceding user message (inclusive).
    let historyCutoff = [messages[0]!];
    if (messages.length > 2 && targetIdx !== 0) {
      const lastUserMsg = messages
        .slice(0, targetIdx)
        .toReversed()
        .find((m) => m.role === "user");
      if (lastUserMsg) {
        const userIdx = messages.findIndex((m) => m.id === lastUserMsg.id);
        historyCutoff = messages.slice(0, userIdx + 1);
      }
    } else if (messages.length > 2 && targetIdx === 0) {
      historyCutoff = [messages[0]!, messages[1]!];
    }

    currentAgent.setMessages(historyCutoff);
    ck.runAgent({ agent: currentAgent }).catch((err: unknown) =>
      console.error("regeneration failed", err),
    );
  }, []); // stable — deps captured via refs
}
