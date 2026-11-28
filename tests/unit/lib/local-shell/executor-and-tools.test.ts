import * as fs from "node:fs/promises";
import * as os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { evaluateToolRisk } from "@/lib/agent-pipeline/risk-registry";
import { buildBuiltinTools } from "@/lib/builtin-tools";
import { executeLocalCommand } from "@/lib/local-shell/executor.server";
import {
  _clearLocalShellTaskStore,
  readBackgroundTaskOutput,
  shutdownAllLocalShellTasks,
  stopBackgroundTask,
} from "@/lib/local-shell/task-store.server";

describe("local-shell executor & integration", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await shutdownAllLocalShellTasks();
    _clearLocalShellTaskStore();
    for (const dir of tempDirs.splice(0)) {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });

  async function makeWorkDir(): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "nango-local-shell-"));
    tempDirs.push(dir);
    return dir;
  }

  it("refuses execution when host.shell.enabled is false", async () => {
    const res = await executeLocalCommand(
      { command: "echo hi" },
      { forceEnabled: false },
    );
    expect(res.ok).toBe(false);
    if (!res.ok && "error" in res) {
      expect(res.error).toBe("LOCAL_SHELL_DISABLED");
    }
  });

  it("runs a real command, strips ANSI, and isolates parent secrets", async () => {
    const workDir = await makeWorkDir();
    const res = await executeLocalCommand(
      {
        command:
          'node -e "console.log(\'\\x1b[32mhello-nango\\x1b[0m\', \'SECRET=\' + (process.env.OPENAI_API_KEY || \'NONE\'))"',
      },
      {
        forceEnabled: true,
        cwdOpts: {
          hostFileRoot: workDir,
          allowAnyCwd: false,
          desktopUserDataDir: null,
          appRootDir: null,
        },
        sourceEnv: {
          ...process.env,
          OPENAI_API_KEY: "sk-must-not-leak-12345678901234567890",
        },
      },
    );

    expect(res.ok).toBe(true);
    if ("background" in res && !res.background) {
      expect(res.exitCode).toBe(0);
      expect(res.output).toContain("hello-nango");
      expect(res.output).toContain("SECRET=NONE");
      expect(res.output).not.toContain("\x1b[32m");
      expect(res.output).not.toContain("sk-must-not-leak");
    }
  });

  it("returns structured failure on non-zero exit code without throwing", async () => {
    const workDir = await makeWorkDir();
    const res = await executeLocalCommand(
      { command: 'node -e "console.error(\'boom\'); process.exit(7)"' },
      {
        forceEnabled: true,
        cwdOpts: {
          hostFileRoot: workDir,
          allowAnyCwd: false,
          desktopUserDataDir: null,
          appRootDir: null,
        },
      },
    );

    expect(res.ok).toBe(false);
    if ("background" in res && !res.background) {
      expect(res.exitCode).toBe(7);
      expect(res.output).toContain("boom");
    }
  });

  it("enforces timeout on long-running foreground commands", async () => {
    const workDir = await makeWorkDir();
    const res = await executeLocalCommand(
      {
        command: 'node -e "setTimeout(() => console.log(\'late\'), 10000)"',
        timeout_seconds: 1,
      },
      {
        forceEnabled: true,
        cwdOpts: {
          hostFileRoot: workDir,
          allowAnyCwd: false,
          desktopUserDataDir: null,
          appRootDir: null,
        },
      },
    );

    expect(res.ok).toBe(false);
    if ("background" in res && !res.background) {
      expect(res.timedOut).toBe(true);
    }
  }, 15_000);

  it("supports background task start, output read, and stop", async () => {
    const workDir = await makeWorkDir();
    const started = await executeLocalCommand(
      {
        command:
          'node -e "console.log(\'bg-ready\'); setInterval(() => {}, 1000)"',
        background: true,
      },
      {
        forceEnabled: true,
        cwdOpts: {
          hostFileRoot: workDir,
          allowAnyCwd: false,
          desktopUserDataDir: null,
          appRootDir: null,
        },
      },
    );

    expect(started.ok).toBe(true);
    if (!started.ok || !("background" in started) || !started.background) {
      throw new Error("Expected background task start");
    }

    // Wait briefly for stdout chunk to arrive
    let captured = "";
    for (let i = 0; i < 30; i += 1) {
      const polled = readBackgroundTaskOutput(started.taskId);
      if (polled.ok && polled.output.includes("bg-ready")) {
        captured = polled.output;
        break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(captured).toContain("bg-ready");

    const stopped = await stopBackgroundTask(started.taskId);
    expect(stopped.ok).toBe(true);
    if (stopped.ok) {
      expect(stopped.status).toBe("stopped");
    }
  }, 15_000);

  it("auto-mounts auxiliary background tools and evaluates tool risk accurately", () => {
    const tools = buildBuiltinTools(["run_local_command"]);
    const names = tools.map((t) => t.name);
    expect(names).toContain("run_local_command");
    expect(names).toContain("read_local_command_output");
    expect(names).toContain("stop_local_command");

    const normalRisk = evaluateToolRisk("run_local_command", {
      command: "git status",
    });
    expect(normalRisk.riskLevel).toBe("high");
    expect(normalRisk.requiresApproval).toBe(true);
    expect(normalRisk.headlessAllowed).toBe(false);

    const dangerousRisk = evaluateToolRisk("run_local_command", {
      command: "Remove-Item -Recurse -Force ./dist",
    });
    expect(dangerousRisk.riskLevel).toBe("critical");
    expect(dangerousRisk.sideEffects).toBe("destructive");

    const readRisk = evaluateToolRisk("read_local_command_output", {
      task_id: "cmd_123",
    });
    expect(readRisk.riskLevel).toBe("low");
    expect(readRisk.requiresApproval).toBe(false);
  });
});
