/**
 * Best-effort peek into the AG-UI POST body for chat dispatch. Pulls
 * the user's latest message + clientMessageId, the threadId, and any
 * trailing `role: "tool"` messages that mark a CONTINUATION turn
 * (frontend / HITL tool result, no new user message).
 *
 * See docs/runner-events.md.
 */

import "server-only";

import { childLogger } from "@/lib/observability/logger";

const log = childLogger({ component: "extract-run-input" });

/** Fields the runner pulls out of the AG-UI POST body. */
export interface RunInputPeek {
  /** Triggering input for this run, capped at 1000 chars. Latest user
   *  text on a normal turn; first tool-result content on continuation. */
  task: string;
  threadId: string | undefined;
  /** Client-generated `id` of the latest user message — persisted so
   *  history replay emits TEXT_MESSAGE_* with the SAME id the client
   *  already has and the message doesn't duplicate after `/connect`.
   *  `undefined` on continuation runs (no new user message). */
  userMessageId: string | undefined;
  /** Trailing block of `role: "tool"` messages that triggered this
   *  continuation run; empty for normal chat turns. Persisted as
   *  `tool_call_result` events on the new run. */
  triggeringToolResults: ReadonlyArray<{ toolCallId: string; content: string }>;
}

/** Coerce arbitrary tool-result content into a UI-safe string. */
export function stringifyToolContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** Trailing block of `role: "tool"` messages in body order, with
 *  `content` already stringified. Empty if the tail isn't a tool. */
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

/** Extract from a pre-parsed body. */
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

  // Tool-tail = continuation run: trigger is the tool result, not the
  // (stale) last user message.
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
 * Clone-and-parse the body once. Best-effort: parse failures return
 * empty values so persistence never breaks the chat path.
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
