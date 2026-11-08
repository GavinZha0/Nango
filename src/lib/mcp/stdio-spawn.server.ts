/**
 * Stdio MCP client transport wrapper with process-tree cleanup and env isolation.
 *
 * See docs/desktop-architecture.md.
 */

import "server-only";

import { execFile } from "node:child_process";
import path from "node:path";
import readline from "node:readline";
import { Readable } from "node:stream";
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from "@modelcontextprotocol/client/stdio";

import type { McpServerEntity } from "@/lib/db/schema";
import { getCredentialFieldsById } from "@/lib/credentials/lookup";
import { getOAuthAccessToken } from "@/lib/credentials/oauth-token-manager";
import { childLogger, logger } from "@/lib/observability/logger";

export const DEFAULT_STDIO_CREDENTIAL_ENV_NAME = "MCP_API_KEY";

export interface StdioMcpTransportConfig {
  label: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

/**
 * SECURITY: Default-off in multi-tenant Docker deployments so container
 * editors/admins cannot spawn arbitrary child processes unless explicitly
 * opted in via `NANGO_ALLOW_STDIO_MCP=true` or running in desktop mode
 * (`NANGO_DESKTOP=1`).
 */
export function isStdioMcpAllowed(): boolean {
  const flag = process.env.NANGO_ALLOW_STDIO_MCP?.trim().toLowerCase();
  if (flag === "true" || flag === "1") return true;
  if (flag === "false" || flag === "0") return false;
  return process.env.NANGO_DESKTOP === "1";
}

/**
 * Resolve the credential token for a stdio MCP server and merge it into
 * the configured non-sensitive environment map.
 */
export async function buildMcpStdioEnv(
  server: Pick<
    McpServerEntity,
    "env" | "credentialId" | "credentialEnvName"
  >,
): Promise<Record<string, string>> {
  const resolved: Record<string, string> = { ...(server.env ?? {}) };
  if (!server.credentialId) return resolved;

  const envName =
    server.credentialEnvName?.trim() || DEFAULT_STDIO_CREDENTIAL_ENV_NAME;

  const cred = await getCredentialFieldsById(server.credentialId);
  if (cred === null) return resolved;

  if (cred.type === "oauth_client") {
    try {
      resolved[envName] = await getOAuthAccessToken(server.credentialId);
    } catch (err) {
      logger.error(
        {
          component: "mcp-stdio",
          event: "oauth_token_failed",
          credentialId: server.credentialId,
          err:
            err instanceof Error
              ? { message: err.message, name: err.name }
              : String(err),
        },
        "Failed to obtain OAuth access token for stdio MCP server",
      );
    }
    return resolved;
  }

  const raw: unknown =
    cred.fields.token ?? cred.fields.key ?? cred.fields.password;
  if (typeof raw === "string" && raw.length > 0) {
    resolved[envName] = raw;
  }
  return resolved;
}

/**
 * Assemble the final process environment passed to `StdioClientTransport`.
 *
 * SECURITY: Starts from `getDefaultEnvironment()` (safe OS variables only)
 * rather than `process.env` so server secrets (`CREDENTIAL_ENCRYPTION_KEYRING`,
 * `BETTER_AUTH_SECRET`, `POSTGRES_PASSWORD`) are never leaked to child MCP
 * processes.
 */
export function assembleSafeChildEnv(
  customEnv?: Record<string, string>,
): Record<string, string> {
  const baseEnv: Record<string, string> = {
    ...getDefaultEnvironment(),
  };

  // Prepend bundled Node binary directory when running inside Nango Desktop
  // so `node` / `npx` work on user machines that do not have Node installed.
  const bundledNodeBin = process.env.NANGO_BUNDLED_NODE_BIN_DIR?.trim();
  if (bundledNodeBin) {
    const pathKey =
      Object.keys(baseEnv).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
    const existingPath = baseEnv[pathKey] ?? "";
    baseEnv[pathKey] = existingPath
      ? `${bundledNodeBin}${path.delimiter}${existingPath}`
      : bundledNodeBin;
  }

  if (customEnv) {
    for (const [k, v] of Object.entries(customEnv)) {
      if (typeof v === "string") {
        baseEnv[k] = v;
      }
    }
  }

  return baseEnv;
}

/**
 * Terminate a process tree on Windows using `taskkill /PID <pid> /T /F`.
 */
function killWindowsProcessTree(pid: number): Promise<void> {
  return new Promise((resolve) => {
    execFile(
      "taskkill",
      ["/PID", String(pid), "/T", "/F"],
      { windowsHide: true },
      () => resolve(),
    );
  });
}

/**
 * List direct child PIDs of `parentPid` on POSIX (macOS / Linux) via `pgrep -P`.
 */
function listPosixChildPids(parentPid: number): Promise<number[]> {
  return new Promise((resolve) => {
    execFile("pgrep", ["-P", String(parentPid)], (err, stdout) => {
      if (err || !stdout) {
        resolve([]);
        return;
      }
      const pids = stdout
        .split(/\r?\n/)
        .map((line) => Number.parseInt(line.trim(), 10))
        .filter((n) => Number.isInteger(n) && n > 0);
      resolve(pids);
    });
  });
}

/**
 * Recursively collect all descendant PIDs bottom-up (grandchildren before children)
 * and terminate them on POSIX (macOS / Linux).
 */
async function killPosixProcessTree(
  rootPid: number,
  signal: NodeJS.Signals = "SIGTERM",
): Promise<number[]> {
  const visited = new Set<number>();
  const postOrder: number[] = [];

  async function walk(pid: number): Promise<void> {
    if (visited.has(pid)) return;
    visited.add(pid);
    const children = await listPosixChildPids(pid);
    for (const childPid of children) {
      await walk(childPid);
    }
    postOrder.push(pid);
  }

  await walk(rootPid);

  for (const pid of postOrder) {
    try {
      process.kill(pid, signal);
    } catch {
      // Ignore ESRCH if process already exited
    }
  }
  return postOrder;
}

/**
 * Cross-platform recursive process-tree termination for a spawned stdio MCP server.
 */
export async function killProcessTree(
  pid: number,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  if (!Number.isInteger(pid) || pid <= 0) return;
  if (platform === "win32") {
    await killWindowsProcessTree(pid);
    return;
  }
  await killPosixProcessTree(pid, "SIGTERM");
}

/**
 * Create a `StdioClientTransport` with stderr logging and recursive
 * process-tree termination on `close()`.
 */
export function createStdioTransport(
  cfg: StdioMcpTransportConfig,
): StdioClientTransport {
  const log = childLogger({ component: "mcp-stdio", label: cfg.label });
  const env = assembleSafeChildEnv(cfg.env);

  const transport = new StdioClientTransport({
    command: cfg.command,
    args: cfg.args ?? [],
    env,
    cwd: cfg.cwd?.trim() ? cfg.cwd.trim() : undefined,
    stderr: "pipe",
  });

  if (transport.stderr instanceof Readable) {
    const rl = readline.createInterface({
      input: transport.stderr,
      crlfDelay: Infinity,
    });
    rl.on("line", (line) => {
      const trimmed = line.trim();
      if (trimmed.length > 0) {
        log.warn({ event: "mcp_stdio_stderr", stderr: trimmed }, "MCP stdio stderr");
      }
    });
    rl.on("error", () => {
      // Ignore stream teardown errors on child exit.
    });
  }

  // QUIRK: `@modelcontextprotocol/client/stdio` uses `cross-spawn` without
  // process-group detachment. On Windows it wraps `.cmd` launchers (`npx`,
  // `pnpm`, `uvx`) in `cmd.exe /d /s /c`, and on macOS/Linux `npx`/`uvx`
  // spawn child `node` and browser processes. `StdioClientTransport.close()`
  // only sends SIGTERM to the top-level wrapper PID, stranding descendants.
  // Override `close()` to reap the entire descendant tree on both win32 and POSIX.
  const originalClose = transport.close.bind(transport);
  let closingPromise: Promise<void> | null = null;

  transport.close = (): Promise<void> => {
    if (closingPromise) return closingPromise;
    closingPromise = (async () => {
      const pid = transport.pid;
      let posixDescendants: number[] = [];
      if (typeof pid === "number" && pid > 0) {
        if (process.platform === "win32") {
          await killWindowsProcessTree(pid);
        } else {
          posixDescendants = await killPosixProcessTree(pid, "SIGTERM");
        }
      }
      await originalClose();
      if (posixDescendants.length > 0) {
        for (const childPid of posixDescendants) {
          try {
            process.kill(childPid, "SIGKILL");
          } catch {
            // Already exited
          }
        }
      }
    })();
    return closingPromise;
  };

  return transport;
}
