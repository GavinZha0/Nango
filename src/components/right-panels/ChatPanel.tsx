"use client";

import "@copilotkit/react-ui/v2/styles.css";

import {
  createContext,
  memo,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import { toast } from "sonner";
import {
  CopilotChat,
  CopilotChatAssistantMessage,
  CopilotChatReasoningMessage,
  CopilotChatToolCallsView,
  CopilotChatUserMessage,
  CopilotChatView,
  type CopilotChatAssistantMessageProps,
  type CopilotChatReasoningMessageProps,
  type CopilotChatToolCallsViewProps,
  type CopilotChatUserMessageProps,
  type CopilotChatViewProps,
  useAgent,
  useCopilotKit,
} from "@/lib/copilot/client";

import { cn } from "@/lib/utils";

import { useWorkspaceStore } from "@/store/workspace";
import { ChatComposerInput } from "@/components/right-panels/ChatComposerInput";
import { useElapsedSeconds } from "@/components/copilotkit/use-elapsed-seconds";
import { useRegenerate } from "@/hooks/useRegenerate";
import { useInjectHandoffContext } from "@/hooks/useHandoff";
import { authClient } from "@/lib/auth/client";
import { classifyError } from "@/lib/copilot/classify-error";
import {
  formatTokenPair,
  formatTokenTooltip,
  mergeTokenUsage,
  summarizeRunUsage,
  type TokenUsageSummary,
} from "@/lib/copilot/token-usage";

/**
 * ChatPanel — v2 CopilotKit chat surface (body only).
 * See docs/chat-flow-audit.md.
 */

// Stable references

/** Stable reference so <CopilotChat> shallow-equality check doesn't bail out. */
const CHAT_LABELS = {
  chatInputPlaceholder: "Message the agent…",
  chatInputToolbarStartTranscribeButtonLabel: "Start voice input",
  chatInputToolbarCancelTranscribeButtonLabel: "Cancel voice input",
  chatInputToolbarFinishTranscribeButtonLabel: "Finish voice input",
  chatInputToolbarAddButtonLabel: "Add attachment or context",
  chatInputToolbarToolsButtonLabel: "Tools",
  chatInputToolbarSendButtonLabel: "Send message",
  chatInputToolbarStopButtonLabel: "Stop generating",
  assistantMessageToolbarCopyCodeLabel: "Copy code",
  assistantMessageToolbarCopyCodeCopiedLabel: "Copied",
  assistantMessageToolbarCopyMessageLabel: "Copy message",
  assistantMessageToolbarThumbsUpLabel: "Good response",
  assistantMessageToolbarThumbsDownLabel: "Bad response",
  assistantMessageToolbarReadAloudLabel: "Read aloud",
  assistantMessageToolbarRegenerateLabel: "Regenerate response",
  userMessageToolbarCopyMessageLabel: "Copy message",
  userMessageToolbarEditMessageLabel: "Edit message",
  chatScrollToBottomLabel: "Scroll to bottom",
  chatConnectingLabel: "Connecting…",
} as const;

/** No-op for unimplemented toolbar buttons (thumbs up/down/read-aloud). v2 still renders the slot. */
const noop = () => {};

/** Per-turn token usage keyed by the turn's originating user message id
 *  (or `"__turn_0__"` when a reply has no preceding user message). */
const EMPTY_TURN_USAGE: ReadonlyMap<string, TokenUsageSummary> = new Map();
const TurnUsageContext = createContext<ReadonlyMap<string, TokenUsageSummary>>(
  EMPTY_TURN_USAGE,
);

function findTurnKey(
  messages: ReadonlyArray<{ id: string; role?: string }>,
  endIdxInclusive: number,
): string {
  for (let i = Math.min(endIdxInclusive, messages.length - 1); i >= 0; i--) {
    if (messages[i]?.role === "user") {
      return messages[i].id;
    }
  }
  return "__turn_0__";
}

let activeAudio: HTMLAudioElement | null = null;
let activeMessageId: string | null = null;

async function readAloud(message: {id?: string; content?: string}): Promise<void> {
  if (activeAudio && activeMessageId === (message.id ?? null)) {
    activeAudio.pause();
    activeAudio = null;
    activeMessageId = null;
    return;
  }

  if (activeAudio) {
    activeAudio.pause();
    activeAudio = null;
    activeMessageId = null;
  }

  const text = typeof message.content === 'string' ? message.content.trim() : '';
  if (!text) return;
  try {
    const res = await fetch('/api/tts', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ text: text.slice(0, 5000) }),
    });

    if (!res.ok) {
      let errorMsg = 'Failed to generate audio';
      try {
        const data = await res.json();
        if (data?.message) {
          errorMsg = data.message;
        }
      } catch {
        // ignore
      }
      throw new Error(errorMsg);
    }

    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);

    audio.addEventListener('ended', () => {
      URL.revokeObjectURL(url);
      if (activeAudio === audio) {
        activeAudio = null;
        activeMessageId = null;
      }
    });
    
    activeAudio = audio;
    activeMessageId = message.id ?? null;
    await audio.play();
  } catch (error) {
    activeAudio = null;
    activeMessageId = null;
    console.error('Failed to generate audio:', error);
    toast.error(error instanceof Error ? error.message : 'Failed to generate TTS audio');
  }
}

function CollapsibleUserMessage(props: CopilotChatUserMessageProps): ReactNode {
  const [isExpanded, setIsExpanded] = useState(false);
  const [canCollapse, setCanCollapse] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const checkOverflow = () => {
      if (containerRef.current) {
        const proseEl = containerRef.current.querySelector('[class*="prose"]') as HTMLElement;
        if (proseEl && !isExpanded) {
          // If the intrinsic height (scrollHeight) is greater than the clamped height
          // (clientHeight), the text is overflowing the 3-line limit.
          setCanCollapse(proseEl.scrollHeight > proseEl.clientHeight);
        }
      }
    };

    const timeout = setTimeout(checkOverflow, 50);
    return () => clearTimeout(timeout);
  }, [props.message.content, isExpanded]);

  return (
    <div className="relative group/user-msg flex flex-col w-full">
      <div
        ref={containerRef}
        onClick={() => {
          if (canCollapse) setIsExpanded(!isExpanded);
        }}
        className={cn(
          "transition-all duration-200",
          canCollapse && "cursor-pointer hover:opacity-95",
          !isExpanded && "[&_[class*='prose']]:line-clamp-3 [&_[class*='prose']]:overflow-hidden [&_[class*='prose']]:[-webkit-box-orient:vertical]"
        )}
      >
        <CopilotChatUserMessage {...props} />
      </div>
    </div>
  );
}

// ChatViewShell — chatView slot wrapper

// ── Custom Tool Calls View (Grouped + Pending Approval Guard) ────

/**
 * Collapses consecutive wildcard tool calls into a compact summary line
 * (`display="line"`), while falling back to `display="separate"` whenever
 * any tool call in the message has a pending approval so HITL approval
 * buttons are never hidden inside a collapsed group.
 */
function GroupedToolCallsView(props: CopilotChatToolCallsViewProps): ReactElement | null {
  const pendingApprovals = useWorkspaceStore((s) => s.pendingApprovals);
  const toolCalls = props.message.toolCalls;
  const hasPendingApproval =
    pendingApprovals.length > 0 &&
    Array.isArray(toolCalls) &&
    toolCalls.some((tc) =>
      pendingApprovals.some(
        (a) =>
          (a.toolCallId && a.toolCallId === tc.id) ||
          a.toolName === tc.function.name,
      ),
    );

  return (
    <CopilotChatToolCallsView
      {...props}
      display={hasPendingApproval ? "separate" : "line"}
    />
  );
}

// ── Custom Assistant Message with Turn-End Button Logic ──────────

function ConnectedAssistantMessage(
  props: CopilotChatAssistantMessageProps,
): ReactNode {
  const activeAgentId = useWorkspaceStore((s) => s.activeAgentId);
  const { agent } = useAgent({ agentId: activeAgentId ?? "" });
  const regenerate = useRegenerate(agent);

  const { data: session } = authClient.useSession();
  const userFields = session?.user as { ttsCredentialId?: string | null } | undefined;
  const hasTts = !!userFields?.ttsCredentialId;

  const messages = agent.messages;
  const isRunning = agent.isRunning;
  const index = messages.findIndex((m) => m.id === props.message.id);

  let isEndOfTurn = true;
  if (index !== -1) {
    const remaining = messages.slice(index + 1);
    const nextUserIdx = remaining.findIndex((m) => m.role === "user");

    if (nextUserIdx !== -1) {
      // Historical turn: followed by a subsequent user prompt.
      // Is end-of-turn if no other assistant message exists before that next user prompt.
      const turnSubSlice = remaining.slice(0, nextUserIdx);
      const hasLaterAssistant = turnSubSlice.some((m) => m.role === "assistant");
      isEndOfTurn = !hasLaterAssistant;
    } else {
      // Current active turn: no subsequent user prompt yet.
      // Hide toolbar if agent is actively running or if a later assistant message exists.
      if (isRunning) {
        isEndOfTurn = false;
      } else {
        const hasLaterAssistant = remaining.some((m) => m.role === "assistant");
        isEndOfTurn = !hasLaterAssistant;
      }
    }
  }

  const hasText = Boolean(props.message.content && props.message.content.trim().length > 0);
  const hasToolCalls = Boolean(props.message.toolCalls && props.message.toolCalls.length > 0);
  const forceToolTurnToolbar = !hasText && hasToolCalls && isEndOfTurn && !isRunning;

  const turnUsageMap = useContext(TurnUsageContext);
  const turnKey = index !== -1 ? findTurnKey(messages, index) : "__turn_0__";
  const turnUsage = isEndOfTurn ? turnUsageMap.get(turnKey) : undefined;
  const tokenLabel = formatTokenPair(turnUsage);
  const tokenTooltip = formatTokenTooltip(turnUsage);

  return (
    <CopilotChatAssistantMessage
      {...props}
      toolCallsView={GroupedToolCallsView}
      onRegenerate={isEndOfTurn ? regenerate : undefined}
      onThumbsUp={isEndOfTurn ? noop : undefined}
      onThumbsDown={isEndOfTurn ? noop : undefined}
      onReadAloud={isEndOfTurn && hasTts ? readAloud : undefined}
      additionalToolbarItems={
        tokenLabel ? (
          <span
            data-testid="copilot-token-usage"
            title={tokenTooltip}
            className="ml-auto select-text font-mono text-[11px] tabular-nums text-muted-foreground/80"
          >
            {tokenLabel}
          </span>
        ) : undefined
      }
    >
      {forceToolTurnToolbar
        ? ({ markdownRenderer, toolCallsView, toolbar }) => (
            <div
              data-testid="copilot-assistant-message"
              className="copilotKitMessage copilotKitAssistantMessage"
            >
              <div className="cpk:prose cpk:max-w-full cpk:break-words cpk:dark:prose-invert">
                {markdownRenderer}
              </div>
              {toolCallsView}
              {toolbar}
            </div>
          )
        : undefined}
    </CopilotChatAssistantMessage>
  );
}

// ── Custom Collapsible Reasoning Message with Live Elapsed Seconds ──

/**
 * Custom reasoning message renderer that stays collapsed by default
 * even while streaming thoughts, preventing layout jumps and keeping
 * the response body front-and-center. Displays live elapsed duration
 * during output and total elapsed time on completion.
 */
function CollapsibleReasoningMessage({
  message,
  messages,
  isRunning,
  isLatest: isLatestProp,
  className,
  header: _header,
  contentView: _contentView,
  toggle: _toggle,
  children: _children,
  ...props
}: CopilotChatReasoningMessageProps): ReactNode {
  const isLatest = isLatestProp ?? (messages?.[messages.length - 1]?.id === message.id);
  const isStreaming = !!(isRunning && isLatest);
  const hasContent = !!(message.content && message.content.length > 0);

  // Default collapsed (never force-opened during streaming). User can expand on click.
  const [isOpen, setIsOpen] = useState(false);

  // Track elapsed seconds in real time using the shared timing hook
  const elapsed = useElapsedSeconds(message.id, isStreaming);

  const label = isStreaming
    ? `Thinking · ${elapsed}`
    : elapsed && elapsed !== "0s"
      ? `Thought for ${elapsed}`
      : "Thought";

  const handleToggle = hasContent ? () => setIsOpen((prev) => !prev) : undefined;

  return (
    <div
      className={cn("cpk:my-1", className)}
      data-message-id={message.id}
      {...props}
    >
      <CopilotChatReasoningMessage.Header
        isOpen={isOpen}
        label={label}
        hasContent={hasContent}
        isStreaming={isStreaming}
        onClick={handleToggle}
      />
      <CopilotChatReasoningMessage.Toggle isOpen={isOpen}>
        <CopilotChatReasoningMessage.Content
          isStreaming={isStreaming}
          hasContent={hasContent}
        >
          {message.content}
        </CopilotChatReasoningMessage.Content>
      </CopilotChatReasoningMessage.Toggle>
    </div>
  );
}

/** Top-level static messageView object — zero references changes across turns,
 *  preventing CopilotChatView from unmounting/remounting the entire list and resetting scroll. */
const STATIC_MESSAGE_VIEW = {
  userMessage: CollapsibleUserMessage as unknown as typeof CopilotChatUserMessage,
  assistantMessage: ConnectedAssistantMessage as unknown as typeof CopilotChatAssistantMessage,
  reasoningMessage: CollapsibleReasoningMessage as unknown as typeof CopilotChatReasoningMessage,
};

// ChatViewShell — chatView slot wrapper

/** Slot wrapper inside CopilotChat's chatConfig provider. Hooks
 *  that need the live per-thread clone (regenerate, handoff
 *  injection) live here so `useAgent` resolves the same agent
 *  instance the chat UI is subscribed to. */
function ChatViewShell(slotProps: CopilotChatViewProps): ReactNode {
  const activeAgentId = useWorkspaceStore((s) => s.activeAgentId);
  // Defensive: if the active agent vanishes mid-unmount, fall back to the
  // default view rather than calling useAgent with an invalid id.
  if (!activeAgentId) return <CopilotChatView {...slotProps} />;
  return <ChatViewShellBody agentId={activeAgentId} slotProps={slotProps} />;
}

function ChatViewShellBody({
  agentId,
  slotProps,
}: {
  agentId: string;
  slotProps: CopilotChatViewProps;
}): ReactNode {
  // useAgent here picks up chatConfig.threadId via fallback — same clone
  // the CopilotChat UI is rendering, regardless of the outer threadId prop.
  const { agent } = useAgent({ agentId });

  // Drain pending handoff context as the first user message.
  useInjectHandoffContext(agent);

  // Auto-focus input when chatbot input moves to bottom after first message
  const hasFocusedFirstMsgRef = useRef(false);
  useEffect(() => {
    if (agent.messages.length === 0) {
      hasFocusedFirstMsgRef.current = false;
      return;
    }
    if (agent.messages.length > 0 && !hasFocusedFirstMsgRef.current) {
      hasFocusedFirstMsgRef.current = true;
      const timer = setTimeout(() => {
        // SECURITY / CONTRACT: Restrict query strictly to the right chat panel
        // so global textarea elements in main workspace panels (editor, verification, eval)
        // are never focused accidentally.
        const chatRoot =
          document.querySelector('[data-slot="chat-panel-body"]') ||
          document.querySelector('[data-testid="right-chat-panel"]');
        const textarea = chatRoot?.querySelector(
          ".copilotKitInput textarea, .copilotKitChat textarea, textarea, input"
        ) as HTMLTextAreaElement | HTMLInputElement | null;
        if (textarea) {
          textarea.focus();
        }
      }, 100);
      return () => clearTimeout(timer);
    }
  }, [agent.messages.length]);

  // Per-turn token usage collected from live & `/connect` replayed `RUN_FINISHED` events.
  // `ChatViewShellBody` remounts on `key={agentId:chatEpoch}` so state starts clean per agent/chat.
  const turnRunsRef = useRef<Map<string, Map<string, TokenUsageSummary>>>(new Map());
  const [turnUsageMap, setTurnUsageMap] = useState<ReadonlyMap<string, TokenUsageSummary>>(
    EMPTY_TURN_USAGE,
  );

  // Subscribe to agent run errors & token usage: toast for system infrastructure errors,
  // in-chat role: "activity" error_card for session/model errors, and per-turn token totals
  // from `RUN_FINISHED.usage` (covers both live runs and `/connect` history replay).
  const { copilotkit } = useCopilotKit();
  useEffect(() => {
    if (!agent) return;
    turnRunsRef.current = new Map();

    const handleError = (rawErr: unknown) => {
      const classified = classifyError(rawErr);
      if (classified.scope === "system") {
        toast.error(classified.message);
        return;
      }

      // Session / model error -> inject activity message into chat stream.
      // Deduplicate if the last message is already an error_card.
      const msgs = agent.messages;
      const lastMsg = msgs.length > 0 ? msgs[msgs.length - 1] : undefined;
      if (
        lastMsg &&
        lastMsg.role === "activity" &&
        (lastMsg as { activityType?: string }).activityType === "error_card"
      ) {
        return;
      }

      const errorPayload: Record<string, unknown> =
        typeof rawErr === "object" && rawErr !== null
          ? (rawErr as Record<string, unknown>)
          : { message: classified.rawMessage };

      agent.addMessage({
        id: `err-${Date.now()}`,
        role: "activity",
        activityType: "error_card",
        content: {
          message: classified.message,
          error: errorPayload,
        },
      } as unknown as Parameters<typeof agent.addMessage>[0]);
    };

    const sub = copilotkit.subscribeToAgentWithOptions(
      agent,
      {
        onRunFailed: ({ error }) => handleError(error),
        onRunErrorEvent: ({ event: errEvent }) => handleError(errEvent),
      },
      {},
    );

    // Subscribe directly on the AG-UI agent for `onRunFinishedEvent` (not in
    // `subscribeToAgentWithOptions`'s allowlist) so live runs and `/connect`
    // history replays both populate per-turn token usage.
    const usageSub = agent.subscribe({
      onMessagesChanged: ({ messages }) => {
        if (messages.length === 0 && turnRunsRef.current.size > 0) {
          turnRunsRef.current = new Map();
          setTurnUsageMap(EMPTY_TURN_USAGE);
        }
      },
      onRunStartedEvent: ({ messages }) => {
        // On Regenerate, history is truncated so the trailing message is the
        // retried user prompt; drop its prior run usage before the new run lands.
        // Frontend-tool continuation runs start after a `tool` message, so their
        // preceding Run 1 usage is preserved and summed with Run 2.
        const tail = messages.length > 0 ? messages[messages.length - 1] : undefined;
        if (tail?.role === "user" && turnRunsRef.current.has(tail.id)) {
          turnRunsRef.current.delete(tail.id);
          setTurnUsageMap((prev) => {
            if (!prev.has(tail.id)) return prev;
            const next = new Map(prev);
            next.delete(tail.id);
            return next;
          });
        }
      },
      onRunFinishedEvent: ({ event, messages }) => {
        const parsed = summarizeRunUsage(event.usage);
        if (!parsed) return;
        const turnKey = findTurnKey(messages, messages.length - 1);
        let byRun = turnRunsRef.current.get(turnKey);
        if (!byRun) {
          byRun = new Map();
          turnRunsRef.current.set(turnKey, byRun);
        }
        const runKey = event.runId || `${turnKey}:${byRun.size}`;
        byRun.set(runKey, parsed);
        const merged = mergeTokenUsage([...byRun.values()]);
        if (!merged) return;
        setTurnUsageMap((prev) => {
          const next = new Map(prev);
          next.set(turnKey, merged);
          return next;
        });
      },
    });

    return () => {
      sub.unsubscribe();
      usageSub.unsubscribe();
    };
  }, [agent, copilotkit]);

  // NOTE: only augment messageView using the static top-level reference.
  // Do NOT override slotProps.messages / onSubmitMessage / isRunning —
  // those are CopilotChat-managed state.
  return (
    <TurnUsageContext.Provider value={turnUsageMap}>
      <CopilotChatView {...slotProps} messageView={STATIC_MESSAGE_VIEW} />
    </TurnUsageContext.Provider>
  );
}

// MemoChat

/** Memoised chat surface. Isolates <CopilotChat> from panel chrome re-renders. */
const MemoChat = memo(function MemoChat({
  agentId,
  threadId,
}: {
  agentId: string;
  threadId: string | undefined;
}) {
  return (
    <CopilotChat
      agentId={agentId}
      threadId={threadId}
      labels={CHAT_LABELS}
      chatView={ChatViewShell}
      input={ChatComposerInput}
    />
  );
});

// ChatPanelBody

/** Chat body for the right-panel tab. Returns null when no agent
 *  is active. Only `explicitThreadId` flows into <CopilotChat>;
 *  fresh-chat mode keeps it null so CopilotKit mints a fresh ABC. */
export function ChatPanelBody(): ReactNode {
  const activeAgentId = useWorkspaceStore((s) => s.activeAgentId);
  const explicitThreadId = useWorkspaceStore((s) => s.explicitThreadId);

  useEffect(() => {
    if (typeof window === "undefined" || !navigator.mediaDevices?.getUserMedia) return;

    const originalGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);

    navigator.mediaDevices.getUserMedia = async function (constraints) {
      try {
        return await originalGetUserMedia(constraints);
      } catch (err) {
        if (constraints?.audio) {
          let friendlyMsg = "Failed to access microphone.";
          if (err instanceof Error) {
            if (err.name === "NotFoundError" || err.name === "DevicesNotFoundError") {
              friendlyMsg = "No microphone device found on your system.";
            } else if (err.name === "NotAllowedError" || err.name === "PermissionDeniedError") {
              friendlyMsg = "Microphone permission was denied by the browser.";
            } else if (err.name === "NotReadableError" || err.name === "TrackStartError") {
              friendlyMsg = "Microphone is already in use by another application.";
            } else if (err.message) {
              friendlyMsg = err.message;
            }
          }

          toast.error(friendlyMsg);
        }
        throw err;
      }
    };

    return () => {
      navigator.mediaDevices.getUserMedia = originalGetUserMedia;
    };
  }, []);

  if (!activeAgentId) return null;

  return (
    <div className="h-full" data-slot="chat-panel-body">
      <ChatPanelInner
        agentId={activeAgentId}
        threadId={explicitThreadId ?? undefined}
      />
    </div>
  );
}

/**
 * Inner component inside CopilotKitProvider. Hooks that need the
 * per-thread clone live inside ChatViewShell (chatView slot of
 * <CopilotChat>); this layer is only here to own the remount key.
 */
function ChatPanelInner({
  agentId,
  threadId,
}: {
  agentId: string;
  threadId: string | undefined;
}): ReactNode {
  // `key={agentId:chatEpoch}` forces a remount on agent switch
  // OR `startFreshChat` so CopilotKit mints a fresh internal ABC
  // (otherwise its useMemo caches the first one). See
  // docs/threadid-lifecycle.md.
  const chatEpoch = useWorkspaceStore((s) => s.chatEpoch);
  return (
    <MemoChat
      key={`${agentId}:${chatEpoch}`}
      agentId={agentId}
      threadId={threadId}
    />
  );
}
