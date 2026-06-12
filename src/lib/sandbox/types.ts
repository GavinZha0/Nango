/**
 * Sandbox integration layer — domain types and adapter interface.
 *
 * See docs/sandbox.md.
 */

/**
 * Stable backend ids. Each value doubles as the public `SANDBOX_MODE`
 * env-var slug (1:1 — no alias layer). Backend selection is always
 * explicit: callers pin one of these via SANDBOX_MODE; the registry
 * never auto-probes. `remote-docker` is reserved — the registry
 * carries a null stub for it that rejects with `BackendUnavailableError`.
 */
export const SANDBOX_BACKENDS = [
  "subprocess",
  "local-docker",
  "remote-docker",
] as const;
export type SandboxBackend = (typeof SANDBOX_BACKENDS)[number];

// Container runtime

/**
 * Container runtime used by LocalDockerAdapter. Podman's CLI is
 * Docker-compatible, so the only difference is the binary name.
 * Controlled via config key `sandbox.runtime` (default: "docker").
 */
import { getConfig } from "@/lib/config";

export const CONTAINER_RUNTIMES = ["docker", "podman"] as const;
export type ContainerRuntime = (typeof CONTAINER_RUNTIMES)[number];

/** Resolve the container runtime binary from config. */
export function resolveContainerRuntime(): ContainerRuntime {
  const raw = getConfig("sandbox.runtime", "docker").trim().toLowerCase();
  if (raw === "docker") return "docker";
  if (raw === "podman") return "podman";
  throw new Error(
    `Unknown sandbox.runtime=${raw}. Expected one of: ${CONTAINER_RUNTIMES.join(", ")}.`,
  );
}

// ─── Shared env-var key constants ──────────────────────────────────

/**
 * Env var key under which the workflow engine serializes a code
 * node's `inputs.params` object as a JSON string before handing
 * it to the sandbox adapter.
 *
 * The sandbox preamble reads this key and deserializes it into the
 * language-native `params` variable:
 *   Python: `params = json.loads(os.environ[SANDBOX_PARAMS_ENV_KEY])`
 *
 * Rule: the sandbox Docker image must NEVER declare this key in its
 * own `ENV` instructions — doing so would let the image-baked value
 * silently override a caller-supplied payload in the Docker adapter,
 * which does not apply an allowlist filter (unlike the subprocess
 * adapter). Double-underscore prefix is the naming convention that
 * marks these keys as "owned by the Nango engine, not user space".
 */
export const SANDBOX_PARAMS_ENV_KEY = "__PARAMS__" as const;

// ─── Input / output shapes ──────────────────────────────────────────

export interface SandboxInput {
  /** argv array — never a shell string. argv[0] must be a runtime in
   *  the rootfs ("python3", "node", "bash"). */
  command: string[];

  /** Optional content piped to the command's stdin. NOT written to a
   *  file; the command receives it on its stdin. */
  stdin?: string;

  /** Datasets to expose read-only at `./data/<name>/` (cwd-relative)
   *  inside the sandbox. The runner resolves names to absolute Parquet
   *  directory paths; the local-docker adapter bind-mounts each at
   *  `/work/data/<name>` (readonly) while the subprocess adapter
   *  symlinks them under `tmpHostDir/data/<name>` (degraded —
   *  readonly is not enforced). */
  datasets?: string[];

  /** Extra files written to `./<name>` (cwd-relative) before execution
   *  and cleared on exit. The local-docker adapter places them under
   *  the writable `/work` mount; the subprocess adapter writes them
   *  under `tmpHostDir`. */
  inputFiles?: Record<string, Buffer>;

  /**
   * Caller-supplied environment variable overlay injected into the
   * sandbox process. Values MUST be plain strings; the caller is
   * responsible for any necessary serialization (e.g. JSON for typed
   * data — see `__PARAMS__` in `execute-workflow.ts`).
   *
   * CONTRACT (security): both adapters merge this overlay AFTER their
   * own allowlists/defaults, so callers cannot override system-managed
   * variables such as PATH, HOME, TMPDIR, NANGO_SANDBOX_BACKEND, or
   * the venv VIRTUAL_ENV setting. Attempting to set any of those keys
   * here is silently ignored.
   */
  env?: Record<string, string>;

  /** Hard timeout. SIGKILL on overshoot. Default: 30 000. */
  timeoutMs?: number;

  /** Memory cap in MB. Cgroup-backed in local-docker, RSS-poll
   *  based in subprocess (best-effort). Default: 256. */
  maxMemoryMb?: number;

  /** CPU cap as fractional cores. Default: 0.8. */
  maxCpuCores?: number;

  /** Plumbed through cancellable child handles. */
  signal?: AbortSignal;
}

export interface SandboxOutput {
  /** Truncated, path-masked stdout. */
  stdout: string;

  /** Truncated, path-masked stderr. */
  stderr: string;

  /** Process exit code; 124 by convention on timeout. */
  exitCode: number;

  /** Wall-clock execution time, milliseconds. */
  durationMs: number;

  /** Set when the runner killed the process. */
  termination?: "timeout" | "oom" | "abort" | "signal";
}

// Adapter interface

export interface ISandboxAdapter {
  readonly backend: SandboxBackend;
  readonly displayName: string;

  /** True iff this backend can be used in the current process's
   *  environment. LocalDockerAdapter.isAvailable() requires
   *  `docker info` to succeed; SubprocessAdapter.isAvailable()
   *  is always true. */
  isAvailable(): Promise<boolean>;

  /** Execute one command in a fresh sandbox; tear down on return.
   *  CONTRACT: never throws on user-code failures (timeout, OOM,
   *  non-zero exit) — those surface via SandboxOutput.exitCode and
   *  .termination. Throws only on infrastructure failures (missing
   *  rootfs, broken Docker socket, ...). */
  run(input: SandboxInput): Promise<SandboxOutput>;
}
