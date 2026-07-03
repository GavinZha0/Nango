/**
 * GET /api/eval-runs/[id]/messages — reconstruct the target agent's
 * conversation from a completed eval case result.
 *
 * Query: ?caseId=<number>
 * Response: { messages: AGUIMessage[] }
 *
 * Uses the `eval_case_result.thread_id` (which stores the target
 * agent's entity_run.id) to read events and reconstruct messages.
 */

import "server-only";

import { z } from "zod";
import { asc, eq, inArray } from "drizzle-orm";

import { db } from "@/lib/db";
import {
  EntityRunEventTable,
  EntityRunTable,
  type EntityRunEventEntity,
} from "@/lib/db/schema";
import { ApiError, withSession } from "@/lib/http/route-handlers";
import * as storage from "@/lib/evaluation/storage";
import { loadSuite } from "@/lib/evaluation/access";

const ROUTE = "/api/eval-runs/[id]/messages";

const querySchema = z.object({
  caseId: z.coerce.number().int().positive(),
});

interface SimpleMessage {
  role: "user" | "assistant" | "tool";
  content: string;
  toolName?: string;
  toolCallId?: string;
}

export const GET = withSession<{ id: string }>(
  ROUTE,
  async ({ req, params, session }) => {
    const url = new URL(req.url);
    const parsed = querySchema.safeParse({
      caseId: url.searchParams.get("caseId"),
    });
    if (!parsed.success) {
      throw new ApiError("VALIDATION_FAILED", 400, "caseId is required.");
    }

    const run = await storage.getRunById(params.id);
    if (!run) throw new ApiError("NOT_FOUND", 404, "Eval run not found.");

    await loadSuite(run.suiteId, session);

    const result = await storage.getCaseResult(params.id, parsed.data.caseId);
    if (!result || !result.threadId) {
      return Response.json({ messages: [] });
    }

    // result.threadId stores the target agent's conversation threadId.
    // Read all runs that belong to this thread.
    const targetThreadId = result.threadId;

    const runs = await db
      .select({ id: EntityRunTable.id, inputTask: EntityRunTable.inputTask })
      .from(EntityRunTable)
      .where(eq(EntityRunTable.threadId, targetThreadId))
      .orderBy(asc(EntityRunTable.startedAt));

    if (runs.length === 0) {
      return Response.json({ messages: [] });
    }

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

    const messages: SimpleMessage[] = [];
    for (const run of runs) {
      if (run.inputTask) {
        messages.push({ role: "user", content: run.inputTask });
      }
      const runEvents = eventsByRun.get(run.id) ?? [];
      messages.push(...reconstructMessages(runEvents));
    }

    return Response.json({ messages });
  },
);

interface MsgPayload { role?: string; text?: string }
interface ToolChunkPayload { toolCallId?: string; toolName?: string; args?: string }
interface ToolResultPayload { toolCallId?: string; content?: unknown }

function reconstructMessages(events: EntityRunEventEntity[]): SimpleMessage[] {
  const out: SimpleMessage[] = [];
  const toolResults = new Map<string, string>();

  // First pass: collect tool results
  for (const ev of events) {
    if (ev.type === "tool_call_result") {
      const p = (ev.payload ?? {}) as ToolResultPayload;
      if (p.toolCallId) {
        const content = typeof p.content === "string"
          ? p.content
          : JSON.stringify(p.content ?? null);
        toolResults.set(p.toolCallId, content);
      }
    }
  }

  // Second pass: build messages
  for (const ev of events) {
    if (ev.type === "message") {
      const p = (ev.payload ?? {}) as MsgPayload;
      out.push({
        role: p.role === "user" ? "user" : "assistant",
        content: p.text ?? "",
      });
    } else if (ev.type === "tool_call_chunk") {
      const p = (ev.payload ?? {}) as ToolChunkPayload;
      if (p.toolCallId && p.toolName) {
        out.push({
          role: "tool",
          content: toolResults.get(p.toolCallId) ?? "",
          toolName: p.toolName,
          toolCallId: p.toolCallId,
        });
      }
    }
  }

  return out;
}
