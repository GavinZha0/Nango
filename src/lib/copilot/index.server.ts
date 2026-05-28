/**
 * Server-side vendor barrel for `@copilotkit/runtime/v2` and `@ag-ui/client`.
 */

import "server-only";

// @copilotkit/runtime/v2
export {
  defineTool,
  BuiltInAgent,
  // CopilotRuntime is the legacy compat shim that delegates to
  // CopilotSseRuntime when `options.intelligence` is unset (always the
  // case in Nango — we don't use CopilotKit Intelligence Platform).
  // We prefer this name over `CopilotSseRuntime` because it matches the
  // rest of the `CopilotRuntime*` naming family (`*Like`, `*Hooks`,
  // `*Options`, `*User`) and keeps the transport detail out of the
  // surface API. We do not re-export `CopilotSseRuntime`.
  CopilotRuntime,
  createCopilotRuntimeHandler,
  // Runner extension point — required so a custom AgentRunner subclass
  // can replace the default in-memory historical event store with a
  // DB-backed implementation.
  // @see docs/persisted-agent-runner-migration.md
  AgentRunner,
  InMemoryAgentRunner,
  type ToolDefinition,
  type MCPClientProvider,
  type AgentRunnerRunRequest,
  type AgentRunnerConnectRequest,
  type AgentRunnerIsRunningRequest,
  type AgentRunnerStopRequest,
} from "@copilotkit/runtime/v2";

// @ag-ui/client (protocol layer)
export { AbstractAgent, HttpAgent } from "@ag-ui/client";
export type {
  BaseEvent,
  RunAgentInput,
  Message,
  Tool,
} from "@ag-ui/client";

// AG-UI typed event surface
//
// Re-export every concrete event type the bridges and the runner emit, plus
// the `EventType` enum, so call sites can stop using the loose `BaseEvent`
// + `as BaseEvent` cast pattern. See `docs/runner-events.md` §11 for the
// full plan; the casts are removed file-by-file in subsequent PRs.
//
// Two reasons this lives in *this* barrel rather than a new top-level module:
//   1. AG-UI vendor lock-in mitigation already routes through here (see the
//      header comment) — concentrating @ag-ui imports makes future upgrades
//      a single-file edit.
//   2. The discriminated union below relies on `EventType.XXX` as the
//      narrowing tag (TS string-enum branding), so `EventType` and the
//      type aliases must come from the same resolution path.
export { EventType, EventSchemas } from "@ag-ui/client";

// Concrete event types — the discriminants of {@link AgUiEvent}.
export type {
  RunStartedEvent,
  RunFinishedEvent,
  RunErrorEvent,
  TextMessageStartEvent,
  TextMessageContentEvent,
  TextMessageEndEvent,
  TextMessageChunkEvent,
  ToolCallStartEvent,
  ToolCallArgsEvent,
  ToolCallEndEvent,
  ToolCallResultEvent,
  ToolCallChunkEvent,
  ReasoningStartEvent,
  ReasoningEndEvent,
  ReasoningMessageStartEvent,
  ReasoningMessageContentEvent,
  ReasoningMessageEndEvent,
  ReasoningMessageChunkEvent,
  StepStartedEvent,
  StepFinishedEvent,
  CustomEvent,
  RawEvent,
} from "@ag-ui/client";

import type {
  RunStartedEvent,
  RunFinishedEvent,
  RunErrorEvent,
  TextMessageStartEvent,
  TextMessageContentEvent,
  TextMessageEndEvent,
  TextMessageChunkEvent,
  ToolCallStartEvent,
  ToolCallArgsEvent,
  ToolCallEndEvent,
  ToolCallResultEvent,
  ToolCallChunkEvent,
  ReasoningStartEvent,
  ReasoningEndEvent,
  ReasoningMessageStartEvent,
  ReasoningMessageContentEvent,
  ReasoningMessageEndEvent,
  ReasoningMessageChunkEvent,
  StepStartedEvent,
  StepFinishedEvent,
  CustomEvent,
  RawEvent,
} from "@ag-ui/client";

/**
 * Discriminated union covering every AG-UI event the Nango bridges or
 * runner currently emits or reads. Use this in place of `BaseEvent` in
 * `emit` callbacks and event-receiving code paths so TypeScript can
 * narrow on `event.type` (an {@link EventType} enum value) and access
 * the per-event-type fields without cast.
 *
 * SCOPE NOTE: deliberately omits niche events Nango does not handle
 * yet (`STATE_SNAPSHOT`, `STATE_DELTA`, `MESSAGES_SNAPSHOT`,
 * `ACTIVITY_*`, deprecated `THINKING_*`). Adding one is a one-line
 * append below + the matching re-export above. Don't widen
 * preemptively — every member of the union has to be either ignored
 * or persisted by the runner / persisting-agent switch, so widening
 * implies a corresponding handler update.
 *
 * @see docs/runner-events.md §11 (rationale + per-PR migration plan)
 */
export type AgUiEvent =
  | RunStartedEvent
  | RunFinishedEvent
  | RunErrorEvent
  | TextMessageStartEvent
  | TextMessageContentEvent
  | TextMessageEndEvent
  | TextMessageChunkEvent
  | ToolCallStartEvent
  | ToolCallArgsEvent
  | ToolCallEndEvent
  | ToolCallResultEvent
  | ToolCallChunkEvent
  | ReasoningStartEvent
  | ReasoningEndEvent
  | ReasoningMessageStartEvent
  | ReasoningMessageContentEvent
  | ReasoningMessageEndEvent
  | ReasoningMessageChunkEvent
  | StepStartedEvent
  | StepFinishedEvent
  | CustomEvent
  | RawEvent;
