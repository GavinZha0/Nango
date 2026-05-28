"use client";

/**
 * useInteractiveTools — registers HITL (Human-in-the-Loop) frontend
 * tools that pause the agent and render interactive UI inline in chat.
 *
 * Three tools, all named under the unified `ask_user_*` family so the
 * LLM sees a coherent series:
 *
 *  - `ask_user_choice`       — single-choice selection from 2-5 options
 *  - `ask_user_confirmation` — binary approve / reject
 *  - `ask_user_datetime`     — date/time picker (single or range)
 *
 * Free-text answers do NOT have a dedicated tool: the agent can ask
 * in natural language and receive the reply through the main chat
 * input, which is enabled while no HITL tool is pending.
 *
 * Each tool is a one-line `useHitlTool({...})` declaration; the heavy
 * lifting (FIFO resolver queue, schema-guarded handler, render-prop
 * adapter, unmount cancellation) lives in `useHitlTool` itself.
 * Schema validation is applied automatically by
 * `useValidatedFrontendTool` (which `useHitlTool` wraps); CopilotKit
 * v2 does not validate args natively, so we re-run Zod at the
 * boundary — see the helper's docstring for the rationale.
 *
 * @see src/lib/copilot/frontend-tool-helpers.tsx — the helpers.
 * @see docs/chat-interactive-ui.md §3
 */

import { z } from "zod";

import {
  ChoiceSelector,
  type ChoiceArgs,
} from "@/components/chat-interactive/ChoiceSelector";
import {
  ConfirmationButtons,
  type ConfirmArgs,
} from "@/components/chat-interactive/ConfirmationButtons";
import {
  DateTimePicker,
  type DateTimeArgs,
} from "@/components/chat-interactive/DateTimePicker";
import { useHitlTool } from "@/lib/copilot/frontend-tool-helpers";

// ---------------------------------------------------------------------------
// Zod schemas (kept here so handler + render share the same source)
// ---------------------------------------------------------------------------

const choiceSchema = z.object({
  question: z.string().describe("The question to display"),
  options: z
    .array(
      z.object({
        label: z.string().describe("Display text"),
        value: z.string().describe("Value returned on selection"),
        description: z.string().optional().describe("Brief explanation"),
      }),
    )
    .describe("2-5 options to choose from"),
});

const confirmSchema = z.object({
  message: z.string().describe("What needs confirmation"),
  confirmLabel: z
    .string()
    .optional()
    .describe("Confirm button text (default: 'Approve')"),
  rejectLabel: z
    .string()
    .optional()
    .describe("Reject button text (default: 'Reject')"),
});

const datetimeSchema = z.object({
  prompt: z.string().describe("What to ask the user, e.g. 'Select start time'"),
  mode: z
    .enum(["single", "range"])
    .optional()
    .describe("'single' for one datetime (default), 'range' for start+end"),
  defaultStart: z
    .string()
    .optional()
    .describe("Default start value as ISO 8601 string"),
  defaultEnd: z
    .string()
    .optional()
    .describe("Default end value as ISO 8601 string (range mode only)"),
});

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useInteractiveTools(): void {
  useHitlTool<ChoiceArgs>({
    name: "ask_user_choice",
    description:
      "Present a list of options for the user to pick EXACTLY ONE. " +
      "Use this when you have 2-5 concrete alternatives and need the " +
      "user to choose before proceeding. This tool does NOT support " +
      "multi-select; if the user needs to pick several items, call " +
      "this tool multiple times.",
    parameters: choiceSchema,
    component: ChoiceSelector,
  });

  useHitlTool<ConfirmArgs>({
    name: "ask_user_confirmation",
    description:
      "Ask the user to confirm or reject an action before proceeding. " +
      "Use this for irreversible operations or important decisions.",
    parameters: confirmSchema,
    component: ConfirmationButtons,
  });

  useHitlTool<DateTimeArgs>({
    name: "ask_user_datetime",
    description:
      "Show a date/time picker and wait for the user to select. " +
      'Use mode "single" (default) for one datetime, or "range" ' +
      "for a start+end pair. Returns ISO 8601 strings.",
    parameters: datetimeSchema,
    component: DateTimePicker,
  });
}
