/**
 * Local command execution engine powered by `execa` and `strip-ansi`.
 *
 * Enforces:
 *  1. Feature toggle (`host.shell.enabled`)
 *  2. Pre-execution command & working-directory guards (`.env`, secrets, registry)
 *  3. Strict environment allowlist (`extendEnv: false`)
 *  4. Cross-platform process-tree cleanup (`killDescendants: true`)
 *  5. Output ANSI stripping, secret redaction, and bounded truncation
 */

import "server-only";

import { execa } from "execa";
import stripAnsi from "strip-ansi";

import {
  getConfig,
  getConfigBoolean,
  getConfigMs,
  getConfigNumber,
} from "@/lib/config";
import { truncateMiddle } from "@/lib/sandbox/output";

import { killProcessTree } from "@/lib/mcp/stdio-spawn.server";

import {
  checkSensitiveCommand,
  validateLocalShellCwd,
  type ResolveCwdOptions,
} from "./command-guard.server";
import { buildSafeLocalEnv } from "./env.server";
import { redactShellOutput } from "./redact.server";
import { resolveShellInvocation } from "./shell-detect.server";
import {
  canStartBackgroundTask,
  registerBackgroundTask,
} from "./task-store.server";
import {
  LOCAL_SHELL_KINDS,
  type LocalShellKind,
  type RunLocalCommandArgs,
  type RunLocalCommandEnvelope,
} from "./schema";

const DEFAULT_TIMEOUT_SECONDS = 60;
const DEFAULT_MAX_OUTPUT_CHARS = 30_000;
const EXECA_MAX_BUFFER_BYTES = 10 * 1024 * 1024;
const FORCE_KILL_AFTER_DELAY_MS = 5_000;

/**
 * Returns whether local shell execution is enabled in the current runtime.
 * Defaults to true in Nango Desktop (`NANGO_DESKTOP=1`) and false in Docker.
 */
export function isLocalShellEnabled(): boolean {
  return getConfigBoolean("host.shell.enabled", process.env.NANGO_DESKTOP === "1");
}

function resolveDefaultShellKind(): LocalShellKind {
  const raw = getConfig("host.shell.default_shell", "auto").trim().toLowerCase();
  return (LOCAL_SHELL_KINDS as readonly string[]).includes(raw)
    ? (raw as LocalShellKind)
    : "auto";
}

export interface ExecuteLocalCommandOptions {
  abortSignal?: AbortSignal;
  /** Test seam overrides. */
  cwdOpts?: ResolveCwdOptions;
  /** Override parent env used for allowlist & redaction (tests). */
  sourceEnv?: Record<string, string | undefined>;
  /** Override `host.shell.enabled` check (tests). */
  forceEnabled?: boolean;
}

/**
 * Execute a non-interactive shell command on the local host.
 * CONTRACT: Never throws on command failure, timeout, cancellation, or guard
 * refusal — all failures return structured `RunLocalCommandEnvelope` values.
 */
export async function executeLocalCommand(
  args: RunLocalCommandArgs,
  opts: ExecuteLocalCommandOptions = {},
): Promise<RunLocalCommandEnvelope> {
  const enabled = opts.forceEnabled ?? isLocalShellEnabled();
  if (!enabled) {
    return {
      ok: false,
      error: "LOCAL_SHELL_DISABLED",
      message:
        "Local shell execution is disabled (`host.shell.enabled` is false). " +
        "An administrator can enable it in Admin → Config.",
    };
  }

  const guard = checkSensitiveCommand(args.command);
  if (!guard.allowed) {
    return {
      ok: false,
      error: "SENSITIVE_ACCESS_DENIED",
      rule: guard.rule,
      message: `${guard.reason} Do not attempt to read `.concat(
        "`.env` files, host credential stores, or sensitive environment variables.",
      ),
    };
  }

  const cwdResult = await validateLocalShellCwd(args.cwd, opts.cwdOpts);
  if (!cwdResult.ok) {
    return cwdResult;
  }

  const env = buildSafeLocalEnv({ sourceEnv: opts.sourceEnv });
  const shellKind = args.shell ?? resolveDefaultShellKind();
  const invocation = resolveShellInvocation(args.command, shellKind, { env });

  if (args.background) {
    if (!canStartBackgroundTask()) {
      return {
        ok: false,
        error: "TOO_MANY_TASKS",
        message:
          "Too many concurrent background local commands are running. " +
          "Stop an existing task with `stop_local_command` before starting another.",
      };
    }

    try {
      // QUIRK: On Windows, execa's `killDescendants: true` replaces
      // `subprocess.kill()` with `taskkill.exe` without a timeout fallback,
      // which can stall in restricted environments. Keep POSIX process-group
      // `killDescendants` enabled and let `stopBackgroundTask` combine bounded
      // `killProcessTree` + direct `subprocess.kill("SIGKILL")` on win32.
      const subprocess = execa(invocation.bin, invocation.args, {
        cwd: cwdResult.cwd,
        env,
        extendEnv: false,
        stdin: "ignore",
        all: true,
        buffer: false,
        reject: false,
        killDescendants: process.platform !== "win32",
        windowsHide: true,
        cleanup: true,
      });

      const { taskId, pid } = registerBackgroundTask({
        command: args.command,
        cwd: cwdResult.cwd,
        shell: invocation.resolvedShell,
        subprocess,
      });

      return {
        ok: true,
        background: true,
        taskId,
        pid,
        cwd: cwdResult.cwd,
        shell: invocation.resolvedShell,
        status: "running",
      };
    } catch (err) {
      return {
        ok: false,
        error: "EXEC_FAILED",
        message: `Failed to start background command: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  const timeoutMs =
    args.timeout_seconds !== undefined
      ? args.timeout_seconds * 1000
      : getConfigMs("host.shell.timeout", DEFAULT_TIMEOUT_SECONDS);
  const maxOutputChars = Math.max(
    500,
    Math.floor(getConfigNumber("host.shell.max_output_chars", DEFAULT_MAX_OUTPUT_CHARS)),
  );

  const startedAt = Date.now();
  try {
    const isWin = process.platform === "win32";
    const subprocess = execa(invocation.bin, invocation.args, {
      cwd: cwdResult.cwd,
      env,
      extendEnv: false,
      stdin: "ignore",
      all: true,
      reject: false,
      timeout: timeoutMs,
      forceKillAfterDelay: FORCE_KILL_AFTER_DELAY_MS,
      killDescendants: !isWin,
      cancelSignal: opts.abortSignal,
      maxBuffer: EXECA_MAX_BUFFER_BYTES,
      windowsHide: true,
      cleanup: true,
    });
    const childPid = subprocess.pid;
    const res = await subprocess;
    if (isWin && (res.timedOut || res.isCanceled || res.isMaxBuffer) && typeof childPid === "number" && childPid > 0) {
      await Promise.race([
        killProcessTree(childPid),
        new Promise((r) => setTimeout(r, 1_500)),
      ]);
    }

    const rawCombined =
      typeof res.all === "string"
        ? res.all
        : [res.stdout, res.stderr]
            .filter((part): part is string => typeof part === "string" && part.length > 0)
            .join("\n");

    const cleaned = stripAnsi(rawCombined);
    const redacted = redactShellOutput(cleaned, { sourceEnv: opts.sourceEnv });
    const truncated = redacted.length > maxOutputChars || res.isMaxBuffer;
    const output = truncateMiddle(redacted, maxOutputChars);

    const exitCode = typeof res.exitCode === "number" ? res.exitCode : null;
    const ok =
      !res.failed &&
      !res.timedOut &&
      !res.isCanceled &&
      !res.isMaxBuffer &&
      exitCode === 0;

    let errorMessage: string | undefined;
    if (res.timedOut) {
      errorMessage = `Command timed out after ${Math.round(timeoutMs / 1000)}s.`;
    } else if (res.isCanceled) {
      errorMessage = "Command was canceled.";
    } else if (res.isMaxBuffer) {
      errorMessage = `Command output exceeded the ${EXECA_MAX_BUFFER_BYTES} byte buffer cap and was terminated.`;
    } else if (!ok) {
      errorMessage =
        res.shortMessage ||
        (exitCode !== null ? `Command exited with code ${exitCode}.` : "Command failed.");
    }

    return {
      ok,
      background: false,
      cwd: cwdResult.cwd,
      shell: invocation.resolvedShell,
      exitCode,
      timedOut: res.timedOut,
      canceled: res.isCanceled,
      maxBufferExceeded: res.isMaxBuffer,
      durationMs: Math.round(res.durationMs ?? Date.now() - startedAt),
      output,
      truncated,
      ...(errorMessage ? { error: errorMessage } : {}),
    };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | null)?.code;
    if (code === "ENOENT") {
      return {
        ok: false,
        error: "SHELL_NOT_FOUND",
        message: `Shell executable "${invocation.bin}" was not found on this machine.`,
      };
    }
    return {
      ok: false,
      error: "EXEC_FAILED",
      message: `Local command failed to execute: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
