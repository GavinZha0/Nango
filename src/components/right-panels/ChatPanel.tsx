"use client";

import "@copilotkit/react-ui/v2/styles.css";

import { memo, useCallback, useEffect, useMemo, useRef, type ReactNode } from "react";
import {
  CopilotChat,
  CopilotChatAssistantMessage,
  CopilotChatView,
  type CopilotAgent,
  type CopilotChatAssistantMessageProps,
  type CopilotChatViewProps,
  useAgent,
  useCopilotKit,
} from "@/lib/copilot/client";

import { useWorkspaceStore } from "@/store/workspace";
import { NangoSlotButton } from "@/components/right-panels/NangoSlotButton";
import { useInjectHandoffContext } from "@/hooks/useHandoff";

/**
 * ChatPanel — v2 CopilotKit chat surface (body only).
 * @see docs/chat-flow-audit.md §1.10 (chatView slot wrapper rationale).
 */

// Stable references

/** Stable reference so <CopilotChat> shallow-equality check doesn't bail out. */
const CHAT_LABELS = {
  chatInputPlaceholder: "Message the agent…",
} as const;

/** Slot config: replaces CopilotKit's default `+` with Nango entry-point. Hoisted for referential stability. */
const NANGO_INPUT_SLOT = { addMenuButton: NangoSlotButton } as const;

/** No-op for unimplemented toolbar buttons (thumbs up/down/read-aloud). v2 still renders the slot. */
const noop = () => {};

// Regeneration logic

/**
 * v2 onRegenerate is a notification slot (does NOT reload messages).
 * Truncates history to the preceding user prompt, then re-runs the agent.
 *
 * Caller passes the live per-thread agent directly — must be the same
 * instance the UI is rendering (typically obtained via `useAgent`
 * inside the chatView slot shell). See docs/chat-flow-audit.md §1.10.
 *
 * Ref-captured for referential stability across memo'd ancestors.
 */
function useOnRegenerate(agent: CopilotAgent | undefined) {
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
      console.error("ChatPanel: regeneration failed", err),
    );
  }, []); // stable — deps captured via refs
}

// ChatViewShell — chatView slot wrapper

/**
 * Slot wrapper rendered inside CopilotChat's internal
 * CopilotChatConfigurationProvider. All hooks that need to operate on
 * the live per-thread clone (regenerate, handoff injection) belong here:
 * `useAgent` falls back to chatConfig.threadId so we resolve the same
 * agent instance the chat UI is subscribed to.
 *
 * @see docs/chat-flow-audit.md §1.10
 */
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
  const onRegenerate = useOnRegenerate(agent);

  // Replace the assistant message slot to wire up onRegenerate and
  // stub out the un-implemented toolbar buttons (thumbs up/down /
  // read-aloud). Performance metrics — TTFT, run duration, etc. —
  // are not surfaced here; see /admin/thread/[id] for the
  // authoritative server-side timeline.
  const AssistantMessageWithRegenerate = useCallback(
    (props: CopilotChatAssistantMessageProps) => (
      <CopilotChatAssistantMessage
        {...props}
        onRegenerate={onRegenerate}
        onThumbsUp={noop}
        onThumbsDown={noop}
        onReadAloud={noop}
      />
    ),
    [onRegenerate],
  );

  // `SlotValue<C>` requires `C` (a namespace component with static fields)
  // but v2 runtime (`renderSlot`) accepts any component type. Cast to
  // satisfy TS without forcing our render fn into a namespace shape.
  const messageView = useMemo(
    () => ({
      assistantMessage:
        AssistantMessageWithRegenerate as unknown as typeof CopilotChatAssistantMessage,
    }),
    [AssistantMessageWithRegenerate],
  );

  // NOTE: only augment messageView. Do NOT override slotProps.messages /
  // onSubmitMessage / isRunning / hasExplicitThreadId / isConnecting —
  // those are CopilotChat-managed state.
  return <CopilotChatView {...slotProps} messageView={messageView} />;
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
      // SlotValue typing requires a namespace component; cast for the
      // same reason as messageView above (runtime accepts any FC).
      chatView={ChatViewShell as unknown as typeof CopilotChatView}
      input={NANGO_INPUT_SLOT}
    />
  );
});

// ChatPanelBody

/** Chat body for the right-panel tab. Returns null if no agent is active (defensive guard). */
export function ChatPanelBody(): ReactNode {
  const activeAgentId = useWorkspaceStore((s) => s.activeAgentId);
  // Only `explicitThreadId` flows into <CopilotChat>. Fresh-chat mode
  // keeps it `null` so CopilotKit mints its own non-explicit ABC and
  // shows the welcome screen. History-restore sets it to the picked id.
  // @see docs/chat-flow-audit.md §1.11
  const explicitThreadId = useWorkspaceStore((s) => s.explicitThreadId);

  if (!activeAgentId) return null;

  // Nango entry-point rendered inside CopilotKit's input via NANGO_INPUT_SLOT.
  return (
    <div className="h-full">
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
  // The `key` is what makes the "New chat" button actually start a
  // fresh conversation. In fresh-chat mode (`threadId === undefined`)
  // CopilotKit caches `resolvedThreadId` via
  // `useMemo(..., [providedThreadId])` and never re-mints while the
  // prop stays undefined. Bumping `chatEpoch` from
  // `RightPanel.handleNewChat` changes the key, forcing CopilotChat
  // to unmount and remount with a freshly-minted internal ABC.
  // Agent switches are also covered (agentId is in the key), so
  // they don't need a separate epoch bump.
  // @see docs/threadid-lifecycle.md §"Lifecycle Events" #5
  const chatEpoch = useWorkspaceStore((s) => s.chatEpoch);
  return (
    <MemoChat
      key={`${agentId}:${chatEpoch}`}
      agentId={agentId}
      threadId={threadId}
    />
  );
}
