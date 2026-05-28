"use client";

/**
 * WorkspaceProvider — bootstraps workspace state.
 */

import { useWorkspaceStore } from "@/store/workspace";
import { useOutcomeStore } from "@/store/outcome-store";
import { getEntities, toBackendCredentials } from "@/lib/backends/facade";
import type { BackendCredentialInfo } from "@/lib/backends/facade";
import type { EntityKind } from "@/lib/backends/types";
import { authClient } from "@/lib/auth/client";
import { useEffect, useRef } from "react";
import type { ReactNode } from "react";
import type { BuiltinAgentRow } from "@/components/main-panels/BuiltinAgentEditor";
import { useStartNotifications } from "@/hooks/useNotifications";

interface WorkspaceProviderProps {
  children: ReactNode;
}

export function WorkspaceProvider({ children }: WorkspaceProviderProps) {
  const { data: sessionData } = authClient.useSession();
  const userId = sessionData?.user.id;
  const setActiveAgent = useWorkspaceStore((s) => s.setActiveAgent);
  const setEntities = useWorkspaceStore((s) => s.setEntities);
  const mergeBuiltinAgents = useWorkspaceStore((s) => s.mergeBuiltinAgents);
  const setUserId = useWorkspaceStore((s) => s.setUserId);

  useEffect(() => {
    setUserId(userId);
  }, [userId, setUserId]);

  // Boot the notification subsystem (initial fetch + SSE stream +
  // BroadcastChannel listener). Once is enough; the hook itself is
  // idempotent across re-renders.
  useStartNotifications();

  // Outcome panel ↔ thread coupling.
  //
  // Subscribe to workspaceStore.runtimeThreadId so the Outcomes panel
  // tracks the live thread. (We pick runtimeThreadId not explicitThreadId
  // because outcomes are attribution — they belong to whichever thread
  // actually ran the chart, regardless of whether the user got here via
  // fresh chat or history restore.) See docs/chat-flow-audit.md §1.11.
  //
  // Clear/load policy (see docs/data-visualization.md §6.7):
  //
  //  - null → uuid (FIRST-time capture for this session):
  //      do NOT clear — render_chart handlers running in-flight
  //      may have JUST added outcomes whose `threadId` field is
  //      still null/"unknown" because workspaceStore hadn't seen
  //      the id yet. Load only if the local list is empty — that
  //      covers the page-refresh path without blowing away
  //      just-added charts.
  //
  //  - uuid₁ → uuid₂ (real thread switch — new chat, history click,
  //      handoff): clear and load.
  //
  //  - uuid → null (logout, agent switch that resets thread):
  //      clear; don't load.
  //
  //  - equal: no-op.
  useEffect(() => {
    const unsubscribe = useWorkspaceStore.subscribe((state, prev) => {
      const next = state.runtimeThreadId;
      const prior = prev.runtimeThreadId;
      if (next === prior) return;

      const store = useOutcomeStore.getState();

      if (prior === null && next !== null) {
        // First capture for this session — preserve any optimistic
        // outcomes added during the in-flight run. Back-fill their
        // (still-null) threadId so the Save flow has the real id.
        store.bindPendingThreadId(next);
        if (store.outcomes.length === 0) {
          void store.loadForThread(next);
        }
        return;
      }

      // Either uuid → null or uuid₁ → uuid₂ — both need a clear.
      store.clearForThreadSwitch();
      if (next !== null) {
        void store.loadForThread(next);
      }
    });
    return unsubscribe;
  }, []);

  // Load all three agent sources in parallel exactly once on mount.
  // Each source updates the store as soon as it arrives. The first source
  // with available agents auto-selects the default for the chat panel.
  // `cancelled` only goes true on unmount — NOT when an agent is selected,
  // so slower sources still get their data merged into the store.
  const didLoad = useRef(false);

  useEffect(() => {
    if (didLoad.current) return;
    didLoad.current = true;

    let unmounted = false;

    async function loadAllSources() {
      let creds: BackendCredentialInfo[] = [];
      try {
        const res = await fetch("/api/agent-credentials");
        if (res.ok) {
          const data = await res.json();
          creds = toBackendCredentials(data);
        }
      } catch {
        // no credentials configured — will show empty backend list
      }

      /** Auto-select if nothing is selected yet. */
      function tryAutoSelect(
        id: string,
        type: EntityKind,
        source: "backend" | "builtin",
        credentialId?: string,
        provider?: string,
      ) {
        const { activeAgentId } = useWorkspaceStore.getState();
        if (!activeAgentId) {
          setActiveAgent(id, type, source, credentialId, provider);
        }
      }

      // Source 1: Backend entities — single fan-out across all kinds.
      // Each adapter dispatches whatever upstream calls it needs and
      // tags every descriptor with `kind`.
      const entitiesP = getEntities(creds).then((result) => {
        if (unmounted) return;
        const entities = result.data ?? [];
        setEntities(entities);
        // Auto-select the first agent (workflows can't be chatted with
        // and teams are a fallback if no agent exists).
        const firstAgent =
          entities.find((e) => e.kind === "agent")
          ?? entities.find((e) => e.kind === "team");
        if (firstAgent) {
          tryAutoSelect(
            firstAgent.id,
            firstAgent.kind,
            "backend",
            firstAgent.credentialId,
            firstAgent.provider,
          );
        }
      });

      // Source 2: Built-in agents
      //
      // Auto-select policy: the user's Nango (supervisor) wins over
      // every other agent. Nango is the workspace-level default
      // entry-point — when configured, the user should land on it on
      // every fresh boot. We pre-empt the backend autoselect race by
      // setting the active agent unconditionally here once the
      // supervisor row arrives. Falls back to the first enabled normal
      // agent only when no supervisor exists.
      const builtinP = fetch("/api/builtin-agents")
        .then((res) => (res.ok ? res.json() as Promise<BuiltinAgentRow[]> : []))
        .catch(() => [] as BuiltinAgentRow[])
        .then((rows) => {
          if (unmounted) return;
          mergeBuiltinAgents(rows);
          const supervisor = rows.find(
            (r) => r.enabled && r.isSupervisor === true,
          );
          if (supervisor) {
            // Force-set even if a backend agent already won the race;
            // Nango is the canonical default and beats first-result
            // ordering.
            setActiveAgent(supervisor.id, "agent", "builtin");
            return;
          }
          const first = rows.find((r) => r.enabled);
          if (first) {
            tryAutoSelect(first.id, "agent", "builtin");
          }
        });

      await Promise.allSettled([entitiesP, builtinP]);
    }

    void loadAllSources();
    return () => { unmounted = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- run once on mount
  }, []);

  return <>{children}</>;
}
