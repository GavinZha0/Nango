"use client";

import "@copilotkit/react-ui/v2/styles.css";

import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import {
  CopilotChat,
  CopilotChatAssistantMessage,
  CopilotChatUserMessage,
  CopilotChatView,
  type CopilotAgent,
  type CopilotChatAssistantMessageProps,
  type CopilotChatUserMessageProps,
  type CopilotChatViewProps,
  useAgent,
  useCopilotKit,
} from "@/lib/copilot/client";

import { cn } from "@/lib/utils";

import { useWorkspaceStore } from "@/store/workspace";
import { NangoSlotButton } from "@/components/right-panels/NangoSlotButton";
import { useInjectHandoffContext } from "@/hooks/useHandoff";
import { authClient } from "@/lib/auth/client";

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

  const { data: session } = authClient.useSession();
  const userFields = session?.user as { ttsProvider?: string | null } | undefined;
  const hasTts = !!userFields?.ttsProvider;

  // Drain pending handoff context as the first user message.
  useInjectHandoffContext(agent);
  const onRegenerate = useOnRegenerate(agent);

  // Ref-capture for stable callback — avoids re-creating the
  // assistant message component on every streaming token.
  const messagesRef = useRef(agent.messages);
  useEffect(() => { messagesRef.current = agent.messages; });

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
        const textarea = document.querySelector(
          ".copilotKitChat textarea, .copilotKitChat input, textarea"
        ) as HTMLTextAreaElement | HTMLInputElement | null;
        if (textarea) {
          textarea.focus();
        }
      }, 100);
      return () => clearTimeout(timer);
    }
  }, [agent.messages.length]);

  // Wire up onRegenerate; thumbs/read-aloud slots are no-op stubs.
  const AssistantMessageWithRegenerate = useCallback(
    (props: CopilotChatAssistantMessageProps) => {
      // Determine if this is the last message of the assistant's current turn.
      // If there's another assistant message or tool call immediately after this one,
      // we hide the toolbar to avoid rendering multiple sets of action buttons.
      const messages = messagesRef.current;
      const index = messages.findIndex((m) => m.id === props.message.id);
      
      let isEndOfTurn = true;
      if (index !== -1 && index < messages.length - 1) {
        const nextMessage = messages[index + 1];
        if (nextMessage?.role !== "user") {
          isEndOfTurn = false;
        }
      }

      return (
        <CopilotChatAssistantMessage
          {...props}
          onRegenerate={isEndOfTurn ? onRegenerate : undefined}
          onThumbsUp={isEndOfTurn ? noop : undefined}
          onThumbsDown={isEndOfTurn ? noop : undefined}
          onReadAloud={isEndOfTurn && hasTts ? readAloud : undefined}
        />
      );
    },
    [onRegenerate, hasTts],
  );

  // `SlotValue<C>` requires `C` (a namespace component with static fields)
  // but v2 runtime (`renderSlot`) accepts any component type. Cast to
  // satisfy TS without forcing our render fn into a namespace shape.
  const messageView = useMemo(
    () => ({
      userMessage:
        CollapsibleUserMessage as unknown as typeof CopilotChatUserMessage,
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
