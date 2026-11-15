"use client";

import {
  createGenerativeUI,
  standardUI,
  type GenerativeUIConfig,
} from "@copilotkit/react-core/v2/generative-ui";

import {
  STANDARD_UI_COMPONENT_NAMES,
  type StandardUiComponentName,
} from "@/lib/generative-ui/catalog";

/**
 * Build a CopilotKit `generativeUI` config scoped to `agentId` and trimmed
 * to the admin-enabled standard A2UI components.
 */
export function buildGenerativeUiConfig(
  enabledComponents: readonly StandardUiComponentName[],
  agentId: string,
): GenerativeUIConfig | undefined {
  if (enabledComponents.length === 0) return undefined;
  const keep = new Set<string>(enabledComponents);
  const omitList = STANDARD_UI_COMPONENT_NAMES.filter((name) => !keep.has(name));
  const ui =
    omitList.length === 0
      ? standardUI
      : createGenerativeUI({
          id: "nango/workspace@1",
          extends: [standardUI.omit([...omitList])],
          components: {},
        });
  return {
    ui,
    agentIds: [agentId],
  };
}
