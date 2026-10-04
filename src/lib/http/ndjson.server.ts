/**
 * Request-scoped NDJSON streaming response for ephemeral (non-persisted)
 * two-phase single-case runs (Evaluation / Web Auto playground).
 *
 * Why not the shared SSE bus (`/api/runs/stream`)? That channel is
 * owner-wide broadcast, non-durable, keyed by persisted `runId`, and sized
 * for small frames. Playground runs persist nothing and can carry MB-sized
 * screenshots, so they stream on their own request instead.
 * See docs/architecture.md §"Streaming channels".
 */

import "server-only";

import { childLogger } from "@/lib/observability/logger";

const log = childLogger({ component: "ndjson-stream" });

const ENCODER = new TextEncoder();

export const NDJSON_CONTENT_TYPE = "application/x-ndjson";

/** Emits one intermediate frame. CONTRACT: never throws / rejects. */
export type NdjsonEmit = (frame: Record<string, unknown>) => Promise<void>;

/** True when the client asked for a streamed NDJSON response. */
export function wantsNdjson(req: Request): boolean {
  if (req.headers.get("accept")?.includes(NDJSON_CONTENT_TYPE)) return true;
  return new URL(req.url).searchParams.get("stream") === "true";
}

/**
 * Stream `run` as NDJSON. Intermediate frames go through `emit`; the value
 * `run` resolves to is sent as the terminal `{ type: "verdict_complete", outcome }`
 * frame. A thrown error becomes a terminal `{ type: "error", error }` frame.
 *
 * CONTRACT:
 * - The background task never produces an unhandled rejection, even when
 *   the client disconnects mid-run (writes after disconnect are dropped).
 * - `signal` aborts when the client disconnects, so `run` can skip work
 *   that no one will see (e.g. the LLM judge phase).
 */
export function ndjsonResponse(
  req: Request,
  run: (emit: NdjsonEmit, signal: AbortSignal) => Promise<unknown>,
): Response {
  const controller = new AbortController();
  let closed = false;
  let streamController: ReadableStreamDefaultController<Uint8Array> | null = null;

  const markClosed = (): void => {
    if (closed) return;
    closed = true;
    controller.abort();
  };

  // QUIRK: req.signal is not guaranteed to fire on client disconnect across
  // all Next.js runtimes; ReadableStream.cancel() covers the other path.
  if (req.signal.aborted) markClosed();
  else req.signal.addEventListener("abort", markClosed, { once: true });

  const emit: NdjsonEmit = async (frame) => {
    if (closed || !streamController) return;
    try {
      streamController.enqueue(ENCODER.encode(JSON.stringify(frame) + "\n"));
    } catch {
      markClosed();
    }
  };

  const stream = new ReadableStream<Uint8Array>({
    start(ctrl) {
      streamController = ctrl;
      void (async () => {
        try {
          const outcome = await run(emit, controller.signal);
          await emit({ type: "verdict_complete", outcome });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          log.warn({ err: message }, "ndjson run failed");
          await emit({ type: "error", error: message });
        } finally {
          req.signal.removeEventListener("abort", markClosed);
          if (!closed) {
            closed = true;
            try {
              ctrl.close();
            } catch {
              // already closed by a cancel race; nothing to do
            }
          }
        }
      })().catch((err: unknown) => {
        // Last-resort guard: keeps the CONTRACT even if logging itself throws.
        console.error("[ndjson] unexpected failure:", err);
      });
    },
    cancel() {
      markClosed();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": NDJSON_CONTENT_TYPE,
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}
