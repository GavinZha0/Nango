import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/credentials/lookup", () => ({
  getEnabledInfrastructureCredentialByProvider: vi.fn().mockResolvedValue({
    id: "cred-1",
    provider: "dify-sandbox",
    host: "http://localhost:8190",
    apiKey: "dify-sandbox",
  }),
}));

vi.mock("@/lib/config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/config")>();
  return {
    ...actual,
    getConfig: (_key: string, defaultValue: string) => defaultValue,
    getConfigMs: (_key: string, defaultMs: number) => defaultMs,
    getConfigNumber: (_key: string, defaultNum: number) => defaultNum,
  };
});

import { ServiceSandboxAdapter } from "@/lib/sandbox/adapters/service/adapter.server";

describe("ServiceSandboxAdapter", () => {
  it("has correct backend identifier and displayName", () => {
    const adapter = new ServiceSandboxAdapter();
    expect(adapter.backend).toBe("service");
    expect(adapter.displayName).toBe("Service Sandbox (dify)");
  });

  it("formats python script request and parses dify-sandbox response", async () => {
    const adapter = new ServiceSandboxAdapter();

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        code: 0,
        message: "success",
        data: {
          stdout: "Hello from Service Sandbox!\n",
          stderr: "",
          error: "",
        },
      }),
    });

    vi.stubGlobal("fetch", mockFetch);

    const output = await adapter.run({
      command: ["python3"],
      stdin: "print('Hello')",
    });

    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:8190/v1/sandbox/run",
      expect.objectContaining({
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Api-Key": "dify-sandbox",
        },
      }),
    );

    expect(output.stdout).toBe("Hello from Service Sandbox!\n");
    expect(output.exitCode).toBe(0);

    vi.unstubAllGlobals();
  });

  it("injects env overlay and sets up params deserialization in python preamble", async () => {
    const adapter = new ServiceSandboxAdapter();
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        code: 0,
        message: "success",
        data: { stdout: "ok\n" },
      }),
    });
    vi.stubGlobal("fetch", mockFetch);

    await adapter.run({
      language: "python3",
      command: ["python3", "-"],
      stdin: "print(params['threshold'])",
      env: {
        __PARAMS__: JSON.stringify({ threshold: 42 }),
        threshold: "42",
      },
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body as string) as {
      code: string;
      language: string;
    };
    expect(sentBody.language).toBe("python3");
    expect(sentBody.code).toContain("__nango_os.environ[\"threshold\"] = \"42\"");
    expect(sentBody.code).toContain("__nango_os.environ[\"__PARAMS__\"] = \"{\\\"threshold\\\":42}\"");
    expect(sentBody.code).toContain("params = __nango_json.loads(__nango_os.environ['__PARAMS__'])");
    expect(sentBody.code).toContain("print(params['threshold'])");

    vi.unstubAllGlobals();
  });

  it("injects env overlay and sets up params deserialization in javascript preamble", async () => {
    const adapter = new ServiceSandboxAdapter();
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        code: 0,
        message: "success",
        data: { stdout: "ok\n" },
      }),
    });
    vi.stubGlobal("fetch", mockFetch);

    await adapter.run({
      language: "javascript",
      command: ["node", "-"],
      stdin: "console.log(params.threshold);",
      env: {
        __PARAMS__: JSON.stringify({ threshold: 42 }),
        threshold: "42",
      },
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body as string) as {
      code: string;
      language: string;
    };
    expect(sentBody.language).toBe("javascript");
    expect(sentBody.code).toContain("process.env[\"threshold\"] = \"42\";");
    expect(sentBody.code).toContain("process.env[\"__PARAMS__\"] = \"{\\\"threshold\\\":42}\";");
    expect(sentBody.code).toContain("params = JSON.parse(process.env[\"__PARAMS__\"]");
    expect(sentBody.code).toContain("console.log(params.threshold);");

    vi.unstubAllGlobals();
  });

  it("unconditionally defines params = {} in python and javascript preambles when __PARAMS__ is absent (P7)", async () => {
    const adapter = new ServiceSandboxAdapter();
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        code: 0,
        message: "success",
        data: { stdout: "ok\n" },
      }),
    });
    vi.stubGlobal("fetch", mockFetch);

    // Python without __PARAMS__
    await adapter.run({
      language: "python3",
      command: ["python3", "-"],
      stdin: "print(len(params))",
    });

    const pyBody = JSON.parse(mockFetch.mock.calls[0][1].body as string) as { code: string };
    expect(pyBody.code).toContain("params = {}\n");
    expect(pyBody.code).not.toContain("__nango_json.loads");

    // JavaScript without __PARAMS__
    await adapter.run({
      language: "javascript",
      command: ["node", "-"],
      stdin: "console.log(Object.keys(params).length);",
    });

    const jsBody = JSON.parse(mockFetch.mock.calls[1][1].body as string) as { code: string };
    expect(jsBody.code).toContain("let params = {};\n");
    expect(jsBody.code).not.toContain("JSON.parse");

    vi.unstubAllGlobals();
  });

  it("does not produce duplicate params declarations or SyntaxError when script already declares params", async () => {
    const adapter = new ServiceSandboxAdapter();
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        code: 0,
        message: "success",
        data: { stdout: "ok\n" },
      }),
    });
    vi.stubGlobal("fetch", mockFetch);

    // Case 1: Script has existing const params
    await adapter.run({
      language: "javascript",
      command: ["node", "-"],
      stdin: "const params = { x: 1 };\nconsole.log(params.x);",
      env: {
        __PARAMS__: JSON.stringify({ x: 2 }),
      },
    });

    const body1 = JSON.parse(mockFetch.mock.calls[0][1].body as string) as { code: string };
    // Should NOT inject `let params = {};`
    expect(body1.code).not.toContain("let params = {};");

    // Case 2: Verify both generated bodies compile cleanly in Node.js VM without SyntaxError
    const vm = await import("node:vm");
    expect(() => new vm.Script(body1.code)).not.toThrow();

    vi.unstubAllGlobals();
  });
});
