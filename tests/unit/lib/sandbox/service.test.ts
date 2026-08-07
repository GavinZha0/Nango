import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

vi.mock("@/lib/credentials/lookup", () => ({
  getEnabledInfrastructureCredentialByProvider: vi.fn().mockResolvedValue({
    id: "cred-1",
    provider: "dify-sandbox",
    host: "http://localhost:8190",
    apiKey: "dify-sandbox",
  }),
}));

vi.mock("@/lib/config", () => ({
  getConfig: (_key: string, defaultValue: string) => defaultValue,
  getConfigMs: (_key: string, defaultMs: number) => defaultMs,
  getConfigNumber: (_key: string, defaultNum: number) => defaultNum,
}));

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
});
