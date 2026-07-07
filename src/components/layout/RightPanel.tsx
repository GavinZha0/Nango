"use client";

/**
 * RightPanel — collapsible right panel hosting Chat + History.
 *
 * Owns the `<CopilotKitProvider>` mount point and its `key={copilotKey}`
 * remount-per-agent contract. Before changing how the provider is
 * mounted or whether the key is needed, read
 * `docs/copilotkit-provider-lifecycle.md`.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { History, MessagesSquare, RefreshCw, Hospital } from "lucide-react";
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
import { useCopilotSharedStateSync } from "@/hooks/useCopilotSharedState";
import { useRole } from "@/hooks/useRole";
import { SaveToEvalDialog } from "@/components/chat/SaveToEvalDialog";

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
  { id: "chat", label: "Chat", icon: MessagesSquare },
  { id: "history", label: "History", icon: History },
];

// Stable empty-object refs for `CopilotKitProvider` props. Fresh `{}`
// per render triggers the provider's setter useEffect on every
// commit, which kicks off a full reconnect cycle and breaks the
// HITL render cache. See docs/chat-flow-audit.md.
const STABLE_EMPTY_AGENTS = Object.freeze({}) as Record<string, never>;
const STABLE_EMPTY_PROPS = Object.freeze({}) as Record<string, unknown>;

// localStorage helpers for AgentSelector's disabled-agents set.
// Reads through `useStoredValue` (a `useSyncExternalStore` wrapper)
// so SSR sees the empty set and cross-tab writes propagate via the
// native `storage` event. SSR_EMPTY_SET is shared so the hook's
// reference-equality cache holds (a fresh `new Set()` would never
// match).

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
  const { isEditor } = useRole();
  const [evalDialogOpen, setEvalDialogOpen] = useState(false);
  
  const rightTab = useSidebarStore((s) => s.rightTab);
  const setRightTab = useSidebarStore((s) => s.setRightTab);

  const agents = useWorkspaceStore((s) => s.agents);
  const teams = useWorkspaceStore((s) => s.teams);
  const builtinAgents = useWorkspaceStore((s) => s.builtinAgents);
  const activeAgentId = useWorkspaceStore((s) => s.activeAgentId);
  const activeAgentType = useWorkspaceStore((s) => s.activeAgentType);
  const activeAgentSource = useWorkspaceStore((s) => s.activeAgentSource);
  const activeCredentialId = useWorkspaceStore((s) => s.activeCredentialId);
  const runtimeThreadId = useWorkspaceStore((s) => s.runtimeThreadId);
  const setActiveAgent = useWorkspaceStore((s) => s.setActiveAgent);
  const startFreshChat = useWorkspaceStore((s) => s.startFreshChat);
  const bumpHistoryRevision = useSidebarStore((s) => s.bumpHistoryRevision);

  const { agent } = useAgent({ agentId: activeAgentId || undefined });
  const hasUserMessage = agent
    ? agent.messages.some((m) => m.role === "user")
    : false;

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

      {/* ── New chat (text button for discoverability) ────────────── */}
      <Button
        variant="outline"
        size="sm"
        className="h-7 px-3 text-xs"
        onClick={handleNewChat}
        aria-label="New chat"
      >
        New Chat
      </Button>

      {/* ── Add to Eval ─────────────────────────────────────────────── */}
      {isEditor && (
        <>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 text-muted-foreground hover:text-foreground"
            onClick={() => setEvalDialogOpen(true)}
            disabled={!hasUserMessage}
            aria-label="Add to Eval"
            title={hasUserMessage ? "Add to Eval" : "Add to Eval (send a message first)"}
          >
            <Hospital className="h-4 w-4" />
          </Button>
          {activeAgentId && runtimeThreadId && (
            <SaveToEvalDialog
              open={evalDialogOpen}
              onOpenChange={setEvalDialogOpen}
              agentId={activeAgentId}
              agentSource={activeAgentSource || "builtin"}
              threadId={runtimeThreadId}
            />
          )}
        </>
      )}

      {/* ── Refresh history (always visible, disabled outside History) */}
      <Button
        variant="ghost"
        size="icon"
        className="h-7 w-7 text-muted-foreground hover:text-foreground"
        onClick={bumpHistoryRevision}
        disabled={rightTab !== "history"}
        aria-label="Refresh history"
        title="Refresh history"
      >
        <RefreshCw className="h-3.5 w-3.5" />
      </Button>

      {/* ── Separator ───────────────────────────────────────────────── */}
      <div className="mx-0.5 h-5 w-px bg-border" aria-hidden />

      {/* ── Chat / History tab buttons (no group wrapper) ────────────── */}
      <div role="tablist" aria-label="Right panel view" className="flex items-center">
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
                "flex h-7 w-7 items-center justify-center rounded-md transition-colors",
                "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                active
                  ? "bg-muted text-foreground"
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
 * Provider-scoped side effects that must outlive tab switches:
 * frontend-tool registration, custom tool-call renderers, and
 * threadId eager-capture. Renders nothing.
 */
function ChatProviderHooks(): ReactNode {
  useOutcomeTools();
  useCopilotSharedStateSync();
  // Specific renderers — CopilotKit's matcher prefers exact name
  // match before falling back to the wildcard.
  useRenderTool({
    name: "delegate_to_agent",
    parameters: delegateToAgentArgsSchema,
    render: DelegateToAgentCard,
  });
  // web_search renders an inline preview AND writes a Report
  // outcome via useEffect — see WebSearchInlinePreview.
  useRenderTool({
    name: "web_search",
    parameters: webSearchArgsSchema,
    render: WebSearchInlinePreview,
  });
  useHandoffTools();
  useInteractiveTools();
  // Custom wildcard replaces CopilotKit's `DefaultToolCallRenderer`
  // to add error badge + per-toolCallId elapsed timer. Registered
  // via `useRenderTool({ name: "*" })` (not `useDefaultRenderTool`)
  // because the latter's props omit `toolCallId` and break the
  // timing cache. See `WildcardToolRenderer.tsx`.
  useRenderTool({
    name: "*",
    parameters: z.any(),
    render: WildcardToolRenderer,
  });

  // threadId eager-capture: write `runtimeThreadId` once per agent
  // on the first run's `onRunInitialized` (the id is already on
  // `agent.threadId` by then). See docs/threadid-lifecycle.md and
  // docs/chat-flow-audit.md.
  const storedThreadId = useWorkspaceStore((s) => s.runtimeThreadId);
  const activeAgentId = useWorkspaceStore((s) => s.activeAgentId);
  const setChatError = useWorkspaceStore((s) => s.setChatError);
  const clearChatError = useWorkspaceStore((s) => s.clearChatError);
  const { copilotkit } = useCopilotKit();
  const { agent } = useAgent({ agentId: activeAgentId || undefined });

  // threadId eager-capture
  useEffect(() => {
    if (storedThreadId) return;
    if (!activeAgentId || !agent) return;
    const sub = copilotkit.subscribeToAgentWithOptions(
      agent,
      {
        onRunInitialized: () => {
          const tid = agent.threadId;
          if (!tid) return;
          // Recheck inside the callback — the closure guard could be
          // stale if a sibling run finalised between setup and dispatch.
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

  // Chat error capture — onRunInitialized clears stale banners,
  // onRunFailed / onRunErrorEvent populate them.
  useEffect(() => {
    if (!activeAgentId || !agent) return;
    const sub = copilotkit.subscribeToAgentWithOptions(
      agent,
      {
        // Starting a new run clears the slate so a previous run's
        // error banner doesn't sit on top of fresh output.
        onRunInitialized: () => clearChatError(),
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

  // New-chat reset. CopilotKit v2 holds messages on the per-agent
  // instance (not on `<CopilotChat>`) and its `connect-on-thread`
  // effect short-circuits in fresh-chat mode, so a remount alone
  // leaves the prior conversation visible. Drive the clear off
  // `chatEpoch`: `startFreshChat` bumps the counter, we reset agent
  // state. See docs/threadid-lifecycle.md and docs/chat-flow-audit.md.
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

  // Custom chat headers — backend sends `X-Credential-Id`, built-in
  // sends `X-Orchestration-Mode`. See docs/orchestrator.md.
  const headers = useMemo(() => {
    const h: Record<string, string> = {};
    if (agentSource === "backend" && credentialId) {
      h[CREDENTIAL_ID_HEADER] = credentialId;
    }
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
    <CopilotKitProvider
      key={copilotKey}
      runtimeUrl={runtimeUrl}
      headers={headers}
      // Stable refs — see STABLE_EMPTY_AGENTS comment at top.
      properties={STABLE_EMPTY_PROPS}
      agents__unsafe_dev_only={STABLE_EMPTY_AGENTS}
      selfManagedAgents={STABLE_EMPTY_AGENTS}
    >
      <ChatProviderHooks />
      <div
        className="flex h-full flex-col border-l"
        style={{ backgroundColor: "var(--panel-bg)" }}
      >
        <RightPanelToolbar />

        <div
          className="relative flex-1 overflow-hidden"
        >
          <div
            id="right-tabpanel-chat"
            role="tabpanel"
            aria-labelledby="right-tab-chat"
            hidden={rightTab !== "chat"}
            className="flex h-full flex-col"
          >
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
        </div>
      </div>
    </CopilotKitProvider>
  );
}
