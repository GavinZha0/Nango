"use client";

import { useCallback, useEffect } from "react";
import { type CopilotAgent, useCopilotKit } from "@/lib/copilot/client";
import { useValidatedFrontendTool } from "@/lib/copilot/frontend-tool-helpers";

import {
  HandoffCard,
  switchAgentWithContextArgsSchema,
  type SwitchAgentWithContextArgs,
} from "@/components/right-panels/HandoffCard";
import { useWorkspaceStore, type PreviousAgentSnapshot } from "@/store/workspace";
import { computeDisplayName } from "@/lib/orchestration/display-name";

function useResolveTarget(): (
  args: SwitchAgentWithContextArgs,
) => PreviousAgentSnapshot | null {
  const builtinAgents = useWorkspaceStore((s) => s.builtinAgents);
  const agents = useWorkspaceStore((s) => s.agents);
  const teams = useWorkspaceStore((s) => s.teams);
  const workflows = useWorkspaceStore((s) => s.workflows);
  const userId = useWorkspaceStore((s) => s.userId);

  return useCallback(
    (args) => {
      const target = args.agent.trim();
      if (!target) return null;

      for (const a of builtinAgents) {
        if (!a.enabled || a.isSupervisor === true) continue;
        const isPublicByOthers =
          a.visibility === "public"
          && userId !== undefined
          && a.createdBy !== userId;
        const dn = computeDisplayName({
          source: "builtin",
          isPublicByOthers,
          name: a.name,
        });
        if (dn === target) {
          return {
            id: a.id,
            type: "agent",
            source: "builtin",
            name: a.name,
          };
        }
      }

      const all = [
        ...agents.map((e) => ({ ...e, type: "agent" as const })),
        ...teams.map((e) => ({ ...e, type: "team" as const })),
        ...workflows.map((e) => ({ ...e, type: "workflow" as const })),
      ];
      for (const e of all) {
        const dn = computeDisplayName({
          source: "backend",
          credentialName: e.credentialName,
          name: e.name ?? e.id,
        });
        if (dn === target) {
          return {
            id: e.id,
            type: e.type,
            source: "backend",
            credentialId: e.credentialId,
            provider: e.provider,
            name: e.name,
          };
        }
      }

      return null;
    },
    [builtinAgents, agents, teams, workflows, userId],
  );
}

export function useHandoffTools(): void {
  const enterAgent = useWorkspaceStore((s) => s.enterAgent);
  const resolveTarget = useResolveTarget();

  useValidatedFrontendTool<SwitchAgentWithContextArgs>({
    name: "switch_agent_with_context",
    description:
      "Hand the user's conversation off to a specialist. Pass the specialist's `agent` exactly as listed under 'Available specialists' in this prompt, and write a self-contained briefing as `contextSummary` so they can continue without the original transcript. After this returns, the user is no longer with you — wrap up briefly.",
    parameters: switchAgentWithContextArgsSchema,
    handler: async (args) => {
      const target = resolveTarget(args);
      if (!target) {
        return {
          isError: true,
          severity: "error",
          message: `Agent '${args.agent}' not found in the catalog.`,
        };
      }
      enterAgent(target, args.contextSummary);
      return {
        ok: true,
        target: target.name ?? target.id,
        message: `Handed off to ${target.name ?? target.id}.`,
      };
    },
    render: HandoffCard,
  });
}

/**
 * Drains the pending handoff context (set by `enterAgent`) and dispatches
 * it as a synthetic first user message on the agent the chat surface is
 * currently showing.
 *
 * Caller passes the live per-thread agent in directly — must be the same
 * instance the UI is subscribed to (typically obtained via `useAgent`
 * inside the chatView slot shell). See docs/chat-flow-audit.md §1.10.
 *
 * De-duplication relies on `consumeHandoffContext` being an atomic
 * read-and-clear: once the pending text has been consumed, subsequent
 * effect runs see `null` and bail. No per-agent ref guard is needed —
 * an explicit one previously here was redundant given the atomicity,
 * and it accidentally blocked the legitimate case of injecting a
 * fresh context into the same agent within one mount lifecycle (a
 * pattern we don't use today but want to keep the door open for).
 */
export function useInjectHandoffContext(agent: CopilotAgent | undefined): void {
  const { copilotkit } = useCopilotKit();
  const consumeHandoffContext = useWorkspaceStore(
    (s) => s.consumeHandoffContext,
  );

  useEffect(() => {
    if (!agent) return;
    const text = consumeHandoffContext();
    if (!text) return;

    agent.setMessages([
      {
        id: crypto.randomUUID(),
        role: "user",
        content: text,
      },
    ]);
    copilotkit
      .runAgent({ agent })
      .catch((err: unknown) =>
        console.error("Handoff: failed to dispatch context", err),
      );
  }, [agent, copilotkit, consumeHandoffContext]);
}
