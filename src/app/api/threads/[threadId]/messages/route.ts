/**
 * GET /api/threads/[threadId]/messages — reconstruct conversation
 *
 * **Admin debugging only.** The chat surface no longer calls this
 * route: history replay flows through `PersistedAgentRunner.connect()`
 * via CopilotKit's SSE stream (see
 * `src/lib/copilot/event-reconstruction.ts` for the canonical
 * reconstruction). This endpoint remains as a JSON view of the same
 * data for run-forensics tooling and ad-hoc inspection. If you find
 * yourself calling this from product code, you're probably looking
 * for the SSE path instead.
 *
 * @see docs/persisted-agent-runner-migration.md
 */

import "server-only";

import { and, asc, eq, inArray, isNull } from "drizzle-orm";

import { db } from "@/lib/db";
import {
  EntityRunEventTable,
  EntityRunTable,
  type EntityRunEventEntity,
} from "@/lib/db/schema";
import { withSession } from "@/lib/http/route-handlers";

const ROUTE = "/api/threads/[threadId]/messages";
type RouteParams = { threadId: string };

/** Shape mirrors AG-UI's `Message` discriminated union (`@ag-ui/core`).
 *  We don't import the types directly — they're zod-derived and pull
 *  the entire core package into the route bundle. The fields we use
 *  are the stable subset; CopilotKit's React client validates the
 *  rest at the wire boundary.
 *
 *  CopilotKit React v2 renders `role: "reasoning"` natively via
 *  `CopilotChatReasoningMessage` (collapsed-by-default thinking
 *  card), so emitting reasoning rows from history reconstruction is
 *  enough — no extra UI plumbing needed. */
type AGUIMessage =
  | { id: string; role: "user"; content: string }
  | {
      id: string;
      role: "assistant";
      content?: string;
      toolCalls?: AGUIToolCall[];
    }
  | { id: string; role: "tool"; toolCallId: string; content: string }
  | { id: string; role: "reasoning"; content: string };

interface AGUIToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface MessagePayload {
  messageId?: string;
  role?: string;
  text?: string;
}

interface ReasoningPayload {
  messageId?: string;
  text?: string;
}

interface ToolCallChunkPayload {
  toolCallId?: string;
  toolName?: string;
  args?: string;
}

interface ToolCallResultPayload {
  toolCallId?: string;
  content?: unknown;
}

export const GET = withSession<RouteParams>(
  ROUTE,
  async ({ params, session }) => {
    const ownerId = session.user.id;
    const threadId = params.threadId;

    if (!threadId) {
      return Response.json(
        { ok: false, code: "BAD_REQUEST", message: "threadId required" },
        { status: 400 },
      );
    }

    // 1) Pick out runs that compose this thread, excluding supervisor sub-runs.
    const runs = await db
      .select({
        id: EntityRunTable.id,
        inputTask: EntityRunTable.inputTask,
        startedAt: EntityRunTable.startedAt,
        createdAt: EntityRunTable.createdAt,
      })
      .from(EntityRunTable)
      .where(
        and(
          eq(EntityRunTable.threadId, threadId),
          eq(EntityRunTable.ownerId, ownerId),
          isNull(EntityRunTable.parentRunId),
        ),
      )
      .orderBy(asc(EntityRunTable.startedAt), asc(EntityRunTable.createdAt));

    if (runs.length === 0) {
      return Response.json({ messages: [] });
    }

    // 2) Pull every event for those runs, ordered by seq.
    const runIds = runs.map((r) => r.id);
    const events: EntityRunEventEntity[] = await db
      .select()
      .from(EntityRunEventTable)
      .where(inArray(EntityRunEventTable.runId, runIds))
      .orderBy(asc(EntityRunEventTable.runId), asc(EntityRunEventTable.seq));

    const eventsByRun = new Map<string, EntityRunEventEntity[]>();
    for (const ev of events) {
      const list = eventsByRun.get(ev.runId);
      if (list) list.push(ev);
      else eventsByRun.set(ev.runId, [ev]);
    }

    // 3) Build message list from each run's persisted events. The user
    //    prompt now lives as a `message` row at seq 0 with `role: "user"`
    //    (see `runner.recordUserMessage`) — `transformRunEvents` emits it
    //    through the regular message arm, no per-run synthesis needed.
    const messages: AGUIMessage[] = [];
    for (const run of runs) {
      const runEvents = eventsByRun.get(run.id) ?? [];
      messages.push(...transformRunEvents(run.id, runEvents));
    }

    return Response.json({ messages });
  },
);

/**
 * Convert one run's persisted events into AG-UI messages.
 *
 * @see docs/runner-events.md#44-why-two-rows-per-tool-call
 */
function transformRunEvents(
  runId: string,
  events: EntityRunEventEntity[],
): AGUIMessage[] {
  const out: AGUIMessage[] = [];
  let assistant: { id: string; role: "assistant"; content?: string; toolCalls?: AGUIToolCall[] } | null = null;

  const flushAssistant = (): void => {
    if (!assistant) return;
    out.push(assistant);
    assistant = null;
  };

  const ensureAssistantCarrier = (seq: number): typeof assistant => {
    if (!assistant) {
      assistant = {
        id: `${runId}.assist.${seq}`,
        role: "assistant",
        content: "",
        toolCalls: [],
      };
    }
    if (!assistant.toolCalls) assistant.toolCalls = [];
    return assistant;
  };

  for (const ev of events) {
    switch (ev.type) {
      case "message": {
        flushAssistant();
        const p = (ev.payload ?? {}) as MessagePayload;
        const messageId = p.messageId ?? `${runId}.msg.${ev.seq}`;
        // @see docs/runner-events.md#stage-5-replay
        if (p.role === "user") {
          out.push({
            id: messageId,
            role: "user",
            content: p.text ?? "",
          });
        } else {
          // Assistant text (default for missing role). Use the
          // assistant carrier so any following tool_call_chunk rows
          // attach as toolCalls on the same message.
          assistant = {
            id: messageId,
            role: "assistant",
            content: p.text ?? "",
          };
        }
        break;
      }

      case "tool_call_chunk": {
        const p = (ev.payload ?? {}) as ToolCallChunkPayload;
        if (!p.toolCallId) break;
        const carrier = ensureAssistantCarrier(ev.seq);
        carrier!.toolCalls!.push({
          id: p.toolCallId,
          type: "function",
          function: {
            name: p.toolName ?? "unknown",
            arguments: p.args ?? "",
          },
        });
        break;
      }

      case "tool_call_result": {
        flushAssistant();
        const p = (ev.payload ?? {}) as ToolCallResultPayload;
        const toolCallId = p.toolCallId ?? "";
        const content =
          typeof p.content === "string"
            ? p.content
            : JSON.stringify(p.content ?? null);
        out.push({
          id: `${runId}.tool.${ev.seq}`,
          role: "tool",
          toolCallId,
          content,
        });
        break;
      }

      case "reasoning": {
        // Reasoning belongs above the assistant message. Skip empty reasoning.
        const p = (ev.payload ?? {}) as ReasoningPayload;
        const text = (p.text ?? "").trim();
        if (text.length === 0) break;
        flushAssistant();
        out.push({
          id: p.messageId ?? `${runId}.reasoning.${ev.seq}`,
          role: "reasoning",
          content: text,
        });
        break;
      }

      // CONTRACT: lifecycle events are not surfaced as messages.
      case "started":
      case "finished":
      case "error":
      default:
        break;
    }
  }

  flushAssistant();
  return out;
}
