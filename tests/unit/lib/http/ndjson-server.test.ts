import { describe, it, expect } from "vitest";
import {
  ndjsonResponse,
  wantsNdjson,
  NDJSON_CONTENT_TYPE,
} from "@/lib/http/ndjson.server";

describe("ndjson.server", () => {
  describe("wantsNdjson", () => {
    it("returns true when Accept header contains application/x-ndjson", () => {
      const req = new Request("http://localhost/api/run", {
        headers: { Accept: NDJSON_CONTENT_TYPE },
      });
      expect(wantsNdjson(req)).toBe(true);
    });

    it("returns true when query parameter stream=true", () => {
      const req = new Request("http://localhost/api/run?stream=true");
      expect(wantsNdjson(req)).toBe(true);
    });

    it("returns false for regular requests", () => {
      const req = new Request("http://localhost/api/run", {
        headers: { Accept: "application/json" },
      });
      expect(wantsNdjson(req)).toBe(false);
    });
  });

  describe("ndjsonResponse", () => {
    it("streams intermediate frames and finishes with verdict_complete", async () => {
      const req = new Request("http://localhost/api/run?stream=true");

      const response = ndjsonResponse(req, async (emit) => {
        await emit({ type: "phase_one", data: "ok" });
        return { status: "passed", score: 100 };
      });

      expect(response.headers.get("Content-Type")).toBe(NDJSON_CONTENT_TYPE);
      expect(response.body).not.toBeNull();

      const text = await response.text();
      const lines = text.trim().split("\n").map((line) => JSON.parse(line));

      expect(lines).toHaveLength(2);
      expect(lines[0]).toEqual({ type: "phase_one", data: "ok" });
      expect(lines[1]).toEqual({
        type: "verdict_complete",
        outcome: { status: "passed", score: 100 },
      });
    });

    it("emits error frame when runner throws", async () => {
      const req = new Request("http://localhost/api/run?stream=true");

      const response = ndjsonResponse(req, async () => {
        throw new Error("Target agent timeout");
      });

      const text = await response.text();
      const lines = text.trim().split("\n").map((line) => JSON.parse(line));

      expect(lines).toHaveLength(1);
      expect(lines[0]).toEqual({
        type: "error",
        error: "Target agent timeout",
      });
    });

    it("aborts runner signal and avoids unhandled rejection when client disconnects", async () => {
      const abortController = new AbortController();
      const req = new Request("http://localhost/api/run?stream=true", {
        signal: abortController.signal,
      });

      const signalHolder: { current?: AbortSignal } = {};
      let emitAfterAbortThrew = false;

      const response = ndjsonResponse(req, async (emit, signal) => {
        signalHolder.current = signal;
        await emit({ type: "step1" });

        // Simulate client disconnect mid-run
        abortController.abort();

        // Check if signal updated
        expect(signal.aborted).toBe(true);

        // Writing after abort should be safely dropped without throwing
        try {
          await emit({ type: "step2_ignored" });
        } catch {
          emitAfterAbortThrew = true;
        }

        return { status: "aborted" };
      });

      // Read whatever came through
      const reader = response.body?.getReader();
      if (reader) {
        await reader.read();
        await reader.cancel();
      }

      expect(signalHolder.current?.aborted).toBe(true);
      expect(emitAfterAbortThrew).toBe(false);
    });

    it("aborts when stream is cancelled by consumer", async () => {
      const req = new Request("http://localhost/api/run?stream=true");
      let signalAborted = false;

      const response = ndjsonResponse(req, async (_emit, signal) => {
        // Wait until cancelled
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => {
            signalAborted = true;
            resolve();
          });
        });
        return { status: "cancelled" };
      });

      const reader = response.body!.getReader();
      await reader.cancel();

      // Give event loop a tick to trigger cancel
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(signalAborted).toBe(true);
    });
  });
});
