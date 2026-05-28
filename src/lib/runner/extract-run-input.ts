/**
 * `extractRunInput` — best-effort peek into the AG-UI POST body for
 * the chat dispatch paths. Pulls out the user's latest message text
 * + client message id, the threadId, and any trailing tool-result
 * messages that mark a CONTINUATION turn (LLM was paused on a
 * frontend / HITL tool call, user supplied result, CopilotKit
 * re-posted with the result as a new `role: "tool"` message at the
 * tail — there is no new user message in that case).
 *
 * Lives in its own module so the parsing rules can be unit-tested
 * in isolation without spinning up the full runner stack.
 *
 * @see docs/runner-events.md §"Continuation runs"
 */

import "server-only";

import { childLogger } from "@/lib/observability/logger";

const log = childLogger({ component: "extract-run-input" });

/** Fields the runner pulls out of the AG-UI POST body. */
export interface RunInputPeek {
  /** Triggering input for this run, capped at 1000 chars.
   *  - Normal chat turn: the user's latest message text.
   *  - Continuation turn: the first tool result's content. */
  task: string;
  threadId: string | undefined;
  /** The client-generated `id` of the latest user message in the
   *  request body. Persisted on the user-message event row so that
   *  history replay emits TEXT_MESSAGE_* events with the SAME id the
   *  client's local state already has — without that match, the
   *  client treats the replay as a new message and renders a
   *  duplicate of the user's prompt after `/connect` fires
   *  post-`onRunFinalized`.
   *
   *  `undefined` in continuation runs (tool-result-triggered) where
   *  there is no new user message — the caller skips writing a
   *  user_message event in that case. */
  userMessageId: string | undefined;
  /** Tool-result messages at the tail of the request body that are
   *  effectively the triggering input for this run. Populated when
   *  the LAST message in the body is `role: "tool"` (frontend / HITL
   *  tool result) — the LLM was paused, the user picked an option,
   *  CopilotKit re-posted with the result as a new tool message but
   *  WITHOUT a new user message. Empty for normal chat turns where
   *  the tail is a user message.
   *
   *  Persisted as `tool_call_result` events on the new run, replacing
   *  the synthetic `user_message` event that used to duplicate the
   *  prior user prompt. */
  triggeringToolResults: ReadonlyArray<{ toolCallId: string; content: string }>;
}

/** Coerce arbitrary tool-result content into a UI-safe string.
 *  CopilotKit's frontend-tool handlers can return any JSON-serialisable
 *  value; OpenAI-compatible tool messages already carry strings. */
export function stringifyToolContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** Extract the trailing block of `role: "tool"` messages (in body
 *  order). Returns empty if the tail is something else. Each entry
 *  is `{toolCallId, content}` with `content` already stringified. */
export function extractTrailingToolResults(
  messages: ReadonlyArray<{
    role?: string;
    toolCallId?: unknown;
    content?: unknown;
  }>,
): Array<{ toolCallId: string; content: string }> {
  const out: Array<{ toolCallId: string; content: string }> = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role !== "tool") break;
    const toolCallId = typeof m.toolCallId === "string" ? m.toolCallId : "";
    if (!toolCallId) continue;
    out.unshift({ toolCallId, content: stringifyToolContent(m.content) });
  }
  return out;
}

/** Pull task text + clientMessageId out of a single user message. */
function readUserMessage(
  m: { id?: unknown; content?: unknown },
): { task: string; userMessageId: string | undefined } | null {
  const idFromBody = typeof m.id === "string" && m.id.length > 0 ? m.id : undefined;
  const c = m.content;
  if (typeof c === "string") {
    return { task: c.slice(0, 1000), userMessageId: idFromBody };
  }
  if (Array.isArray(c)) {
    const text = c
      .map((p) =>
        p && typeof p === "object" && "type" in p && (p as { type: string }).type === "text"
          ? String((p as { text?: string }).text ?? "")
          : "",
      )
      .filter(Boolean)
      .join("\n");
    if (text) return { task: text.slice(0, 1000), userMessageId: idFromBody };
  }
  return null;
}

/** Pure-data overload: extract from a pre-parsed body. Useful for
 *  tests; also called by the request-based variant after JSON parse. */
export function extractRunInputFromBody(body: {
  threadId?: unknown;
  messages?: ReadonlyArray<{
    id?: unknown;
    role?: string;
    content?: unknown;
    toolCallId?: unknown;
  }>;
}): RunInputPeek {
  const threadId =
    typeof body.threadId === "string" && body.threadId.length > 0
      ? body.threadId
      : undefined;
  const messages = Array.isArray(body.messages) ? body.messages : [];

  // If the request tail is a block of tool messages, this is a
  // continuation: the LLM was paused on a frontend-tool call, the
  // user supplied results, CopilotKit re-posted with the same prior
  // user message + the new tool result(s) appended. Treat the tool
  // results as the trigger, NOT the (stale) last user message.
  const triggeringToolResults = extractTrailingToolResults(messages);
  if (triggeringToolResults.length > 0) {
    const first = triggeringToolResults[0]!;
    return {
      task: first.content.slice(0, 1000),
      threadId,
      userMessageId: undefined,
      triggeringToolResults,
    };
  }

  // Normal chat turn — find the last user message.
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role !== "user") continue;
    const parsed = readUserMessage(m);
    if (parsed) {
      return {
        task: parsed.task,
        threadId,
        userMessageId: parsed.userMessageId,
        triggeringToolResults: [],
      };
    }
  }
  return { task: "", threadId, userMessageId: undefined, triggeringToolResults: [] };
}

/**
 * Read the body **once** (clone-and-parse) and pull out task /
 * threadId / userMessageId / triggeringToolResults. Best-effort: any
 * parse failure returns empty values so persistence never breaks the
 * chat path.
 */
export async function extractRunInput(request: Request): Promise<RunInputPeek> {
  try {
    const body = (await request.clone().json()) as Parameters<
      typeof extractRunInputFromBody
    >[0];
    return extractRunInputFromBody(body);
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "extractRunInput: failed to parse request body — proceeding with empty task/threadId",
    );
    return {
      task: "",
      threadId: undefined,
      userMessageId: undefined,
      triggeringToolResults: [],
    };
  }
}
