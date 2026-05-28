"use client";

/**
 * useOutcomeTools — registers built-in agents' frontend tools for the
 * Outcomes panel.
 *
 * V1 registers a single tool, `render_chart`. Future outcome kinds
 * (table, html, image, dashboard, ...) attach as additional tool
 * registrations in this same hook — see docs/architecture.md
 * §"Adding a new outcome kind" for the extension recipe.
 *
 * Tool uses the **handler / render split** mandated by
 * `docs/data-visualization.md` §6.3:
 *
 *  - `useFrontendTool` registers the handler — pure side-effect into
 *    `outcomeStore.addOutcome`, **no `render` prop**. Render is
 *    registered separately so we can three-state-branch on streaming
 *    args without coupling it to the handler. See
 *    `useInteractiveTools.tsx` for the same pattern.
 *  - `useRenderTool` registers `ChartPreviewCard` — three-state
 *    branching so partial-JSON `option` arguments are never parsed
 *    during streaming.
 *
 * Called once in `ChatProviderHooks` (RightPanel.tsx) so it survives
 * tab switches.
 *
 * @see docs/data-visualization.md §6.3 (tool registration), §6.4
 *      (first-outcome auto-jump), §6.7 (Outcome Store).
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
 * string ends up in the model's tool catalog.
 *
 * Design (V1.3): `optionJson` is a JSON **string**, not an object.
 *
 * Earlier iterations declared `option` as a free-form object
 * (`z.record(z.string(), z.unknown())`). The JSON Schema the LLM
 * saw was `{type:"object", additionalProperties:true}` with no
 * required sub-fields, and models repeatedly submitted `option: {}`
 * — a plausible "I don't know what to put here" default for an
 * unconstrained object parameter.
 *
 * Switching to `z.string()` removes the trap: LLMs almost never
 * submit empty strings for required string parameters, and the
 * description's literal JSON examples become copy-and-modify
 * templates instead of abstract guidance. The handler parses the
 * string back into an object before persisting to the outcome
 * store.
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

/** Hard upper bound on `option` JSON size. See §6.3 oversize-routing. */
const OPTION_HARD_CAP_BYTES = 64_000;

// hook

export function useOutcomeTools(): void {
  // NOTE: this hook intentionally does NOT do any navigation.
  //
  // Earlier iterations auto-navigated to `/outcomes` on the first
  // chart of a thread — first directly via `router.push` inside the
  // handler, then via an `OutcomeAutoJump` effect subscribed to the
  // outcome store. Both forms triggered a Next.js route transition
  // that raced with the recursive `runAgent()` CopilotKit fires for
  // the LLM continuation of a frontend tool call. Observed
  // user-visible symptom: the first chart's continuation (e.g. a
  // Python script the user asked for in the same prompt) silently
  // never reached the chat — only ONE `/run` POST hit the network,
  // not two. The useEffect form did not fix it because the
  // transition still happens BEFORE the recursive `runAgent`'s
  // POST (React's commit / MessageChannel scheduling runs ahead of
  // CopilotKit's `setTimeout(0)` yield).
  //
  // Resolution: drop auto-navigation entirely. `ChartPreviewCard`
  // already exposes the chart title as a prominent ↗ link into
  // `/outcomes`; users navigate when they want to. The chart is
  // immediately visible inline in chat regardless.
  //
  // See `docs/data-visualization.md` §6.4 for the full trace.

  // Stable handler — frontend tool registration must not churn on
  // every render or active tool calls lose their handler.
  //
  // Schema validation runs upstream in `useValidatedFrontendTool`
  // (CopilotKit v2 doesn't validate args natively; the wrapper
  // re-runs Zod and short-circuits with a structured error envelope
  // on failure). This handler only needs to enforce business rules
  // that Zod can't express:
  //
  //   - `OPTION_TOO_LARGE` — hard byte cap on `optionJson`
  //   - `OPTION_JSON_PARSE_FAILED` — JSON-parse + plain-object check
  //
  // Handler returns plain objects (CopilotKit core stringifies
  // automatically — see frontend-tool-helpers.tsx for the chain).
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

      // Capture agentId + threadId from workspaceStore (NOT from
      // LLM args). runId is NOT available client-side; replay
      // populates it server-side from entity_run_event.run_id.
      //
      // The handler is intentionally pure beyond this store write:
      // no router.push, no React state mutations. See the long
      // comment at the top of this hook for why navigation is
      // user-driven now instead of automatic.
      //
      // Block model: a single chart is a Report with one `chart`
      // block. Multi-block reports (text + chart, etc.) are produced
      // by other tools / a future "report" agent — never by
      // render_chart.
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
        // runtimeThreadId may still be null here — CopilotKit v2's
        // threadId is captured lazily on `onRunFinalized`. The
        // WorkspaceProvider subscriber back-fills via
        // `bindPendingThreadId` once the real id arrives.
        // @see docs/chat-flow-audit.md §1.11
        threadId: ws.runtimeThreadId ?? null,
        runId: null, // server replay populates; V1 UI doesn't use
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
