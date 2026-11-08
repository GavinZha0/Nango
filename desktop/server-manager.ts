/**
 * Bundled Node 24 LTS migration runner and Next.js standalone (`server.js`)
 * supervisor for Nango Desktop.
 *
 * Responsibilities:
 * - Ensure all writable desktop directories exist under `userData` and `Documents/NangoWorkspace`
 * - Assemble the desktop environment variables (without leaking raw host secrets to untrusted children)
 * - Execute `docker/migrate.mjs` idempotently before booting Next.js
 * - Supervise `.next/standalone/server.js` with readiness probing and exponential backoff crash recovery
 * - Gracefully terminate `server.js` on shutdown so `instrumentation.ts` reaps all `stdio` MCP trees
 *
 * See docs/desktop-architecture.md.
 */

import { execFile, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { DesktopSecrets } from "./keyring";

const execFileAsync = promisify(execFile);

export const MAX_SERVER_CRASH_RESTARTS = 3;

export interface DesktopWritableDirs {
  workspaceDir: string;
  datasourceCacheDir: string;
  playwrightStorageDir: string;
  logsDir: string;
}

/**
 * Create all writable runtime directories required by Nango Desktop before
 * `server.js` boots.
 */
export function ensureDesktopWritableDirs(input: {
  userDataDir: string;
  workspaceDir: string;
}): DesktopWritableDirs {
  const datasourceCacheDir = path.join(input.userDataDir, "cache", "datasource");
  const playwrightStorageDir = path.join(input.userDataDir, "cache", "playwright");
  const logsDir = path.join(input.userDataDir, "logs");

  fs.mkdirSync(input.workspaceDir, { recursive: true });
  fs.mkdirSync(datasourceCacheDir, { recursive: true });
  fs.mkdirSync(playwrightStorageDir, { recursive: true });
  fs.mkdirSync(logsDir, { recursive: true });

  return {
    workspaceDir: input.workspaceDir,
    datasourceCacheDir,
    playwrightStorageDir,
    logsDir,
  };
}

export interface DesktopServerEnvInput {
  appPort: number;
  pgPort: number;
  betterAuthUrl: string;
  secrets: DesktopSecrets;
  userDataDir: string;
  workspaceDir: string;
  bundledNodeExe: string;
  bundledNodeBinDir: string;
  bundledPlaywrightMcpCli?: string;
  duckdbExtensionDir?: string;
  pgUser?: string;
  pgDatabase?: string;
  baseEnv?: Record<string, string | undefined>;
}

/**
 * Build the complete environment map injected into `docker/migrate.mjs` and
 * `.next/standalone/server.js`.
 */
export function buildDesktopServerEnv(
  input: DesktopServerEnvInput,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    NODE_ENV: "production",
  };
  const sourceEnv = input.baseEnv ?? process.env;
  for (const [k, v] of Object.entries(sourceEnv)) {
    if (k !== "NODE_ENV" && typeof v === "string") {
      env[k] = v;
    }
  }

  const pgUser = input.pgUser ?? "nango";
  const pgDatabase = input.pgDatabase ?? "nango";

  env.NANGO_DESKTOP = "1";
  env.NANGO_ALLOW_STDIO_MCP = "true";
  env.HOSTNAME = "127.0.0.1";
  env.PORT = String(input.appPort);
  env.BETTER_AUTH_URL = input.betterAuthUrl;
  env.BETTER_AUTH_SECRET = input.secrets.betterAuthSecret;
  env.CREDENTIAL_ENCRYPTION_KEYRING = input.secrets.credentialEncryptionKeyring;

  env.POSTGRES_HOST = "127.0.0.1";
  env.POSTGRES_PORT = String(input.pgPort);
  env.POSTGRES_USER = pgUser;
  env.POSTGRES_PASSWORD = input.secrets.postgresPassword;
  env.POSTGRES_DB = pgDatabase;

  env.NANGO_PGDATA_DIR = path.join(input.userDataDir, "pgdata");
  env.NANGO_DEFAULT_HOST_FILE_ROOT = input.workspaceDir;
  env.NANGO_DEFAULT_CACHE_ROOT = path.join(
    input.userDataDir,
    "cache",
    "datasource",
  );
  env.NANGO_PLAYWRIGHT_STORAGE_DIR = path.join(
    input.userDataDir,
    "cache",
    "playwright",
  );

  env.NANGO_BUNDLED_NODE_EXE = input.bundledNodeExe;
  env.NANGO_BUNDLED_NODE_BIN_DIR = input.bundledNodeBinDir;

  if (input.bundledPlaywrightMcpCli) {
    env.NANGO_BUNDLED_PLAYWRIGHT_MCP_CLI = input.bundledPlaywrightMcpCli;
  }
  if (input.duckdbExtensionDir) {
    env.NANGO_DUCKDB_EXTENSION_DIR = input.duckdbExtensionDir;
  }

  return env;
}

/**
 * Compute exponential backoff delay in milliseconds (`1000`, `2000`, `4000`, ...).
 */
export function computeBackoffDelayMs(
  attempt: number,
  baseDelayMs: number = 1_000,
): number {
  const clamped = Math.max(1, Math.floor(attempt));
  return baseDelayMs * Math.pow(2, clamped - 1);
}

export interface ServerManagerOptions extends DesktopServerEnvInput {
  /** Root directory of the repaired Next.js standalone bundle (contains `server.js` and `docker/migrate.mjs`). */
  standaloneDir: string;
  /** Optional callback invoked when consecutive crash restarts are exhausted. */
  onFatalExit?: (err: Error) => void;
}

export class ServerManager {
  private readonly opts: ServerManagerOptions;
  private proc: ChildProcess | null = null;
  private stopping = false;
  private consecutiveCrashes = 0;

  constructor(opts: ServerManagerOptions) {
    this.opts = opts;
  }

  /**
   * Execute `docker/migrate.mjs` using the bundled Node 24 binary before
   * starting `server.js`.
   */
  async runMigrations(env: NodeJS.ProcessEnv): Promise<void> {
    const migrateScript = path.join(
      this.opts.standaloneDir,
      "docker",
      "migrate.mjs",
    );
    await execFileAsync(this.opts.bundledNodeExe, [migrateScript], {
      cwd: this.opts.standaloneDir,
      env,
      timeout: 60_000,
      windowsHide: true,
    });
  }

  /**
   * Ensure directories exist, run DB migrations, spawn `server.js`, and wait
   * until the HTTP server responds on `http://127.0.0.1:<appPort>`.
   */
  async start(): Promise<void> {
    this.stopping = false;
    ensureDesktopWritableDirs({
      userDataDir: this.opts.userDataDir,
      workspaceDir: this.opts.workspaceDir,
    });

    const env = buildDesktopServerEnv(this.opts);
    await this.runMigrations(env);
    await this.spawnAndWaitReady(env);
  }

  private async spawnAndWaitReady(env: NodeJS.ProcessEnv): Promise<void> {
    const serverScript = path.join(this.opts.standaloneDir, "server.js");
    const child = spawn(this.opts.bundledNodeExe, [serverScript], {
      cwd: this.opts.standaloneDir,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    this.proc = child;

    child.on("exit", (code, signal) => {
      this.proc = null;
      if (this.stopping) return;
      void this.handleUnexpectedExit(code, signal, env);
    });

    await this.waitForHttpReady(30_000);
    this.consecutiveCrashes = 0;
  }

  private async waitForHttpReady(timeoutMs: number): Promise<void> {
    const probeUrl = `http://127.0.0.1:${this.opts.appPort}/api/auth/get-session`;
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      try {
        const res = await fetch(probeUrl, {
          signal: AbortSignal.timeout(2_000),
        });
        if (res.status > 0) {
          return;
        }
      } catch {
        await new Promise((r) => setTimeout(r, 250));
      }
    }

    throw new Error(
      `Next.js standalone server did not become ready at ${probeUrl} within ${timeoutMs}ms.`,
    );
  }

  private async handleUnexpectedExit(
    code: number | null,
    signal: NodeJS.Signals | null,
    env: NodeJS.ProcessEnv,
  ): Promise<void> {
    this.consecutiveCrashes += 1;
    if (this.consecutiveCrashes > MAX_SERVER_CRASH_RESTARTS) {
      const fatal = new Error(
        `Next.js server exited unexpectedly (${this.consecutiveCrashes} consecutive crashes; last code=${String(code)}, signal=${String(signal)}).`,
      );
      this.opts.onFatalExit?.(fatal);
      return;
    }

    const delayMs = computeBackoffDelayMs(this.consecutiveCrashes);
    await new Promise((r) => setTimeout(r, delayMs));
    if (this.stopping) return;

    try {
      await this.spawnAndWaitReady(env);
    } catch (err) {
      this.opts.onFatalExit?.(
        err instanceof Error ? err : new Error(String(err)),
      );
    }
  }

  /**
   * Gracefully stop `server.js` (allowing `instrumentation.ts` shutdown hooks
   * to close `mcpProviderPool` and scheduler timers), force-killing after 5s.
   */
  async stop(): Promise<void> {
    this.stopping = true;
    const child = this.proc;
    if (!child || child.exitCode !== null) {
      this.proc = null;
      return;
    }

    await new Promise<void>((resolve) => {
      const killTimer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // Process already exited
        }
        resolve();
      }, 5_000);

      child.once("exit", () => {
        clearTimeout(killTimer);
        resolve();
      });

      try {
        child.kill("SIGTERM");
      } catch {
        clearTimeout(killTimer);
        resolve();
      }
    });

    this.proc = null;
  }
}
