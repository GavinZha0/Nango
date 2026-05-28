import { describe, it, expect } from "vitest";

import {
  detectToolResultStatus,
  extractErrorMessage,
} from "@/lib/copilot/detect-tool-result-status";

describe("detectToolResultStatus", () => {
  it("returns null for empty / undefined / null", () => {
    expect(detectToolResultStatus(undefined)).toBeNull();
    expect(detectToolResultStatus(null)).toBeNull();
    expect(detectToolResultStatus("")).toBeNull();
  });

  it("returns null for non-JSON strings (raw text results)", () => {
    expect(detectToolResultStatus("just a string")).toBeNull();
    expect(detectToolResultStatus("Error: connection refused")).toBeNull();
  });

  it("returns null for JSON that is not a plain object", () => {
    expect(detectToolResultStatus("123")).toBeNull();
    expect(detectToolResultStatus("true")).toBeNull();
    expect(detectToolResultStatus("[1, 2, 3]")).toBeNull();
    expect(detectToolResultStatus("null")).toBeNull();
  });

  it("returns failure on MCP isError: true", () => {
    expect(
      detectToolResultStatus(JSON.stringify({ isError: true, content: [] })),
    ).toBe("failure");
  });

  it("returns success on MCP isError: false", () => {
    expect(
      detectToolResultStatus(JSON.stringify({ isError: false, content: [] })),
    ).toBe("success");
  });

  it("returns failure on Nango wrapper shape", () => {
    expect(
      detectToolResultStatus(
        JSON.stringify({
          isError: true,
          message: "Connection refused",
          toolName: "run_ssh_command",
        }),
      ),
    ).toBe("failure");
  });

  it("returns failure on business { ok: false }", () => {
    expect(
      detectToolResultStatus(JSON.stringify({ ok: false, error: "not found" })),
    ).toBe("failure");
  });

  it("returns success on business { ok: true }", () => {
    expect(
      detectToolResultStatus(JSON.stringify({ ok: true, runId: "abc" })),
    ).toBe("success");
  });

  it("returns null when result has neither isError nor ok", () => {
    expect(
      detectToolResultStatus(
        JSON.stringify({ rows: [1, 2, 3], schema: { columns: [] } }),
      ),
    ).toBeNull();
  });

  it("prefers isError over ok when both present", () => {
    // Synthetic edge case: a tool that reports both. isError is the MCP
    // protocol standard, so it wins.
    expect(
      detectToolResultStatus(JSON.stringify({ isError: true, ok: true })),
    ).toBe("failure");
  });

  it("returns warning when isError carries severity:'warning'", () => {
    // Canonical history-replay synthesis path (event-reconstruction
    // produces this when tool_call_result was never persisted).
    expect(
      detectToolResultStatus(
        JSON.stringify({
          isError: true,
          severity: "warning",
          message: "No tool result was recorded — outcome inferred.",
        }),
      ),
    ).toBe("warning");
  });

  it("returns failure when isError carries severity:'error' (explicit)", () => {
    // Explicit error severity (synthesised run_aborted shape) stays
    // classified as a hard failure.
    expect(
      detectToolResultStatus(
        JSON.stringify({
          isError: true,
          severity: "error",
          message: "Run aborted before this tool completed.",
        }),
      ),
    ).toBe("failure");
  });

  it("returns failure when severity is missing or unrecognised", () => {
    // Defensive: unknown severity values must not silently pass as
    // warning. Anything other than the literal "warning" -> failure.
    expect(
      detectToolResultStatus(
        JSON.stringify({ isError: true, severity: "critical" }),
      ),
    ).toBe("failure");
    expect(
      detectToolResultStatus(JSON.stringify({ isError: true })),
    ).toBe("failure");
  });

  // Process-result envelope (run_code_in_sandbox & future shell tools).
  // Mirrors lib/artifacts/coalesce-tool-calls.ts::isFailedEnvelope so
  // chat-side cards, admin timeline, and save pipeline agree.

  it("returns failure on process-result envelope with exitCode != 0", () => {
    // Real shape from a failed Python run.
    expect(
      detectToolResultStatus(
        JSON.stringify({
          stdout: "",
          stderr: "Traceback ... ModuleNotFoundError: No module named 'duckdb'",
          exitCode: 1,
          durationMs: 62,
          backend: "subprocess",
        }),
      ),
    ).toBe("failure");
  });

  it("returns success on process-result envelope with exitCode === 0", () => {
    expect(
      detectToolResultStatus(
        JSON.stringify({
          stdout: "hello\n",
          stderr: "",
          exitCode: 0,
          durationMs: 12,
          backend: "subprocess",
        }),
      ),
    ).toBe("success");
  });

  it("ignores non-numeric exitCode (only `typeof === 'number'` counts)", () => {
    // Defensive: a tool that returns exitCode as a string or omits it
    // must NOT be classified by this branch — fall through to null.
    expect(
      detectToolResultStatus(
        JSON.stringify({ exitCode: "0", payload: 42 }),
      ),
    ).toBeNull();
    expect(
      detectToolResultStatus(JSON.stringify({ rows: [1, 2, 3] })),
    ).toBeNull();
  });

  it("prefers `ok` over `exitCode` when both present", () => {
    // A tool that wraps a sandbox call could emit both. The semantic
    // ok wins — it's a more curated signal than a raw subprocess code.
    expect(
      detectToolResultStatus(
        JSON.stringify({ ok: true, exitCode: 1 }),
      ),
    ).toBe("success");
    expect(
      detectToolResultStatus(
        JSON.stringify({ ok: false, exitCode: 0 }),
      ),
    ).toBe("failure");
  });

  it("prefers `isError` over `exitCode` when both present", () => {
    expect(
      detectToolResultStatus(
        JSON.stringify({ isError: true, exitCode: 0 }),
      ),
    ).toBe("failure");
  });
});

describe("extractErrorMessage", () => {
  it("returns null for empty / non-JSON / non-object", () => {
    expect(extractErrorMessage(undefined)).toBeNull();
    expect(extractErrorMessage(null)).toBeNull();
    expect(extractErrorMessage("")).toBeNull();
    expect(extractErrorMessage("not json")).toBeNull();
    expect(extractErrorMessage("123")).toBeNull();
  });

  it("returns top-level message (wrapper shape)", () => {
    expect(
      extractErrorMessage(
        JSON.stringify({
          isError: true,
          message: "Connection refused",
          toolName: "x",
        }),
      ),
    ).toBe("Connection refused");
  });

  it("returns top-level error string (simple business)", () => {
    expect(
      extractErrorMessage(JSON.stringify({ ok: false, error: "Not found" })),
    ).toBe("Not found");
  });

  it("returns nested error.message (structured business)", () => {
    expect(
      extractErrorMessage(
        JSON.stringify({
          ok: false,
          error: { code: "INVALID_NAME", message: "bad slug" },
        }),
      ),
    ).toBe("bad slug");
  });

  it("returns MCP content[].text joined", () => {
    expect(
      extractErrorMessage(
        JSON.stringify({
          isError: true,
          content: [
            { type: "text", text: "First error" },
            { type: "text", text: "Second line" },
          ],
        }),
      ),
    ).toBe("First error\nSecond line");
  });

  it("skips non-text content blocks", () => {
    expect(
      extractErrorMessage(
        JSON.stringify({
          isError: true,
          content: [
            { type: "image", data: "..." },
            { type: "text", text: "The real message" },
          ],
        }),
      ),
    ).toBe("The real message");
  });

  it("returns null when no recognised error field present", () => {
    expect(
      extractErrorMessage(JSON.stringify({ ok: false })),
    ).toBeNull();
    expect(
      extractErrorMessage(JSON.stringify({ isError: true })),
    ).toBeNull();
  });

  it("priority: message > error string > error.message > content[]", () => {
    // All four shapes present — message wins.
    expect(
      extractErrorMessage(
        JSON.stringify({
          isError: true,
          message: "from message",
          error: "from error string",
          content: [{ type: "text", text: "from content" }],
        }),
      ),
    ).toBe("from message");
  });

  // stderr fallback for process-result envelope.

  it("returns stderr when it's the only diagnostic field", () => {
    expect(
      extractErrorMessage(
        JSON.stringify({
          stdout: "",
          stderr:
            "Traceback (most recent call last):\n  File \"<stdin>\", line 2\nModuleNotFoundError: No module named 'duckdb'",
          exitCode: 1,
          durationMs: 62,
          backend: "subprocess",
        }),
      ),
    ).toContain("ModuleNotFoundError");
  });

  it("stderr is the LAST fallback — curated fields win", () => {
    // A hypothetical wrapped sandbox shape with both a curated
    // `message` and the raw `stderr`. The curated field is preferred
    // because the runtime author bothered to set it.
    expect(
      extractErrorMessage(
        JSON.stringify({
          message: "Sandbox aborted: module missing",
          stderr: "raw traceback dump...",
          exitCode: 1,
        }),
      ),
    ).toBe("Sandbox aborted: module missing");
  });

  it("ignores empty stderr", () => {
    // Successful sandbox runs typically have empty stderr; we don't
    // emit "" as a message even when other diagnostic fields are
    // missing.
    expect(
      extractErrorMessage(
        JSON.stringify({ stdout: "ok", stderr: "", exitCode: 0 }),
      ),
    ).toBeNull();
  });
});
