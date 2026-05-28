/**
 * Build the "Available SSH hosts" system-prompt block for an agent.
 */

import "server-only";

import { listSshServersByIds } from "./lookup";

export interface SshPromptBlock {
  /** The block itself, ready to concatenate into the system prompt
   *  with a leading newline; empty string when no usable servers are
   *  bound (caller should skip the concatenation entirely). */
  promptBlock: string;
}

/**
 * Build the prompt block from a set of ssh_server ids. Resolves
 * + filters in one DB read; safe to call once per dispatch.
 */
export async function buildSshHostsPromptBlock(
  sshServerIds: readonly string[],
): Promise<SshPromptBlock> {
  if (sshServerIds.length === 0) return { promptBlock: "" };

  const rows = await listSshServersByIds([...sshServerIds]);
  if (rows.length === 0) return { promptBlock: "" };

  const lines = rows.map((r) => {
    const desc = r.description ? ` — ${r.description}` : "";
    const restricted =
      r.commandAllow !== null || r.commandDeny.length > 0
        ? " [restricted]"
        : "";
    return `  - ${r.name} (${r.host}:${r.port})${restricted}${desc}`;
  });

  const intro =
    "Available SSH hosts (pass the slug as `serverName` to " +
    "run_ssh_command). Each host has a configured OS user — the " +
    "command runs as that user with FULL shell access on the host " +
    "(there is no remote sandbox). Hosts marked `[restricted]` " +
    "additionally enforce a per-server command allow / deny policy; " +
    "rejected calls come back with `error: 'POLICY_DENIED'` " +
    "(unrestricted hosts skip that gate). Treat this like an " +
    "authenticated terminal session: use it for diagnostics, log " +
    "inspection, controlled deploys; do NOT use it to mutate data you " +
    "cannot easily roll back. Output is captured (stdout, stderr, " +
    "exitCode) and may be truncated if very large.";

  return { promptBlock: `${intro}\n${lines.join("\n")}` };
}
