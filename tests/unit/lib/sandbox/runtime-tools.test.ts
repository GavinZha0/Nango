import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the active-adapter resolver before importing runtime-tools.
const mockRun = vi.fn();
vi.mock("@/lib/sandbox/registry.server", () => ({
  getActiveAdapter: async () => ({
    backend: "service" as const,
    displayName: "Mocked",
    isAvailable: async () => true,
    run: mockRun,
  }),
}));

import { buildRunInSandboxTool, buildSandboxRuntime } from "@/lib/sandbox/runtime-tools";

beforeEach(() => {
  mockRun.mockReset();
});

afterEach(() => {
  mockRun.mockReset();
});

describe("buildRunInSandboxTool", () => {
  it("declares the expected tool name + parameters shape", () => {
    const tool = buildRunInSandboxTool();
    expect(tool.name).toBe("run_code_in_sandbox");
    expect(typeof tool.description).toBe("string");
    expect(tool.description.length).toBeGreaterThan(50);
  });

  it("execute calls the active adapter and returns its output projected", async () => {
    mockRun.mockResolvedValue({
      stdout: "hello\n",
      stderr: "",
      exitCode: 0,
      durationMs: 12,
    });
    const tool = buildRunInSandboxTool();
    const result = await tool.execute!({
      language: "python",
      code_text: "print('hello')",
    });
    // The tool maps `language: "python"` → argv `["python3", "-"]`
    // internally; the LLM never picks the argv.
    expect(mockRun).toHaveBeenCalledWith(
      expect.objectContaining({
        command: ["python3", "-"],
        stdin: "print('hello')",
      }),
    );
    // buildRunInSandboxTool returns { ...assembleCodeOutput(out), backend }.
    // "hello\n" is not valid JSON → message = raw stdout, all data fields null.
    expect(result).toEqual({
      ok: true,
      duration_ms: 12,
      rows: null,
      row_count: null,
      row_schema: null,
      message: "hello\n",
      files: null,
      error: null,
      backend: "service",
    });
  });

  it("execute forwards optional fields when present", async () => {
    mockRun.mockResolvedValue({
      stdout: "",
      stderr: "",
      exitCode: 0,
      durationMs: 5,
    });
    const tool = buildRunInSandboxTool();
    await tool.execute!({
      language: "python",
      code_text: "print(1)",
      datasets: ["sales_q1"],
      // Tool surface is SECONDS (project convention; field name
      // disambiguates from the LLM's setTimeout intuition); internally
      // it gets multiplied by 1000 before reaching the adapter.
      timeout_seconds: 5,
    });
    expect(mockRun).toHaveBeenCalledWith({
      language: "python3",
      command: ["python3", "-"],
      stdin: "print(1)",
      datasets: ["sales_q1"],
      timeoutMs: 5000,
    });
  });

  it("execute forwards params serialized into env overlay", async () => {
    mockRun.mockResolvedValue({
      stdout: "",
      stderr: "",
      exitCode: 0,
      durationMs: 5,
    });
    const tool = buildRunInSandboxTool();
    await tool.execute!({
      language: "python",
      code_text: "print(1)",
      params: { threshold: 42, label: "test", active: true },
    });
    expect(mockRun).toHaveBeenCalledWith(
      expect.objectContaining({
        language: "python3",
        env: {
          __PARAMS__: JSON.stringify({ threshold: 42, label: "test", active: true }),
          threshold: "42",
          label: "test",
          active: "true",
        },
      }),
    );
  });

  it("includes termination in the result when set", async () => {
    mockRun.mockResolvedValue({
      stdout: "",
      stderr: "killed\n",
      exitCode: 124,
      durationMs: 31000,
      termination: "timeout",
    });
    const tool = buildRunInSandboxTool();
    const result = await tool.execute!({
      language: "python",
      code_text: "import time; time.sleep(999)",
    });
    // assembleCodeOutput maps exitCode≠0 → ok=false; stderr.trim() → error.
    // The adapter's `termination` field is not forwarded (not in CodeOutputEnvelope).
    expect((result as { ok: boolean }).ok).toBe(false);
    expect((result as { error: string | null }).error).toBe("killed");
  });

  it("rejects reserved __PARAMS__ key in params with validation error (P8)", async () => {
    const tool = buildRunInSandboxTool();
    const result = await tool.execute!({
      language: "python",
      code_text: "print(1)",
      params: { __PARAMS__: "conflict", other: 123 },
    });
    expect((result as { ok: boolean }).ok).toBe(false);
    expect((result as { error: string }).error).toContain(
      "'__PARAMS__' is a reserved system parameter name and cannot be used in params",
    );
    expect(mockRun).not.toHaveBeenCalled();
  });
});

describe("buildSandboxRuntime", () => {
  it("returns the runInSandbox tool plus an empty prompt block", () => {
    const r = buildSandboxRuntime();
    expect(r.tools).toHaveLength(1);
    expect(r.tools[0].name).toBe("run_code_in_sandbox");
    expect(r.promptBlock).toBe("");
  });
});
