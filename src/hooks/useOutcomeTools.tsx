"use client";

/**
 * useOutcomeTools — frontend renderer registration for the
 * `generate_echarts_config` server tool.
 *
 * This hook does ONE thing: register the `ChartPreviewCard`
 * component as the streaming-arg renderer for
 * `generate_echarts_config` tool calls via CopilotKit's
 * `useRenderTool`. Called once in `ChatProviderHooks` so it
 * survives tab switches.
 *
 * The handler that used to live here (validation + Outcomes-store
 * update) is gone — validation now happens server-side in
 * `lib/outcomes/runtime-tools.ts`, and the Outcomes-store update is
 * triggered by a `useEffect` inside `ChartPreviewCard` itself on
 * the `complete` render-props status. See docs/data-visualization.md
 * and docs/workflow-spec.md (two LLM authoring contexts for chart).
 */

import { useRenderTool } from "@/lib/copilot/client";
import { ChartPreviewCard } from "@/components/right-panels/ChartPreviewCard";
import { generateEchartsConfigSchema } from "@/lib/outcomes/schema";

export function useOutcomeTools(): void {
  useRenderTool({
    name: "generate_echarts_config",
    parameters: generateEchartsConfigSchema,
    render: ChartPreviewCard,
  });
}
