"use client";

/**
 * HtmlPreviewCard — inline chat preview for `generate_html_page`
 * server-tool calls.
 *
 * Two responsibilities (mirrors ChartPreviewCard):
 *
 * 1. **Streaming render.** CopilotKit's `useRenderTool` invokes this
 *    component as the tool's args arrive over AG-UI and again on
 *    `tool_call_result`. The render state is a 3-way discriminated
 *    union by `status`:
 *      - `inProgress`: parameters is `Partial<...>` — show skeleton.
 *      - `executing`: parameters fully validated; server tool running.
 *      - `complete`: server tool returned success or failure.
 *
 * 2. **Outcomes-store update.** When `status` transitions to
 *    `complete` with `ok === true`, a `useEffect` upserts the HTML
 *    page into `useOutcomeStore` so the Outcomes panel renders it.
 */

import {
  ArrowUpRight,
  Code2,
  Loader2,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, type ReactElement } from "react";

import { cn } from "@/lib/utils";
import { useOutcomeStore } from "@/store/outcome-store";
import { useWorkspaceStore } from "@/store/workspace";
import { useToolApproval, ToolApprovalButtons, ToolApprovalBadge } from "@/hooks/useToolApproval";

import type {
  GenerateHtmlPageArgs,
  GenerateHtmlPageResult,
} from "@/lib/outcomes/schema";
import { detectToolResultStatus } from "@/lib/copilot/detect-tool-result-status";
import { WildcardToolRenderer } from "@/components/copilotkit/WildcardToolRenderer";

// props

export interface HtmlPreviewProps {
  name: string;
  toolCallId: string;
  parameters:
    | Partial<GenerateHtmlPageArgs>
    | GenerateHtmlPageArgs;
  status: "inProgress" | "executing" | "complete";
  result: string | undefined;
}

// component

export function HtmlPreviewCard(props: HtmlPreviewProps): ReactElement {
  const router = useRouter();
  const select = useOutcomeStore((s) => s.select);
  
  const approval = useToolApproval(props.toolCallId, props.name, props.parameters);
  const actions = approval.showButtons ? (
    <ToolApprovalButtons state={approval} />
  ) : (
    <ToolApprovalBadge state={approval} />
  );

  // Side-effect: when the server tool completes successfully, upsert
  // the HTML page into the Outcomes store.
  useEffect(() => {
    if (props.status !== "complete") return;
    const parsed = parseServerResult(props.result);
    if (parsed === null || parsed.ok !== true) return;

    const ws = useWorkspaceStore.getState();
    useOutcomeStore.getState().addOutcome({
      outcomeId: parsed.page_id,
      kind: "report",
      title: parsed.title,
      description: parsed.description,
      blocks: [
        {
          kind: "html",
          html: parsed.html,
        },
      ],
      agentId: ws.activeAgentId,
      threadId: ws.runtimeThreadId ?? null,
      runId: null,
      createdAt: Date.now(),
      collapsed: false,
      savedArtifactId: null,
    });
  }, [props.status, props.result, props.toolCallId]);

  const onView = (pageId: string): void => {
    router.push("/outcomes");
    select(pageId);
  };

  // inProgress: args stream in incrementally — render a skeleton.
  if (props.status === "inProgress") {
    const partial = props.parameters as Partial<GenerateHtmlPageArgs>;
    return (
      <CardShell actions={actions}>
        <div className="flex items-center gap-2">
          <Loader2
            className="h-4 w-4 animate-pulse text-muted-foreground"
            aria-hidden
          />
          <span className="text-sm font-medium text-muted-foreground">
            {partial.title ?? partial.page_id ?? "Generating HTML page…"}
          </span>
        </div>
      </CardShell>
    );
  }

  // executing or complete: parameters are fully validated.
  const args = props.parameters as GenerateHtmlPageArgs;

  if (props.status === "executing") {
    return (
      <CardShell actions={actions}>
        <div className="flex items-center gap-2">
          <Loader2 className="h-4 w-4 animate-spin text-blue-500" aria-hidden />
          <span className="text-sm font-medium">{args.title}</span>
        </div>
      </CardShell>
    );
  }

  // complete: inspect server result envelope.
  const parsed = parseServerResult(props.result);

  const detected = detectToolResultStatus(props.result);
  const isFailed =
    detected === "failure" ||
    (props.result !== undefined &&
      props.result.trim().length > 0 &&
      parsed === null);

  if (isFailed) {
    return <WildcardToolRenderer {...props} />;
  }

  return <SuccessCard args={args} onView={onView} actions={actions} />;
}

// helpers

function SuccessCard({
  args,
  onView,
  actions,
}: {
  args: GenerateHtmlPageArgs;
  onView: (pageId: string) => void;
  actions?: React.ReactNode;
}): ReactElement {
  return (
    <CardShell actions={actions}>
      <div className="flex items-center gap-2">
        <Code2 className="h-4 w-4 text-blue-500" aria-hidden />
        <button
          type="button"
          onClick={() => onView(args.page_id)}
          className="inline-flex cursor-pointer items-center gap-1 text-sm font-medium text-blue-600 hover:text-blue-700 hover:underline dark:text-blue-400 dark:hover:text-blue-300"
          aria-label={`View ${args.title} in Outcomes`}
        >
          {args.title}
          <ArrowUpRight className="h-3 w-3" aria-hidden />
        </button>
      </div>
      {args.description && (
        <p className="mt-1 text-xs text-muted-foreground">
          {args.description}
        </p>
      )}
    </CardShell>
  );
}

function CardShell({
  variant = "default",
  children,
  actions,
}: {
  variant?: "default" | "error";
  children: React.ReactNode;
  actions?: React.ReactNode;
}): ReactElement {
  return (
    <div
      className={cn(
        "my-2 flex flex-wrap items-center justify-between gap-2 rounded-lg border bg-card p-3 min-w-0",
        variant === "error" && "border-destructive/40 bg-destructive/5",
      )}
    >
      <div className="flex flex-col w-full flex-1 min-w-0">
        {children}
      </div>
      {actions && <div className="ml-auto shrink-0 flex items-center">{actions}</div>}
    </div>
  );
}

/**
 * Parse the JSON envelope returned by the `generate_html_page`
 * server tool's `execute()`.
 */
function parseServerResult(
  result: string | undefined,
): GenerateHtmlPageResult | null {
  if (typeof result !== "string" || result.length === 0) return null;
  try {
    const obj = JSON.parse(result) as Record<string, unknown>;
    if (obj === null || typeof obj !== "object") return null;
    if (obj.ok === true && typeof obj.page_id === "string") {
      return obj as unknown as GenerateHtmlPageResult;
    }
    if (obj.ok === false) {
      return obj as unknown as GenerateHtmlPageResult;
    }
    return null;
  } catch {
    return null;
  }
}
