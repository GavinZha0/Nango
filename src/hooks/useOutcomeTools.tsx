"use client";

/**
 * useOutcomeTools — registers `render_chart` for the Outcomes
 * panel using the handler/render split: `useValidatedFrontendTool`
 * for the side-effect handler, `useRenderTool` for the streaming-
 * aware preview card. Called once in `ChatProviderHooks` so it
 * survives tab switches. See docs/data-visualization.md.
 */

import { useCallback } from "react";
import { z } from "zod";

import { useRenderTool } from "@/lib/copilot/client";
import { useValidatedFrontendTool } from "@/lib/copilot/frontend-tool-helpers";
import { ChartPreviewCard } from "@/components/right-panels/ChartPreviewCard";
import { useOutcomeStore } from "@/store/outcome-store";
import { useWorkspaceStore } from "@/store/workspace";

// schema

/**
 * `render_chart` parameter schema. LLM-facing — every `.describe`
 * string ends up in the model's tool catalog. `optionJson` is a
 * JSON STRING (not an object): a free-form `option` parameter
 * caused models to submit empty `{}` defaults; a string with
 * concrete JSON examples in the description avoids that trap.
 */
export const renderChartSchema = z.object({
  chartId: z
    .string()
    .regex(/^[a-z0-9-]+$/, "chartId must be lowercase kebab-case (letters, numbers, hyphens only)")
    .min(1, "chartId cannot be empty")
    .max(64, "chartId max 64 characters")
    .describe(
      "Stable per-thread identifier; re-using the same id overwrites the previous chart. Pick a short kebab-case slug like 'sales-pie' or 'q3-revenue'. Lowercase letters, numbers, and hyphens only.",
    ),
  title: z.string().describe("Human-readable chart title (shown on the card header)"),
  description: z
    .string()
    .optional()
    .describe("One-sentence description of what the chart shows."),
  optionJson: z
    .string()
    .min(10, "optionJson must contain a non-empty ECharts option object")
    .describe(
      [
        "Full ECharts option, serialized as a JSON STRING (not an object).",
        "Must parse to a plain object whose `series` is a non-empty array (each entry needs a `type`).",
        "Pure JSON only — no functions, callbacks, or expressions.",
        "Put data in `dataset.source` (2D array, first row = column names).",
        "",
        "Example (pie):",
        '  "{\\"dataset\\":{\\"source\\":[[\\"name\\",\\"value\\"],[\\"Alpha\\",42],[\\"Beta\\",17]]},\\"series\\":[{\\"type\\":\\"pie\\"}]}"',
        "",
        "Example (bar):",
        '  "{\\"dataset\\":{\\"source\\":[[\\"q\\",\\"v\\"],[\\"Q1\\",120],[\\"Q2\\",200]]},\\"xAxis\\":{\\"type\\":\\"category\\"},\\"yAxis\\":{},\\"series\\":[{\\"type\\":\\"bar\\"}]}"',
      ].join("\n"),
    ),
  datasetName: z
    .string()
    .optional()
    .describe(
      "Optional: the cache key passed to extract_dataset_by_sql for this chart's underlying data.",
    ),
});

export type RenderChartArgs = z.infer<typeof renderChartSchema>;

// caps

/** Hard upper bound on `option` JSON size. See docs/data-visualization.md
 *  for the oversize-routing policy. */
const OPTION_HARD_CAP_BYTES = 64_000;

// hook

export function useOutcomeTools(): void {
  // GOTCHA: do NOT auto-navigate to `/outcomes` from here. Any
  // route transition during a frontend-tool handler races
  // CopilotKit's recursive `runAgent()` and silently drops the
  // LLM's continuation `/run` POST. See docs/data-visualization.md.

  // Stable handler — frontend tool registration must not churn
  // on every render or active tool calls lose their handler.
  // Zod validation runs in `useValidatedFrontendTool`; the handler
  // only enforces what Zod can't (`OPTION_TOO_LARGE`,
  // `OPTION_JSON_PARSE_FAILED`).
  const handler = useCallback(
    async (args: RenderChartArgs): Promise<object> => {
      // Hard size cap (measured on the raw JSON string the LLM sent).
      if (args.optionJson.length > OPTION_HARD_CAP_BYTES) {
        return {
          isError: true,
          severity: "error",
          message: `optionJson is ${args.optionJson.length} bytes; cap is ${OPTION_HARD_CAP_BYTES}. Aggregate in run_code_in_sandbox first.`,
        };
      }

      // Parse the JSON string into a plain object. Rejects empty
      // `{}`, arrays, primitives, and unparseable garbage with a
      // structured error the LLM can react to.
      let option: Record<string, unknown>;
      try {
        const decoded: unknown = JSON.parse(args.optionJson);
        if (
          decoded === null ||
          typeof decoded !== "object" ||
          Array.isArray(decoded)
        ) {
          throw new Error("must be a plain JSON object");
        }
        option = decoded as Record<string, unknown>;
      } catch (err) {
        const msg: string = err instanceof Error ? err.message : String(err);
        return {
          isError: true,
          severity: "error",
          message:
            `optionJson is not a valid JSON object: ${msg}. ` +
            "Submit the full ECharts option serialized as a JSON string " +
            '(e.g. \'{"dataset":{"source":[["name","value"],["A",1]]},"series":[{"type":"pie"}]}\').',
        };
      }

      // agentId / threadId come from workspaceStore, NOT LLM args.
      // runId is server-side only — replay back-fills it.
      const ws = useWorkspaceStore.getState();
      useOutcomeStore.getState().addOutcome({
        outcomeId: args.chartId,
        kind: "report",
        title: args.title,
        description: args.description,
        blocks: [
          {
            kind: "chart",
            option,
            ...(args.datasetName ? { datasetName: args.datasetName } : {}),
          },
        ],
        agentId: ws.activeAgentId,
        // runtimeThreadId may be null here (CopilotKit captures
        // it lazily); `bindPendingThreadId` back-fills.
        threadId: ws.runtimeThreadId ?? null,
        runId: null,
        createdAt: Date.now(),
        collapsed: false,
        savedArtifactId: null,
      });

      return { ok: true, chartId: args.chartId };
    },
    [],
  );

  // handler-only registration (schema validation auto-injected by helper)
  useValidatedFrontendTool<RenderChartArgs>({
    name: "render_chart",
    description:
      "Display an ECharts chart in the user's Outcomes panel. " +
      "Re-calling with the same chartId overwrites the previous chart.",
    parameters: renderChartSchema,
    handler,
  });

  // render-only registration
  useRenderTool({
    name: "render_chart",
    parameters: renderChartSchema,
    render: ChartPreviewCard,
  });
}
