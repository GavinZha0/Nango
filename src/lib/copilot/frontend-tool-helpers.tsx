"use client";

/**
 * Frontend-tool registration helpers for the chat surface.
 *
 * Two hooks live here, both wrap CopilotKit v2 primitives to fix
 * sharp edges we hit in practice:
 *
 *   - {@link useValidatedFrontendTool} — adds runtime Zod validation
 *     to a `useFrontendTool` registration. CopilotKit v2's own
 *     `parseToolArguments` only does `JSON.parse` + an "is it an
 *     object" check before invoking the handler; the declared Zod
 *     schema is used only to derive the JSON Schema the LLM sees.
 *     This wrapper re-runs `safeParse` at handler entry and returns
 *     a structured `{ isError: true, severity: "error", message }`
 *     envelope on failure — same shape understood by
 *     `WildcardToolRenderer` so the user gets a red badge + inline
 *     diagnostic.
 *
 *   - {@link useHitlTool} — pure DX shrink-wrap for the four
 *     Human-In-The-Loop tools (`ask_user_choice`, `_confirmation`,
 *     `_input`, `_datetime`). Encapsulates the FIFO resolver queue,
 *     hook-level unmount cleanup (resolves outstanding prompts with
 *     a {@link HITL_CANCELLED} sentinel), the `respond` callback, and
 *     the `adaptRenderProps` boundary. Each HITL tool collapses from
 *     ~30 lines (handler + queue + callback + render adapter) to a
 *     single 5-line declaration.
 *
 * Both helpers MUST be called inside `<CopilotKitProvider>` — they
 * internally call `useFrontendTool` / `useRenderTool` which depend
 * on CopilotKit context.
 *
 * See docs/chat-interactive-ui.md.
 * @see docs/diagrams/frontend-tool-flow.html
 */

import React, { useCallback, useEffect, useRef, type ReactElement } from "react";
import type { ZodType } from "zod";

import { useFrontendTool, useRenderTool } from "@/lib/copilot/client";
import { formatZodIssues } from "@/lib/copilot/zod-format";
import type { HitlRenderProps } from "@/components/chat-interactive/types";

// Re-export so existing imports keep working. New code can import
// directly from `@/lib/copilot/zod-format`.
export { formatZodIssues };

// ---------------------------------------------------------------------------
// Sentinel / prompt block — public so tools can reference these from
// their `description` strings (e.g. CANCELLED_NOTE appended after the
// tool-specific copy).
// ---------------------------------------------------------------------------

/** Sentinel resolved on the handler's Promise when the user navigates
 *  away without answering (HITL tools only). The unusual `__` prefix
 *  makes accidental collision with legitimate user input
 *  vanishingly unlikely. */
export const HITL_CANCELLED = "__hitl_cancelled__";

/** Prompt fragment appended to every HITL tool description, telling
 *  the LLM how to interpret the cancellation sentinel. */
export const HITL_CANCELLED_NOTE =
  ` If the result is "${HITL_CANCELLED}", the user navigated away without answering — treat it as "declined to answer" and proceed with a sensible default or ask again.`;

// ---------------------------------------------------------------------------
// useValidatedFrontendTool
// ---------------------------------------------------------------------------

/** Standard structured-error envelope. Matches the contract
 *  `detectToolResultStatus` + `extractErrorMessage` already consume,
 *  so `WildcardToolRenderer` renders these as a red "Error" badge
 *  with the message inlined in the header. */
export interface FrontendToolValidationError {
  isError: true;
  severity: "error";
  message: string;
}

/** CopilotKit v2's render prop shape (from `ReactToolCallRenderer<T>`).
 *  Re-declared locally as a thin alias so callers don't need to import
 *  CopilotKit type internals. */
type FrontendToolRender<T extends Record<string, unknown>> = NonNullable<
  Parameters<typeof useFrontendTool<T>>[0]["render"]
>;

export interface ValidatedFrontendToolConfig<
  T extends Record<string, unknown>,
> {
  name: string;
  description: string;
  parameters: ZodType<T>;
  /** Handler receives ALREADY-PARSED args. No need to safeParse again. */
  handler: (args: T) => Promise<unknown>;
  /** Optional inline renderer. When provided, behaves identically to
   *  `useFrontendTool({ render })` — same `addHookRenderToolCall`
   *  registration, same exact-name-over-wildcard matcher precedence. */
  render?: FrontendToolRender<T>;
}

/**
 * `useFrontendTool` + automatic runtime Zod validation.
 *
 * On invalid args the wrapped handler short-circuits with a
 * {@link FrontendToolValidationError} envelope, never reaching the
 * caller's `handler`. CopilotKit's core type-detects the return
 * value (object → JSON.stringify automatically), so callers should
 * return plain objects — no manual JSON.stringify needed.
 *
 * The optional `render` prop is forwarded to `useFrontendTool` for
 * tools that want the handler/render coupled (e.g. handoff). HITL
 * tools should NOT use this prop — they go through `useHitlTool`,
 * which registers render via a separate `useRenderTool` so the
 * adapter can branch on streaming `status`.
 */
export function useValidatedFrontendTool<T extends Record<string, unknown>>(
  config: ValidatedFrontendToolConfig<T>,
): void {
  useFrontendTool<T>({
    name: config.name,
    description: config.description,
    parameters: config.parameters,
    handler: async (rawArgs: T): Promise<unknown> => {
      const parsed = config.parameters.safeParse(rawArgs);
      if (!parsed.success) {
        const validationError: FrontendToolValidationError = {
          isError: true,
          severity: "error",
          message: `${config.name} arguments failed schema validation: ${formatZodIssues(parsed.error)}`,
        };
        return validationError;
      }
      return config.handler(parsed.data);
    },
    ...(config.render !== undefined ? { render: config.render } : {}),
  });
}

// ---------------------------------------------------------------------------
// HITL render-prop adapter
// ---------------------------------------------------------------------------

/**
 * Normalise CopilotKit's per-status render props into the shape every
 * HITL component expects ({@link HitlRenderProps}).
 *
 * TypeScript cannot narrow `Partial<T> | T` based on `status` because
 * the parameter union isn't discriminated; the `as` casts are safe
 * because CopilotKit guarantees the correct shape per status at
 * runtime.
 *
 * `respond` is typed as `(value: unknown) => void` to accept both
 * sync and async callers; we cast it to the `Promise<void>` flavour
 * the component contract uses.
 */
function adaptRenderProps<T>(
  renderProps: {
    name: string;
    toolCallId: string;
    parameters: Partial<T> | T;
    status: "inProgress" | "executing" | "complete";
    result: string | undefined;
  },
  respond: ((value: unknown) => void) | undefined,
): HitlRenderProps<T> {
  switch (renderProps.status) {
    case "inProgress":
      return {
        name: renderProps.name,
        args: renderProps.parameters as Partial<T>,
        status: "inProgress" as const,
        result: undefined,
        respond: undefined,
      };
    case "executing":
      return {
        name: renderProps.name,
        args: renderProps.parameters as T,
        status: "executing" as const,
        result: undefined,
        respond: respond as (value: unknown) => Promise<void>,
      };
    case "complete":
      return {
        name: renderProps.name,
        args: renderProps.parameters as T,
        status: "complete" as const,
        result: renderProps.result ?? "",
        respond: undefined,
      };
  }
}

// ---------------------------------------------------------------------------
// useHitlTool
// ---------------------------------------------------------------------------

export interface HitlToolConfig<T extends Record<string, unknown>> {
  name: string;
  /** Without the `HITL_CANCELLED_NOTE` suffix — the helper appends it. */
  description: string;
  parameters: ZodType<T>;
  component: React.ComponentType<HitlRenderProps<T>>;
}

/**
 * One-line HITL tool registration.
 *
 * Wraps three CopilotKit hooks and bundles the FIFO resolver queue +
 * unmount cleanup so the call site only declares WHAT the tool is,
 * never HOW the handler/render plumbing works. See file-level
 * docstring for the design rationale.
 *
 * The handler returns a Promise that the helper resolves later via
 * the queue's `respond` callback — wired to the same render's UI
 * (chips / buttons / input / picker) by name match.
 *
 * Cleanup: on unmount (agent switch / CopilotKitProvider teardown),
 * any still-pending Promise is resolved with the {@link HITL_CANCELLED}
 * sentinel so the LLM sees a structured "declined" result instead of
 * a hung tool call.
 *
 * See docs/chat-interactive-ui.md. — why handler/render are
 *      split across two hooks instead of using `useHumanInTheLoop`.
 */
export function useHitlTool<T extends Record<string, unknown>>(
  config: HitlToolConfig<T>,
): void {
  // FIFO: handler.push, respond.shift. A Map<toolCallId, resolver>
  // would be cleaner but CopilotKit's handler signature does NOT
  // pass toolCallId. FIFO works because CopilotKit dispatches
  // handlers and renders in the same order within a single agent
  // turn — see useInteractiveTools.tsx history for the discovery.
  const queue = useRef<Array<(v: unknown) => void>>([]);

  // CONTRACT: cancellation lives at the HOOK level, not component
  // level — React 19 strict mode double-mounts trigger
  // component-level cleanup prematurely (resolving Promises before
  // user interacts). This effect only fires on real
  // CopilotKitProvider teardown / agent switch.
  useEffect(
    () => () => {
      for (const resolve of queue.current) resolve(HITL_CANCELLED);
      queue.current = [];
    },
    [],
  );

  const respond = useCallback(async (value: unknown): Promise<void> => {
    queue.current.shift()?.(value);
  }, []);

  // Handler half — schema-validated, returns the pending Promise.
  useValidatedFrontendTool<T>({
    name: config.name,
    description: config.description + HITL_CANCELLED_NOTE,
    parameters: config.parameters,
    handler: async (): Promise<unknown> =>
      new Promise((resolve) => {
        queue.current.push(resolve);
      }),
  });

  // Render half — wires the same name back to `component` and feeds
  // `respond` only while the tool is in `executing` state.
  useRenderTool({
    name: config.name,
    parameters: config.parameters,
    render: (props): ReactElement => {
      const adapted = adaptRenderProps<T>(
        props,
        props.status === "executing" ? respond : undefined,
      );
      return React.createElement(config.component, adapted);
    },
  });
}
