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
 * See docs/chat-flow-audit.md.
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

/** v2 `onRegenerate` is a notification slot — it doesn't reload
 *  messages. We truncate history to the preceding user prompt and
 *  re-run the agent ourselves. Caller must pass the live per-thread
 *  agent (typically via `useAgent` inside the chatView slot).
 *  Ref-captured for referential stability. */
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
  const onRegenerate = useOnRegenerate(agent);

  // Wire up onRegenerate; thumbs/read-aloud slots are no-op stubs.
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

/** Chat body for the right-panel tab. Returns null when no agent
 *  is active. Only `explicitThreadId` flows into <CopilotChat>;
 *  fresh-chat mode keeps it null so CopilotKit mints a fresh ABC. */
export function ChatPanelBody(): ReactNode {
  const activeAgentId = useWorkspaceStore((s) => s.activeAgentId);
  const explicitThreadId = useWorkspaceStore((s) => s.explicitThreadId);

  if (!activeAgentId) return null;

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
