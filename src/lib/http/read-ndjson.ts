/**
 * Client-side reader for request-scoped NDJSON streams produced by
 * `ndjsonResponse` (src/lib/http/ndjson.server.ts).
 */

export interface NdjsonTerminalFrame<TOutcome> {
  type: "verdict_complete";
  outcome: TOutcome;
}

/** Thrown when the stream closes before a terminal frame arrives. */
export class NdjsonIncompleteError extends Error {
  constructor() {
    super("Connection closed before the run returned a result.");
    this.name = "NdjsonIncompleteError";
  }
}

/**
 * Consume an NDJSON response body, dispatching each parsed frame to
 * `onFrame`, and resolve with the `verdict_complete` outcome.
 *
 * CONTRACT:
 * - Malformed lines are skipped (warned), never fatal.
 * - An `{ type: "error" }` frame rejects with that message.
 * - A stream that ends without `verdict_complete` rejects with
 *   `NdjsonIncompleteError` — callers must never treat silence as success.
 * - Exceptions thrown by `onFrame` propagate to the caller.
 */
export async function readNdjson<TFrame extends { type: string }, TOutcome>(
  body: ReadableStream<Uint8Array>,
  onFrame: (frame: TFrame) => void,
): Promise<TOutcome> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let outcome: { value: TOutcome } | null = null;

  const handleLine = (line: string): void => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let frame: TFrame | { type: "error"; error?: string } | NdjsonTerminalFrame<TOutcome>;
    try {
      frame = JSON.parse(trimmed) as typeof frame;
    } catch {
      console.warn("[ndjson] skipping malformed line:", trimmed.slice(0, 200));
      return;
    }
    if (!frame || typeof frame !== "object" || typeof frame.type !== "string") return;
    if (frame.type === "error") {
      throw new Error((frame as { error?: string }).error || "Run failed");
    }
    if (frame.type === "verdict_complete") {
      outcome = { value: (frame as NdjsonTerminalFrame<TOutcome>).outcome };
    }
    onFrame(frame as TFrame);
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) handleLine(line);
    }
    buffer += decoder.decode();
    if (buffer) handleLine(buffer);
  } catch (err) {
    // Propagates the disconnect to the server so it can skip remaining phases.
    await reader.cancel().catch(() => {});
    throw err;
  } finally {
    reader.releaseLock();
  }

  const result = outcome as { value: TOutcome } | null;
  if (!result) throw new NdjsonIncompleteError();
  return result.value;
}
