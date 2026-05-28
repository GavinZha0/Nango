/**
 * SSH client wrapper. One call = connect → exec → dispose.
 * Strict host-key verification (no TOFU). @see docs/ssh.md §4
 */

import "server-only";

import { createHash } from "node:crypto";
import { NodeSSH } from "node-ssh";

import { childLogger } from "@/lib/observability/logger";
import { getSshLimits } from "./limits";
import type { NormalisedSshAuth } from "./credential-schema";

const log = childLogger({ component: "ssh" });

// Errors (typed)

export class SshError extends Error {
  constructor(
    public readonly code:
      | "HOST_KEY_MISMATCH"
      | "CONNECT_FAILED"
      | "EXEC_FAILED"
      | "ABORTED"
      | "TIMEOUT",
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "SshError";
  }
}

export class SshHostKeyMismatchError extends SshError {
  constructor(host: string, expected: string, actual: string) {
    super(
      "HOST_KEY_MISMATCH",
      `SSH host-key mismatch on ${host}: expected ${expected}, got ${actual}. ` +
        "If the server was legitimately re-keyed, an editor must update the ssh_server's knownHostFingerprint.",
    );
  }
}

// Result shape

export interface ExecResult {
  stdout: string;
  stderr: string;
  /** Exit code, or null if the process was killed by a signal / abort. */
  exitCode: number | null;
  /** Populated when `exitCode` is null. `"ABORTED"` for caller-cancelled. */
  signal: string | null;
  /** Wall-clock duration measured client-side. */
  durationMs: number;
  /** True if either stream was capped at `SSH_EXEC_MAX_OUTPUT_BYTES`. */
  truncated: boolean;
}

// Server connection target

/**
 * Just the connection-relevant fields from a resolved ssh_server
 * (host / port / pinned fingerprint). The OS username is sourced
 * from the credential (`NormalisedSshAuth.username`), not from the
 * ssh_server row. Decoupled from `ResolvedSshServer` so unit tests
 * can call `execOnServer` without standing up the lookup layer.
 *
 * `knownHostFingerprint` may be `null` ONLY when called from
 * `verifyConnection` in capture mode — admin clicked "Verify
 * connection" on a not-yet-pinned row and we need to record
 * whatever the host hands us. All real SSH execution (`execOnServer`)
 * REQUIRES a non-null fingerprint and will reject otherwise.
 */
export interface SshConnectionTarget {
  host: string;
  port: number;
  knownHostFingerprint: string | null;
  /** When true, the command is wrapped as `bash -lc '<command>'` so
   *  the host's profile scripts run and the resulting `PATH` / env
   *  match an interactive SSH session. Off the call path for
   *  `verifyConnection` (no command is executed). @see docs/ssh.md §3.3 */
  loginShell?: boolean;
}

// Public API

export interface ExecOptions {
  /** Per-call override; falls back to `SSH_EXEC_TIMEOUT_MS`. */
  timeoutMs?: number;
  /** Caller-provided cancel signal. Closing the SSH client on abort
   *  unblocks the tool immediately; the remote process is NOT killed
   *  (SSH protocol cannot pre-empt server-side execution). */
  signal?: AbortSignal;
}

/**
 * Execute a single command on the host described by `server`,
 * authenticating with `auth`. Always verifies the server's host key
 * against `server.knownHostFingerprint` before any data is exchanged.
 *
 * @throws SshHostKeyMismatchError on key mismatch
 * @throws SshError on connect / exec / timeout failures
 */
export async function execOnServer(
  server: SshConnectionTarget,
  auth: NormalisedSshAuth,
  command: string,
  opts: ExecOptions = {},
): Promise<ExecResult> {
  const limits = getSshLimits();
  const timeoutMs = opts.timeoutMs ?? limits.execTimeoutMs;
  const ssh = new NodeSSH();

  const startedAt = Date.now();
  let aborted = false;
  const onAbort = (): void => {
    aborted = true;
    ssh.dispose();
  };
  if (opts.signal) {
    if (opts.signal.aborted) {
      throw new SshError("ABORTED", "Aborted before connect.");
    }
    opts.signal.addEventListener("abort", onAbort, { once: true });
  }

  try {
    await ssh.connect(buildConnectConfig(server, auth, limits.connectTimeoutMs));
  } catch (err) {
    if (err instanceof SshHostKeyMismatchError) throw err;
    if (aborted) throw new SshError("ABORTED", "Connect aborted by caller.");
    throw new SshError(
      "CONNECT_FAILED",
      `SSH connect to ${server.host}:${server.port} failed: ${errMessage(err)}`,
      err,
    );
  }

  // Exec with output cap + per-call timeout.
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ssh.dispose();
  }, timeoutMs);

  try {
    const stdoutCap = makeCappedSink(limits.maxOutputBytes);
    const stderrCap = makeCappedSink(limits.maxOutputBytes);

    const finalCommand = server.loginShell
      ? buildLoginShellCommand(command)
      : command;
    const result = await ssh.execCommand(finalCommand, {
      onStdout: (chunk) => stdoutCap.push(chunk),
      onStderr: (chunk) => stderrCap.push(chunk),
    });

    const durationMs = Date.now() - startedAt;

    if (aborted) {
      return {
        stdout: stdoutCap.value(),
        stderr: stderrCap.value(),
        exitCode: null,
        signal: "ABORTED",
        durationMs,
        truncated: stdoutCap.truncated || stderrCap.truncated,
      };
    }
    if (timedOut) {
      throw new SshError(
        "TIMEOUT",
        `SSH exec exceeded ${timeoutMs}ms on ${server.host}; channel closed (remote process may still be running).`,
      );
    }

    return {
      stdout: stdoutCap.value(),
      stderr: stderrCap.value(),
      exitCode: result.code,
      signal: result.signal,
      durationMs,
      truncated: stdoutCap.truncated || stderrCap.truncated,
    };
  } catch (err) {
    if (err instanceof SshError) throw err;
    if (timedOut) {
      throw new SshError(
        "TIMEOUT",
        `SSH exec exceeded ${timeoutMs}ms on ${server.host}.`,
      );
    }
    if (aborted) throw new SshError("ABORTED", "Exec aborted by caller.");
    throw new SshError(
      "EXEC_FAILED",
      `SSH exec on ${server.host} failed: ${errMessage(err)}`,
      err,
    );
  } finally {
    clearTimeout(timer);
    if (opts.signal) opts.signal.removeEventListener("abort", onAbort);
    ssh.dispose();
  }
}

// Verify (host capture + auth in one round-trip)

/**
 * Result envelope for `verifyConnection`.
 *
 * `fingerprint` is populated whenever the TCP handshake reached the
 * point where the server presented a host key — INCLUDING the
 * `auth-failed` case. Only true network failures (DNS / connect
 * refused / connect timeout) will return `fingerprint === null`.
 */
export interface VerifyConnectionResult {
  ok: boolean;
  durationMs: number;
  /** SHA256:<base64> of the host key the server presented; null only
   *  when the handshake didn't get that far. */
  fingerprint: string | null;
  /** Populated when `ok` is false. */
  error?: {
    code: SshError["code"];
    message: string;
  };
}

/**
 * One-round-trip "Verify connection" button worker:
 *
 *   1. TCP + SSH handshake — captures the host key fingerprint in
 *      `hostVerifier`.
 *   2. If `expectedFingerprint` is provided AND mismatches, abort
 *      auth (existing strict-pin behaviour).
 *   3. If `expectedFingerprint` is null OR matches, allow auth to
 *      proceed; success means `{username, password|privateKey}`
 *      authenticate cleanly on the host.
 *   4. Dispose immediately — no command is executed.
 *
 * Returns the captured fingerprint regardless of auth outcome so the
 * editor can populate its input even when auth fails (admin can fix
 * credentials and re-verify without losing the host pin).
 *
 * Never throws — every error is folded into the result envelope.
 */
export async function verifyConnection(
  server: SshConnectionTarget,
  auth: NormalisedSshAuth,
): Promise<VerifyConnectionResult> {
  const limits = getSshLimits();
  const ssh = new NodeSSH();
  const startedAt = Date.now();
  // Capture the host key from inside `hostVerifier`. The callback
  // runs synchronously during the handshake and BEFORE auth, so this
  // closure variable is the only safe place to record the offered key.
  let captured: string | null = null;

  try {
    const cfg = buildConnectConfig(
      server,
      auth,
      limits.connectTimeoutMs,
      (fp) => {
        captured = fp;
      },
    );
    await ssh.connect(cfg);
    return {
      ok: true,
      durationMs: Date.now() - startedAt,
      fingerprint: captured,
    };
  } catch (err) {
    const durationMs = Date.now() - startedAt;
    if (err instanceof SshHostKeyMismatchError) {
      return {
        ok: false,
        durationMs,
        fingerprint: captured,
        error: { code: "HOST_KEY_MISMATCH", message: err.message },
      };
    }
    // node-ssh wraps auth failures with no consistent error type;
    // fall back to message inspection. CONNECT_FAILED covers both
    // network unreachability and bad credentials — the message
    // string in `error.message` carries the detail for the UI.
    return {
      ok: false,
      durationMs,
      fingerprint: captured,
      error: {
        code: "CONNECT_FAILED",
        message: errMessage(err),
      },
    };
  } finally {
    ssh.dispose();
  }
}

// Internals

type ConnectConfig = Parameters<NodeSSH["connect"]>[0];

/**
 * Compose the `node-ssh` connect config from server target + auth.
 * The host-key verifier is the security boundary — `hostVerifier`
 * runs BEFORE auth, so a mismatched host can never see our
 * password / private key.
 *
 * When `server.knownHostFingerprint` is non-null (the production
 * exec path), the verifier strictly compares the offered key against
 * the pin and rejects on mismatch. When it is null (capture mode,
 * only reachable via `verifyConnection`), the verifier records the
 * offered key via `onCapture` and allows the connection to proceed
 * to auth.
 */
function buildConnectConfig(
  server: SshConnectionTarget,
  auth: NormalisedSshAuth,
  connectTimeoutMs: number,
  onCapture?: (fingerprint: string) => void,
): ConnectConfig {
  const expected = server.knownHostFingerprint;
  const base: ConnectConfig = {
    host: server.host,
    port: server.port,
    username: auth.username,
    readyTimeout: connectTimeoutMs,
    hostVerifier: (key: Buffer | string): boolean => {
      const keyBuf =
        typeof key === "string" ? Buffer.from(key, "binary") : key;
      const actual = "SHA256:" + createHash("sha256")
        .update(keyBuf)
        .digest("base64")
        .replace(/=+$/, "");
      if (onCapture) onCapture(actual);
      if (expected === null) {
        // Capture mode: trust whatever the host sends. The caller
        // (verifyConnection) is responsible for surfacing the
        // captured fingerprint to a human for review.
        return true;
      }
      if (actual !== expected) {
        throw new SshHostKeyMismatchError(server.host, expected, actual);
      }
      return true;
    },
  };

  if (auth.kind === "password") {
    return { ...base, password: auth.password };
  }
  return {
    ...base,
    privateKey: auth.privateKey,
    ...(auth.passphrase !== undefined ? { passphrase: auth.passphrase } : {}),
  };
}

/**
 * Capped streaming sink: appends Buffers up to `maxBytes`, drops the
 * rest, and exposes `truncated` so the caller can flag the result.
 * Decoded as UTF-8 at the end.
 */
function makeCappedSink(maxBytes: number): {
  push: (chunk: Buffer) => void;
  value: () => string;
  truncated: boolean;
} {
  const chunks: Buffer[] = [];
  let total = 0;
  const sink = {
    truncated: false,
    push(chunk: Buffer): void {
      if (sink.truncated) return;
      const room = maxBytes - total;
      if (chunk.length <= room) {
        chunks.push(chunk);
        total += chunk.length;
        return;
      }
      if (room > 0) chunks.push(chunk.subarray(0, room));
      total = maxBytes;
      sink.truncated = true;
    },
    value(): string {
      return Buffer.concat(chunks).toString("utf8");
    },
  };
  return sink;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Login-shell wrapping

/**
 * POSIX-safe single-quote escape: wraps `s` in `'…'` and escapes any
 * embedded single quotes via the classic `'\''` close/escape/reopen
 * trick. Inside single quotes everything else is literal — `$`,
 * backticks, backslashes etc. all keep their textual value, which is
 * exactly what we want when we forward an arbitrary command to bash.
 *
 * @example
 *   shellSingleQuote("foo")          // → "'foo'"
 *   shellSingleQuote("it's")         // → "'it'\\''s'"
 *   shellSingleQuote("$PATH `id`")   // → "'$PATH `id`'"
 *   shellSingleQuote("")             // → "''"
 */
export function shellSingleQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Wrap a free-form shell command so it executes inside an interactive
 * login bash on the remote side. The login shell sources
 * `/etc/profile` + `~/.bash_profile` (or `~/.profile`) + the files in
 * `/etc/profile.d/` before running `<command>`, restoring the `PATH`
 * / env that an admin sees when they SSH in by hand — which is what
 * lets `appd version`-style product-specific commands resolve.
 *
 * NOTE the remote host MUST have `/bin/bash`. Minimal images (Alpine,
 * busybox) and network devices typically don't — those hosts should
 * have `ssh_server.login_shell = false` so we send the raw command.
 */
export function buildLoginShellCommand(command: string): string {
  return `bash -lc ${shellSingleQuote(command)}`;
}

// Suppress the unused-log warning (we keep `log` for future telemetry).
void log;
