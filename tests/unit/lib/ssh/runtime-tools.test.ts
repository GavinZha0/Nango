import { describe, it, expect, vi, beforeEach } from "vitest";

import { runOnBoundServer, buildRunSshCommandTool } from "@/lib/ssh/runtime-tools";
import * as lookup from "@/lib/ssh/lookup";
import * as policy from "@/lib/ssh/policy";
import { execOnServer, SshError } from "@/lib/ssh/client";

vi.mock("@/lib/ssh/lookup");
vi.mock("@/lib/ssh/policy");

// Partial mock: `SshError` must stay the real class, otherwise
// `err instanceof SshError` in runOnBoundServer matches a mock shell whose
// instances carry no `code`, and the error-mapping branch goes untested.
vi.mock("@/lib/ssh/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ssh/client")>();
  return { ...actual, execOnServer: vi.fn() };
});

const mockResolve = vi.mocked(lookup.resolveSshServerByName);
const mockPolicy = vi.mocked(policy.evaluateCommandPolicy);
const mockExec = vi.mocked(execOnServer);

const server = {
  id: "server-1",
  name: "test-server",
  host: "10.0.0.5",
  port: 22,
  knownHostFingerprint: "SHA256:abc",
  loginShell: true,
  commandAllow: null,
  commandDeny: ["rm -rf"],
  auth: { username: "svc-nango", credentialId: "cred-1" },
};

const okResult = {
  stdout: "hello",
  stderr: "",
  exitCode: 0,
  signal: null,
  durationMs: 12,
  truncated: false,
};

function allowEverything() {
  mockResolve.mockResolvedValue({ ok: true, resolved: server as never });
  mockPolicy.mockReturnValue({ allowed: true });
}

beforeEach(() => {
  // reset (not clear) so a `mockResolvedValue` from one case cannot leak into
  // the next — several cases assert the "did not reach the host" branches.
  vi.resetAllMocks();
});

describe("runOnBoundServer", () => {
  it("returns NOT_FOUND when the server lookup fails", async () => {
    mockResolve.mockResolvedValue({
      ok: false,
      error: "NOT_FOUND",
      message: "no such server",
    } as never);

    const result = await runOnBoundServer({
      serverName: "x",
      command: "ls",
      agentSshServerIds: [],
    });

    expect(result).toEqual({ ok: false, error: "NOT_FOUND", message: "no such server" });
    expect(mockExec).not.toHaveBeenCalled();
  });

  it("returns NOT_BOUND when the server is not bound to the agent", async () => {
    mockResolve.mockResolvedValue({ ok: true, resolved: server as never });

    const result = await runOnBoundServer({
      serverName: "test-server",
      command: "ls",
      agentSshServerIds: ["other-server"],
    });

    expect(result).toEqual({
      ok: false,
      error: "NOT_BOUND",
      message: expect.stringContaining("is not bound to"),
    });
    expect(mockPolicy).not.toHaveBeenCalled();
    expect(mockExec).not.toHaveBeenCalled();
  });

  // CONTRACT: the policy gate runs before any SSH channel is opened.
  it("returns POLICY_DENIED and forwards matchedPattern without connecting", async () => {
    mockResolve.mockResolvedValue({ ok: true, resolved: server as never });
    mockPolicy.mockReturnValue({
      allowed: false,
      reason: "Denied",
      matchedPattern: "rm -rf",
    });

    const result = await runOnBoundServer({
      serverName: "test-server",
      command: "rm -rf /",
      agentSshServerIds: ["server-1"],
    });

    expect(result).toEqual({
      ok: false,
      error: "POLICY_DENIED",
      message: "Denied",
      matchedPattern: "rm -rf",
    });
    expect(mockExec).not.toHaveBeenCalled();
  });

  it("omits matchedPattern when the policy gives only a reason", async () => {
    allowEverything();
    mockPolicy.mockReturnValue({ allowed: false, reason: "Blocked" });

    const result = await runOnBoundServer({
      serverName: "test-server",
      command: "ls",
      agentSshServerIds: ["server-1"],
    });

    expect(result.ok).toBe(false);
    expect("matchedPattern" in result).toBe(false);
  });

  it("policies the full command string against the row's allow/deny lists", async () => {
    allowEverything();
    mockExec.mockResolvedValue(okResult as never);

    await runOnBoundServer({
      serverName: "test-server",
      command: "bash -c 'echo hi' 'skill'",
      agentSshServerIds: ["server-1"],
    });

    expect(mockPolicy).toHaveBeenCalledWith(
      "bash -c 'echo hi' 'skill'",
      server.commandAllow,
      server.commandDeny,
    );
  });

  // Regression for the cap being checked pre-wrap: `bash -lc '<cmd>'`
  // re-quotes the whole command, so every `'` costs four characters.
  it("measures maxCommandChars after login-shell wrapping", async () => {
    allowEverything();
    mockExec.mockResolvedValue(okResult as never);

    // 60 quote characters: 60 raw, but 60 + 3*60 + 11 = 251 on the wire.
    const command = "'".repeat(60);
    const result = await runOnBoundServer({
      serverName: "test-server",
      command,
      agentSshServerIds: ["server-1"],
      maxCommandChars: 200,
    });

    expect(result).toEqual({
      ok: false,
      error: "COMMAND_TOO_LONG",
      message: expect.stringContaining("251 characters after login-shell wrapping"),
    });
    expect(mockExec).not.toHaveBeenCalled();
  });

  it("lets a command under the wrapped cap through", async () => {
    allowEverything();
    mockExec.mockResolvedValue(okResult as never);

    const result = await runOnBoundServer({
      serverName: "test-server",
      command: "'".repeat(60),
      agentSshServerIds: ["server-1"],
      maxCommandChars: 251,
    });

    expect(result.ok).toBe(true);
    expect(mockExec).toHaveBeenCalled();
  });

  it("measures the raw command when the host has no login shell", async () => {
    allowEverything();
    mockResolve.mockResolvedValue({
      ok: true,
      resolved: { ...server, loginShell: false } as never,
    });

    const result = await runOnBoundServer({
      serverName: "test-server",
      command: "'".repeat(60),
      agentSshServerIds: ["server-1"],
      maxCommandChars: 59,
    });

    expect(result).toEqual({
      ok: false,
      error: "COMMAND_TOO_LONG",
      message: expect.stringContaining("60 characters, exceeding the maximum of 59"),
    });
    expect((result as { message: string }).message).not.toMatch(/login-shell/);
  });

  // run_ssh_command's 8000 bounds LLM output, not the wire, so it passes no
  // cap and a wrapped command may legitimately exceed it.
  it("applies no wire cap when maxCommandChars is unset", async () => {
    allowEverything();
    mockExec.mockResolvedValue(okResult as never);

    const result = await runOnBoundServer({
      serverName: "test-server",
      command: "'".repeat(8000),
      agentSshServerIds: ["server-1"],
    });

    expect(result.ok).toBe(true);
    expect(mockExec).toHaveBeenCalled();
  });

  it("returns the exec envelope with server identity", async () => {
    allowEverything();
    mockExec.mockResolvedValue(okResult as never);

    const result = await runOnBoundServer({
      serverName: "test-server",
      command: "ls",
      agentSshServerIds: ["server-1"],
    });

    expect(result).toEqual({
      ok: true,
      serverName: "test-server",
      host: "10.0.0.5",
      ...okResult,
    });
    // SECURITY: the OS username lives in the credential payload and must
    // never leak into an LLM-visible tool result.
    expect(JSON.stringify(result)).not.toContain("svc-nango");
  });

  it("passes connection target, auth and abort signal to execOnServer", async () => {
    allowEverything();
    mockExec.mockResolvedValue(okResult as never);
    const controller = new AbortController();

    await runOnBoundServer({
      serverName: "test-server",
      command: "ls",
      agentSshServerIds: ["server-1"],
      signal: controller.signal,
    });

    expect(mockExec).toHaveBeenCalledWith(
      {
        host: "10.0.0.5",
        port: 22,
        knownHostFingerprint: "SHA256:abc",
        loginShell: true,
      },
      server.auth,
      "ls",
      { timeoutMs: undefined, signal: controller.signal },
    );
  });

  // CONTRACT: the tool surface speaks seconds; internals stay ms.
  it("converts timeoutSeconds into timeoutMs", async () => {
    allowEverything();
    mockExec.mockResolvedValue(okResult as never);

    await runOnBoundServer({
      serverName: "test-server",
      command: "ls",
      timeoutSeconds: 45,
      agentSshServerIds: ["server-1"],
    });

    expect(mockExec.mock.calls[0][3]).toEqual(
      expect.objectContaining({ timeoutMs: 45_000 }),
    );
  });

  it("maps SshError codes onto the failure envelope", async () => {
    allowEverything();
    mockExec.mockRejectedValue(new SshError("CONNECT_FAILED", "Connection failed"));

    const result = await runOnBoundServer({
      serverName: "test-server",
      command: "ls",
      agentSshServerIds: ["server-1"],
    });

    expect(result).toEqual({
      ok: false,
      error: "CONNECT_FAILED",
      message: "Connection failed",
    });
  });

  it("rethrows non-SshError failures", async () => {
    allowEverything();
    mockExec.mockRejectedValue(new Error("boom"));

    await expect(
      runOnBoundServer({
        serverName: "test-server",
        command: "ls",
        agentSshServerIds: ["server-1"],
      }),
    ).rejects.toThrow("boom");
  });
});

// The scripts-on-ssh work extracted the body of `run_ssh_command` into
// `runOnBoundServer`. These pin the pre-refactor behaviour so the extraction
// cannot silently change the LLM-facing contract.
describe("run_ssh_command after the runOnBoundServer extraction", () => {
  type Executable = {
    execute: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
  };

  function buildTool(): Executable {
    return buildRunSshCommandTool({
      agentSshServerIds: ["server-1"],
    }) as unknown as Executable;
  }

  it("delegates parsed args through the shared path", async () => {
    allowEverything();
    mockExec.mockResolvedValue(okResult as never);

    const result = await buildTool().execute({
      serverName: "test-server",
      command: "uptime",
      timeoutSeconds: 5,
    });

    expect(result).toMatchObject({ ok: true, serverName: "test-server", stdout: "hello" });
    expect(mockPolicy).toHaveBeenCalledWith("uptime", null, ["rm -rf"]);
    expect(mockExec.mock.calls[0][3]).toEqual(
      expect.objectContaining({ timeoutMs: 5_000 }),
    );
  });

  it("keeps the 8000-character cap on LLM-authored commands", async () => {
    await expect(
      buildTool().execute({
        serverName: "test-server",
        command: "a".repeat(8001),
      }),
    ).rejects.toThrow();
    expect(mockResolve).not.toHaveBeenCalled();
    expect(mockExec).not.toHaveBeenCalled();
  });

  // SECURITY: binding is evaluated on the resolved row's id, not the slug the
  // model typed — knowing another agent's server name must not be enough.
  it("refuses a server that is not bound to the agent", async () => {
    mockResolve.mockResolvedValue({ ok: true, resolved: server as never });

    const tool = buildRunSshCommandTool({
      agentSshServerIds: ["some-other-server-id"],
    }) as unknown as Executable;
    const result = await tool.execute({
      serverName: "test-server",
      command: "ls",
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBe("NOT_BOUND");
    expect(mockExec).not.toHaveBeenCalled();
  });
});
