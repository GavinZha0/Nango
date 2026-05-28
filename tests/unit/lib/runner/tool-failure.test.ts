import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("server-only", () => ({}));

import {
  wrapToolExecute,
  type ToolExecutionFailure,
  ERROR_POLICY_BLOCK,
} from "@/lib/runner/tool-failure";

/** Minimal callable shape returned by `wrapToolExecute`. The wrapper
 *  returns the same logical type it received (typed as `T`), so we
 *  cast to this when invoking `.execute` for assertions. */
interface Wrapped {
  execute: (args?: unknown) => Promise<unknown>;
}

function stubLogger() {
  return {
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

describe("wrapToolExecute — generic tool failure envelope", () => {
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // Intercept any accidental console.warn so it doesn't pollute test
    // output; the wrapper now uses an injected pino child, never
    // console — this is a regression guard, not the assertion target.
    consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    consoleWarnSpy.mockRestore();
  });

  it("passes through the original result when execute resolves", async () => {
    const tool = {
      description: "ok tool",
      execute: async () => ({ rows: [1, 2, 3] }),
    };
    const wrapped = wrapToolExecute(tool, "fetch") as unknown as Wrapped;
    const out = await wrapped.execute({});
    expect(out).toEqual({ rows: [1, 2, 3] });
    expect(consoleWarnSpy).not.toHaveBeenCalled();
  });

  it("returns a structured ToolExecutionFailure when execute throws", async () => {
    const tool = {
      description: "bad tool",
      execute: async () => {
        throw new Error("connection refused");
      },
    };
    const log = stubLogger();
    const wrapped = wrapToolExecute(
      tool,
      "search",
      log as never,
      "mcp_tool_call_failed",
    ) as unknown as Wrapped;
    const out = (await wrapped.execute({})) as ToolExecutionFailure;

    expect(out.isError).toBe(true);
    expect(out.message).toBe("connection refused");
    expect(out.toolName).toBe("search");
    // Flat shape — no nested error object, no code, no serverLabel, no hint.
    expect(out).not.toHaveProperty("error");
    expect(out).not.toHaveProperty("hint");
    expect(out).not.toHaveProperty("ok");

    // Pino-style structured warning with the caller-supplied event tag.
    expect(log.warn).toHaveBeenCalledOnce();
    const [payload] = log.warn.mock.calls[0] as [{ event: string; toolName: string }];
    expect(payload.event).toBe("mcp_tool_call_failed");
    expect(payload.toolName).toBe("search");
  });

  it("defaults the log event to `tool_execute_failed` when caller omits it", async () => {
    const tool = {
      execute: async () => {
        throw new Error("boom");
      },
    };
    const log = stubLogger();
    const wrapped = wrapToolExecute(tool, "x", log as never) as unknown as Wrapped;
    await wrapped.execute({});
    const [payload] = log.warn.mock.calls[0] as [{ event: string }];
    expect(payload.event).toBe("tool_execute_failed");
  });

  it("stringifies non-Error throws", async () => {
    const tool = {
      execute: async () => {
        throw "raw string boom";
      },
    };
    const wrapped = wrapToolExecute(tool, "x") as unknown as Wrapped;
    const out = (await wrapped.execute({})) as ToolExecutionFailure;
    expect(out.message).toBe("raw string boom");
    expect(out.isError).toBe(true);
  });

  it("preserves all non-execute properties on the tool object", async () => {
    const tool = {
      description: "metadata",
      inputSchema: { type: "object" },
      execute: async () => "ok",
    };
    const wrapped = wrapToolExecute(tool, "n") as unknown as {
      description: string;
      inputSchema: { type: string };
      execute: (args?: unknown) => Promise<unknown>;
    };
    expect(wrapped.description).toBe("metadata");
    expect(wrapped.inputSchema).toEqual({ type: "object" });
  });

  it("is idempotent — wrapping a wrapped tool returns the same reference", () => {
    const tool = { execute: async () => "ok" };
    const once = wrapToolExecute(tool, "n");
    const twice = wrapToolExecute(once, "n");
    // Reference equality is the strongest signal that no extra
    // try/catch layer was added on the second call.
    expect(twice).toBe(once);
  });

  it("returns the tool unchanged if it has no execute function", () => {
    const opaque = { description: "metadata only" };
    const wrapped = wrapToolExecute(opaque, "n");
    expect(wrapped).toBe(opaque);
  });

  it("returns the input unchanged for non-objects", () => {
    expect(wrapToolExecute(null, "n")).toBe(null);
    expect(wrapToolExecute(undefined, "n")).toBe(undefined);
    expect(wrapToolExecute(42, "n")).toBe(42);
  });

  it("does not invoke the logger when no logger is supplied", async () => {
    const tool = {
      execute: async () => {
        throw new Error("silent");
      },
    };
    // No log argument — wrapper should still return a failure envelope
    // without throwing about the missing logger.
    const wrapped = wrapToolExecute(tool, "x") as unknown as Wrapped;
    const out = (await wrapped.execute({})) as ToolExecutionFailure;
    expect(out.isError).toBe(true);
    expect(out.message).toBe("silent");
  });
});

describe("ERROR_POLICY_BLOCK", () => {
  it("instructs the LLM not to retry on isError: true", () => {
    expect(ERROR_POLICY_BLOCK).toContain("isError: true");
    expect(ERROR_POLICY_BLOCK).toContain("Do not retry");
  });
});
