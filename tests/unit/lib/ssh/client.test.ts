import { describe, it, expect, beforeEach, vi } from "vitest";
import { createHash } from "node:crypto";

let mockMaxOutputBytes = 1_048_576;
let mockMaxSessionsPerServer = 10;
vi.mock("@/lib/config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/config")>();
  return {
    ...actual,
    getConfigMs: (_key: string, defaultSeconds: number) => defaultSeconds * 1000,
    getConfigNumber: (key: string, defaultValue: number) => {
      if (key === "ssh.max_output_bytes") return mockMaxOutputBytes;
      if (key === "ssh.max_sessions_per_server") return mockMaxSessionsPerServer;
      return defaultValue;
    },
  };
});

// ── Mock node-ssh ─────────────────────────────────────────────────────────
//
// We capture the connect config (esp. hostVerifier) to drive the
// host-key reject path; capture the execCommand options so the cap
// logic can be exercised by feeding chunks via onStdout / onStderr.

interface CapturedConfig {
  config?: Record<string, unknown>;
  execCommand?: string;
  execOpts?: {
    onChannel?: (ch: { close: () => void }) => void;
    onStdout?: (chunk: Buffer) => void;
    onStderr?: (chunk: Buffer) => void;
  };
}

const captured: CapturedConfig = {};
let connectImpl: () => Promise<void> = async () => {};
let execImpl: (
  command: string,
  opts: CapturedConfig["execOpts"],
) => Promise<{
  stdout: string;
  stderr: string;
  code: number | null;
  signal: string | null;
}> = async () => ({ stdout: "", stderr: "", code: 0, signal: null });
let putFileImpl: () => Promise<void> = async () => {};
let channelCloseSpy = vi.fn();
let sftpEndSpy = vi.fn();
let disposeSpy = vi.fn();

vi.mock("node-ssh", () => ({
  NodeSSH: class {
    connection = null;
    connected = false;
    isConnected = () => this.connected;
    async connect(config: Record<string, unknown>): Promise<this> {
      captured.config = config;
      if (typeof config.hostVerifier === "function") {
        const verifier = config.hostVerifier as (k: Buffer) => boolean;
        const key = (captured as { hostKey?: Buffer }).hostKey
          ?? Buffer.from("default-host-key");
        verifier(key);
      }
      await connectImpl();
      this.connected = true;
      return this;
    }
    async execCommand(
      command: string,
      opts: {
        onChannel?: (ch: { close: () => void }) => void;
        onStdout?: (chunk: Buffer) => void;
        onStderr?: (chunk: Buffer) => void;
      },
    ): Promise<{ stdout: string; stderr: string; code: number | null; signal: string | null }> {
      captured.execCommand = command;
      captured.execOpts = opts;
      opts.onChannel?.({ close: channelCloseSpy });
      return execImpl(command, opts);
    }
    async requestSFTP(): Promise<{ end: () => void }> {
      return { end: sftpEndSpy };
    }
    async putFile(): Promise<void> {
      return putFileImpl();
    }
    dispose = () => {
      this.connected = false;
      disposeSpy();
    };
  },
}));

const {
  execOnServer,
  putFileOnServer,
  SshError,
  SshHostKeyMismatchError,
  shellSingleQuote,
  buildLoginShellCommand,
} = await import("@/lib/ssh/client");
const { __resetSshLimitsCache } = await import("@/lib/ssh/limits");
const { clearSshPool } = await import("@/lib/ssh/pool.server");
const { __sshSessionSlotStats } = await import("@/lib/ssh/session-limiter.server");

// Helpers --------------------------------------------------------------------

const HOST_KEY = Buffer.from("the-real-host-key");
const CORRECT_FP =
  "SHA256:" +
  createHash("sha256").update(HOST_KEY).digest("base64").replace(/=+$/, "");

const targetServer = {
  host: "h",
  port: 22,
  knownHostFingerprint: CORRECT_FP,
};

const passwordAuth = {
  kind: "password" as const,
  username: "u",
  password: "p",
};
const keyAuth = {
  kind: "privateKey" as const,
  username: "u",
  privateKey: "PEM",
  passphrase: "phrase",
};

beforeEach(() => {
  captured.config = undefined;
  captured.execCommand = undefined;
  captured.execOpts = undefined;
  (captured as { hostKey?: Buffer }).hostKey = HOST_KEY;
  connectImpl = async () => {};
  execImpl = async () => ({ stdout: "ok", stderr: "", code: 0, signal: null });
  putFileImpl = async () => {};
  channelCloseSpy = vi.fn();
  sftpEndSpy = vi.fn();
  disposeSpy = vi.fn();
  mockMaxOutputBytes = 1_048_576;
  mockMaxSessionsPerServer = 10;
  clearSshPool();
  __resetSshLimitsCache();
});

// Tests ----------------------------------------------------------------------

describe("execOnServer — success", () => {
  it("returns stdout / exitCode for a successful command (password auth)", async () => {
    execImpl = async () => ({ stdout: "hello", stderr: "", code: 0, signal: null });
    const result = await execOnServer(targetServer, passwordAuth, "echo hello");
    expect(result.exitCode).toBe(0);
    expect(result.signal).toBeNull();
    expect(result.truncated).toBe(false);
  });

  it("passes password to node-ssh config when auth.kind is password", async () => {
    await execOnServer(targetServer, passwordAuth, "echo");
    expect(captured.config?.password).toBe("p");
    expect(captured.config?.privateKey).toBeUndefined();
  });

  it("passes privateKey + passphrase when auth.kind is privateKey", async () => {
    await execOnServer(targetServer, keyAuth, "echo");
    expect(captured.config?.privateKey).toBe("PEM");
    expect(captured.config?.passphrase).toBe("phrase");
    expect(captured.config?.password).toBeUndefined();
  });
});

describe("execOnServer — host-key verification", () => {
  it("rejects when the server key does not match the pinned fingerprint", async () => {
    (captured as { hostKey?: Buffer }).hostKey = Buffer.from("imposter");
    await expect(
      execOnServer(targetServer, passwordAuth, "echo"),
    ).rejects.toBeInstanceOf(SshHostKeyMismatchError);
  });

  it("includes both expected and actual fingerprints in the error", async () => {
    (captured as { hostKey?: Buffer }).hostKey = Buffer.from("imposter");
    try {
      await execOnServer(targetServer, passwordAuth, "echo");
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(SshHostKeyMismatchError);
      expect((err as Error).message).toContain(CORRECT_FP);
      expect((err as Error).message).toContain("got SHA256:");
    }
  });
});

describe("execOnServer — connect failure", () => {
  it("wraps connect errors into SshError(CONNECT_FAILED)", async () => {
    connectImpl = async () => {
      throw new Error("ECONNREFUSED");
    };
    await expect(execOnServer(targetServer, passwordAuth, "echo"))
      .rejects.toMatchObject({ code: "CONNECT_FAILED" });
  });
});

describe("execOnServer — abort", () => {
  it("rejects synchronously when signal is already aborted", async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(
      execOnServer(targetServer, passwordAuth, "echo", { signal: ac.signal }),
    ).rejects.toMatchObject({ code: "ABORTED" });
  });
});

describe("execOnServer — output cap", () => {
  it("flags truncated when stdout exceeds ssh.max_output_bytes config", async () => {
    mockMaxOutputBytes = 1024;
    execImpl = async () => {
      captured.execOpts?.onStdout?.(Buffer.alloc(1024, 0x61));
      captured.execOpts?.onStdout?.(Buffer.from("OVERFLOW"));
      return { stdout: "", stderr: "", code: 0, signal: null };
    };
    const result = await execOnServer(targetServer, passwordAuth, "echo");
    expect(result.truncated).toBe(true);
    expect(result.stdout.length).toBe(1024);
    mockMaxOutputBytes = 1_048_576; // restore
  });

  it("does not flag truncated when output stays under the cap", async () => {
    execImpl = async () => {
      captured.execOpts?.onStdout?.(Buffer.from("small"));
      return { stdout: "", stderr: "", code: 0, signal: null };
    };
    const result = await execOnServer(targetServer, passwordAuth, "echo");
    expect(result.truncated).toBe(false);
    expect(result.stdout).toBe("small");
  });
});

describe("execOnServer — exec failure", () => {
  it("wraps unexpected exec errors into SshError(EXEC_FAILED)", async () => {
    execImpl = async () => {
      throw new Error("channel reset");
    };
    await expect(execOnServer(targetServer, passwordAuth, "echo"))
      .rejects.toBeInstanceOf(SshError);
  });
});

// ── shellSingleQuote --------------------------------------------------------

describe("shellSingleQuote", () => {
  it("wraps a plain string in single quotes", () => {
    expect(shellSingleQuote("foo")).toBe("'foo'");
  });

  it("yields a literal pair for the empty string", () => {
    expect(shellSingleQuote("")).toBe("''");
  });

  it("escapes embedded single quotes via the close/escape/reopen trick", () => {
    expect(shellSingleQuote("it's")).toBe(`'it'\\''s'`);
  });

  it("does NOT expand $VAR / backticks / backslashes — they stay literal", () => {
    expect(shellSingleQuote("$PATH `id` \\n")).toBe(`'$PATH \`id\` \\n'`);
  });

  it("survives a string that is JUST a single quote", () => {
    expect(shellSingleQuote("'")).toBe(`''\\'''`);
  });
});

// ── buildLoginShellCommand --------------------------------------------------

describe("buildLoginShellCommand", () => {
  it("prefixes `bash -lc ` and quotes the command", () => {
    expect(buildLoginShellCommand("appd version")).toBe(`bash -lc 'appd version'`);
  });

  it("escapes single quotes inside the command", () => {
    expect(buildLoginShellCommand(`echo 'hi'`)).toBe(`bash -lc 'echo '\\''hi'\\'''`);
  });

  it("handles pipelines without re-escaping their operators", () => {
    expect(buildLoginShellCommand("ls -la | grep foo")).toBe(
      `bash -lc 'ls -la | grep foo'`,
    );
  });
});

// ── execOnServer — login_shell wrapping -------------------------------------

describe("execOnServer — login_shell", () => {
  it("forwards the raw command when loginShell is false / unset", async () => {
    await execOnServer(targetServer, passwordAuth, "appd version");
    expect(captured.execCommand).toBe("appd version");
  });

  it("wraps the command in `bash -lc '…'` when loginShell is true", async () => {
    await execOnServer(
      { ...targetServer, loginShell: true },
      passwordAuth,
      "appd version",
    );
    expect(captured.execCommand).toBe(`bash -lc 'appd version'`);
  });

  it("escapes single quotes inside the wrapped command", async () => {
    await execOnServer(
      { ...targetServer, loginShell: true },
      passwordAuth,
      `echo 'hello'`,
    );
    expect(captured.execCommand).toBe(`bash -lc 'echo '\\''hello'\\'''`);
  });

  it("normalizes trailing base64 padding on knownHostFingerprint", async () => {
    await execOnServer(
      { ...targetServer, knownHostFingerprint: `${CORRECT_FP}=` },
      passwordAuth,
      "uptime",
    );
    expect(captured.execCommand).toBe("uptime");
  });

  it("disposes ssh client even when connect fails", async () => {
    connectImpl = async () => {
      throw new Error("ECONNREFUSED");
    };
    await expect(
      execOnServer(targetServer, passwordAuth, "uptime"),
    ).rejects.toThrow(SshError);
    expect(disposeSpy).toHaveBeenCalledTimes(1);
  });

  it("forwards stdin to ssh.execCommand when provided", async () => {
    await execOnServer(targetServer, passwordAuth, "bash -s", {
      stdin: "echo from-stdin\n",
    });
    expect(captured.execCommand).toBe("bash -s");
    expect((captured.execOpts as { stdin?: string }).stdin).toBe(
      "echo from-stdin\n",
    );
  });

  it("unblocks immediately on abort without hanging on execCommand", async () => {
    const controller = new AbortController();
    execImpl = () => new Promise(() => {}); // Never resolves

    const p = execOnServer(targetServer, passwordAuth, "tail -f /var/log/app", {
      signal: controller.signal,
    });
    await new Promise((r) => setTimeout(r, 10));
    controller.abort();

    const res = await p;
    expect(res.exitCode).toBeNull();
    expect(res.signal).toBe("ABORTED");
  });

  it("unblocks immediately with TIMEOUT when execCommand hangs", async () => {
    execImpl = () => new Promise(() => {}); // Never resolves

    await expect(
      execOnServer(targetServer, passwordAuth, "tail -f /var/log/app", {
        timeoutMs: 20,
      }),
    ).rejects.toMatchObject({ code: "TIMEOUT" });
    expect(channelCloseSpy).toHaveBeenCalledTimes(1);
  });
});

describe("execOnServer — session slots & shared channel cancel", () => {
  it("closes only the timed-out channel without disposing a shared pooled connection", async () => {
    let releaseSecond!: () => void;
    let callCount = 0;
    execImpl = (_cmd, opts) => {
      callCount += 1;
      if (callCount === 1) {
        return new Promise(() => {}); // Times out
      }
      return new Promise((resolve) => {
        releaseSecond = () => {
          opts?.onStdout?.(Buffer.from("second-ok"));
          resolve({ stdout: "second-ok", stderr: "", code: 0, signal: null });
        };
      });
    };

    const pooledTarget = { ...targetServer, serverId: "srv-shared-1" };
    const p1 = execOnServer(pooledTarget, passwordAuth, "sleep 10", { timeoutMs: 20 });
    const p2 = execOnServer(pooledTarget, passwordAuth, "echo second");

    await expect(p1).rejects.toMatchObject({ code: "TIMEOUT" });
    expect(channelCloseSpy).toHaveBeenCalledTimes(1);
    expect(disposeSpy).not.toHaveBeenCalled();

    releaseSecond();
    const res2 = await p2;
    expect(res2.stdout).toBe("second-ok");
    expect(__sshSessionSlotStats("srv-shared-1")).toEqual({ active: 0, waiters: 0 });
  });

  it("times out cleanly while waiting for a full session slot without leaking", async () => {
    mockMaxSessionsPerServer = 1;
    let releaseFirst!: () => void;
    execImpl = (_cmd, opts) =>
      new Promise((resolve) => {
        releaseFirst = () => {
          opts?.onStdout?.(Buffer.from("first-ok"));
          resolve({ stdout: "first-ok", stderr: "", code: 0, signal: null });
        };
      });

    const pooledTarget = { ...targetServer, serverId: "srv-slot-timeout" };
    const p1 = execOnServer(pooledTarget, passwordAuth, "echo first");
    await new Promise((r) => setTimeout(r, 10));

    const p2 = execOnServer(pooledTarget, passwordAuth, "echo queued", { timeoutMs: 20 });
    await expect(p2).rejects.toMatchObject({ code: "TIMEOUT" });
    expect(__sshSessionSlotStats("srv-slot-timeout")).toEqual({ active: 1, waiters: 0 });

    releaseFirst();
    await expect(p1).resolves.toMatchObject({ stdout: "first-ok" });
    expect(__sshSessionSlotStats("srv-slot-timeout")).toEqual({ active: 0, waiters: 0 });
  });

  it("aborts cleanly while waiting for a full session slot without leaking", async () => {
    mockMaxSessionsPerServer = 1;
    let releaseFirst!: () => void;
    execImpl = (_cmd, opts) =>
      new Promise((resolve) => {
        releaseFirst = () => {
          opts?.onStdout?.(Buffer.from("first-ok"));
          resolve({ stdout: "first-ok", stderr: "", code: 0, signal: null });
        };
      });

    const pooledTarget = { ...targetServer, serverId: "srv-slot-abort" };
    const p1 = execOnServer(pooledTarget, passwordAuth, "echo first");
    await new Promise((r) => setTimeout(r, 10));

    const ac = new AbortController();
    const p2 = execOnServer(pooledTarget, passwordAuth, "echo queued", { signal: ac.signal });
    ac.abort();
    await expect(p2).rejects.toMatchObject({ code: "ABORTED" });
    expect(__sshSessionSlotStats("srv-slot-abort")).toEqual({ active: 1, waiters: 0 });

    releaseFirst();
    await expect(p1).resolves.toMatchObject({ stdout: "first-ok" });
    expect(__sshSessionSlotStats("srv-slot-abort")).toEqual({ active: 0, waiters: 0 });
  });
  it("unblocks immediately with TIMEOUT when connect hangs", async () => {
    connectImpl = () => new Promise(() => {});

    await expect(
      execOnServer(targetServer, passwordAuth, "echo", { timeoutMs: 20 }),
    ).rejects.toMatchObject({ code: "TIMEOUT" });
  });

  it("unblocks immediately with ABORTED when connect hangs", async () => {
    connectImpl = () => new Promise(() => {});
    const ac = new AbortController();

    const p = execOnServer(targetServer, passwordAuth, "echo", { signal: ac.signal });
    await new Promise((r) => setTimeout(r, 10));
    ac.abort();

    await expect(p).rejects.toMatchObject({ code: "ABORTED" });
  });
});

describe("putFileOnServer — SFTP channel cancellation", () => {
  it("ends the SFTP channel and releases the slot on timeout", async () => {
    putFileImpl = () => new Promise(() => {});
    const pooledTarget = { ...targetServer, serverId: "srv-sftp-timeout" };

    await expect(
      putFileOnServer(pooledTarget, passwordAuth, "/tmp/a", "/remote/a", 10, { timeoutMs: 20 }),
    ).rejects.toMatchObject({ code: "TIMEOUT" });
    expect(sftpEndSpy).toHaveBeenCalled();
    expect(__sshSessionSlotStats("srv-sftp-timeout")).toEqual({ active: 0, waiters: 0 });
  });

  it("ends the SFTP channel and releases the slot on abort", async () => {
    putFileImpl = () => new Promise(() => {});
    const pooledTarget = { ...targetServer, serverId: "srv-sftp-abort" };
    const ac = new AbortController();

    const p = putFileOnServer(pooledTarget, passwordAuth, "/tmp/a", "/remote/a", 10, {
      signal: ac.signal,
    });
    await new Promise((r) => setTimeout(r, 10));
    ac.abort();

    await expect(p).rejects.toMatchObject({ code: "ABORTED" });
    expect(sftpEndSpy).toHaveBeenCalled();
    expect(__sshSessionSlotStats("srv-sftp-abort")).toEqual({ active: 0, waiters: 0 });
  });
});
