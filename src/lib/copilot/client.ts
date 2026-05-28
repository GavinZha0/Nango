/**
 * Client-side vendor barrel for `@copilotkit/react-core/v2`.
 */

"use client";

export {
  CopilotKitProvider,
  CopilotChat,
  CopilotChatView,
  CopilotChatAssistantMessage,
  useCopilotKit,
  useAgent,
  useFrontendTool,
  useHumanInTheLoop,
  useDefaultRenderTool,
  useRenderTool,
} from "@copilotkit/react-core/v2";

export type {
  CopilotChatAssistantMessageProps,
  CopilotChatViewProps,
} from "@copilotkit/react-core/v2";

import { useAgent } from "@copilotkit/react-core/v2";

/**
 * Resolved per-thread agent instance returned by `useAgent`.
 * Derived from the upstream hook so we don't have to reach into
 * `@ag-ui/client` for `AbstractAgent` directly.
 */
export type CopilotAgent = ReturnType<typeof useAgent>["agent"];
