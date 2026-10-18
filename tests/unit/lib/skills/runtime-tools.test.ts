import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHash } from "node:crypto";

import {
  buildSkillsRuntime,
  buildRunSkillScriptOnSshTool,
} from "@/lib/skills/runtime-tools";
import { getDbSkillStorage, InvalidSkillPathError } from "@/lib/skills/storage";
import {
  runOnBoundServer,
  SSH_SKILL_SCRIPT_MAX_COMMAND_CHARS,
} from "@/lib/ssh/runtime-tools";
import type { SkillSpec } from "@/lib/skills/skill-pool";

vi.mock("@/lib/skills/storage");

// Explicit factory: automocking would erase the numeric constant that
// runtime-tools.ts imports, silently disabling the COMMAND_TOO_LONG gate.
vi.mock("@/lib/ssh/runtime-tools", () => ({
  runOnBoundServer: vi.fn(),
  SSH_SKILL_SCRIPT_MAX_COMMAND_CHARS: 16_000,
}));

const mockStorage = { readFile: vi.fn() };
const mockRunOnBoundServer = vi.mocked(runOnBoundServer);

function makeSpec(overrides: Partial<SkillSpec> = {}): SkillSpec {
  return {
    skillId: "ssh-skill-id",
    name: "ssh-skill",
    description: "A skill with SSH scripts",
    skillMd: "---\nname: ssh-skill\ndescription: ...\nscripts-on-ssh: [probe.sh]\n---",
    parsed: {} as SkillSpec["parsed"],
    enabled: true,
    visibility: "public",
    createdBy: "user-1",
    scriptsOnSsh: new Set(["scripts/probe.sh"]),
    scriptsOnDb: new Set(),
    ...overrides,
  };
}

const sshSkillSpec = makeSpec();
const pythonSshSpec = makeSpec({
  skillId: "py-skill-id",
  name: "py-skill",
  scriptsOnSsh: new Set(["scripts/probe.py"]),
  scriptsOnDb: new Set(),
});
const sandboxSkillSpec = makeSpec({
  skillId: "sandbox-skill-id",
  name: "sandbox-skill",
  description: "A skill with sandbox scripts",
  skillMd: "---\nname: sandbox-skill\ndescription: ...\n---",
  scriptsOnSsh: new Set(),
  scriptsOnDb: new Set(),
});
const dbSkillSpec = makeSpec({
  skillId: "db-skill-id",
  name: "db-skill",
  description: "A skill with SQL reports",
  scriptsOnSsh: new Set(),
  scriptsOnDb: new Set(["scripts/reports/sales.sql"]),
});

const specs: SkillSpec[] = [sshSkillSpec, pythonSshSpec, sandboxSkillSpec];

/**
 * CONTRACT: tools capture `getDbSkillStorage()` at build time (same as the
 * production wiring), so every tool instance must be constructed AFTER the
 * storage mock is installed — i.e. inside a hook, never in the describe body.
 */
type ToolLike = {
  name: string;
  execute: (
    args: Record<string, unknown>,
    ctx?: { abortSignal?: AbortSignal },
  ) => Promise<Record<string, unknown>>;
};

function buildRunTime(hasSshBindings: boolean) {
  const runtime = buildSkillsRuntime({
    specs,
    hasSshBindings,
  });
  return {
    runSkillScript: runtime.tools.find(
      (t) => t.name === "run_skill_script",
    ) as unknown as ToolLike,
    promptBlock: runtime.promptBlock,
  };
}

let withHost: ReturnType<typeof buildRunTime>;
let withoutHost: ReturnType<typeof buildRunTime>;
let runOnSsh: ToolLike;

beforeEach(() => {
  vi.mocked(getDbSkillStorage).mockReturnValue(mockStorage as never);
  mockStorage.readFile.mockReset();
  mockRunOnBoundServer.mockReset();
  withHost = buildRunTime(true);
  withoutHost = buildRunTime(false);
  runOnSsh = buildRunSkillScriptOnSshTool({
    specs,
    agentSshServerIds: ["server-1"],
  }) as unknown as ToolLike;
});

describe("run_skill_script — scripts-on-ssh routing", () => {
  it("refuses an SSH-declared script with SSH_SCRIPT when the SSH tool is mounted", async () => {
    const result = await withHost.runSkillScript.execute({
      name: "ssh-skill",
      filename: "probe.sh",
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBe("SSH_SCRIPT");
    expect(result.message).toContain("use run_skill_script_on_ssh instead");
    // Never touches storage or the sandbox on a routing refusal.
    expect(mockStorage.readFile).not.toHaveBeenCalled();
  });

  it("accepts bare filename and scripts/-prefixed filename alike", async () => {
    const prefixed = await withHost.runSkillScript.execute({
      name: "ssh-skill",
      filename: "scripts/probe.sh",
    });
    expect(prefixed.error).toBe("SSH_SCRIPT");
  });

  // Regression: the refusal used to point at run_skill_script_on_ssh even when
  // no ssh_server was bound and the tool was therefore not mounted, leaving the
  // model with two refusing tools and no way forward.
  it("refuses with SSH_NOT_AVAILABLE and an actionable hint when no host is bound", async () => {
    const result = await withoutHost.runSkillScript.execute({
      name: "ssh-skill",
      filename: "probe.sh",
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBe("SSH_NOT_AVAILABLE");
    expect(result.message).toContain("no ssh_server bound");
    expect(result.message).toContain("Bind an SSH host");
    expect(result.message).not.toContain("use run_skill_script_on_ssh instead");
  });

  it("still refuses in the sandbox when no host is bound (no silent downgrade)", async () => {
    const result = await withoutHost.runSkillScript.execute({
      name: "ssh-skill",
      filename: "probe.sh",
    });
    expect(mockStorage.readFile).not.toHaveBeenCalled();
    expect(result.error).not.toBe("SSH_SCRIPT");
  });

  it("lets a sandbox-declared script through the routing check", async () => {
    mockStorage.readFile.mockResolvedValue(null);
    const result = await withHost.runSkillScript.execute({
      name: "sandbox-skill",
      filename: "analyze.py",
    });

    // Past routing → reaches file resolution, which we made miss.
    expect(mockStorage.readFile).toHaveBeenCalledWith(
      "sandbox-skill-id",
      "scripts/analyze.py",
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Script not found");
  });

  it("refuses scripts outside scripts/ before touching storage", async () => {
    const result = await withHost.runSkillScript.execute({
      name: "sandbox-skill",
      filename: "bin/analyze.py",
    });

    expect(result.error).toBe("SCRIPT_OUTSIDE_SCRIPTS");
    expect(result.message).toContain("must live under scripts/");
    expect(mockStorage.readFile).not.toHaveBeenCalled();
  });

  it("rejects unsupported extensions before touching storage", async () => {
    const result = await withHost.runSkillScript.execute({
      name: "sandbox-skill",
      filename: "notes.txt",
    });
    expect(result.error).toContain("Unsupported");
    expect(mockStorage.readFile).not.toHaveBeenCalled();
  });
});

describe("buildSkillsRuntime — prompt block SSH annotations", () => {
  it("names run_skill_script_on_ssh only when the tool is mounted", () => {
    const mounted = buildSkillsRuntime({
      specs: [sshSkillSpec],
      hasSshBindings: true,
    });
    expect(mounted.promptBlock).toContain(
      "must use `run_skill_script_on_ssh(name, filename, serverName)`",
    );
    expect(mounted.promptBlock).toContain("(SSH scripts: probe.sh)");
    expect(mounted.promptBlock).not.toContain("not runnable");
  });

  it("marks SSH scripts as not runnable when no host is bound", () => {
    const unmounted = buildSkillsRuntime({ specs: [sshSkillSpec] });
    expect(unmounted.promptBlock).not.toContain("run_skill_script_on_ssh(");
    expect(unmounted.promptBlock).toContain(
      "(SSH scripts: probe.sh — require an SSH host bound to this agent; not runnable)",
    );
  });

  it("adds no SSH note for skills without scripts-on-ssh", () => {
    const runtime = buildSkillsRuntime({
      specs: [sandboxSkillSpec],
      hasSshBindings: true,
    });
    expect(runtime.promptBlock).not.toContain("SSH scripts:");
  });

  it("names run_skill_sql_script only when a data source is bound", () => {
    const mounted = buildSkillsRuntime({
      specs: [dbSkillSpec],
      hasDbBindings: true,
    });
    expect(mounted.promptBlock).toContain(
      "must use `run_skill_sql_script(name, filename, dataSourceName, datasetName)`",
    );
    expect(mounted.promptBlock).toContain(
      "(DB scripts: reports/sales.sql)",
    );
    expect(mounted.promptBlock).not.toContain("not runnable");
  });

  it("marks DB scripts as not runnable when no data source is bound", () => {
    const unmounted = buildSkillsRuntime({ specs: [dbSkillSpec] });
    expect(unmounted.promptBlock).not.toContain("run_skill_sql_script(");
    expect(unmounted.promptBlock).toContain(
      "(DB scripts: reports/sales.sql — require a data source bound to this agent; not runnable)",
    );
  });

  it("adds no DB note for skills without scripts-on-db", () => {
    const runtime = buildSkillsRuntime({
      specs: [sandboxSkillSpec],
      hasDbBindings: true,
    });
    expect(runtime.promptBlock).not.toContain("DB scripts:");
  });

  it("returns an empty runtime for no specs", () => {
    expect(buildSkillsRuntime({ specs: [] })).toEqual({
      tools: [],
      promptBlock: "",
    });
  });
});

describe("buildRunSkillScriptOnSshTool", () => {
  it("returns SKILL_NOT_FOUND for an unbound skill", async () => {
    const result = await runOnSsh.execute({
      name: "nope",
      filename: "probe.sh",
      serverName: "server-1",
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("SKILL_NOT_FOUND");
    expect(result.available).toEqual(["ssh-skill", "py-skill", "sandbox-skill"]);
  });

  it("returns NOT_AN_SSH_SCRIPT for a script missing from scripts-on-ssh", async () => {
    const result = await runOnSsh.execute({
      name: "sandbox-skill",
      filename: "test.sh",
      serverName: "server-1",
    });
    expect(result.error).toBe("NOT_AN_SSH_SCRIPT");
    expect(result.message).toContain("Use run_skill_script for sandbox scripts");
    expect(mockStorage.readFile).not.toHaveBeenCalled();
  });

  it("resolves a sub-directory path under scripts/", async () => {
    const nestedSpec = makeSpec({
      skillId: "nested-skill-id",
      name: "nested-skill",
      scriptsOnSsh: new Set(["scripts/lib/probe.sh"]),
      scriptsOnDb: new Set(),
    });
    const nestedTool = buildRunSkillScriptOnSshTool({
      specs: [nestedSpec],
      agentSshServerIds: ["server-1"],
    }) as unknown as ToolLike;
    mockStorage.readFile.mockResolvedValue({
      content: Buffer.from("echo nested"),
    });
    mockRunOnBoundServer.mockResolvedValue({ ok: true } as never);

    const result = await nestedTool.execute({
      name: "nested-skill",
      filename: "lib/probe.sh",
      serverName: "server-1",
    });

    expect(mockStorage.readFile).toHaveBeenCalledWith(
      "nested-skill-id",
      "scripts/lib/probe.sh",
    );
    expect(result.ok).toBe(true);
  });

  it("returns SCRIPT_NOT_FOUND when the script row is missing", async () => {
    mockStorage.readFile.mockResolvedValue(null);
    const result = await runOnSsh.execute({
      name: "ssh-skill",
      filename: "probe.sh",
      serverName: "server-1",
    });
    expect(result.error).toBe("SCRIPT_NOT_FOUND");
  });

  it("maps InvalidSkillPathError to SCRIPT_NOT_FOUND", async () => {
    mockStorage.readFile.mockRejectedValue(
      new InvalidSkillPathError("bad path"),
    );
    const result = await runOnSsh.execute({
      name: "ssh-skill",
      filename: "probe.sh",
      serverName: "server-1",
    });
    expect(result.error).toBe("SCRIPT_NOT_FOUND");
  });

  it("rethrows unexpected storage failures instead of swallowing them", async () => {
    mockStorage.readFile.mockRejectedValue(new Error("db down"));
    await expect(
      runOnSsh.execute({
        name: "ssh-skill",
        filename: "probe.sh",
        serverName: "server-1",
      }),
    ).rejects.toThrow("db down");
  });

  it("rejects a script containing NUL bytes", async () => {
    mockStorage.readFile.mockResolvedValue({
      content: Buffer.from("echo hi\0there", "utf-8"),
    });
    const result = await runOnSsh.execute({
      name: "ssh-skill",
      filename: "probe.sh",
      serverName: "server-1",
    });
    expect(result.error).toBe("INVALID_SCRIPT_BYTES");
    expect(mockRunOnBoundServer).not.toHaveBeenCalled();
  });

  // Regression: Buffer.toString("utf-8") maps ill-formed bytes to U+FFFD and
  // never throws, so a GBK-encoded script used to execute as mojibake remotely.
  it("refuses a script whose bytes are not valid UTF-8", async () => {
    mockStorage.readFile.mockResolvedValue({
      content: Buffer.from([0x65, 0x63, 0x68, 0x6f, 0x20, 0xc4, 0xe3]),
    });
    const result = await runOnSsh.execute({
      name: "ssh-skill",
      filename: "probe.sh",
      serverName: "server-1",
    });

    expect(result).toEqual(
      expect.objectContaining({
        ok: false,
        error: "INVALID_SCRIPT_BYTES",
        message: expect.stringContaining("not valid UTF-8"),
      }),
    );
    expect(mockRunOnBoundServer).not.toHaveBeenCalled();
  });

  it("strips a leading BOM that bash and python3 both reject", async () => {
    mockStorage.readFile.mockResolvedValue({
      content: Buffer.concat([
        Buffer.from([0xef, 0xbb, 0xbf]),
        Buffer.from("echo hi\n", "utf-8"),
      ]),
    });
    mockRunOnBoundServer.mockResolvedValue({ ok: true, stdout: "hi" } as never);

    await runOnSsh.execute({
      name: "ssh-skill",
      filename: "probe.sh",
      serverName: "server-1",
    });

    expect(mockRunOnBoundServer.mock.calls[0][0].command).toContain("echo hi");
    expect(mockRunOnBoundServer.mock.calls[0][0].command).not.toContain("\ufeff");
  });

  // The cap is measured by runOnBoundServer on the composed wire command; this
  // layer only declares the budget and passes the verdict through.
  it("forwards the wire-length budget instead of measuring it locally", async () => {
    mockStorage.readFile.mockResolvedValue({
      content: Buffer.from("a".repeat(SSH_SKILL_SCRIPT_MAX_COMMAND_CHARS), "utf-8"),
    });
    mockRunOnBoundServer.mockResolvedValue({ ok: true, stdout: "" } as never);

    await runOnSsh.execute({
      name: "ssh-skill",
      filename: "probe.sh",
      serverName: "server-1",
    });

    expect(mockRunOnBoundServer.mock.calls[0][0].maxCommandChars).toBe(
      SSH_SKILL_SCRIPT_MAX_COMMAND_CHARS,
    );
  });

  it("returns COMMAND_TOO_LONG from the shared path unchanged", async () => {
    mockStorage.readFile.mockResolvedValue({
      content: Buffer.from("echo hi\n", "utf-8"),
    });
    mockRunOnBoundServer.mockResolvedValue({
      ok: false,
      error: "COMMAND_TOO_LONG",
      message: "Assembled SSH command is 20000 characters after login-shell wrapping",
    } as never);

    const result = await runOnSsh.execute({
      name: "ssh-skill",
      filename: "probe.sh",
      serverName: "server-1",
    });

    expect(result).toMatchObject({ ok: false, error: "COMMAND_TOO_LONG" });
  });

  // CONTRACT: .sh runs as `bash -c '<script>' '<skill>' <args...>` so $0 is the
  // skill name and $1.. are the caller args; .py runs as `python3 -c '<script>'
  // <args...>` so sys.argv[1:] are the caller args. Arguments are shell-quoted.
  it("assembles the bash command with the skill name as $0", async () => {
    mockStorage.readFile.mockResolvedValue({ content: Buffer.from("echo hi") });
    mockRunOnBoundServer.mockResolvedValue({ ok: true, stdout: "hi" } as never);

    await runOnSsh.execute({
      name: "ssh-skill",
      filename: "probe.sh",
      serverName: "server-1",
      args: ["-n", "value with spaces"],
    });

    expect(mockRunOnBoundServer).toHaveBeenCalledTimes(1);
    const call = mockRunOnBoundServer.mock.calls[0][0];
    expect(call.command).toBe(
      `bash -c 'echo hi' 'ssh-skill' '-n' 'value with spaces'`,
    );
    expect(call.serverName).toBe("server-1");
    expect(call.agentSshServerIds).toEqual(["server-1"]);
  });

  it("assembles the python command without a $0 slot", async () => {
    mockStorage.readFile.mockResolvedValue({
      content: Buffer.from("print('x')"),
    });
    mockRunOnBoundServer.mockResolvedValue({ ok: true, stdout: "x" } as never);

    await runOnSsh.execute({
      name: "py-skill",
      filename: "scripts/probe.py",
      serverName: "server-1",
      args: ["one"],
    });

    expect(mockRunOnBoundServer.mock.calls[0][0].command).toBe(
      `python3 -c 'print('\\''x'\\'')' 'one'`,
    );
  });

  it("omits trailing argument separators when no args are passed", async () => {
    mockStorage.readFile.mockResolvedValue({ content: Buffer.from("echo hi") });
    mockRunOnBoundServer.mockResolvedValue({ ok: true } as never);

    await runOnSsh.execute({
      name: "ssh-skill",
      filename: "probe.sh",
      serverName: "server-1",
    });

    expect(mockRunOnBoundServer.mock.calls[0][0].command).toBe(
      `bash -c 'echo hi' 'ssh-skill'`,
    );
    expect(mockRunOnBoundServer.mock.calls[0][0].timeoutSeconds).toBeUndefined();
  });

  it("escapes single quotes in script bytes and args", async () => {
    mockStorage.readFile.mockResolvedValue({
      content: Buffer.from("echo it's", "utf-8"),
    });
    mockRunOnBoundServer.mockResolvedValue({ ok: true } as never);

    await runOnSsh.execute({
      name: "ssh-skill",
      filename: "probe.sh",
      serverName: "server-1",
      args: ["don't"],
    });

    const { command } = mockRunOnBoundServer.mock.calls[0][0];
    expect(command).toContain(`'echo it'\\''s'`);
    expect(command).toContain(`'don'\\''t'`);
  });

  it("forwards timeoutSeconds and the abort signal", async () => {
    const controller = new AbortController();
    mockStorage.readFile.mockResolvedValue({ content: Buffer.from("echo hi") });
    mockRunOnBoundServer.mockResolvedValue({ ok: true } as never);

    await runOnSsh.execute(
      {
        name: "ssh-skill",
        filename: "probe.sh",
        serverName: "server-1",
        timeoutSeconds: 120,
      },
      { abortSignal: controller.signal },
    );

    const call = mockRunOnBoundServer.mock.calls[0][0];
    expect(call.timeoutSeconds).toBe(120);
    expect(call.signal).toBe(controller.signal);
  });

  it("returns the exec envelope plus audit identity on success", async () => {
    const content = Buffer.from("echo hello");
    mockStorage.readFile.mockResolvedValue({ content });
    mockRunOnBoundServer.mockResolvedValue({
      ok: true,
      serverName: "prod-01",
      host: "10.0.0.5",
      stdout: "hello\n",
      stderr: "",
      exitCode: 0,
      signal: null,
      durationMs: 42,
      truncated: false,
    } as never);

    const result = await runOnSsh.execute({
      name: "ssh-skill",
      filename: "probe.sh",
      serverName: "prod-01",
    });

    expect(result).toEqual({
      ok: true,
      skill: "ssh-skill",
      script: "scripts/probe.sh",
      scriptSha256: createHash("sha256").update(content).digest("hex"),
      serverName: "prod-01",
      host: "10.0.0.5",
      stdout: "hello\n",
      stderr: "",
      exitCode: 0,
      signal: null,
      durationMs: 42,
      truncated: false,
    });
  });

  it("passes a failed runOnBoundServer result through untouched", async () => {
    mockStorage.readFile.mockResolvedValue({ content: Buffer.from("echo hi") });
    const failure = {
      ok: false,
      error: "POLICY_DENIED",
      message: "Denied by denylist",
      matchedPattern: "rm\\s+-rf",
    };
    mockRunOnBoundServer.mockResolvedValue(failure as never);

    const result = await runOnSsh.execute({
      name: "ssh-skill",
      filename: "probe.sh",
      serverName: "server-1",
    });

    expect(result).toEqual(failure);
  });

  it("validates argument shapes before doing any work", async () => {
    mockStorage.readFile.mockResolvedValue({ content: Buffer.from("echo hi") });
    await expect(
      runOnSsh.execute({
        name: "ssh-skill",
        filename: "probe.sh",
        serverName: "server-1",
        timeoutSeconds: 999,
      }),
    ).rejects.toThrow();
    expect(mockStorage.readFile).not.toHaveBeenCalled();
  });
});
