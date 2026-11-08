/**
 * Bundled portable PostgreSQL 18 lifecycle manager for Nango Desktop.
 *
 * Responsibilities:
 * - First-boot `initdb` initialization with SCRAM-SHA-256 authentication
 * - `PG_VERSION` major version check (guards against incompatible data dirs)
 * - Stale `postmaster.pid` recovery after power loss or forced OS reboot
 * - Readiness polling via `pg_isready` and `nango` database creation
 * - Crash supervision with exponential backoff (1s -> 2s -> 4s, max 3 retries)
 * - Graceful `pg_ctl stop -D <pgdata> -m fast` shutdown
 *
 * See docs/desktop-architecture.md.
 */

import { execFile, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const EXPECTED_PG_MAJOR_VERSION = "18";
export const MAX_PG_CRASH_RESTARTS = 3;

/**
 * Parse the postmaster PID from the first line of a PostgreSQL `postmaster.pid` file.
 */
export function parsePostmasterPid(content: string): number | null {
  const firstLine = content.split(/\r?\n/, 1)[0]?.trim() ?? "";
  if (!/^\d+$/.test(firstLine)) return null;
  const pid = Number.parseInt(firstLine, 10);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

/**
 * Check whether an OS process with `pid` is currently alive.
 */
export function defaultIsPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code =
      err && typeof err === "object" && "code" in err
        ? (err as { code?: string }).code
        : undefined;
    // EPERM means the process exists but belongs to another user.
    return code === "EPERM";
  }
}

/**
 * Inspect `<pgDataDir>/postmaster.pid` before starting PostgreSQL.
 *
 * - If the file does not exist, returns `false`.
 * - If the recorded PID is no longer alive (stale lock from a power loss),
 *   deletes `postmaster.pid` and returns `true`.
 * - If the recorded PID is still alive, throws an error to prevent two
 *   postmaster processes from corrupting the same data directory.
 */
export function cleanStalePostmasterPid(
  pgDataDir: string,
  isPidAlive: (pid: number) => boolean = defaultIsPidAlive,
): boolean {
  const pidFilePath = path.join(pgDataDir, "postmaster.pid");
  if (!fs.existsSync(pidFilePath)) {
    return false;
  }

  const content = fs.readFileSync(pidFilePath, "utf8");
  const pid = parsePostmasterPid(content);

  if (pid !== null && isPidAlive(pid)) {
    throw new Error(
      `PostgreSQL postmaster (PID ${pid}) is already running for data directory "${pgDataDir}".`,
    );
  }

  fs.rmSync(pidFilePath, { force: true });
  return true;
}

/**
 * Verify that `<pgDataDir>/PG_VERSION` matches the bundled PostgreSQL major version.
 */
export function verifyPgVersion(
  pgDataDir: string,
  expectedMajor: string = EXPECTED_PG_MAJOR_VERSION,
): void {
  const versionFile = path.join(pgDataDir, "PG_VERSION");
  if (!fs.existsSync(versionFile)) {
    throw new Error(
      `Missing PG_VERSION in "${pgDataDir}". Data directory is not initialized.`,
    );
  }

  const rawVersion = fs.readFileSync(versionFile, "utf8").trim();
  const major = rawVersion.split(".")[0] ?? "";
  if (major !== expectedMajor) {
    throw new Error(
      `Incompatible PostgreSQL data directory version in "${pgDataDir}": found PG_VERSION=${rawVersion}, expected ${expectedMajor}.`,
    );
  }
}

export interface PostgresManagerOptions {
  /** Directory containing bundled `postgres`, `initdb`, `pg_ctl`, `pg_isready`, `createdb` binaries. */
  pgBinDir: string;
  /** Writable `<userData>/pgdata` directory. */
  pgDataDir: string;
  /** Loopback port allocated by `port-finder.ts`. */
  pgPort: number;
  /** Database superuser name (default `"nango"`). */
  pgUser?: string;
  /** Database password from `keyring.ts`. */
  pgPassword: string;
  /** Application database name (default `"nango"`). */
  pgDatabase?: string;
  /** Optional callback invoked when consecutive crash restarts are exhausted. */
  onFatalExit?: (err: Error) => void;
}

export class PostgresManager {
  private readonly pgBinDir: string;
  private readonly pgDataDir: string;
  private readonly pgPort: number;
  private readonly pgUser: string;
  private readonly pgPassword: string;
  private readonly pgDatabase: string;
  private readonly onFatalExit?: (err: Error) => void;

  private proc: ChildProcess | null = null;
  private stopping = false;
  private consecutiveCrashes = 0;
  private newlyInitialized = false;

  constructor(opts: PostgresManagerOptions) {
    this.pgBinDir = opts.pgBinDir;
    this.pgDataDir = opts.pgDataDir;
    this.pgPort = opts.pgPort;
    this.pgUser = opts.pgUser ?? "nango";
    this.pgPassword = opts.pgPassword;
    this.pgDatabase = opts.pgDatabase ?? "nango";
    this.onFatalExit = opts.onFatalExit;
  }

  private binPath(name: string): string {
    const ext = process.platform === "win32" ? ".exe" : "";
    return path.join(this.pgBinDir, `${name}${ext}`);
  }

  /**
   * Initialize `<pgDataDir>` with `initdb` if `PG_VERSION` does not exist yet,
   * then validate `PG_VERSION`.
   */
  async ensureInitialized(): Promise<void> {
    const versionFile = path.join(this.pgDataDir, "PG_VERSION");
    if (!fs.existsSync(versionFile)) {
      fs.mkdirSync(this.pgDataDir, { recursive: true });
      const pwFilePath = path.join(
        path.dirname(this.pgDataDir),
        `.pgpass.init.${process.pid}`,
      );
      try {
        // SECURITY: Write password to a mode-0600 temporary file rather than
        // passing it on the command line where `ps` could observe it.
        fs.writeFileSync(pwFilePath, `${this.pgPassword}\n`, {
          encoding: "utf8",
          mode: 0o600,
        });
        await execFileAsync(this.binPath("initdb"), [
          "-D",
          this.pgDataDir,
          "-U",
          this.pgUser,
          "--auth-host=scram-sha-256",
          "--auth-local=trust",
          "--encoding=UTF8",
          "--no-locale",
          `--pwfile=${pwFilePath}`,
        ]);
        this.newlyInitialized = true;
      } finally {
        fs.rmSync(pwFilePath, { force: true });
      }
    }

    verifyPgVersion(this.pgDataDir, EXPECTED_PG_MAJOR_VERSION);
  }

  /**
   * Start the PostgreSQL daemon, wait for `pg_isready`, and ensure the
   * target database (`nango`) exists.
   */
  async start(): Promise<void> {
    this.stopping = false;
    await this.ensureInitialized();
    cleanStalePostmasterPid(this.pgDataDir);

    await this.spawnAndWaitReady();

    if (this.newlyInitialized) {
      await this.ensureDatabaseCreated();
      this.newlyInitialized = false;
    }
  }

  private async spawnAndWaitReady(): Promise<void> {
    const postgresBin = this.binPath("postgres");
    const child = spawn(
      postgresBin,
      [
        "-D",
        this.pgDataDir,
        "-h",
        "127.0.0.1",
        "-p",
        String(this.pgPort),
      ],
      {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    this.proc = child;

    child.on("exit", (code, signal) => {
      this.proc = null;
      if (this.stopping) return;
      void this.handleUnexpectedExit(code, signal);
    });

    await this.waitForReady(15_000);
    this.consecutiveCrashes = 0;
  }

  private async waitForReady(timeoutMs: number): Promise<void> {
    const pgIsReadyBin = this.binPath("pg_isready");
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      try {
        await execFileAsync(
          pgIsReadyBin,
          ["-h", "127.0.0.1", "-p", String(this.pgPort), "-U", this.pgUser],
          { timeout: 2_000 },
        );
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 250));
      }
    }

    throw new Error(
      `PostgreSQL did not become ready on 127.0.0.1:${this.pgPort} within ${timeoutMs}ms.`,
    );
  }

  private async ensureDatabaseCreated(): Promise<void> {
    const createdbBin = this.binPath("createdb");
    try {
      await execFileAsync(
        createdbBin,
        [
          "-h",
          "127.0.0.1",
          "-p",
          String(this.pgPort),
          "-U",
          this.pgUser,
          this.pgDatabase,
        ],
        {
          env: {
            ...process.env,
            PGPASSWORD: this.pgPassword,
          },
          timeout: 10_000,
        },
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes("already exists")) {
        throw err;
      }
    }
  }

  private async handleUnexpectedExit(
    code: number | null,
    signal: NodeJS.Signals | null,
  ): Promise<void> {
    this.consecutiveCrashes += 1;
    if (this.consecutiveCrashes > MAX_PG_CRASH_RESTARTS) {
      const fatal = new Error(
        `PostgreSQL exited unexpectedly (${this.consecutiveCrashes} consecutive crashes; last code=${String(code)}, signal=${String(signal)}).`,
      );
      this.onFatalExit?.(fatal);
      return;
    }

    const backoffMs = 1_000 * Math.pow(2, this.consecutiveCrashes - 1);
    await new Promise((r) => setTimeout(r, backoffMs));
    if (this.stopping) return;

    try {
      cleanStalePostmasterPid(this.pgDataDir);
      await this.spawnAndWaitReady();
    } catch (err) {
      this.onFatalExit?.(
        err instanceof Error ? err : new Error(String(err)),
      );
    }
  }

  /**
   * Gracefully stop the PostgreSQL server via `pg_ctl stop -D <pgDataDir> -m fast`.
   */
  async stop(): Promise<void> {
    this.stopping = true;
    const pgCtlBin = this.binPath("pg_ctl");

    try {
      await execFileAsync(
        pgCtlBin,
        ["stop", "-D", this.pgDataDir, "-m", "fast", "-w", "-t", "10"],
        { timeout: 12_000 },
      );
    } catch {
      if (this.proc && this.proc.pid) {
        try {
          this.proc.kill("SIGTERM");
        } catch {
          // Process already exited
        }
      }
    } finally {
      this.proc = null;
    }
  }
}
