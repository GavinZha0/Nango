"use client";

/**
 * SlidesPreviewCard — inline chat preview for `generate_bento_slides`
 * server-tool calls.
 *
 * Two responsibilities (mirrors HtmlPreviewCard / ChartPreviewCard):
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
 *    `complete` with `ok === true`, a `useEffect` upserts the Bento
 *    slides deck into `useOutcomeStore` so the Outcomes panel renders it.
 */

import {
  ArrowUpRight,
  Loader2,
  Presentation,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, type ReactElement } from "react";

import { cn } from "@/lib/utils";
import { useOutcomeStore } from "@/store/outcome-store";
import { useWorkspaceStore } from "@/store/workspace";
import { useToolApproval, ToolApprovalButtons, ToolApprovalBadge } from "@/hooks/useToolApproval";

import type {
  GenerateBentoSlidesArgs,
  GenerateBentoSlidesResult,
} from "@/lib/outcomes/schema";
import { detectToolResultStatus } from "@/lib/copilot/detect-tool-result-status";
import { WildcardToolRenderer } from "@/components/copilotkit/WildcardToolRenderer";

// props

export interface SlidesPreviewProps {
  name: string;
  toolCallId: string;
  parameters:
    | Partial<GenerateBentoSlidesArgs>
    | GenerateBentoSlidesArgs;
  status: "inProgress" | "executing" | "complete";
  result: string | undefined;
}

// component

export function SlidesPreviewCard(props: SlidesPreviewProps): ReactElement {
  const router = useRouter();
  const select = useOutcomeStore((s) => s.select);
  
  const approval = useToolApproval(props.toolCallId, props.name, props.parameters);
  const actions = approval.showButtons ? (
    <ToolApprovalButtons state={approval} />
  ) : (
    <ToolApprovalBadge state={approval} />
  );

  // Side-effect: when the server tool completes successfully, upsert
  // the Bento slides into the Outcomes store via specialized slide handler.
  useEffect(() => {
    if (props.status !== "complete") return;
    const parsed = parseServerResult(props.result);
    if (parsed === null || parsed.ok !== true) return;

    const ws = useWorkspaceStore.getState();
    useOutcomeStore.getState().upsertSlideOutcome({
      outcomeId: parsed.outcome_id,
      title: parsed.title,
      description: parsed.description,
      doc: parsed.doc,
      append: parsed.append,
      toolCallId: props.toolCallId,
      agentId: ws.activeAgentId ?? "system",
      threadId: ws.runtimeThreadId ?? null,
      runId: null,
    });
  }, [props.status, props.result, props.toolCallId]);

  const onView = (outcomeId: string): void => {
    router.push("/outcomes");
    select(outcomeId);
  };

  // inProgress: args stream in incrementally — render a skeleton.
  if (props.status === "inProgress") {
    const partial = props.parameters as Partial<GenerateBentoSlidesArgs>;
    return (
      <CardShell actions={actions}>
        <div className="flex items-center gap-2">
          <Loader2
            className="h-4 w-4 animate-pulse text-muted-foreground"
            aria-hidden
          />
          <span className="text-sm font-medium text-muted-foreground">
            {partial.title ?? partial.outcome_id ?? "Generating Bento slides…"}
          </span>
        </div>
      </CardShell>
    );
  }

  // executing or complete: parameters are fully validated.
  const args = props.parameters as GenerateBentoSlidesArgs;

  if (props.status === "executing") {
    return (
      <CardShell actions={actions}>
        <div className="flex items-center gap-2">
          <Loader2 className="h-4 w-4 animate-spin text-amber-500" aria-hidden />
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
  args: GenerateBentoSlidesArgs;
  onView: (outcomeId: string) => void;
  actions?: React.ReactNode;
}): ReactElement {
  return (
    <CardShell actions={actions}>
      <div className="flex items-center gap-2">
        <Presentation className="h-4 w-4 text-amber-500" aria-hidden />
        <button
          type="button"
          onClick={() => onView(args.outcome_id)}
          className="inline-flex cursor-pointer items-center gap-1.5 text-sm font-medium text-amber-600 hover:text-amber-700 hover:underline dark:text-amber-400 dark:hover:text-amber-300"
          aria-label={`View ${args.title} in Outcomes`}
        >
          {args.title}
          {args.append && (
            <span className="text-xs font-normal text-muted-foreground">
              (appended)
            </span>
          )}
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
 * Parse the JSON envelope returned by the `generate_bento_slides`
 * server tool's `execute()`.
 */
function parseServerResult(
  result: string | undefined,
): GenerateBentoSlidesResult | null {
  if (typeof result !== "string" || result.length === 0) return null;
  try {
    const obj = JSON.parse(result) as Record<string, unknown>;
    if (obj === null || typeof obj !== "object") return null;
    if (obj.ok === true && typeof obj.outcome_id === "string") {
      return obj as unknown as GenerateBentoSlidesResult;
    }
    if (obj.ok === false) {
      return obj as unknown as GenerateBentoSlidesResult;
    }
    return null;
  } catch {
    return null;
  }
}
