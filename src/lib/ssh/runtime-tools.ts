/**
 * Server-side SSH agent tools: `run_ssh_command` and `list_ssh_hosts`.
 */

import "server-only";

import { z } from "zod";

import { defineTool } from "@/lib/copilot/index.server";
import type { ToolDefinition } from "@/lib/copilot/index.server";

import { execOnServer, SshError } from "./client";
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
  // SECONDS, not milliseconds. The field is named explicitly to keep
  // the LLM from defaulting to its OpenSSH / setTimeout intuition.
  // @see docs/ssh.md (project convention: external surfaces are
  // unitless + seconds; internal vars carry `Ms` suffix; bridged by
  // getConfigMs).
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

/**
 * Build the `run_ssh_command` tool definition. Bound agent ids are
 * passed in so the tool can refuse calls against a server the agent
 * is NOT bound to — same pattern as `extract_dataset_by_sql`.
 */
export function buildRunSshCommandTool(opts: {
  agentSshServerIds: readonly string[];
}): ToolDefinition {
  const allowedIds = new Set(opts.agentSshServerIds);
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

      const lookup = await resolveSshServerByName(args.serverName);
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
            `SSH server '${args.serverName}' exists but is not bound to ` +
            "this agent. Bind it via the agent editor, then retry.",
        };
      }

      // Policy gate — checked BEFORE we reach out to the host so a
      // denied command never opens an SSH channel. `commandAllow` is
      // null when unconstrained; non-null arrays are evaluated per
      // `lib/ssh/policy.ts`. `commandDeny` always wins on a match.
      const decision = evaluateCommandPolicy(
        args.command,
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

      try {
        const result = await execOnServer(
          {
            host: server.host,
            port: server.port,
            knownHostFingerprint: server.knownHostFingerprint,
            loginShell: server.loginShell,
          },
          server.auth,
          args.command,
          {
            // Convert seconds → ms at the boundary; internals stay
            // millisecond-typed throughout (project convention).
            timeoutMs:
              args.timeoutSeconds != null
                ? args.timeoutSeconds * 1000
                : undefined,
            signal: ctx?.abortSignal,
          },
        );
        return {
          ok: true,
          serverName: server.name,
          host: server.host,
          // INTENTIONALLY no `username` field. The OS user is part
          // of the credential payload, and the security posture
          // (docs/ssh.md §4.1) guarantees credentials never reach
          // the LLM. If the agent needs to know the identity it
          // ran as, `whoami` returns it via the same exec channel.
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
