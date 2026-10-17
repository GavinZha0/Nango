/**
 * Server-side SSH agent tools: `run_ssh_command` and `list_ssh_hosts`.
 *
 * See docs/ssh.md.
 */

import "server-only";

import { z } from "zod";

import { defineTool } from "@/lib/copilot/index.server";
import type { ToolDefinition } from "@/lib/copilot/index.server";

import { composeWireCommand, execOnServer, SshError } from "./client";
import { listSshServersByIds, resolveSshServerByName } from "./lookup";
import { evaluateCommandPolicy } from "./policy";

// run_ssh_command

const RunSshArgs = z.object({
  serverName: z
    .string()
    .min(1)
    .describe(
      "Slug of the ssh_server to target (the row's `name`). Call list_ssh_hosts() if unknown.",
    ),
  command: z
    .string()
    .min(1)
    .max(8000)
    .describe(
      "Single shell command to execute. Runs as the server's configured user.",
    ),
  // SECONDS, not milliseconds — the field is named explicitly so the
  // LLM does not default to its OpenSSH / setTimeout intuition.
  // Project convention: external surfaces are unitless seconds;
  // internal vars carry the `Ms` suffix.
  timeoutSeconds: z
    .number()
    .int()
    .min(1)
    .max(300)
    .optional()
    .describe(
      "Wall-clock timeout in SECONDS (integer 1-300). NOT milliseconds. " +
        "Default is 30 seconds.",
    ),
});

// CONTRACT: Only applies to run_skill_script_on_ssh (reviewed script bytes),
// NOT to run_ssh_command (LLM-authored commands, capped at 8000 at the input).
// Measured against the *composed* wire command — see
// `RunOnBoundServerOpts.maxCommandChars`.
export const SSH_SKILL_SCRIPT_MAX_COMMAND_CHARS = 16_000;

export interface RunOnBoundServerOpts {
  serverName: string;
  command: string;
  timeoutSeconds?: number;
  agentSshServerIds: readonly string[];
  /**
   * Hard cap on the string that actually reaches `sshd`. Login-shell hosts
   * re-quote the whole command (`'` → `'\''`), so a caller that measures its
   * own pre-wrapped string under-reports. Left unset when the caller's cap is
   * about input size rather than wire size.
   */
  maxCommandChars?: number;
  signal?: AbortSignal;
}

export type RunOnBoundServerResult =
  | {
      ok: true;
      serverName: string;
      host: string;
      stdout: string;
      stderr: string;
      exitCode: number | null;
      signal: string | null;
      durationMs: number;
      truncated: boolean;
    }
  | {
      ok: false;
      error: string;
      message: string;
      matchedPattern?: string;
    };

/**
 * Execute a command on an SSH server after resolving by name, checking
 * agent binding, and evaluating command allow/deny policies.
 * Shared by `run_ssh_command` and `run_skill_script_on_ssh`.
 */
export async function runOnBoundServer(
  opts: RunOnBoundServerOpts,
): Promise<RunOnBoundServerResult> {
  const allowedIds = new Set(opts.agentSshServerIds);

  const lookup = await resolveSshServerByName(opts.serverName);
  if (!lookup.ok) {
    return { ok: false, error: lookup.error, message: lookup.message };
  }
  const server = lookup.resolved;

  // SECURITY: only servers EXPLICITLY bound to this agent can be
  // targeted. Without this check, knowledge of any server slug
  // would let one agent reach into another's hosts.
  if (!allowedIds.has(server.id)) {
    return {
      ok: false,
      error: "NOT_BOUND",
      message:
        `SSH server '${opts.serverName}' exists but is not bound to ` +
        "this agent. Bind it via the agent editor, then retry.",
    };
  }

  // Policy gate — checked BEFORE we reach out to the host so a
  // denied command never opens an SSH channel. `commandAllow` is
  // null when unconstrained; non-null arrays are evaluated per
  // `lib/ssh/policy.ts`. `commandDeny` always wins on a match.
  const decision = evaluateCommandPolicy(
    opts.command,
    server.commandAllow,
    server.commandDeny,
  );
  if (!decision.allowed) {
    return {
      ok: false,
      error: "POLICY_DENIED",
      message: decision.reason ?? "Command rejected by ssh_server policy.",
      ...(decision.matchedPattern
        ? { matchedPattern: decision.matchedPattern }
        : {}),
    };
  }

  // Length gate on the string that actually reaches sshd. Measured here, not
  // by the caller, because a login-shell host re-quotes the whole command and
  // a caller that measures its own pre-wrapped string under-reports.
  if (opts.maxCommandChars !== undefined) {
    const wireLength = composeWireCommand(opts.command, server.loginShell).length;
    if (wireLength > opts.maxCommandChars) {
      return {
        ok: false,
        error: "COMMAND_TOO_LONG",
        message:
          `Assembled SSH command is ${wireLength} characters` +
          (server.loginShell
            ? " after login-shell wrapping"
            : "") +
          `, exceeding the maximum of ${opts.maxCommandChars}. ` +
          "Shorten the script or split the run.",
      };
    }
  }

  try {
    const result = await execOnServer(
      {
        host: server.host,
        port: server.port,
        knownHostFingerprint: server.knownHostFingerprint,
        loginShell: server.loginShell,
      },
      server.auth,
      opts.command,
      {
        // Convert seconds → ms at the boundary; internals stay
        // millisecond-typed throughout (project convention).
        timeoutMs:
          opts.timeoutSeconds != null
            ? opts.timeoutSeconds * 1000
            : undefined,
        signal: opts.signal,
      },
    );
    return {
      ok: true,
      serverName: server.name,
      host: server.host,
      // SECURITY: no `username` field on purpose. The OS user is
      // part of the credential payload, which must not reach the
      // LLM. If the agent needs to know who it ran as, `whoami`
      // returns it via the same exec channel.
      ...result,
    };
  } catch (err) {
    if (err instanceof SshError) {
      return {
        ok: false,
        error: err.code,
        message: err.message,
      };
    }
    throw err;
  }
}

/**
 * Build the `run_ssh_command` tool definition. Bound agent ids are
 * passed in so the tool can refuse calls against a server the agent
 * is NOT bound to — same pattern as `extract_dataset_by_sql`.
 */
export function buildRunSshCommandTool(opts: {
  agentSshServerIds: readonly string[];
}): ToolDefinition {
  return defineTool({
    name: "run_ssh_command",
    description:
      "Execute a single shell command on a remote SSH host. Pass " +
      "`serverName` (the ssh_server's slug — see list_ssh_hosts) and " +
      "the shell command. Optional `timeoutSeconds` is in SECONDS " +
      "(NOT milliseconds), integer 1-300, default 30. Returns " +
      "{ stdout, stderr, exitCode, signal, durationMs, truncated }. " +
      "By default the command runs in a login bash (`bash -lc`) so " +
      "the host's profile scripts (`/etc/profile`, " +
      "`~/.bash_profile`, `/etc/profile.d/*.sh`) are sourced — same " +
      "`PATH` / env as an interactive SSH session. The command runs " +
      "as the server's configured user; per-server allow / deny " +
      "patterns may reject the call before it reaches the host " +
      "(`error: 'POLICY_DENIED'`). Output is capped at " +
      "SSH_EXEC_MAX_OUTPUT_BYTES (default 1 MiB per stream); " +
      "exceeding sets `truncated: true`.",
    parameters: RunSshArgs,
    execute: async (rawArgs, ctx?: { abortSignal?: AbortSignal }) => {
      const args = RunSshArgs.parse(rawArgs);
      return runOnBoundServer({
        serverName: args.serverName,
        command: args.command,
        timeoutSeconds: args.timeoutSeconds,
        agentSshServerIds: opts.agentSshServerIds,
        signal: ctx?.abortSignal,
      });
    },
  });
}

// list_ssh_hosts

const ListSshArgs = z.object({});

/**
 * Build the `list_ssh_hosts` tool definition. Returns only servers
 * bound to this agent — auth blobs are NOT loaded (just the public
 * connection metadata).
 */
export function buildListSshHostsTool(opts: {
  agentSshServerIds: readonly string[];
}): ToolDefinition {
  const ids = [...opts.agentSshServerIds];
  return defineTool({
    name: "list_ssh_hosts",
    description:
      "List the SSH hosts bound to this agent. Returns " +
      "[{ name, host, port, description }]. Pass `name` as the " +
      "`serverName` argument to run_ssh_command.",
    parameters: ListSshArgs,
    execute: async () => {
      const hosts = await listSshServersByIds(ids);
      return { hosts };
    },
  });
}
