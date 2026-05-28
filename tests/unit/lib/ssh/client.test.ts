import { describe, it, expect, beforeEach, vi } from "vitest";
import { createHash } from "node:crypto";

vi.mock("server-only", () => ({}));

let mockMaxOutputBytes = 1_048_576;
vi.mock("@/lib/config", () => ({
  getConfigMs: (_key: string, defaultSeconds: number) => defaultSeconds * 1000,
  getConfigNumber: (key: string, defaultValue: number) => {
    if (key === "ssh.max_output_bytes") return mockMaxOutputBytes;
    return defaultValue;
  },
}));

// ── Mock node-ssh ─────────────────────────────────────────────────────────
//
// We capture the connect config (esp. hostVerifier) to drive the
// host-key reject path; capture the execCommand options so the cap
// logic can be exercised by feeding chunks via onStdout / onStderr.

interface CapturedConfig {
  config?: Record<string, unknown>;
  execCommand?: string;
  execOpts?: {
    onStdout?: (chunk: Buffer) => void;
    onStderr?: (chunk: Buffer) => void;
  };
}

const captured: CapturedConfig = {};
let connectImpl: () => Promise<void> = async () => {};
let execImpl: () => Promise<{
  stdout: string;
  stderr: string;
  code: number | null;
  signal: string | null;
}> = async () => ({ stdout: "", stderr: "", code: 0, signal: null });
let disposeSpy = vi.fn();

vi.mock("node-ssh", () => ({
  NodeSSH: class {
    connection = null;
    async connect(config: Record<string, unknown>): Promise<this> {
      captured.config = config;
      if (typeof config.hostVerifier === "function") {
        const verifier = config.hostVerifier as (k: Buffer) => boolean;
        const key = (captured as { hostKey?: Buffer }).hostKey
          ?? Buffer.from("default-host-key");
        verifier(key);
      }
      await connectImpl();
      return this;
    }
    async execCommand(
      command: string,
      opts: {
        onStdout?: (chunk: Buffer) => void;
        onStderr?: (chunk: Buffer) => void;
      },
    ): Promise<{ stdout: string; stderr: string; code: number | null; signal: string | null }> {
      captured.execCommand = command;
      captured.execOpts = opts;
      return execImpl();
    }
    dispose = disposeSpy;
  },
}));

const {
  execOnServer,
  SshError,
  SshHostKeyMismatchError,
  shellSingleQuote,
  buildLoginShellCommand,
} = await import("@/lib/ssh/client");
const { __resetSshLimitsCache } = await import("@/lib/ssh/limits");

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
  disposeSpy = vi.fn();
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
});
