"use client";

/**
 * RightPanel — collapsible right panel hosting Chat + History.
 *
 * Owns the `<CopilotKitProvider>` mount point and its `key={copilotKey}`
 * remount-per-agent contract. Before changing how the provider is
 * mounted or whether the key is needed, read
 * `docs/copilotkit-provider-lifecycle.md`.
 */

import { useCallback, useEffect, useMemo, useRef, type ReactNode } from "react";
import { History, MessageSquare, SquarePen } from "lucide-react";
import { z } from "zod";
import {
  CopilotKitProvider,
  useAgent,
  useCopilotKit,
  useRenderTool,
} from "@/lib/copilot/client";
import "@copilotkit/react-ui/v2/styles.css";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useSidebarStore } from "@/store/sidebar";
import { useStoredValue } from "@/hooks/useStoredValue";
import type { RightTab } from "@/store/sidebar";
import { useWorkspaceStore, type ChatError } from "@/store/workspace";
import type { EntityKind } from "@/lib/backends/types";
import { useOutcomeTools } from "@/hooks/useOutcomeTools";
import { ChatPanelBody } from "@/components/right-panels/ChatPanel";
import { ChatErrorBanner } from "@/components/right-panels/ChatErrorBanner";
import { HistoryPanelBody } from "@/components/right-panels/HistoryPanel";
import { AgentSelector } from "@/components/chat/AgentSelector";
import { CREDENTIAL_ID_HEADER, ORCHESTRATION_MODE_HEADER } from "@/lib/http/chat-headers";
import {
  DelegateToAgentCard,
  delegateToAgentArgsSchema,
} from "@/components/right-panels/DelegateToAgentCard";
import { WebSearchInlinePreview } from "@/components/right-panels/WebSearchInlinePreview";
import { WildcardToolRenderer } from "@/components/copilotkit/WildcardToolRenderer";
import { webSearchArgsSchema } from "@/lib/web-search/schema";
import { useHandoffTools } from "@/hooks/useHandoff";
import { useInteractiveTools } from "@/hooks/useInteractiveTools";

// Chat-error classification

/**
 * Map runtime failure (Error or AG-UI RunErrorEvent) to {@link ChatError}.
 * Extracts HTTP status from CopilotKit's fetch-wrapper message format;
 * falls back to generic "failed to send" on unknown shapes. Never throws.
 */
function buildChatError(
  source: { message?: string; code?: string } | Error,
  agentId: string,
): ChatError {
  const rawMessage =
    source instanceof Error
      ? source.message
      : (source.message ?? source.code ?? "");

  // Match e.g. "HTTP 404: ..." (CopilotKit's fetch-wrapper format).
  const httpMatch = /HTTP\s+(\d{3})\b/.exec(rawMessage);
  const status = httpMatch ? Number(httpMatch[1]) : null;

  let message: string;
  switch (status) {
    case 401:
      message = "Your session has expired. Please sign in again.";
      break;
    case 403:
    case 404:
      // 404: agent deleted / never existed for this user.
      // 403: visibility check failed (treated as 404 server-side, but
      //      kept distinct here in case the route ever differentiates).
      message =
        "This agent is no longer available. It may have been deleted. " +
        "Refresh your agent list or pick another agent.";
      break;
    case 503:
      message =
        "No built-in agents are available right now. " +
        "Please try again in a moment.";
      break;
    case null:
      message = rawMessage
        ? `Failed to send message: ${rawMessage}`
        : "Failed to send message. Please try again.";
      break;
    default:
      message = `Failed to send message (HTTP ${status}). Please try again.`;
  }

  return {
    status,
    message,
    agentId,
    timestamp: Date.now(),
  };
}

// Tab segment metadata

const TAB_SEGMENTS: {
  id: RightTab;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}[] = [
  { id: "chat", label: "Chat", icon: MessageSquare },
  { id: "history", label: "History", icon: History },
];

// Stable empty-object refs for CopilotKitProvider props that otherwise
// default to a freshly-allocated `{}` on every render. Without these
// the provider's setter useEffect re-runs every commit, which in turn
// calls `setRuntimeTransport("auto")` while `_runtimeTransport` is
// already `"rest"` (auto-detect mutates it). The dedup check inside
// setRuntimeTransport fails, triggering a full updateRuntimeConnection
// reconnect cycle — that rebuilds remoteAgents as new objects, blowing
// up the per-thread clone cache and making HITL pickers vanish.
//
// @see docs/chat-flow-audit.md (HITL flash investigation)
const STABLE_EMPTY_AGENTS = Object.freeze({}) as Record<string, never>;
const STABLE_EMPTY_PROPS = Object.freeze({}) as Record<string, unknown>;

// localStorage helpers for AgentSelector's disabled-agents set.
//
// Mirrors `AgentPanel`'s storage shape. A disabled agent is one the
// user has hidden from the agent picker via the panel's checkbox.
// Read via `useStoredValue` (`useSyncExternalStore` under the hood)
// so SSR sees the empty set and the stored value flows in
// post-hydration without a setState-in-effect. Cross-tab updates
// arrive via the native `storage` event; same-tab writes from
// `AgentPanel`'s checkbox arrive via the custom event the hook
// dispatches. SSR_EMPTY_SET is shared between server snapshot and
// the "no stored value" parse path so the hook's reference-equality
// cache works (a fresh `new Set()` per call would never match).

const LS_KEY_DISABLED_BACKEND = "agent-panel-disabled-backend";

const SSR_EMPTY_SET: Set<string> = Object.freeze(new Set<string>()) as Set<string>;

function parseDisabledBackend(raw: string | null): Set<string> {
  if (!raw) return SSR_EMPTY_SET;
  try {
    return new Set(JSON.parse(raw) as string[]);
  } catch {
    return SSR_EMPTY_SET;
  }
}

// Toolbar

/**
 * Single-row toolbar: tab segmented control + new-chat button + agent picker.
 *
 * Lives outside `<CopilotKitProvider>` because nothing it renders needs
 * CopilotKit context — only Zustand state.
 */
function RightPanelToolbar(): ReactNode {
  const rightTab = useSidebarStore((s) => s.rightTab);
  const setRightTab = useSidebarStore((s) => s.setRightTab);

  const agents = useWorkspaceStore((s) => s.agents);
  const teams = useWorkspaceStore((s) => s.teams);
  const builtinAgents = useWorkspaceStore((s) => s.builtinAgents);
  const activeAgentId = useWorkspaceStore((s) => s.activeAgentId);
  const activeAgentType = useWorkspaceStore((s) => s.activeAgentType);
  const activeCredentialId = useWorkspaceStore((s) => s.activeCredentialId);
  const setActiveAgent = useWorkspaceStore((s) => s.setActiveAgent);
  const startFreshChat = useWorkspaceStore((s) => s.startFreshChat);

  // Disabled-backend set — derived from localStorage via the shared
  // `useStoredValue` hook. SSR sees `SSR_EMPTY_SET`, and the real
  // value flows in on the first post-hydration render. Cross-tab
  // updates (a parallel browser window) AND same-tab updates (the
  // user toggling a checkbox in AgentPanel) are both subscribed
  // inside the hook — we don't need a separate `storage` listener
  // here anymore. This component is read-only with respect to the
  // disabled-backend set; AgentPanel owns the write path.
  const { value: disabledBackend } = useStoredValue<Set<string>>({
    key: LS_KEY_DISABLED_BACKEND,
    parse: parseDisabledBackend,
    serialize: () => "",
    serverDefault: SSR_EMPTY_SET,
  });

  // New chat from History also flips the user back to the Chat tab —
  // creating a fresh thread while staying on History would feel like
  // nothing happened.
  const handleNewChat = useCallback(() => {
    // Atomic: clears both threadId fields AND bumps chatEpoch.
    // The epoch bump is what actually starts a new conversation —
    // without it the chat surface is a no-op in fresh-chat mode
    // (prop unchanged → MemoChat memoised → CopilotChat caches its
    // first-mint ABC). @see docs/threadid-lifecycle.md §"Lifecycle Events" #5
    startFreshChat();
    setRightTab("chat");
  }, [startFreshChat, setRightTab]);

  const handleSelectAgent = useCallback(
    (
      id: string,
      type: EntityKind,
      source?: "backend" | "builtin",
      credentialId?: string,
      provider?: string,
    ) => {
      setActiveAgent(id, type, source, credentialId, provider);
    },
    [setActiveAgent],
  );

  return (
    <div className="flex items-center gap-1 border-b px-2 py-1.5">
      {/* ── Agent picker (left — primary context) ──────────────────── */}
      <AgentSelector
        activeAgentId={activeAgentId}
        activeAgentType={activeAgentType}
        activeCredentialId={activeCredentialId}
        agents={agents}
        teams={teams}
        builtinAgents={builtinAgents}
        disabledBackend={disabledBackend}
        onSelect={handleSelectAgent}
      />

      <div className="flex-1" />

      {/* ── New chat (icon-only to save space) ─────────────────────── */}
      <Button
        variant="ghost"
        size="icon"
        className="h-7 w-7 text-muted-foreground hover:text-foreground"
        onClick={handleNewChat}
        aria-label="New chat"
        title="New chat"
      >
        <SquarePen className="h-3.5 w-3.5" />
      </Button>

      {/* ── Segmented control (Chat / History) ─────────────────────── */}
      <div
        className="inline-flex rounded-md border bg-muted/40 p-0.5"
        role="tablist"
        aria-label="Right panel view"
      >
        {TAB_SEGMENTS.map(({ id, label, icon: Icon }) => {
          const active = rightTab === id;
          return (
            <button
              key={id}
              id={`right-tab-${id}`}
              type="button"
              role="tab"
              aria-selected={active}
              aria-label={label}
              aria-controls={`right-tabpanel-${id}`}
              title={label}
              tabIndex={active ? 0 : -1}
              onClick={() => setRightTab(id)}
              onKeyDown={(e) => {
                const ids = TAB_SEGMENTS.map((t) => t.id);
                const idx = ids.indexOf(id);
                let next: RightTab | undefined;
                if (e.key === "ArrowRight") next = ids[(idx + 1) % ids.length];
                else if (e.key === "ArrowLeft") next = ids[(idx - 1 + ids.length) % ids.length];
                else if (e.key === "Home") next = ids[0];
                else if (e.key === "End") next = ids[ids.length - 1];
                if (next) {
                  e.preventDefault();
                  setRightTab(next);
                  document.getElementById(`right-tab-${next}`)?.focus();
                }
              }}
              className={cn(
                "flex h-7 w-7 items-center justify-center rounded-sm transition-colors",
                "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                active
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              <Icon className="h-3.5 w-3.5" />
            </button>
          );
        })}
      </div>
    </div>
  );
}

// Provider-scoped chat hooks (registered once per provider, not per tab)

/**
 * Holds CopilotKit-provider-scoped concerns that must outlive tab
 * switches:
 *
 *  1. **Frontend tool registration** (`useOutcomeTools`,
 *     `useInteractiveTools`, `useHandoffTools`). Without these living
 *     at provider scope, switching to History mid-run would
 *     unregister the tools and break in-flight calls.
 *
 *  2. **Wildcard tool-call rendering** (`useRenderTool({ name: "*" })`).
 *     Registers `WildcardToolRenderer` — our replacement for CopilotKit's
 *     built-in default. Shows tool name, error/done/running badge,
 *     elapsed time, and expandable arguments + result for every
 *     server-side tool call that doesn't have a name-specific renderer.
 *
 *  3. **Lazy threadId capture**. When the user fires the very first run
 *     for the active agent, v2 mints an internal UUID; we capture it
 *     here off `onAgentRunStarted` and persist it to our store so future
 *     CopilotChat remounts find the WeakMap-cached thread clone.
 *
 * Renders nothing — pure side-effect host.
 */
function ChatProviderHooks(): ReactNode {
  // `render_chart` (handler-only) + matching `useRenderTool` for the
  // ChartPreviewCard. See docs/data-visualization.md §6.3.
  useOutcomeTools();
  // Specific renderer for the supervisor's `delegate_to_agent` tool —
  // a Nango-themed card replaces the wildcard JSON view. Order does
  // not matter: CopilotKit's matcher prefers an exact `name` match and
  // only falls back to the wildcard renderer when none exists.
  useRenderTool({
    name: "delegate_to_agent",
    parameters: delegateToAgentArgsSchema,
    render: DelegateToAgentCard,
  });
  // Server-tool renderer: web_search runs server-side but its result
  // both (a) shows a small inline preview in chat, and (b) writes a
  // Report outcome via useEffect inside the component. See the
  // bridge architecture note in WebSearchInlinePreview.
  useRenderTool({
    name: "web_search",
    parameters: webSearchArgsSchema,
    render: WebSearchInlinePreview,
  });
  // Handoff frontend tool — registered globally so any built-in agent
  // capable of orchestration (currently only Nango) can invoke it.
  // The action handler is a thin client-side router that mutates the
  // workspace store; the active-agent change remounts CopilotKit on
  // the next React commit and the new agent's chat panel injects the
  // context summary as the first user message.
  useHandoffTools();
  // HITL interactive tools — the `ask_user_*` family (choice,
  // confirmation, input, datetime). Registered globally so any
  // built-in agent can invoke them.
  useInteractiveTools();
  // Custom wildcard fallback that replaces CopilotKit's built-in
  // `DefaultToolCallRenderer`. Adds two behaviours the vendor default
  // doesn't have: (a) red "Error" badge when the result carries
  // `{ isError: true }` (MCP / `wrapToolExecute` fallback) or
  // `{ ok: false }` (business shape), and (b) an elapsed timer keyed
  // by `toolCallId`. Registered via `useRenderTool({ name: "*" })`
  // (not `useDefaultRenderTool`) so the renderer receives `toolCallId`
  // — `useDefaultRenderTool`'s prop shape omits it, which would break
  // the per-call timing cache in `use-elapsed-seconds`. See
  // `src/components/copilotkit/WildcardToolRenderer.tsx` for the
  // detection rules and AGENTS.md item 19 for the wider rationale.
  useRenderTool({
    name: "*",
    parameters: z.any(),
    render: WildcardToolRenderer,
  });

  // Eager-capture: the SOLE mechanism that writes the post-first-run
  // thread id into the store (eager-mint was removed as part of the
  // chatView slot refactor). Writes happen on `onAgentRunStarted` —
  // ABC is already present on `event.agent.threadId` at this point,
  // so there is no reason to wait for `onRunFinalized`. Earlier write
  // shrinks the "null window" for outcomes/save flows that read
  // `runtimeThreadId` mid-run.
  //
  // We write `runtimeThreadId` only — feeding it back into
  // <CopilotChat> via `explicitThreadId` is reserved for
  // history-restore.
  // @see docs/chat-flow-audit.md §1.11
  // @see docs/threadid-lifecycle.md §"Lifecycle Events" #2
  const storedThreadId = useWorkspaceStore((s) => s.runtimeThreadId);
  const activeAgentId = useWorkspaceStore((s) => s.activeAgentId);
  const setChatError = useWorkspaceStore((s) => s.setChatError);
  const clearChatError = useWorkspaceStore((s) => s.clearChatError);
  const { copilotkit } = useCopilotKit();
  // 1.57 removed the global `onAgentRunStarted` event. Per-agent
  // run lifecycle is now subscribed via the registry agent obtained
  // through `useAgent` + `copilotkit.subscribeToAgentWithOptions`.
  const { agent } = useAgent({ agentId: activeAgentId || undefined });

  // threadId eager-capture
  useEffect(() => {
    if (storedThreadId) return; // already captured for this agent
    if (!activeAgentId || !agent) return;
    const sub = copilotkit.subscribeToAgentWithOptions(
      agent,
      {
        onRunInitialized: () => {
          const tid = agent.threadId;
          if (!tid) return;
          // Recheck inside the callback — the closure-captured guard
          // (`storedThreadId`) could be stale if a sibling run finalized
          // between effect set-up and this dispatch.
          const state = useWorkspaceStore.getState();
          if (state.runtimeThreadId) return;
          if (state.activeAgentId !== activeAgentId) return;
          state.setRuntimeThreadId(tid);
        },
      },
      {},
    );
    return () => sub.unsubscribe();
  }, [storedThreadId, copilotkit, activeAgentId, agent]);

  // Chat error capture (independent lifecycle)
  //
  // Capture transport/protocol errors. Clear stale errors on new runs.
  useEffect(() => {
    if (!activeAgentId || !agent) return;
    const sub = copilotkit.subscribeToAgentWithOptions(
      agent,
      {
        onRunInitialized: () => {
          // Starting a new run wipes the slate — even if the previous
          // run errored, we don't want a stale banner sitting on top of
          // a successful response.
          clearChatError();
        },
        onRunFailed: ({ error }) => {
          setChatError(buildChatError(error, activeAgentId));
        },
        onRunErrorEvent: ({ event: errEvent }) => {
          setChatError(buildChatError(errEvent, activeAgentId));
        },
      },
      {},
    );
    return () => sub.unsubscribe();
  }, [copilotkit, activeAgentId, agent, setChatError, clearChatError]);

  // New-chat reset.
  //
  // CopilotKit v2 stores messages on the per-agentId agent instance
  // (inside `copilotkit` core), NOT on the <CopilotChat> component.
  // Its built-in `connect-on-thread` effect (which would call
  // `agent.setMessages([])` for us) ALSO short-circuits when
  // `hasExplicitThreadId === false`. So in fresh-chat mode
  // (explicitThreadId === null → CopilotChat threadId prop ===
  // undefined → hasExplicitThreadId === false) clicking "New chat"
  // remounts <CopilotChat> but leaves the agent's messages intact —
  // user sees the prior conversation as if nothing happened.
  //
  // Drive the clear ourselves off `chatEpoch`: the store action
  // `startFreshChat` bumps this counter, and we reset agent state
  // here. First mount is a no-op because prev === current.
  // Agent switches don't trigger because `<CopilotKitProvider key>`
  // remounts this hook (resetting the ref to the current epoch).
  // @see docs/threadid-lifecycle.md §"Lifecycle Events" #5
  const chatEpoch = useWorkspaceStore((s) => s.chatEpoch);
  const prevChatEpochRef = useRef(chatEpoch);
  useEffect(() => {
    if (!agent) return;
    if (prevChatEpochRef.current === chatEpoch) return;
    prevChatEpochRef.current = chatEpoch;
    agent.setMessages([]);
    agent.setState({});
  }, [chatEpoch, agent]);

  return null;
}

// RightPanel

export function RightPanel(): ReactNode {
  const rightTab = useSidebarStore((s) => s.rightTab);

  const agentId = useWorkspaceStore((s) => s.activeAgentId);
  const agentSource = useWorkspaceStore((s) => s.activeAgentSource);
  const credentialId = useWorkspaceStore((s) => s.activeCredentialId);

  // Build CopilotKitProvider props. Stable references prevent infinite rerenders.
  const runtimeUrl = agentSource === "builtin"
    ? "/api/copilotkit/builtin"
    : "/api/copilotkit";

  // Memoize stable refs
  const activeMode = useWorkspaceStore((s) => s.activeMode);

  const headers = useMemo(() => {
    const h: Record<string, string> = {};
    // Backend route: server reads `credentialId` from this header to
    // pick the right BridgeAgent build. `agentId` is derived from the
    // URL path (`/agent/<id>/run`); `agentKind` is looked up server-side
    // via EntityCatalog. Nothing else needs to come from the client.
    // @see docs/orchestrator.md "Custom HTTP Headers"
    if (agentSource === "backend" && credentialId) {
      h[CREDENTIAL_ID_HEADER] = credentialId;
    }
    // Built-in route: only the user's transient orchestration-mode
    // preference is carried. Server falls back to the registry
    // default when absent, so this is "send when set", not required.
    if (agentSource === "builtin") {
      h[ORCHESTRATION_MODE_HEADER] = activeMode;
    }
    return h;
  }, [agentSource, credentialId, activeMode]);

  const copilotKey = agentId
    ? `${agentId}::${agentSource}::${credentialId ?? ""}`
    : "no-agent";

  if (!agentId) {
    return (
      <div
        className="flex h-full flex-col border-l"
        style={{ backgroundColor: "var(--panel-bg)" }}
      >
        <div className="flex h-full items-center justify-center p-6 text-center">
          <p className="text-sm text-muted-foreground">
            Select an agent to start chatting.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div
      className="flex h-full flex-col border-l"
      style={{ backgroundColor: "var(--panel-bg)" }}
    >
      <RightPanelToolbar />

      <div
        className="relative flex-1 overflow-hidden"
      >
        <CopilotKitProvider
          key={copilotKey}
          runtimeUrl={runtimeUrl}
          headers={headers}
          // Explicit stable refs — see comment at top of file. Without
          // these CopilotKit re-fetches /info on every commit which
          // rebuilds remoteAgents and breaks HITL renders.
          properties={STABLE_EMPTY_PROPS}
          agents__unsafe_dev_only={STABLE_EMPTY_AGENTS}
          selfManagedAgents={STABLE_EMPTY_AGENTS}
        >
          <ChatProviderHooks />
          <div
            id="right-tabpanel-chat"
            role="tabpanel"
            aria-labelledby="right-tab-chat"
            hidden={rightTab !== "chat"}
            className="flex h-full flex-col"
          >
            {/* Sticky inline error banner — only renders when an error
                exists for the active agent. See ChatErrorBanner.tsx for
                the lifecycle contract. */}
            <ChatErrorBanner />
            <div className="min-h-0 flex-1">
              <ChatPanelBody />
            </div>
          </div>
          <div
            id="right-tabpanel-history"
            role="tabpanel"
            aria-labelledby="right-tab-history"
            hidden={rightTab !== "history"}
            className="h-full"
          >
            <HistoryPanelBody />
          </div>
        </CopilotKitProvider>
      </div>
    </div>
  );
}
