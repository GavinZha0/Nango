"use client";

/**
 * HandoffCard — semantic renderer for the supervisor's
 */

import { z } from "zod";
import { CornerDownRight } from "lucide-react";
import type { ReactElement } from "react";

import { cn } from "@/lib/utils";

export const switchAgentWithContextArgsSchema = z.object({
  /**
   * Specialist display name as listed under "Available specialists"
   * in the supervisor's prompt — e.g. "Built-in / FirstAgent" or
   * "VxAgents / Researcher".
   */
  agent: z.string(),
  contextSummary: z.string(),
});

export type SwitchAgentWithContextArgs = z.infer<
  typeof switchAgentWithContextArgsSchema
>;

/**
 * Frontend-tool render-prop shape — note this differs from the
 * `useRenderTool` shape: `useFrontendTool`'s render callback receives
 * `args` (the historical name from `ReactToolCallRenderer`), while
 * the standalone render hook uses `parameters`. CopilotKit's two
 * registration paths agreed on the schema but not the prop name; we
 * just match each at the boundary.
 */
export type HandoffRenderProps =
  | {
      name: string;
      toolCallId: string;
      args: Partial<SwitchAgentWithContextArgs>;
      status: "inProgress";
      result: undefined;
    }
  | {
      name: string;
      toolCallId: string;
      args: SwitchAgentWithContextArgs;
      status: "executing";
      result: undefined;
    }
  | {
      name: string;
      toolCallId: string;
      args: SwitchAgentWithContextArgs;
      status: "complete";
      result: string;
    };

export function HandoffCard(props: HandoffRenderProps): ReactElement {
  const { args, status } = props;
  // The supervisor passes the specialist's display name directly —
  // no store lookup needed. Empty fallback only for the brief
  // streaming window before the LLM has emitted the field.
  const targetName = (args?.agent ?? "agent").trim() || "agent";
  const isComplete = status === "complete";

  return (
    <div className="my-2 overflow-hidden rounded-lg border border-purple-500/20 bg-purple-500/[0.04]">
      <div className="flex items-center gap-2 px-3 py-2">
        <CornerDownRight className="h-3.5 w-3.5 shrink-0 text-purple-600 dark:text-purple-300" />
        <span className="text-xs font-medium text-purple-700 dark:text-purple-200">
          {isComplete
            ? `Handed off to ${targetName}`
            : `Handing off to ${targetName}`}
        </span>
        <span className="flex-1" />
        <span
          className={cn(
            "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium",
            isComplete
              ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
              : "bg-amber-500/15 text-amber-700 dark:text-amber-300",
          )}
        >
          <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-current" />
          {isComplete ? "Done" : "Routing"}
        </span>
      </div>
      {args?.contextSummary && (
        <div className="border-t border-purple-500/15 px-3 py-1.5 text-[11px] italic text-muted-foreground">
          “{args.contextSummary}”
        </div>
      )}
    </div>
  );
}
