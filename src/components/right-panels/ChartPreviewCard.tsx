"use client";

/**
 * ChartPreviewCard — inline chat preview for `render_chart` tool calls.
 *
 * **Critical**: `parameters` is a discriminated union by `status`:
 *  - `inProgress`: `Partial<RenderChartArgs>` — `optionJson` may be a
 *    half-token of malformed JSON during real streaming. NEVER parse
 *    or render the option here; show a skeleton card with whatever
 *    fields happen to be present.
 *  - `executing`: full validated args, handler is running. Show
 *    title + a "running" indicator.
 *  - `complete`: handler returned. `result` is the JSON string the
 *    handler returned. Inspect it to distinguish success from the
 *    `OPTION_TOO_LARGE` (and future) error sentinel.
 *
 * On `complete + ok` the title itself acts as the link — clicking it
 * navigates to `/outcomes` and selects the produced chart. The
 * trailing `↗` icon + cursor + hover underline are the affordance.
 * We deliberately do NOT auto-jump here — the handler in
 * `useOutcomeTools` covers the first-outcome-of-thread auto-jump;
 * subsequent charts let the user decide.
 *
 * On history replay the DB-backed AgentRunner replays a synthesized
 * `TOOL_CALL_RESULT` for each `render_chart` chunk (see
 * `event-reconstruction.synthesizeToolCallResult`), so CopilotKit
 * emits a `complete` status with `result` populated — no
 * client-side replay-detection hack is needed.
 *
 * Mirrors the state-machine pattern in
 * `useInteractiveTools.adaptRenderProps`.
 */

import { ArrowUpRight, BarChart3, Loader2, AlertTriangle } from "lucide-react";
import { useRouter } from "next/navigation";
import type { ReactElement } from "react";

import { cn } from "@/lib/utils";
import { useOutcomeStore } from "@/store/outcome-store";

import type { RenderChartArgs } from "@/hooks/useOutcomeTools";

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
  parameters: Partial<RenderChartArgs> | RenderChartArgs;
  status: "inProgress" | "executing" | "complete";
  result: string | undefined;
}

// component

export function ChartPreviewCard(props: ChartPreviewProps): ReactElement {
  const router = useRouter();
  const select = useOutcomeStore((s) => s.select);

  const onView = (chartId: string): void => {
    router.push("/outcomes");
    select(chartId);
  };

  // inProgress: args stream in incrementally — render a skeleton
  // with whatever fields are populated so far.
  if (props.status === "inProgress") {
    const partial = props.parameters as Partial<RenderChartArgs>;
    return (
      <CardShell>
        <div className="flex items-center gap-2">
          <BarChart3 className="h-4 w-4 animate-pulse text-muted-foreground" aria-hidden />
          <span className="text-sm font-medium text-muted-foreground">
            {partial.title ?? partial.chartId ?? "Generating chart…"}
          </span>
        </div>
      </CardShell>
    );
  }

  // executing or complete: parameters are fully validated.
  const args = props.parameters as RenderChartArgs;

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

  // complete: inspect handler result.
  const parsed = parseHandlerResult(props.result);

  if (parsed.ok === false) {
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
  args: RenderChartArgs;
  onView: (chartId: string) => void;
}): ReactElement {
  return (
    <CardShell>
      <div className="flex items-center gap-2">
        <BarChart3 className="h-4 w-4 text-blue-500" aria-hidden />
        <button
          type="button"
          onClick={() => onView(args.chartId)}
          className="inline-flex cursor-pointer items-center gap-1 text-sm font-medium text-blue-600 hover:text-blue-700 hover:underline dark:text-blue-400 dark:hover:text-blue-300"
          aria-label={`View ${args.title} in Outcomes`}
        >
          {args.title}
          <ArrowUpRight className="h-3 w-3" aria-hidden />
        </button>
      </div>
      {args.description && (
        <p className="mt-1 text-xs text-muted-foreground">{args.description}</p>
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
 * Discriminate handler result.
 *
 * `useOutcomeTools.handler` returns either
 *   `{ ok: true,  chartId }`
 *   `{ ok: false, error, message }`
 * as a JSON string. We tolerate empty / malformed result strings —
 * older snapshots or upstream failures may surface as undefined.
 */
function parseHandlerResult(
  result: string | undefined,
): { ok: true; chartId?: string } | { ok: false; message?: string } {
  if (!result) return { ok: true };
  try {
    const obj = JSON.parse(result) as { ok?: boolean; chartId?: string; message?: string };
    if (obj && obj.ok === false) {
      return { ok: false, message: obj.message };
    }
    return { ok: true, chartId: obj?.chartId };
  } catch {
    return { ok: true };
  }
}
