import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { EntityDescriptor, EntityKind } from "@/lib/backends/types";
import type { CredentialEntityStatus } from "@/lib/backends/facade";
import type { BuiltinAgentRow } from "@/lib/types/builtin-agent";
import {
  DEFAULT_ORCHESTRATION_MODE,
  type OrchestrationModeId,
} from "@/lib/orchestration/modes";

interface WorkspaceState {
  // Entity list cache. Grouped for cheap UI rendering.

  agents: EntityDescriptor[];
  teams: EntityDescriptor[];
  workflows: EntityDescriptor[];
  builtinAgents: BuiltinAgentRow[];
  backendCredentials: CredentialEntityStatus[];
  /** True after at least one entity source has finished loading. */
  agentsLoaded: boolean;
  /** Replace the entire entity list across all kinds / credentials. */
  setEntities: (entities: EntityDescriptor[]) => void;
  setBackendCredentials: (credentials: CredentialEntityStatus[]) => void;
  replaceBackendCredentialsFor: (credentialIds: ReadonlySet<string>, fresh: CredentialEntityStatus[]) => void;
  /** Replace entities for given credentialIds (optionally filtered by kinds). Outside entries stay untouched. */
  replaceEntitiesForCredentials: (
    credentialIds: ReadonlySet<string>,
    fresh: EntityDescriptor[],
    kinds?: readonly EntityKind[],
  ) => void;
  mergeBuiltinAgents: (builtinAgents: BuiltinAgentRow[]) => void;

  // Agent selection (drives CopilotKit runtimeUrl header)
  activeAgentId: string;
  /** Kind of the currently selected agent. UI-only state — used for
   *  panel guards (e.g. workflows have no history list). Not carried
   *  to the chat dispatch route; server looks up kind from
   *  EntityCatalog. */
  activeAgentType: EntityKind;
  /** "backend" = external agno/Mastra/Dify; "builtin" = DB-configured. */
  activeAgentSource: "backend" | "builtin";
  /** Credential id that owns the active backend agent (undefined for builtin). */
  activeCredentialId: string | undefined;
  activeProvider: string | undefined;
  setActiveAgent: (id: string, type?: EntityKind, source?: "backend" | "builtin", credentialId?: string, provider?: string) => void;

  // Authenticated user
  /** Stable UUID forwarded as user_id to backends. */
  userId: string | undefined;
  setUserId: (id: string | undefined) => void;

  // Orchestration mode (Nango / supervisor only)
  /** Transient — resets to `auto` on reload. */
  activeMode: OrchestrationModeId;
  setActiveMode: (mode: OrchestrationModeId) => void;

  // Nango entry-point
  /** Snapshot of the agent the user was on before switching into
   *  Nango. Cleared when they return or pick a different agent. */
  previousAgent: PreviousAgentSnapshot | null;
  /** Switch to a Nango (supervisor) agent, remembering current as previous. */
  enterNango: (supervisor: { id: string }) => void;
  /** Restore the previous agent (no-op if none recorded). */
  exitNango: () => void;
  /** Switch to an arbitrary target agent, capturing current as
   *  previous. Used by handoff mode. Pairs with
   *  `pendingHandoffContext` — the new chat panel injects that as
   *  the first user message on mount. */
  enterAgent: (target: PreviousAgentSnapshot, contextSummary?: string) => void;
  /** Routed through store because `<CopilotKitProvider>` remounts on agent switch. */
  pendingHandoffContext: string | null;
  /** Atomically read-and-clear the pending context. */
  consumeHandoffContext: () => string | null;

  // Session (thread) — two fields with disjoint semantics.
  // See docs/threadid-lifecycle.md and docs/chat-flow-audit.md.
  /** Live thread id captured after CopilotKit's first run. Identifies
   *  the active conversation for history list, URL sync, outcome
   *  attribution. NEVER passed to <CopilotChat> — feeding it back
   *  would flip `hasExplicitThreadId` false → true. */
  runtimeThreadId: string | null;
  setRuntimeThreadId: (id: string | null) => void;
  /** Set only when the user picks a stored thread (history click, URL
   *  navigation). Flows into `<CopilotChat threadId>`; `null` = fresh
   *  chat mode. */
  explicitThreadId: string | null;
  setExplicitThreadId: (id: string | null) => void;
  /** Monotonic counter used as part of `<CopilotChat>`'s `key` to
   *  force a remount and mint a fresh ABC — CopilotKit otherwise
   *  caches the first ABC forever via `useMemo`. */
  chatEpoch: number;
  bumpChatEpoch: () => void;
  /** Atomically reset both threadId fields and bump the epoch. Use
   *  for any "start a new conversation" entry point — manual
   *  bump-then-clear races the lazy-capture guard. */
  startFreshChat: () => void;

  // Pinned sessions
  pinnedSessions: Set<string>;
  togglePin: (sessionId: string) => void;

  /** Most recent transport / protocol failure. Cleared on new run,
   *  agent switch, or manual dismiss. The banner filters entries
   *  whose `agentId` doesn't match `activeAgentId`. */
  lastChatError: ChatError | null;
  setChatError: (err: ChatError) => void;
  clearChatError: () => void;
}

/** Lightweight chat-active agent snapshot captured before jumping
 *  into Nango. Mirrors `setActiveAgent` fields. */
export interface PreviousAgentSnapshot {
  id: string;
  type: EntityKind;
  source: "backend" | "builtin";
  credentialId?: string;
  provider?: string;
  /** Display name for the "Back to X" button label. */
  name?: string;
}

export interface ChatError {
  /** HTTP status if transport error, else null. */
  status: number | null;
  /** User-facing message (already localised at call site). */
  message: string;
  /** Used to filter stale errors after agent switch. */
  agentId: string;
  /** Wall-clock ms-since-epoch for ordering / debugging. */
  timestamp: number;
}

function nameOfActiveAgent(state: WorkspaceState): string | undefined {
  const id = state.activeAgentId;
  if (!id) return undefined;
  if (state.activeAgentSource === "builtin") {
    return state.builtinAgents.find((b) => b.id === id)?.name;
  }
  const credId = state.activeCredentialId;
  const list =
    state.activeAgentType === "team"
      ? state.teams
      : state.activeAgentType === "workflow"
        ? state.workflows
        : state.agents;
  return list.find((e) => e.id === id && e.credentialId === credId)?.name;
}

export const useWorkspaceStore = create<WorkspaceState>()(
  persist(
    (set, get) => ({
      // Entity list cache
      agents: [],
      teams: [],
      workflows: [],
      builtinAgents: [],
      backendCredentials: [],
      agentsLoaded: false,
      setEntities: (entities) =>
        set({
          agents: entities.filter((e) => e.kind === "agent"),
          teams: entities.filter((e) => e.kind === "team"),
          workflows: entities.filter((e) => e.kind === "workflow"),
          agentsLoaded: true,
        }),
      setBackendCredentials: (credentials) =>
        set({
          backendCredentials: credentials,
        }),
      replaceBackendCredentialsFor: (credentialIds, fresh) =>
        set((state) => ({
          backendCredentials: [
            ...state.backendCredentials.filter((c) => !credentialIds.has(c.credentialId)),
            ...fresh,
          ]
        })),
      replaceEntitiesForCredentials: (credentialIds, fresh, kinds) =>
        set((state) => {
          const targetKinds = kinds ?? (["agent", "team", "workflow"] as const);
          const shouldReplace = (e: EntityDescriptor): boolean =>
            !!e.credentialId
            && credentialIds.has(e.credentialId)
            && targetKinds.includes(e.kind);
          // Drop the slice that's about to be replaced, then append.
          const merged: EntityDescriptor[] = [
            ...state.agents.filter((e) => !shouldReplace(e)),
            ...state.teams.filter((e) => !shouldReplace(e)),
            ...state.workflows.filter((e) => !shouldReplace(e)),
            ...fresh,
          ];
          return {
            agents: merged.filter((e) => e.kind === "agent"),
            teams: merged.filter((e) => e.kind === "team"),
            workflows: merged.filter((e) => e.kind === "workflow"),
            agentsLoaded: true,
          };
        }),
      mergeBuiltinAgents: (builtinAgents) => set({ builtinAgents, agentsLoaded: true }),

      // Agent selection
      activeAgentId: "",
      activeAgentType: "agent",
      activeAgentSource: "backend",
      activeCredentialId: undefined,
      activeProvider: undefined,
      // @see docs/threadid-lifecycle.md
      setActiveAgent: (id, type = "agent", source = "backend", credentialId, provider) =>
        set((state) => {
          const sameAgent =
            state.activeAgentId === id &&
            state.activeCredentialId === credentialId &&
            state.activeAgentType === type;
          return {
            activeAgentId: id,
            activeAgentType: type,
            activeAgentSource: source,
            activeCredentialId: credentialId,
            activeProvider: provider,
            runtimeThreadId: sameAgent ? state.runtimeThreadId : null,
            explicitThreadId: sameAgent ? state.explicitThreadId : null,
            // Preserve error on same-agent re-selection; clear on switch.
            lastChatError: sameAgent ? state.lastChatError : null,
            // Direct selection invalidates the Nango breadcrumb.
            previousAgent: sameAgent ? state.previousAgent : null,
          };
        }),

      // Authenticated user
      userId: undefined,
      setUserId: (id) => set({ userId: id }),

      // Orchestration mode
      activeMode: DEFAULT_ORCHESTRATION_MODE,
      setActiveMode: (mode) => set({ activeMode: mode }),

      // Nango breadcrumb
      previousAgent: null,
      enterNango: (supervisor) =>
        set((state) => {
          // Already on this supervisor — no-op, keep breadcrumb intact.
          if (
            state.activeAgentSource === "builtin"
            && state.activeAgentId === supervisor.id
          ) {
            return state;
          }
          // Capture the agent we're leaving (only when the user
          // actually had one selected).
          const breadcrumb: PreviousAgentSnapshot | null = state.activeAgentId
            ? {
                id: state.activeAgentId,
                type: state.activeAgentType,
                source: state.activeAgentSource,
                credentialId: state.activeCredentialId,
                provider: state.activeProvider,
                name: nameOfActiveAgent(state),
              }
            : null;
          return {
            previousAgent: breadcrumb,
            activeAgentId: supervisor.id,
            activeAgentType: "agent",
            activeAgentSource: "builtin",
            activeCredentialId: undefined,
            activeProvider: undefined,
            runtimeThreadId: null,
            explicitThreadId: null,
            lastChatError: null,
          };
        }),
      exitNango: () =>
        set((state) => {
          const prev = state.previousAgent;
          if (!prev) return { previousAgent: null };
          return {
            previousAgent: null,
            activeAgentId: prev.id,
            activeAgentType: prev.type,
            activeAgentSource: prev.source,
            activeCredentialId: prev.credentialId,
            activeProvider: prev.provider,
            runtimeThreadId: null,
            explicitThreadId: null,
            lastChatError: null,
          };
        }),
      enterAgent: (target, contextSummary) =>
        set((state) => {
          const breadcrumb: PreviousAgentSnapshot | null = state.activeAgentId
            ? {
                id: state.activeAgentId,
                type: state.activeAgentType,
                source: state.activeAgentSource,
                credentialId: state.activeCredentialId,
                provider: state.activeProvider,
                name: nameOfActiveAgent(state),
              }
            : null;
          return {
            previousAgent: breadcrumb,
            activeAgentId: target.id,
            activeAgentType: target.type,
            activeAgentSource: target.source,
            activeCredentialId: target.credentialId,
            activeProvider: target.provider,
            runtimeThreadId: null,
            explicitThreadId: null,
            lastChatError: null,
            pendingHandoffContext:
              contextSummary && contextSummary.trim().length > 0
                ? contextSummary
                : null,
          };
        }),
      pendingHandoffContext: null,
      consumeHandoffContext: () => {
        const ctx = get().pendingHandoffContext;
        if (ctx) set({ pendingHandoffContext: null });
        return ctx;
      },

      // Session — see WorkspaceState above for semantics
      runtimeThreadId: null,
      setRuntimeThreadId: (id) => set({ runtimeThreadId: id }),
      explicitThreadId: null,
      setExplicitThreadId: (id) => set({ explicitThreadId: id }),
      chatEpoch: 0,
      bumpChatEpoch: () => set((s) => ({ chatEpoch: s.chatEpoch + 1 })),
      startFreshChat: () =>
        set((s) => ({
          runtimeThreadId: null,
          explicitThreadId: null,
          chatEpoch: s.chatEpoch + 1,
        })),

      // Pinned sessions
      pinnedSessions: new Set<string>(),
      togglePin: (sessionId) =>
        set((state) => {
          const next = new Set(state.pinnedSessions);
          if (next.has(sessionId)) {
            next.delete(sessionId);
          } else {
            next.add(sessionId);
          }
          return { pinnedSessions: next };
        }),

      // Chat error
      lastChatError: null,
      setChatError: (err) => set({ lastChatError: err }),
      clearChatError: () => set({ lastChatError: null }),
    }),
    {
      name: "workspace-store",
      // CONTRACT: only `pinnedSessions` is persisted; everything
      // else is transient.
      partialize: (state) => ({ pinnedSessions: Array.from(state.pinnedSessions) }),
      merge: (persisted, current) => ({
        ...current,
        pinnedSessions: new Set((persisted as { pinnedSessions: string[] }).pinnedSessions ?? []),
      }),
    }
  )
);
