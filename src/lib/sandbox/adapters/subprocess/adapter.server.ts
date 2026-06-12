/**
 * SubprocessAdapter — degraded-mode sandbox backend.
 *
 * SECURITY POSTURE (read before changing `buildSpawnEnv`):
 *   This adapter spawns LLM-generated code as a child process WITHOUT
 *   a real filesystem / network / capability boundary. The one piece
 *   of meaningful isolation it does provide is `env` scrubbing — the
 *   child inherits ONLY an explicit allowlist (PATH, LANG, LC_ALL,
 *   HOME, TMPDIR, TZ, plus sandbox metadata and the optional venv
 *   overlay). All other variables — DB credentials, master keyring,
 *   provider API keys, BETTER_AUTH_SECRET — stay in the Node parent.
 *   Anyone weakening that allowlist (or restoring `...process.env`)
 *   re-opens the secret-leak channel; please use `local-docker`
 *   instead.
 *
 * See docs/sandbox.md.
 */

import "server-only";

import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { exec as execCb } from "node:child_process";

import type {
  ISandboxAdapter,
  SandboxInput,
  SandboxOutput,
} from "../../types";
import { processStderr, processStdout } from "../../output";
import { buildMapping, SANDBOX_DATA_DIR } from "../../path-mapper";
import {
  getConfig,
  getConfigMs,
  getConfigNumber,
  _isLoaded as isConfigLoaded,
  _cacheSize as configCacheSize,
} from "@/lib/config";

const exec = promisify(execCb);

const DEFAULT_TIMEOUT_S = 30;
const DEFAULT_MEMORY_MB = 256;
const RSS_POLL_MS = 500;

/** Hook for tests to inject a fake RSS reader; production reads via `ps`. */
export type RssReader = (pid: number) => Promise<number | null>;

let warned = false;
/** Per-process latch so a misconfigured venv path warns once, not per-call. */
const venvWarnedFor = new Set<string>();
/** One-shot diagnostic flag — emits a single trace of the resolver
 *  decision on the first sandbox call after process start. */
let venvTraceFired = false;

/** Resolve `sandbox.subprocess.python_path` config into an absolute
 *  venv layout. Accepts:
 *   - empty / unset → null (no venv injection; use system PATH)
 *   - `~/...`        → home-expanded
 *   - `.../bin/python(3)` → interpreter path; venv root inferred as
 *     `dirname(dirname(...))`
 *   - `.../venv-root`     → assumed venv root; bin dir is `<root>/bin`
 *
 *  Returns null on any resolution failure (missing python binary at
 *  the inferred location). The caller falls back to system PATH and
 *  emits a one-shot warning.
 */
export function resolvePythonVenv(
  configured: string,
  homeDir: string = os.homedir(),
): { venvRoot: string; binDir: string; pythonBin: string } | null {
  const trimmed = configured.trim();
  if (trimmed.length === 0) return null;

  let p = trimmed;
  if (p === "~") p = homeDir;
  else if (p.startsWith("~/")) p = path.join(homeDir, p.slice(2));

  // Did the user point at the interpreter itself, or at a venv root?
  const base = path.basename(p);
  let binDir: string;
  let venvRoot: string;
  if (base === "python" || base === "python3") {
    binDir = path.dirname(p);
    venvRoot = path.dirname(binDir);
  } else {
    venvRoot = p;
    binDir = path.join(p, "bin");
  }

  // Probe for an actual interpreter — prefer python3, fall back to python.
  const candidates = [path.join(binDir, "python3"), path.join(binDir, "python")];
  const pythonBin = candidates.find((c) => existsSync(c));
  if (!pythonBin) return null;

  return { venvRoot, binDir, pythonBin };
}

/**
 * Reads RSS in bytes from `ps`. Returns null on any failure (process
 * gone, ps missing, parse failure). Cross-platform within
 * macOS / Linux; falls back to null on Windows where `ps -o rss=` is
 * not available.
 */
const psRssReader: RssReader = async (pid) => {
  try {
    const { stdout } = await exec(`ps -o rss= -p ${pid}`);
    const kb = Number(stdout.trim());
    if (!Number.isFinite(kb)) return null;
    return kb * 1024;
  } catch {
    return null;
  }
};

export class SubprocessAdapter implements ISandboxAdapter {
  readonly backend = "subprocess" as const;
  readonly displayName = "Subprocess (degraded)";

  /** Test seam — production passes `psRssReader`. */
  constructor(private readonly readRss: RssReader = psRssReader) {}

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async run(input: SandboxInput): Promise<SandboxOutput> {
    if (!warned) {
      warned = true;
      console.warn(
        "[sandbox] running in DEGRADED mode (subprocess) — no security boundary. " +
          "Install Docker and set SANDBOX_MODE=local-docker for real isolation.",
      );
    }
    if (input.command.length === 0) {
      throw new Error("SandboxInput.command must not be empty.");
    }

    const startedAt = Date.now();

    // Per-call work directory. Always under os.tmpdir(); auto-cleaned.
    const tmpHostDir = await fs.mkdtemp(path.join(os.tmpdir(), "nango-sandbox-"));
    const mapping = buildMapping(tmpHostDir, input.datasets ?? []);

    try {
      // Expose declared datasets to the child via symlinks under
      // `<tmpHostDir>/<SANDBOX_DATA_DIR>/<name>` → `<cacheRoot>/
      // parquet/<name>/`. The child's cwd is `tmpHostDir`, so
      // `./data/<name>/...` resolves through the symlinks to the
      // real Parquet files in the shared cache — matching the
      // in-sandbox contract that the docker adapter realises via
      // bind mounts at `/work/data/<name>`.
      //
      // Symlinks are NOT chown'd / chmod'd read-only — subprocess
      // mode is "degraded" by design (no filesystem isolation), so
      // LLM-generated code can write back through the symlink and
      // pollute the shared cache. The `local-docker` backend is the
      // only mode that enforces read-only at the kernel level.
      if (
        mapping.datasetHostDirs &&
        Object.keys(mapping.datasetHostDirs).length > 0
      ) {
        const dataDir = path.join(tmpHostDir, SANDBOX_DATA_DIR);
        await fs.mkdir(dataDir, { recursive: true });
        for (const [name, hostDir] of Object.entries(mapping.datasetHostDirs)) {
          await fs.symlink(hostDir, path.join(dataDir, name), "dir");
        }
      }

      // Materialize input files into the tmp dir.
      for (const [name, buf] of Object.entries(input.inputFiles ?? {})) {
        if (name.includes("..") || path.isAbsolute(name)) {
          throw new Error(`Invalid inputFiles key: ${name}`);
        }
        const target = path.join(tmpHostDir, name);
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, buf);
      }

      const child = this.spawnChild(input, tmpHostDir);
      const result = await this.driveChild(child, input);

      const stdout = processStdout(result.rawStdout, mapping);
      const stderr = processStderr(result.rawStderr, mapping);

      return {
        stdout,
        stderr,
        exitCode: result.exitCode,
        durationMs: Date.now() - startedAt,
        ...(result.termination ? { termination: result.termination } : {}),
      };
    } finally {
      await fs.rm(tmpHostDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  // Internals

  private spawnChild(input: SandboxInput, tmpHostDir: string): ChildProcess {
    const [cmd, ...args] = input.command;
    const spawnOpts: SpawnOptions = {
      cwd: tmpHostDir,
      stdio: ["pipe", "pipe", "pipe"],
      // Strict allowlist — see `buildSpawnEnv`. Cast through unknown
      // because the project augments `NodeJS.ProcessEnv` to require
      // `NODE_ENV`, which we deliberately omit from the child env.
      env: this.buildSpawnEnv(tmpHostDir, input.env) as unknown as NodeJS.ProcessEnv,
    };
    const child = spawn(cmd, args, spawnOpts);
    if (input.stdin !== undefined && child.stdin) {
      child.stdin.end(input.stdin);
    }
    return child;
  }

  /** Compose the child's env from a strict ALLOWLIST instead of
   *  inheriting `process.env`. The subprocess backend has no real
   *  filesystem isolation, so anything in the parent env is one
   *  `os.environ.get(...)` call away for LLM-generated code. The
   *  Node process holds genuinely sensitive secrets:
   *
   *    - CREDENTIAL_ENCRYPTION_KEYRING (AES-256-GCM master key)
   *    - DATABASE_URL / POSTGRES_*     (direct DB access)
   *    - BETTER_AUTH_SECRET            (session forgery)
   *    - OPENAI_API_KEY / EXA_API_KEY  (paid API quotas)
   *    - LANGFUSE_*, ANTHROPIC_API_KEY, … and so on
   *
   *  Passing those into a degraded sandbox would be reckless. We
   *  list every variable the child legitimately needs and drop
   *  the rest.
   *
   *  The optional venv activation (`sandbox.subprocess.python_path`)
   *  layers on top of this base allowlist — same semantics as
   *  `source <venv>/bin/activate` (PATH prepended, VIRTUAL_ENV set).
   *  PYTHONHOME is NEVER inherited so site-packages resolution
   *  always uses the venv's lib/.
   *
   *  HOME and TMPDIR are redirected to `tmpHostDir` so libraries
   *  that write to `~/.cache`, `~/.config`, `$TMPDIR/...` land
   *  inside the sandbox's per-call tmp directory (auto-cleaned on
   *  exit) rather than littering the operator's real home.
   *
   *  On venv misconfiguration we fall back to system PATH and log
   *  once per (path, process) pair so the agent surface stays
   *  usable rather than hard-failing every call. */
  private buildSpawnEnv(
    tmpHostDir: string,
    inputEnv?: Record<string, string>,
  ): Record<string, string> {
    // Base allowlist — none of these carry secrets.
    // (Typed as a plain string record because NodeJS.ProcessEnv has
    // a project-augmented `NODE_ENV` requirement we deliberately
    // don't satisfy here — child workloads have no business knowing
    // whether the parent is in production vs development.)
    const env: Record<string, string> = {
      // PATH lets the child resolve `python3`, `bash`, `duckdb`, …
      // Without it `spawn("python3")` would fail to start. The venv
      // overlay below may prepend the venv's bin dir.
      PATH: process.env.PATH ?? "",
      // Locale / timezone are purely cosmetic (numeric formatting,
      // datetime output). Defaults pin a sane fallback so the child
      // is reproducible even when the operator's shell didn't set
      // them.
      LANG: process.env.LANG ?? "C.UTF-8",
      LC_ALL: process.env.LC_ALL ?? "C.UTF-8",
      ...(process.env.TZ ? { TZ: process.env.TZ } : {}),
      // HOME and TMPDIR are deliberately REDIRECTED, not inherited.
      // Many libraries auto-cache under ~/.cache / ~/.config; we
      // want those writes to land in our per-call tmp dir so they
      // get cleaned up with the rest of the sandbox.
      HOME: tmpHostDir,
      TMPDIR: tmpHostDir,
      // Sandbox metadata — informational only, no secret content.
      NANGO_SANDBOX_BACKEND: "subprocess",
      NANGO_SANDBOX_TMP: tmpHostDir,
    };

    const configured = getConfig("sandbox.subprocess.python_path", "").trim();
    // One-shot diagnostic: a single-line trace of the resolver's
    // decision (configured value, resolved binDir, prepended PATH
    // head) so the operator can diagnose "I configured a venv but
    // the sandbox still uses system python" without bisecting code.
    if (!venvTraceFired) {
      venvTraceFired = true;
      console.warn(
        "[sandbox] subprocess venv decision (one-shot diagnostic):\n" +
          `  configured: ${JSON.stringify(configured)}\n` +
          `  config cache loaded: ${isConfigLoaded()}\n` +
          `  config cache size: ${configCacheSize()}\n` +
          `  HOME: ${process.env.HOME ?? "(unset)"}\n` +
          `  inherited PATH head: ${(process.env.PATH ?? "").split(path.delimiter).slice(0, 3).join(path.delimiter)}…`,
      );
    }
    if (configured.length === 0) {
      if (!venvWarnedFor.has("__empty__")) {
        venvWarnedFor.add("__empty__");
        console.warn(
          "[sandbox] sandbox.subprocess.python_path is EMPTY in the " +
            "in-process config cache — child process will use system " +
            "PATH only. If you set this in the admin UI after the " +
            "server started, restart `pnpm dev` to pick it up.",
        );
      }
      return mergeInputEnv(env, inputEnv);
    }

    const resolved = resolvePythonVenv(configured);
    if (!resolved) {
      if (!venvWarnedFor.has(configured)) {
        venvWarnedFor.add(configured);
        console.warn(
          `[sandbox] sandbox.subprocess.python_path=${configured} ` +
            "but no python3/python interpreter was found at that " +
            "location; falling back to system PATH.",
        );
      }
      return mergeInputEnv(env, inputEnv);
    }

    if (!venvWarnedFor.has(`ok:${configured}`)) {
      venvWarnedFor.add(`ok:${configured}`);
      console.warn(
        `[sandbox] venv overlay active: pythonBin=${resolved.pythonBin}, ` +
          `binDir=${resolved.binDir} (prepended to child PATH)`,
      );
    }

    env.VIRTUAL_ENV = resolved.venvRoot;
    env.PATH = `${resolved.binDir}${path.delimiter}${env.PATH ?? ""}`;
    // PYTHONHOME is intentionally NOT carried over from the parent —
    // the allowlist above never lets it through, so site-packages
    // resolution always uses the venv's lib/.
    return mergeInputEnv(env, inputEnv);
  }

  private async driveChild(
    child: ChildProcess,
    input: SandboxInput,
  ): Promise<DriveResult> {
    const timeoutMs = input.timeoutMs ?? getConfigMs("sandbox.timeout", DEFAULT_TIMEOUT_S);
    const maxBytes = (input.maxMemoryMb ?? getConfigNumber("sandbox.memory_mb", DEFAULT_MEMORY_MB)) * 1024 * 1024;
    let rawStdout = "";
    let rawStderr = "";

    return new Promise<DriveResult>((resolve) => {
      let termination: SandboxOutput["termination"];
      let settled = false;

      const finish = (exitCode: number) => {
        if (settled) return;
        settled = true;
        clearTimeout(killTimer);
        clearInterval(rssTimer);
        if (input.signal) input.signal.removeEventListener("abort", onAbort);
        resolve({ rawStdout, rawStderr, exitCode, termination });
      };

      const kill = (reason: NonNullable<SandboxOutput["termination"]>) => {
        if (settled) return;
        termination = reason;
        try {
          child.kill("SIGKILL");
        } catch {
          /* already exited */
        }
      };

      const killTimer = setTimeout(() => kill("timeout"), timeoutMs);

      const onAbort = () => kill("abort");
      if (input.signal) {
        if (input.signal.aborted) onAbort();
        else input.signal.addEventListener("abort", onAbort, { once: true });
      }

      const rssTimer = setInterval(async () => {
        if (settled || child.pid === undefined) return;
        const rss = await this.readRss(child.pid);
        if (rss !== null && rss > maxBytes) kill("oom");
      }, RSS_POLL_MS);

      child.stdout?.on("data", (d: Buffer) => {
        rawStdout += d.toString("utf-8");
      });
      child.stderr?.on("data", (d: Buffer) => {
        rawStderr += d.toString("utf-8");
      });

      child.on("error", (err) => {
        // Spawn failures (e.g. ENOENT for the binary) — surface as
        // exit code 127 (POSIX "command not found") with stderr
        // carrying the message.
        rawStderr += `${err.message}\n`;
        finish(127);
      });

      child.on("close", (code, signal) => {
        // Termination reason precedence: timeout / oom / abort > signal.
        if (termination === undefined && signal !== null) {
          termination = "signal";
        }
        const exitCode = (() => {
          if (termination === "timeout") return 124;
          if (code !== null) return code;
          return 137; // SIGKILL by convention
        })();
        finish(exitCode);
      });
    });
  }
}

interface DriveResult {
  rawStdout: string;
  rawStderr: string;
  exitCode: number;
  termination: SandboxOutput["termination"];
}

/**
 * Merge caller-supplied env vars into the security allowlist.
 * The allowlist ALWAYS wins — callers cannot override PATH, HOME,
 * TMPDIR, NANGO_*, VIRTUAL_ENV, or any other key already present.
 * This prevents LLM-generated `env` values from hijacking the venv
 * or leaking secrets through env-var overrides.
 */
function mergeInputEnv(
  allowlist: Record<string, string>,
  inputEnv: Record<string, string> | undefined,
): Record<string, string> {
  if (inputEnv === undefined) return allowlist;
  const merged = { ...allowlist };
  for (const [k, v] of Object.entries(inputEnv)) {
    if (!(k in merged)) merged[k] = v;
  }
  return merged;
}
