import { describe, it, expect, vi } from "vitest";
import { readNdjson, NdjsonIncompleteError } from "@/lib/http/read-ndjson";

function createStreamFromChunks(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
}

describe("readNdjson", () => {
  it("processes intermediate frames and resolves with terminal outcome", async () => {
    const stream = createStreamFromChunks([
      JSON.stringify({ type: "target_complete", threadId: "t-1" }) + "\n",
      JSON.stringify({
        type: "verdict_complete",
        outcome: { status: "passed", score: 95 },
      }) + "\n",
    ]);

    const frames: unknown[] = [];
    const outcome = await readNdjson<{ type: string }, { status: string; score: number }>(
      stream,
      (f) => frames.push(f),
    );

    expect(frames).toHaveLength(2);
    expect(frames[0]).toEqual({ type: "target_complete", threadId: "t-1" });
    expect(outcome).toEqual({ status: "passed", score: 95 });
  });

  it("skips malformed lines without throwing and continues processing", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const stream = createStreamFromChunks([
      "not-valid-json\n",
      JSON.stringify({ type: "step1", val: 1 }) + "\n",
      "   \n", // whitespace line
      JSON.stringify({
        type: "verdict_complete",
        outcome: { ok: true },
      }) + "\n",
    ]);

    const frames: unknown[] = [];
    const outcome = await readNdjson<{ type: string }, { ok: boolean }>(
      stream,
      (f) => frames.push(f),
    );

    expect(frames).toHaveLength(2);
    expect(frames[0]).toEqual({ type: "step1", val: 1 });
    expect(outcome).toEqual({ ok: true });
    expect(warnSpy).toHaveBeenCalled();

    warnSpy.mockRestore();
  });

  it("flushes trailing buffer without trailing newline", async () => {
    const stream = createStreamFromChunks([
      JSON.stringify({ type: "first" }) + "\n" +
      JSON.stringify({ type: "verdict_complete", outcome: { done: true } }), // no trailing \n
    ]);

    const frames: unknown[] = [];
    const outcome = await readNdjson<{ type: string }, { done: boolean }>(
      stream,
      (f) => frames.push(f),
    );

    expect(frames).toHaveLength(2);
    expect(outcome).toEqual({ done: true });
  });

  it("throws when error frame is received", async () => {
    const stream = createStreamFromChunks([
      JSON.stringify({ type: "target_complete" }) + "\n",
      JSON.stringify({ type: "error", error: "Agent dispatch failed" }) + "\n",
    ]);

    await expect(
      readNdjson(stream, () => {}),
    ).rejects.toThrow("Agent dispatch failed");
  });

  it("throws NdjsonIncompleteError if stream closes without verdict_complete", async () => {
    const stream = createStreamFromChunks([
      JSON.stringify({ type: "target_complete", threadId: "t-1" }) + "\n",
    ]);

    await expect(
      readNdjson(stream, () => {}),
    ).rejects.toThrow(NdjsonIncompleteError);
  });

  it("cancels stream reader and propagates exception when onFrame throws", async () => {
    let cancelled = false;
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(JSON.stringify({ type: "throw_here" }) + "\n"));
      },
      cancel() {
        cancelled = true;
      },
    });

    await expect(
      readNdjson(stream, () => {
        throw new Error("handler exploded");
      }),
    ).rejects.toThrow("handler exploded");

    expect(cancelled).toBe(true);
  });
});
