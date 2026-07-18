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
import type { BuiltinAgentRow } from "@/lib/types/builtin-agent";
import { useStartNotifications } from "@/hooks/useNotifications";

interface WorkspaceProviderProps {
  children: ReactNode;
}

export function WorkspaceProvider({ children }: WorkspaceProviderProps) {
  const { data: sessionData } = authClient.useSession();
  const userId = sessionData?.user.id;
  const setActiveAgent = useWorkspaceStore((s) => s.setActiveAgent);
  const setEntities = useWorkspaceStore((s) => s.setEntities);
  const setBackendCredentials = useWorkspaceStore((s) => s.setBackendCredentials);
  const mergeBuiltinAgents = useWorkspaceStore((s) => s.mergeBuiltinAgents);
  const setUserId = useWorkspaceStore((s) => s.setUserId);

  useEffect(() => {
    setUserId(userId);
  }, [userId, setUserId]);

  const userFields = sessionData?.user as
    | {
        timezone?: string | null;
        timezoneFollowBrowser?: boolean | null;
        mustChangePassword?: boolean | null;
      }
    | undefined;

  const mustChangePassword = userFields?.mustChangePassword === true;
  useEffect(() => {
    if (mustChangePassword && window.location.pathname !== "/profile") {
      window.location.replace("/profile");
    }
  }, [mustChangePassword]);

  // Timezone sync — two modes controlled by `timezoneFollowBrowser`:
  //
  //   followBrowser = true (default):
  //     On every session load, if the browser timezone differs from
  //     the stored profile timezone, update the profile to match.
  //     This keeps `user.timezone` fresh for users who travel or
  //     change their system timezone.
  //
  //   followBrowser = false:
  //     The stored timezone is a fixed value set by the user on the
  //     Profile page. Auto-sync is skipped entirely.
  //
  // First-visit (timezone is null, regardless of followBrowser):
  //   Always seed from the browser so `timezone` has a value.
  const tzSyncedRef = useRef(false);
  const currentTz = userFields?.timezone ?? null;
  const followBrowser = userFields?.timezoneFollowBrowser ?? true;
  useEffect(() => {
    if (!userId || tzSyncedRef.current) return;
    const browserTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (!browserTz) return;

    // Nothing to do: fixed mode and timezone already populated.
    if (!followBrowser && currentTz) return;

    // Nothing to do: follow mode but timezone already matches browser.
    if (followBrowser && currentTz === browserTz) return;

    tzSyncedRef.current = true;
    void authClient
      .updateUser({ timezone: browserTz })
      .then((res) => {
        if (res?.error) {
          tzSyncedRef.current = false;
          console.warn("[workspace] timezone sync failed", res.error);
        }
      })
      .catch((err) => {
        tzSyncedRef.current = false;
        console.warn("[workspace] timezone sync error", err);
      });
  }, [userId, currentTz, followBrowser]);

  // Boot notifications (initial fetch + SSE + BroadcastChannel).
  // Idempotent across re-renders.
  useStartNotifications();

  // Outcome panel ↔ runtimeThreadId coupling.
  //   null → uuid : first capture; back-fill pending threadIds and
  //                 only load if local list is empty (don't wipe
  //                 in-flight optimistic outcomes).
  //   uuid₁ → uuid₂ : real thread switch — clear and load.
  //   uuid → null : clear, no load.
  // See docs/data-visualization.md.
  useEffect(() => {
    const unsubscribe = useWorkspaceStore.subscribe((state, prev) => {
      const next = state.runtimeThreadId;
      const prior = prev.runtimeThreadId;
      if (next === prior) return;

      const store = useOutcomeStore.getState();

      if (prior === null && next !== null) {
        // First capture — back-fill optimistic outcomes, load only
        // when local list is empty (page refresh path).
        store.bindPendingThreadId(next);
        if (store.outcomes.length === 0) {
          void store.loadForThread(next);
        }
        return;
      }

      store.clearForThreadSwitch();
      if (next !== null) {
        void store.loadForThread(next);
      }
    });
    return unsubscribe;
  }, []);

  // Load all agent sources in parallel exactly once on mount. Each
  // source merges into the store as it arrives; the first source
  // with results auto-selects the default chat agent.
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
        setBackendCredentials(result.credentials);
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
            (r) => r.enabled && r.role === "supervisor",
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
