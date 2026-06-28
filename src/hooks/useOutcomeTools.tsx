"use client";

/**
 * useOutcomeTools — frontend renderer registration for outcome-
 * producing server tools (`generate_echarts_config`,
 * `generate_html_page`).
 *
 * Each tool gets its own `useRenderTool` registration that maps it
 * to a streaming preview card component. Called once in
 * `ChatProviderHooks` so it survives tab switches.
 *
 * Validation lives server-side in `lib/outcomes/runtime-tools.ts`;
 * the Outcomes-store update is a `useEffect` inside each preview
 * card on the `complete` status. See docs/data-visualization.md.
 */

import { useRenderTool } from "@/lib/copilot/client";
import { ChartPreviewCard } from "@/components/right-panels/ChartPreviewCard";
import { HtmlPreviewCard } from "@/components/right-panels/HtmlPreviewCard";
import {
  generateEchartsConfigSchema,
  generateHtmlPageSchema,
} from "@/lib/outcomes/schema";

export function useOutcomeTools(): void {
  useRenderTool({
    name: "generate_echarts_config",
    parameters: generateEchartsConfigSchema,
    render: ChartPreviewCard,
  });

  useRenderTool({
    name: "generate_html_page",
    parameters: generateHtmlPageSchema,
    render: HtmlPreviewCard,
  });
}
