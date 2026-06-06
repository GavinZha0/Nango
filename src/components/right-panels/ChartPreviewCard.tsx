"use client";

/**
 * ChartPreviewCard — inline chat preview for `generate_echarts_config`
 * server-tool calls.
 *
 * Two responsibilities:
 *
 * 1. **Streaming render.** CopilotKit's `useRenderTool` invokes this
 *    component as the tool's args arrive over AG-UI and again on
 *    `tool_call_result`. The render state is a 3-way discriminated
 *    union by `status`:
 *      - `inProgress`: parameters is `Partial<...>` — `option` may
 *        be a half-token of malformed JSON during real streaming.
 *        NEVER parse / render the option here; show a skeleton.
 *      - `executing`: parameters is fully validated args; server
 *        tool is running its (fast) validator. Show title + spinner.
 *      - `complete`: server tool returned. `result` is the JSON
 *        string of the server's `execute()` return value
 *        (`{ ok: true, chart_id, title, ... }` on success;
 *        `{ ok: false, error, message }` on validation failure).
 *
 * 2. **Outcomes-store update.** When `status` transitions to
 *    `complete` with `ok === true`, a `useEffect` upserts the
 *    chart into `useOutcomeStore` so the Outcomes panel renders it.
 *    Previously this lived in the frontend-tool handler in
 *    `useOutcomeTools`; moving it here keeps the side-effect
 *    colocated with the render so a single render path covers both
 *    live tool calls and history-replay.
 *
 * On history replay the DB-backed AgentRunner replays a synthesized
 * TOOL_CALL_RESULT for each `generate_echarts_config` chunk (see
 * `event-reconstruction.synthesizeToolCallResult`), so CopilotKit
 * emits a `complete` status with `result` populated — no
 * client-side replay-detection hack is needed.
 *
 * Mirrors the state-machine pattern in
 * `useInteractiveTools.adaptRenderProps`.
 */

import {
  ArrowUpRight,
  BarChart3,
  Loader2,
  AlertTriangle,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, type ReactElement } from "react";

import { cn } from "@/lib/utils";
import { useOutcomeStore } from "@/store/outcome-store";
import { useWorkspaceStore } from "@/store/workspace";

import type {
  GenerateEchartsConfigArgs,
  GenerateEchartsConfigResult,
} from "@/lib/outcomes/schema";

// props

/**
 * Shape CopilotKit v2's `useRenderTool` passes to `render`.
 *
 * We keep this local rather than importing CopilotKit's
 * `RenderToolProps<StandardSchemaV1>` because that generic type
 * threads schema inference through a `StandardSchemaV1` reference
 * we don't otherwise need; matching the runtime shape directly is
 * cleaner.
 */
export interface ChartPreviewProps {
  name: string;
  toolCallId: string;
  parameters:
    | Partial<GenerateEchartsConfigArgs>
    | GenerateEchartsConfigArgs;
  status: "inProgress" | "executing" | "complete";
  result: string | undefined;
}

// component

export function ChartPreviewCard(props: ChartPreviewProps): ReactElement {
  const router = useRouter();
  const select = useOutcomeStore((s) => s.select);

  // Side-effect: when the server tool completes successfully, upsert
  // the chart into the Outcomes store. Keyed by toolCallId so each
  // distinct tool call fires the effect exactly once per mount.
  // `addOutcome` upserts by outcomeId (= chart_id), so duplicate
  // fires (e.g. history replay arriving alongside a live result)
  // are idempotent.
  useEffect(() => {
    if (props.status !== "complete") return;
    const parsed = parseServerResult(props.result);
    if (parsed === null || parsed.ok !== true) return;

    const ws = useWorkspaceStore.getState();
    useOutcomeStore.getState().addOutcome({
      outcomeId: parsed.chart_id,
      kind: "report",
      title: parsed.title,
      description: parsed.description,
      blocks: [
        {
          kind: "chart",
          option: parsed.option,
          ...(parsed.dataset_id !== undefined && {
            datasetName: parsed.dataset_id,
          }),
        },
      ],
      agentId: ws.activeAgentId,
      // runtimeThreadId may be null here (CopilotKit captures it
      // lazily); `bindPendingThreadId` back-fills.
      threadId: ws.runtimeThreadId ?? null,
      runId: null,
      createdAt: Date.now(),
      collapsed: false,
      savedArtifactId: null,
    });
  }, [props.status, props.result, props.toolCallId]);

  const onView = (chartId: string): void => {
    router.push("/outcomes");
    select(chartId);
  };

  // inProgress: args stream in incrementally — render a skeleton
  // with whatever fields are populated so far.
  if (props.status === "inProgress") {
    const partial = props.parameters as Partial<GenerateEchartsConfigArgs>;
    return (
      <CardShell>
        <div className="flex items-center gap-2">
          <BarChart3
            className="h-4 w-4 animate-pulse text-muted-foreground"
            aria-hidden
          />
          <span className="text-sm font-medium text-muted-foreground">
            {partial.title ?? partial.chart_id ?? "Generating chart…"}
          </span>
        </div>
      </CardShell>
    );
  }

  // executing or complete: parameters are fully validated.
  const args = props.parameters as GenerateEchartsConfigArgs;

  if (props.status === "executing") {
    return (
      <CardShell>
        <div className="flex items-center gap-2">
          <Loader2 className="h-4 w-4 animate-spin text-blue-500" aria-hidden />
          <span className="text-sm font-medium">{args.title}</span>
        </div>
      </CardShell>
    );
  }

  // complete: inspect server result envelope.
  const parsed = parseServerResult(props.result);

  if (parsed !== null && parsed.ok === false) {
    return (
      <CardShell variant="error">
        <div className="flex items-center gap-2">
          <AlertTriangle className="h-4 w-4 text-destructive" aria-hidden />
          <span className="text-sm font-medium text-destructive">
            Chart rejected
          </span>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          {parsed.message ?? "The agent's chart option was rejected."}
        </p>
      </CardShell>
    );
  }

  return <SuccessCard args={args} onView={onView} />;
}

// helpers

/** Render the "chart is ready" card. The title doubles as the
 *  link into Outcomes — no separate action button. The trailing `↗`
 *  icon + hover underline + cursor:pointer are the affordance. */
function SuccessCard({
  args,
  onView,
}: {
  args: GenerateEchartsConfigArgs;
  onView: (chartId: string) => void;
}): ReactElement {
  return (
    <CardShell>
      <div className="flex items-center gap-2">
        <BarChart3 className="h-4 w-4 text-blue-500" aria-hidden />
        <button
          type="button"
          onClick={() => onView(args.chart_id)}
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
}: {
  variant?: "default" | "error";
  children: React.ReactNode;
}): ReactElement {
  return (
    <div
      className={cn(
        "my-2 rounded-lg border bg-card p-3",
        variant === "error" && "border-destructive/40 bg-destructive/5",
      )}
    >
      {children}
    </div>
  );
}

/**
 * Parse the JSON envelope returned by the
 * `generate_echarts_config` server tool's `execute()`.
 *
 * Returns `null` when `result` is missing / unparseable — older
 * snapshots or upstream failures may surface as undefined; the
 * caller treats that as "no recognised result, fall back to args".
 */
function parseServerResult(
  result: string | undefined,
): GenerateEchartsConfigResult | null {
  if (typeof result !== "string" || result.length === 0) return null;
  try {
    const obj = JSON.parse(result) as Record<string, unknown>;
    if (obj === null || typeof obj !== "object") return null;
    if (obj.ok === true && typeof obj.chart_id === "string") {
      return obj as unknown as GenerateEchartsConfigResult;
    }
    if (obj.ok === false) {
      return obj as unknown as GenerateEchartsConfigResult;
    }
    return null;
  } catch {
    return null;
  }
}
