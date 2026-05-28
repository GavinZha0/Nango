import "server-only";

import { and, asc, eq, gt } from "drizzle-orm";

import { db } from "@/lib/db";
import { NotificationTable, type NotificationEntity } from "@/lib/db/schema";
import { withSession } from "@/lib/http/route-handlers";
import {
  subscribe,
  type RunnerEvent,
  type NotificationCreatedEvent,
} from "@/lib/runner/event-bus";

export const dynamic = "force-dynamic";

const ROUTE = "/api/runs/stream";

const ENCODER = new TextEncoder();
const KEEPALIVE_MS = 25_000;

/** SECURITY: only valid UUIDs are accepted as a replay anchor — any
 *  other shape is silently treated as "no anchor" so the live stream
 *  still opens. drizzle parameterises queries, so the regex is
 *  defence-in-depth, not the security boundary. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** CONTRACT: a client whose Last-Event-ID is older than this many
 *  rows must catch up via `/api/notifications?limit=…` instead. SSE
 *  is for the live tail; the persistent inbox is the source of truth. */
const REPLAY_LIMIT = 200;

/** CONTRACT: cap memory while events are buffered during replay so a
 *  pathological burst can't OOM the connection. Beyond this we drop
 *  oldest first — the drop is recoverable on the next reconnect. */
const REPLAY_BUFFER_CAP = 1000;

function sseFrame(event: RunnerEvent): Uint8Array {
  // CONTRACT: only `notification` events emit `id:`. `run_finalized` is informational.
  if (event.kind === "notification") {
    return ENCODER.encode(
      `id: ${event.notification.id}\ndata: ${JSON.stringify(event)}\n\n`,
    );
  }
  return ENCODER.encode(`data: ${JSON.stringify(event)}\n\n`);
}

function readReplayAnchor(req: Request): string | null {
  // Extract lastEventId from header or query param.
  const headerValue = req.headers.get("last-event-id");
  const queryValue = new URL(req.url).searchParams.get("lastEventId");
  const raw = headerValue ?? queryValue;
  if (!raw || !UUID_RE.test(raw)) return null;
  return raw;
}

/**
 * GET /api/runs/stream — long-lived SSE feed of runner events
 * scoped to the authenticated user.
 *
 * Replay (Last-Event-ID)
 * ----------------------
 * On reconnect the browser's EventSource sends `Last-Event-ID` set
 * to the most recent `notification.id` it saw. We resume by querying
 * `notification WHERE owner_id = $u AND id > $lastId ORDER BY id LIMIT
 * REPLAY_LIMIT` — `notification.id` is UUIDv7 (PG18 `uuidv7()`), so
 * the index range scan walks new rows only. Events that arrive on
 * the live event-bus during replay are buffered and replayed in id
 * order after the catch-up; ones whose id ≤ replay's max id are
 * skipped to prevent duplicate emission.
 *
 * Architecture
 * ------------
 * The browser opens an EventSource. We register the connection's
 * sink with the in-process EventBus keyed by the caller's userId,
 * and stream every `RunnerEvent` published for them as a single
 * `data:` line (preceded by `id:` for notifications). Disconnect is
 * detected via `request.signal.aborted` (Next.js wires the request
 * signal to socket close); we unsubscribe and close the writer
 * there to free the entry.
 *
 * Keepalive
 * ---------
 * We push a comment frame (`: ping`) every 25 s so intermediate
 * proxies (Vercel, nginx, fly's edge) don't time the idle connection
 * out. SSE comments are spec-defined no-ops for the client.
 */
export const GET = withSession(ROUTE, async ({ req, session }) => {
  const ownerId = session.user.id;
  const lastEventId = readReplayAnchor(req);

  let unsubscribe: (() => void) | undefined;
  let keepalive: ReturnType<typeof setInterval> | undefined;
  let abortListener: (() => void) | undefined;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      // State machine drives replay-vs-live handoff. Subscribe BEFORE query to avoid race.
      type Phase = "initial" | "replay" | "live";
      let phase: Phase = "initial";
      const buffered: RunnerEvent[] = [];
      let maxReplayId: string | null = null;

      const enqueueFrame = (event: RunnerEvent): void => {
        try {
          controller.enqueue(sseFrame(event));
        } catch {
          // Stream already closed (rare race): swallow and let the
          // abort listener run cleanup.
        }
      };

      const handleEvent = (event: RunnerEvent): void => {
        if (phase !== "live") {
          if (buffered.length >= REPLAY_BUFFER_CAP) buffered.shift();
          buffered.push(event);
          return;
        }
        // CONTRACT: suppress live-stream duplicates that raced during query.
        if (
          event.kind === "notification"
          && maxReplayId !== null
          && event.notification.id <= maxReplayId
        ) {
          return;
        }
        enqueueFrame(event);
      };

      unsubscribe = subscribe(ownerId, handleEvent);

      // Initial comment to confirm channel is live.
      controller.enqueue(ENCODER.encode(": connected\n\n"));

      keepalive = setInterval(() => {
        try {
          controller.enqueue(ENCODER.encode(": ping\n\n"));
        } catch {
          // closed; ignore
        }
      }, KEEPALIVE_MS);

      abortListener = () => {
        if (keepalive) clearInterval(keepalive);
        if (unsubscribe) unsubscribe();
        try {
          controller.close();
        } catch {
          // already closed; ignore
        }
      };
      req.signal.addEventListener("abort", abortListener);

      // Async replay + buffer flush. CONTRACT: always end in live phase.
      (async (): Promise<void> => {
        if (lastEventId) {
          phase = "replay";
          const rows: NotificationEntity[] = await db
            .select()
            .from(NotificationTable)
            .where(
              and(
                eq(NotificationTable.ownerId, ownerId),
                gt(NotificationTable.id, lastEventId),
              ),
            )
            .orderBy(asc(NotificationTable.id))
            .limit(REPLAY_LIMIT);

          for (const row of rows) {
            if (req.signal.aborted) return;
            const event: NotificationCreatedEvent = {
              kind: "notification",
              notification: row,
            };
            enqueueFrame(event);
            maxReplayId = row.id;
          }
        }

        phase = "live";
        for (const event of buffered) {
          if (
            event.kind === "notification"
            && maxReplayId !== null
            && event.notification.id <= maxReplayId
          ) {
            continue;
          }
          enqueueFrame(event);
        }
        buffered.length = 0;
      })().catch((err) => {
        console.error("[sse] replay failed:", err);
        // Salvage the connection: switch to live so the buffer drains
        // and new events don't accumulate.
        phase = "live";
        for (const event of buffered) enqueueFrame(event);
        buffered.length = 0;
      });
    },
    cancel() {
      // Browser closed the EventSource — mirror the abort path.
      if (keepalive) clearInterval(keepalive);
      if (unsubscribe) unsubscribe();
      if (abortListener) req.signal.removeEventListener("abort", abortListener);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // Disable proxy buffering for immediate delivery.
      "X-Accel-Buffering": "no",
    },
  });
});
