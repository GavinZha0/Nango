"use client";

/**
 * WildcardToolRenderer — the fallback chat-side renderer for every
 * tool call that doesn't have a name-specific `useRenderTool`
 * registration (MCP tools, sandbox `run_code_in_sandbox`,
 * `extract_dataset_by_sql`, `run_ssh_command`, `list_ssh_hosts`,
 * `get_skill`, `get_skill_file`, `run_skill_script`, all the
 * supervisor schedule tools, and anything new added later).
 *
 * Replaces CopilotKit's built-in `DefaultToolCallRenderer` (registered
 * via `useDefaultRenderTool()` with `render: WildcardToolRenderer`).
 * The visual style intentionally mirrors the vendor default — low-key
 * grey-themed card — so the only user-visible behavioural difference
 * is the badge colour reacting to result content:
 *
 *   - tool execute throws (caught by wrapToolExecute, returns
 *     { isError: true, message, toolName })             → red Error
 *   - tool returns business failure (e.g. { ok: false })  → red Error
 *   - tool returns process-result envelope with
 *     non-zero exitCode (run_code_in_sandbox traceback)  → red Error
 *   - tool returns recognised success                     → green Done
 *   - tool returns unrecognised shape                     → green Done
 *     (we don't infer failure from absence of a flag)
 *   - tool still running                                  → amber Running
 *
 * The full envelope-detection rules live in
 * `lib/copilot/detect-tool-result-status.ts`, mirrored by the save
 * pipeline's `coalesce-tool-calls.ts::isFailedEnvelope` so the chat
 * card, admin event timeline, and workflow save filter all agree.
 *
 * On failure the error message is surfaced in the collapsed-state
 * header so the user doesn't have to expand to see what went wrong;
 * the expanded view shows the full args + result JSON for debugging.
 * For sandbox failures the surfaced message is the `stderr` text
 * (Python traceback, ModuleNotFoundError, OOM, …).
 */

import { useEffect, useMemo, useState, type ReactElement } from "react";
import { ArrowUpRight, ChevronDown, ChevronRight, ImageIcon, Wrench } from "lucide-react";
import { useRouter } from "next/navigation";

import { useToolApproval, ToolApprovalButtons, ToolApprovalBadge } from "@/hooks/useToolApproval";
import { useOutcomeStore } from "@/store/outcome-store";
import { useWorkspaceStore } from "@/store/workspace";

import {
  detectToolResultStatus,
  extractErrorMessage,
} from "@/lib/copilot/detect-tool-result-status";
import { useElapsedSeconds } from "@/components/copilotkit/use-elapsed-seconds";
import {
  ToolStatusBadge,
  deriveBadgeStatus,
} from "@/components/copilotkit/ToolStatusBadge";

/** Props CopilotKit v2 passes to wildcard / per-tool renderers.
 *  Locally re-declared (matches `RenderToolProps` minus the schema
 *  generic) to avoid deep imports into CopilotKit internals. */
export type WildcardRenderProps = {
  name: string;
  toolCallId: string;
  parameters: unknown;
  status: "inProgress" | "executing" | "complete";
  result: string | undefined;
};

interface ExtractedToolImage {
  src: string;
  mimeType?: string;
  alt?: string;
  filename?: string;
}

function extractFilenameFromScreenshotText(text: string): string | null {
  if (!text || typeof text !== "string") return null;

  // 1. Match Markdown link: [Screenshot of viewport](./mypage) or [Screenshot](...)
  const mdMatch = text.match(/\[(?:[^\]]*screenshot[^\]]*)\]\(([^)]+)\)/i);
  // 2. Match Playwright code block parameter: path: './mypage'
  const codeMatch = text.match(/path:\s*['"]([^'"]+)['"]/i);

  const rawPath = mdMatch?.[1] || codeMatch?.[1];
  if (!rawPath) return null;

  let cleaned = rawPath.trim().replace(/^['"]|['"]$/g, "").replace(/\\/g, "/");
  cleaned = cleaned.replace(/^(\.\/|\/app\/\.output\/|\.playwright-mcp\/)/, "");

  const basename = cleaned.split("/").pop();
  if (!basename || basename === "." || basename === "..") return null;
  return basename;
}

function extractImages(rawResult: string | undefined): ExtractedToolImage[] {
  if (!rawResult) return [];
  try {
    const obj = JSON.parse(rawResult) as Record<string, unknown>;
    if (!obj || typeof obj !== "object") return [];

    const contentList: Array<Record<string, unknown>> = Array.isArray(obj.content)
      ? (obj.content as Array<Record<string, unknown>>)
      : Array.isArray(obj)
        ? (obj as Array<Record<string, unknown>>)
        : [];

    const images: ExtractedToolImage[] = [];

    // Priority 1: Check for explicit image blocks (Base64 data or server URLs)
    for (const item of contentList) {
      if (item && item.type === "image") {
        const url = typeof item.url === "string" ? item.url : null;
        const data = typeof item.data === "string" ? item.data : null;
        const mimeType = typeof item.mimeType === "string" ? item.mimeType : "image/png";

        if (url) {
          images.push({ src: url, mimeType, alt: "Tool image output" });
        } else if (data && !data.startsWith("[")) {
          const src = data.startsWith("data:") ? data : `data:${mimeType};base64,${data}`;
          images.push({ src, mimeType, alt: "Tool image output" });
        }
      }
    }

    if (images.length > 0) {
      return images;
    }

    // Priority 2: Fallback to extracting screenshot file paths from text blocks
    for (const item of contentList) {
      if (item && item.type === "text" && typeof item.text === "string") {
        const filename = extractFilenameFromScreenshotText(item.text);
        if (filename) {
          images.push({
            src: `/api/media/playwright-files?file=${encodeURIComponent(filename)}`,
            mimeType: "image/png",
            alt: filename,
            filename,
          });
        }
      }
    }

    return images;
  } catch {
    return [];
  }
}

/** Pretty-print arbitrary parameters object. Empty objects render as
 *  `{}` (the CopilotKit default behaviour); we don't substitute a
 *  custom "(no arguments)" string to keep the visual cue minimal. */
function formatParameters(parameters: unknown): string {
  try {
    return JSON.stringify(parameters ?? {}, null, 2);
  } catch {
    return String(parameters);
  }
}

/** Format result safely for display, truncating any raw long base64 strings
 *  to avoid hanging the browser DOM. */
function formatDisplayResult(rawResult: string | undefined): string {
  if (!rawResult) return "";
  try {
    const parsed = JSON.parse(rawResult) as unknown;
    if (parsed && typeof parsed === "object") {
      const sanitized = JSON.parse(
        JSON.stringify(parsed, (key, value) => {
          if (key === "data" && typeof value === "string" && value.length > 200) {
            return `[${Math.round((value.length * 0.75) / 1024)}KB base64 image data]`;
          }
          return value;
        }),
      );
      return JSON.stringify(sanitized, null, 2);
    }
    return rawResult;
  } catch {
    return rawResult;
  }
}

export function WildcardToolRenderer({
  name,
  toolCallId,
  parameters,
  status,
  result,
}: WildcardRenderProps): ReactElement {
  const router = useRouter();
  const select = useOutcomeStore((s) => s.select);
  const addOutcome = useOutcomeStore((s) => s.addOutcome);

  const approval = useToolApproval(toolCallId, name, parameters);

  const detected = detectToolResultStatus(result);
  const badgeStatus = approval.showButtons ? "waiting" : deriveBadgeStatus(status, detected);
  const elapsed = useElapsedSeconds(toolCallId, badgeStatus === "running");

  // Extract any images present in the tool result
  const images = useMemo(() => extractImages(result), [result]);
  const hasImages = images.length > 0;

  // Upsert image outcome to OutcomeStore when tool finishes successfully
  useEffect(() => {
    if (status !== "complete" || images.length === 0) return;

    const ws = useWorkspaceStore.getState();
    const firstFilename = images.find((i) => i.filename)?.filename;
    const outcomeTitle = firstFilename || `Screenshot: ${name}`;
    const outcomeDescription = `Captured from ${name}`;

    addOutcome({
      outcomeId: toolCallId,
      kind: "report",
      title: outcomeTitle,
      description: outcomeDescription,
      blocks: images.map((img) => ({
        kind: "image",
        src: img.src,
        mimeType: img.mimeType,
        alt: img.alt,
      })),
      agentId: ws.activeAgentId,
      threadId: ws.runtimeThreadId ?? null,
      runId: null,
      createdAt: Date.now(),
      collapsed: false,
      savedArtifactId: null,
    });
  }, [status, images, toolCallId, name, addOutcome]);

  const onViewInOutcomes = (e: React.MouseEvent): void => {
    e.stopPropagation();
    router.push("/outcomes");
    select(toolCallId);
  };

  // Inline header annotation
  const annotated = badgeStatus === "error" || badgeStatus === "warning";
  const headerMessage = annotated ? extractErrorMessage(result) : null;

  // Default collapsed for both success and failure paths
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="my-2 overflow-hidden rounded-lg border border-border bg-card">
      {/* Header row — always visible. */}
      <div
        onClick={() => setExpanded((prev) => !prev)}
        className="flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-muted/40"
      >
        {hasImages ? (
          <ImageIcon className="h-3.5 w-3.5 shrink-0 text-blue-500" aria-hidden />
        ) : (
          <Wrench className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
        )}
        <span className="shrink-0 text-xs font-medium text-foreground">
          {name}
        </span>

        {hasImages && (
          <button
            type="button"
            onClick={onViewInOutcomes}
            className="inline-flex cursor-pointer items-center gap-1 text-[11px] font-medium text-blue-600 hover:text-blue-700 hover:underline dark:text-blue-400 dark:hover:text-blue-300"
            title="View image in Outcomes panel"
          >
            Screenshot ({images.length})
            <ArrowUpRight className="h-3 w-3" aria-hidden />
          </button>
        )}

        {elapsed !== "0s" && (
          <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
            · {elapsed}
          </span>
        )}
        {annotated && headerMessage ? (
          <span
            className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground"
            title={headerMessage}
          >
            · {headerMessage}
          </span>
        ) : (
          <span className="flex-1" />
        )}
        {approval.showButtons ? (
          <ToolApprovalButtons state={approval} />
        ) : approval.localConfirmed !== null ? (
          <ToolApprovalBadge state={approval} />
        ) : (
          <ToolStatusBadge status={badgeStatus} />
        )}
        {expanded ? (
          <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" />
        )}
      </div>

      {/* Expanded — full args + result JSON for debugging. */}
      {expanded && (
        <>
          <div className="border-t border-border px-3 py-2">
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
              Arguments
            </div>
            <pre className="mt-1.5 max-h-48 overflow-auto rounded bg-muted/50 p-2 text-[11px] leading-relaxed text-foreground">
              {formatParameters(parameters)}
            </pre>
          </div>
          {result !== undefined && (
            <div className="border-t border-border px-3 py-2">
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                Result
              </div>
              <pre className="mt-1.5 max-h-64 overflow-auto rounded bg-muted/50 p-2 text-[11px] leading-relaxed text-foreground">
                {formatDisplayResult(result)}
              </pre>
            </div>
          )}
        </>
      )}
    </div>
  );
}
