"use client";

import { useEffect, useRef } from "react";
import { GENERATIVE_UI_ACTIVITY_TYPE } from "@copilotkit/shared/generative-ui";
import type { CopilotAgent } from "@/lib/copilot/client";
import {
  deriveSurfaceOutcomeId,
  extractSurfaceTitle,
  parseSurfaceContent,
} from "@/lib/generative-ui/surface";
import { useOutcomeStore } from "@/store/outcome-store";
import { useWorkspaceStore } from "@/store/workspace";

/**
 * Live tap for `generative-ui-surface` activity messages on the active
 * CopilotKit agent. Upserts ready surfaces into `outcomeStore` so A2UI
 * outputs appear in `/outcomes` alongside server-produced outcomes.
 */
export function useA2UiOutcomeTap(
  agent: CopilotAgent | undefined,
  enabled: boolean,
): void {
  const seenSignaturesRef = useRef<Map<string, string>>(new Map());
  const runtimeThreadId = useWorkspaceStore((s) => s.runtimeThreadId);

  useEffect(() => {
    seenSignaturesRef.current.clear();
  }, [agent, runtimeThreadId]);

  useEffect(() => {
    if (!agent || !enabled) return;

    const syncMessages = (messages: readonly unknown[]) => {
      for (const msg of messages) {
        if (!msg || typeof msg !== "object") continue;
        const m = msg as Record<string, unknown>;
        if (m.role !== "activity" || m.activityType !== GENERATIVE_UI_ACTIVITY_TYPE) {
          continue;
        }
        const surface = parseSurfaceContent(m.content);
        if (!surface || surface.status !== "ready" || surface.operations.length === 0) {
          continue;
        }

        const outcomeId = deriveSurfaceOutcomeId(surface.surfaceId);
        const signature = `${surface.status}:${surface.operations.length}:${surface.rejected.length}`;
        if (seenSignaturesRef.current.get(outcomeId) === signature) {
          continue;
        }
        seenSignaturesRef.current.set(outcomeId, signature);

        const ws = useWorkspaceStore.getState();
        useOutcomeStore.getState().addOutcome({
          outcomeId,
          kind: "report",
          title: extractSurfaceTitle(surface),
          blocks: [{ kind: "a2ui", surface }],
          agentId: ws.activeAgentId,
          threadId: ws.runtimeThreadId ?? null,
          runId: null,
          createdAt: Date.now(),
          collapsed: false,
          savedArtifactId: null,
          revision: String(surface.operations.length),
          savedRevision: null,
        });
      }
    };

    const sub = agent.subscribe({
      onMessagesChanged: ({ messages }) => {
        syncMessages(messages);
      },
    });

    return () => {
      sub.unsubscribe();
    };
  }, [agent, enabled]);
}
