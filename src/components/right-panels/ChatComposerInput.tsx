"use client";

/**
 * ChatComposerInput — two-row composer built on CopilotKit's `CopilotChatInput`
 * render-prop slot so text input, IME handling, Enter/Shift+Enter, auto-resize,
 * and send/stop mechanics stay 100% CopilotKit-managed.
 */

import type { MouseEvent, ReactNode } from "react";
import {
  Check,
  ChevronDown,
  Loader2,
  Plus,
  Shield,
  ShieldAlert,
  ShieldCheck,
  ShieldOff,
} from "lucide-react";

import {
  CopilotChatInput,
  type CopilotChatInputProps,
} from "@/lib/copilot/client";
import { authClient } from "@/lib/auth/client";
import { useRole } from "@/hooks/useRole";
import {
  parseToolApprovalMode,
  type ToolApprovalMode,
} from "@/lib/http/chat-headers";
import { useWorkspaceStore } from "@/store/workspace";
import { cn } from "@/lib/utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { NangoSlotButton } from "@/components/right-panels/NangoSlotButton";
import { StreamingMicButton } from "@/components/right-panels/StreamingMicButton";

interface ApprovalModeMeta {
  id: ToolApprovalMode;
  label: string;
  description: string;
  icon: typeof Shield;
}

const APPROVAL_MODES: readonly ApprovalModeMeta[] = [
  {
    id: "auto",
    label: "Auto",
    description: "Approve high-risk tool calls",
    icon: ShieldCheck,
  },
  {
    id: "always",
    label: "Always",
    description: "Approve every tool call",
    icon: ShieldAlert,
  },
  {
    id: "never",
    label: "Never",
    description: "Run tools without approval",
    icon: ShieldOff,
  },
] as const;

const APPROVAL_MODE_MAP: Record<ToolApprovalMode, ApprovalModeMeta> = {
  auto: APPROVAL_MODES[0],
  always: APPROVAL_MODES[1],
  never: APPROVAL_MODES[2],
};

function UploadFileButton({ onAddFile }: { onAddFile?: () => void }): ReactNode {
  const enabled = Boolean(onAddFile);
  return (
    <span className="inline-flex" title="Upload file">
      <button
        type="button"
        disabled={!enabled}
        onClick={onAddFile}
        data-testid="composer-upload-button"
        aria-label="Upload file"
        className={cn(
          "inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
          enabled
            ? "cursor-pointer text-muted-foreground hover:bg-accent hover:text-foreground"
            : "cursor-not-allowed text-muted-foreground/45",
        )}
      >
        <Plus className="h-4 w-4" />
      </button>
    </span>
  );
}

function ApprovalModeSelector(): ReactNode {
  const { isEditor } = useRole();
  const activeAgentId = useWorkspaceStore((s) => s.activeAgentId);
  const activeAgentSource = useWorkspaceStore((s) => s.activeAgentSource);
  const builtinAgents = useWorkspaceStore((s) => s.builtinAgents);
  const approvalModeOverride = useWorkspaceStore((s) => s.approvalModeOverride);
  const setApprovalModeOverride = useWorkspaceStore(
    (s) => s.setApprovalModeOverride,
  );

  const activeBuiltinAgent =
    activeAgentSource === "builtin" && activeAgentId
      ? builtinAgents.find((a) => a.id === activeAgentId)
      : undefined;
  const isBuiltin = Boolean(activeBuiltinAgent);
  const defaultMode: ToolApprovalMode | null = isBuiltin
    ? (parseToolApprovalMode(activeBuiltinAgent?.toolApprovalMode) ?? "auto")
    : null;
  const effectiveMode: ToolApprovalMode | null = isBuiltin
    ? (approvalModeOverride ?? defaultMode ?? "auto")
    : null;
  const isOverridden =
    isBuiltin &&
    approvalModeOverride !== null &&
    approvalModeOverride !== defaultMode;
  const canEdit = isBuiltin && isEditor;

  const activeMeta = effectiveMode ? APPROVAL_MODE_MAP[effectiveMode] : null;
  const ModeIcon = activeMeta?.icon ?? Shield;
  const displayLabel = activeMeta?.label ?? "External";

  if (!canEdit) {
    return (
      <span className="inline-flex" title="Approval mode">
        <button
          type="button"
          disabled
          data-testid="composer-approval-mode"
          data-mode={effectiveMode ?? "external"}
          aria-label="Approval mode"
          className="inline-flex h-7 shrink-0 cursor-not-allowed items-center gap-1 rounded-full px-2 text-xs font-medium text-muted-foreground/50"
        >
          <ModeIcon className="h-3.5 w-3.5 shrink-0" />
          <span>{displayLabel}</span>
        </button>
      </span>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <button
            type="button"
            data-testid="composer-approval-mode"
            data-mode={effectiveMode ?? "auto"}
            data-overridden={isOverridden ? "true" : "false"}
            aria-label="Approval mode"
            title="Approval mode"
            className="inline-flex h-7 shrink-0 cursor-pointer items-center gap-1 rounded-full px-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            <ModeIcon className="h-3.5 w-3.5 shrink-0" />
            <span>{displayLabel}</span>
            <ChevronDown className="h-3 w-3 opacity-70" />
          </button>
        }
      />

      <DropdownMenuContent align="start" side="top" className="w-56">
        {APPROVAL_MODES.map((item) => {
          const Icon = item.icon;
          const isSelected = item.id === effectiveMode;
          const isDefault = item.id === defaultMode;
          return (
            <DropdownMenuItem
              key={item.id}
              data-testid={`approval-mode-option-${item.id}`}
              onClick={() =>
                setApprovalModeOverride(isDefault ? null : item.id)
              }
              className="flex items-start gap-2 py-2"
            >
              <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span
                    className={cn(
                      "text-xs",
                      isSelected ? "font-semibold" : "font-medium",
                    )}
                  >
                    {item.label}
                  </span>
                  {isDefault && (
                    <span className="rounded bg-muted px-1 py-0.2 text-[10px] text-muted-foreground">
                      Default
                    </span>
                  )}
                </div>
                <p className="text-[11px] leading-snug text-muted-foreground">
                  {item.description}
                </p>
              </div>
              {isSelected && (
                <Check className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              )}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const COMPACT_TOOLBAR_ICON = { className: "h-7! w-7! [&_svg]:size-4!" } as const;

export function ChatComposerInput(props: CopilotChatInputProps): ReactNode {
  const { data: session } = authClient.useSession();
  const userFields = session?.user as
    | { sttCredentialId?: string | null }
    | undefined;
  const useContinuousVoice = Boolean(userFields?.sttCredentialId);
  const realGetUserMedia =
    typeof navigator !== "undefined" && navigator.mediaDevices
      ? navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices)
      : undefined;

  const { className, bottomAnchored = false, ...restProps } = props;

  return (
    <CopilotChatInput
      {...restProps}
      bottomAnchored={bottomAnchored}
      sendButton={restProps.sendButton ?? COMPACT_TOOLBAR_ICON}
      cancelTranscribeButton={restProps.cancelTranscribeButton ?? COMPACT_TOOLBAR_ICON}
      finishTranscribeButton={restProps.finishTranscribeButton ?? COMPACT_TOOLBAR_ICON}
    >
      {({
        textArea,
        audioRecorder,
        sendButton,
        cancelTranscribeButton,
        finishTranscribeButton,
        disclaimer,
        mode,
        onAddFile,
        onCancelTranscribe,
        onFinishTranscribe,
        positioning,
        keyboardHeight = 0,
        showDisclaimer,
        containerRef,
      }) => {
        const handleCardClick = (e: MouseEvent<HTMLDivElement>) => {
          const target = e.target as HTMLElement;
          if (target.closest("button") || target.closest("[role='menuitem']")) {
            return;
          }
          const textarea = e.currentTarget.querySelector("textarea");
          if (textarea && mode === "input") {
            textarea.focus();
          }
        };

        return (
          <div
            ref={containerRef}
            className={cn(
              "pointer-events-none relative z-20",
              positioning === "absolute" && "absolute bottom-0 left-0 right-0",
              className,
            )}
            style={{
              transform:
                keyboardHeight > 0
                  ? `translateY(-${keyboardHeight}px)`
                  : undefined,
              transition: "transform 0.2s ease-out",
              ...(positioning === "absolute" || bottomAnchored
                ? {
                    paddingBottom:
                      "var(--copilotkit-license-banner-offset, 0px)",
                  }
                : {}),
            }}
          >
            <div className="pointer-events-auto mx-auto max-w-3xl px-4 py-0">
              {/* CONTRACT: keep `.copilotKitInput` and `data-testid="copilot-chat-input"`
                  so `useStreamingASR` and ChatPanel auto-focus locate the textarea. */}
              <div
                data-testid="copilot-chat-input"
                onClick={handleCardClick}
                className={cn(
                  "copilotKitInput flex w-full cursor-text flex-col overflow-visible rounded-2xl border border-border/80 bg-white shadow-[0_4px_12px_rgba(0,0,0,0.06)] transition-colors focus-within:border-ring/50 dark:bg-[#2a2a2a] dark:shadow-[0_4px_12px_rgba(0,0,0,0.28)]",
                )}
              >
                {/* Row 1: full-width input area */}
                <div className="relative flex min-h-[44px] w-full flex-col justify-center px-3.5 pt-2.5 pb-1 [&>textarea]:p-0!">
                  {mode === "transcribe" ? (
                    audioRecorder
                  ) : mode === "processing" ? (
                    <div className="flex w-full items-center justify-center py-2">
                      <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                    </div>
                  ) : (
                    textArea
                  )}
                </div>

                {/* Row 2: action toolbar */}
                <div className="flex items-center justify-between gap-1 px-2 pb-2 pt-1">
                  <div className="flex min-w-0 items-center gap-1">
                    <UploadFileButton
                      onAddFile={mode === "input" ? onAddFile : undefined}
                    />
                    <NangoSlotButton />
                    <ApprovalModeSelector />
                  </div>

                  <div className="flex shrink-0 items-center gap-1.5 [&>div]:mr-0!">
                    {mode === "transcribe" ? (
                      <>
                        {onCancelTranscribe && cancelTranscribeButton}
                        {onFinishTranscribe && finishTranscribeButton}
                      </>
                    ) : (
                      <>
                        {useContinuousVoice && realGetUserMedia && (
                          <StreamingMicButton getUserMedia={realGetUserMedia} />
                        )}
                        {sendButton}
                      </>
                    )}
                  </div>
                </div>
              </div>
            </div>
            {showDisclaimer && disclaimer}
          </div>
        );
      }}
    </CopilotChatInput>
  );
}
