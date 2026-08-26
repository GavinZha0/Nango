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

/** Real-time page/editor context passed via Copilot shared state. */
export interface PageContextSnapshot {
  activeUrl?: string;
  activeView?: string;
  activeResourceId?: string | null;
  activeResourceData?: Record<string, unknown> | null;
}

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
  /** Read-only snapshot of the user's active editor page context (if present). */
  pageContext?: PageContextSnapshot | null;
}

/** Format a page context snapshot into a clean Markdown block for agent prompt injection. */
export function formatPageContextSnapshot(ctx: PageContextSnapshot): string {
  const parts: string[] = [];
  if (ctx.activeView) parts.push(`- **Active View / Panel**: \`${ctx.activeView}\``);
  if (ctx.activeResourceId) parts.push(`- **Active Resource ID**: \`${ctx.activeResourceId}\``);
  if (ctx.activeUrl) parts.push(`- **Active URL**: \`${ctx.activeUrl}\``);
  if (ctx.activeResourceData && Object.keys(ctx.activeResourceData).length > 0) {
    parts.push(`- **Active Resource Content**:\n\`\`\`json\n${JSON.stringify(ctx.activeResourceData, null, 2)}\n\`\`\``);
  }
  return parts.length > 0 ? parts.join("\n") : "(No active resource open in editor)";
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
  state?: unknown;
  context?: unknown;
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

  let pageContext: PageContextSnapshot | null = null;
  const rawState = body.state && typeof body.state === "object" ? (body.state as Record<string, unknown>) : undefined;
  const rawContext =
    (rawState?.context && typeof rawState.context === "object" ? (rawState.context as Record<string, unknown>) : undefined)
    ?? (body.context && typeof body.context === "object" ? (body.context as Record<string, unknown>) : undefined);

  if (rawContext) {
    pageContext = {
      activeUrl: typeof rawContext.activeUrl === "string" ? rawContext.activeUrl : undefined,
      activeView: typeof rawContext.activeView === "string" ? rawContext.activeView : undefined,
      activeResourceId:
        typeof rawContext.activeResourceId === "string" || rawContext.activeResourceId === null
          ? rawContext.activeResourceId
          : undefined,
      activeResourceData:
        rawContext.activeResourceData && typeof rawContext.activeResourceData === "object"
          ? (rawContext.activeResourceData as Record<string, unknown>)
          : null,
    };
  }

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
      pageContext,
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
        pageContext,
      };
    }
  }
  return { task: "", threadId, userMessageId: undefined, triggeringToolResults: [], pageContext };
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
