/**
 * Sandbox integration layer — domain types and adapter interface.
 *
 * See docs/sandbox.md.
 */

/**
 * Stable backend ids. Nango uses the external `dify-sandbox` service
 * as the sole sandbox backend. The subprocess fallback was removed —
 * see docs/sandbox.md for rationale.
 */
export const SANDBOX_BACKENDS = ["service"] as const;
export type SandboxBackend = (typeof SANDBOX_BACKENDS)[number];

export const SERVICE_SANDBOX_PROVIDERS = ["dify", "opensandbox"] as const;
export type ServiceSandboxProvider = (typeof SERVICE_SANDBOX_PROVIDERS)[number];

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
 * silently override a caller-supplied payload, which the
 * `ServiceSandboxAdapter` does not filter.
 * Double-underscore prefix is the naming convention that
 * marks these keys as "owned by the Nango engine, not user space".
 */
export const SANDBOX_PARAMS_ENV_KEY = "__PARAMS__" as const;

// ─── Input / output shapes ──────────────────────────────────────────

export interface SandboxInput {
  /** Optional high-level language identifier for HTTP sandbox services ("python3" | "javascript"). */
  language?: "python3" | "javascript";

  /** argv array — never a shell string. argv[0] must be a runtime in
   *  the rootfs ("python3", "node", "bash"). */
  command: string[];

  /** Optional content piped to the command's stdin. NOT written to a
   *  file; the command receives it on its stdin. */
  stdin?: string;

  /** Datasets to expose read-only at `./data/<name>/` (cwd-relative)
   *  inside the sandbox. The runner resolves names to absolute Parquet
   *  directory paths; the service adapter bind-mounts each at
   *  the sandbox's site-packages `data/` directory (readonly). */
  datasets?: string[];

  /** Extra files written to `./<name>` (cwd-relative) before execution
   *  and cleared on exit. */
  inputFiles?: Record<string, Buffer>;

  /**
   * Caller-supplied environment variable overlay injected into the
   * sandbox process. Values MUST be plain strings; the caller is
   * responsible for any necessary serialization (e.g. JSON for typed
   * data — see `__PARAMS__` in `execute-workflow.ts`).
   */
  env?: Record<string, string>;

  /** Hard timeout. SIGKILL on overshoot. Default: 30 000. */
  timeoutMs?: number;

  /** Memory cap in MB. Default: 256. */
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
   *  environment. ServiceSandboxAdapter probes the sandbox HTTP
   *  endpoint for reachability. */
  isAvailable(): Promise<boolean>;

  /** Execute one command in a fresh sandbox; tear down on return.
   *  CONTRACT: never throws on user-code failures (timeout, OOM,
   *  non-zero exit) — those surface via SandboxOutput.exitCode and
   *  .termination. Throws only on infrastructure failures (missing
   *  rootfs, broken Docker socket, ...). */
  run(input: SandboxInput): Promise<SandboxOutput>;
}
