import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  SubprocessAdapter,
  resolvePythonVenv,
} from "@/lib/sandbox/adapters/subprocess/adapter.server";

describe("SubprocessAdapter — real spawn", () => {
  const adapter = new SubprocessAdapter();

  it("captures stdout from a simple echo", async () => {
    const out = await adapter.run({
      command: ["sh", "-c", "echo hello"],
      timeoutMs: 5000,
    });
    expect(out.exitCode).toBe(0);
    expect(out.stdout.trim()).toBe("hello");
    expect(out.stderr).toBe("");
    expect(out.termination).toBeUndefined();
    expect(out.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("forwards stdin to the child", async () => {
    const out = await adapter.run({
      command: ["sh", "-c", "cat"],
      stdin: "ping",
      timeoutMs: 5000,
    });
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toBe("ping");
  });

  it("propagates non-zero exit codes", async () => {
    const out = await adapter.run({
      command: ["sh", "-c", "exit 7"],
      timeoutMs: 5000,
    });
    expect(out.exitCode).toBe(7);
    expect(out.termination).toBeUndefined();
  });

  it("returns 127 on missing binary instead of throwing", async () => {
    const out = await adapter.run({
      command: ["this-binary-definitely-does-not-exist-xyz"],
      timeoutMs: 5000,
    });
    expect(out.exitCode).toBe(127);
    expect(out.stderr.length).toBeGreaterThan(0);
  });

  it("kills on timeout and reports termination + exit 124", async () => {
    const out = await adapter.run({
      command: ["sh", "-c", "sleep 5"],
      timeoutMs: 200,
    });
    expect(out.termination).toBe("timeout");
    expect(out.exitCode).toBe(124);
    expect(out.durationMs).toBeLessThan(2000);
  });

  it("respects an externally aborted signal", async () => {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 100);
    const out = await adapter.run({
      command: ["sh", "-c", "sleep 5"],
      timeoutMs: 5000,
      signal: ctrl.signal,
    });
    expect(out.termination).toBe("abort");
    expect(out.durationMs).toBeLessThan(2000);
  });

  it("rejects empty argv", async () => {
    await expect(
      adapter.run({ command: [], timeoutMs: 1000 }),
    ).rejects.toThrow();
  });

  it("kills on RSS over the cap (mocked reader)", async () => {
    const fakeRss = vi.fn().mockResolvedValue(500 * 1024 * 1024); // 500MB
    const a = new SubprocessAdapter(fakeRss);
    const out = await a.run({
      command: ["sh", "-c", "sleep 5"],
      maxMemoryMb: 100,
      timeoutMs: 5000,
    });
    expect(out.termination).toBe("oom");
    expect(out.durationMs).toBeLessThan(3000);
  });

  it("materializes inputFiles into the work dir", async () => {
    const out = await adapter.run({
      command: ["sh", "-c", "cat data.txt"],
      inputFiles: { "data.txt": Buffer.from("from-input") },
      timeoutMs: 5000,
    });
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toBe("from-input");
  });

  it("rejects path-traversal in inputFiles keys", async () => {
    await expect(
      adapter.run({
        command: ["true"],
        inputFiles: { "../escape": Buffer.from("x") },
        timeoutMs: 1000,
      }),
    ).rejects.toThrow(/Invalid inputFiles/);
  });
});

describe("SubprocessAdapter — env allowlist (secret scrubbing)", () => {
  const adapter = new SubprocessAdapter();

  /** Spawn `env` in the child and parse `KEY=VALUE` lines into a map. */
  async function readChildEnv(): Promise<Record<string, string>> {
    const out = await adapter.run({
      command: ["env"],
      timeoutMs: 5000,
    });
    expect(out.exitCode).toBe(0);
    const map: Record<string, string> = {};
    for (const line of out.stdout.split("\n")) {
      const eq = line.indexOf("=");
      if (eq <= 0) continue;
      map[line.slice(0, eq)] = line.slice(eq + 1);
    }
    return map;
  }

  it("propagates the base allowlist (PATH, LANG, LC_ALL, HOME, TMPDIR, NANGO_*)", async () => {
    const env = await readChildEnv();
    expect(env.PATH).toBeDefined();
    expect(env.PATH!.length).toBeGreaterThan(0);
    expect(env.LANG).toBeDefined();
    expect(env.LC_ALL).toBeDefined();
    expect(env.HOME).toBeDefined();
    expect(env.TMPDIR).toBeDefined();
    expect(env.NANGO_SANDBOX_BACKEND).toBe("subprocess");
    expect(env.NANGO_SANDBOX_TMP).toBeDefined();
    // HOME/TMPDIR point at the per-call tmp dir, not the operator's $HOME.
    expect(env.HOME).toBe(env.NANGO_SANDBOX_TMP);
    expect(env.TMPDIR).toBe(env.NANGO_SANDBOX_TMP);
  });

  it("does NOT leak parent secrets to the child", async () => {
    // Plant fake secrets on the parent process for the duration of this test.
    // We use unique names to avoid clobbering anything real.
    const planted = {
      NANGO_TEST_LEAK_DB_URL: "postgres://leak:leak@localhost/leak",
      NANGO_TEST_LEAK_API_KEY: "sk-leakleakleakleak",
      NANGO_TEST_LEAK_KEYRING: "v1:abcd1234",
      // Also pretend the real production secrets exist so we catch
      // accidental allowlist additions for those by name.
      CREDENTIAL_ENCRYPTION_KEYRING: "test-master-key",
      DATABASE_URL: "postgres://test/test",
      BETTER_AUTH_SECRET: "test-auth-secret",
      OPENAI_API_KEY: "sk-test-openai",
      EXA_API_KEY: "exa-test-key",
    } as const;
    const previous: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(planted)) {
      previous[k] = process.env[k];
      process.env[k] = v;
    }

    try {
      const env = await readChildEnv();
      for (const k of Object.keys(planted)) {
        expect(env[k], `${k} must not be inherited`).toBeUndefined();
      }
    } finally {
      for (const [k, v] of Object.entries(previous)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  it("does NOT inherit PYTHONHOME from the parent", async () => {
    const previous = process.env.PYTHONHOME;
    process.env.PYTHONHOME = "/should/not/leak";
    try {
      const env = await readChildEnv();
      expect(env.PYTHONHOME).toBeUndefined();
    } finally {
      if (previous === undefined) delete process.env.PYTHONHOME;
      else process.env.PYTHONHOME = previous;
    }
  });
});

describe("resolvePythonVenv", () => {
  const cleanup: string[] = [];
  afterEach(() => {
    while (cleanup.length > 0) {
      const dir = cleanup.pop()!;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  /** Build a fake venv layout under tmpdir so existsSync probes succeed. */
  function makeFakeVenv(opts: { interpreterName: "python3" | "python" } = { interpreterName: "python3" }): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nango-venv-"));
    const bin = path.join(root, "bin");
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, opts.interpreterName), "#!/bin/sh\n", { mode: 0o755 });
    cleanup.push(root);
    return root;
  }

  it("returns null for empty input", () => {
    expect(resolvePythonVenv("")).toBeNull();
    expect(resolvePythonVenv("   ")).toBeNull();
  });

  it("treats a path ending in /bin/python3 as the interpreter and infers venv root", () => {
    const root = makeFakeVenv();
    const interpreter = path.join(root, "bin", "python3");
    const res = resolvePythonVenv(interpreter);
    expect(res).not.toBeNull();
    expect(res!.pythonBin).toBe(interpreter);
    expect(res!.binDir).toBe(path.join(root, "bin"));
    expect(res!.venvRoot).toBe(root);
  });

  it("treats a path ending in /bin/python (no 3) as the interpreter", () => {
    const root = makeFakeVenv({ interpreterName: "python" });
    const interpreter = path.join(root, "bin", "python");
    const res = resolvePythonVenv(interpreter);
    expect(res).not.toBeNull();
    expect(res!.pythonBin).toBe(interpreter);
  });

  it("treats any other path as a venv root and appends /bin/python3", () => {
    const root = makeFakeVenv();
    const res = resolvePythonVenv(root);
    expect(res).not.toBeNull();
    expect(res!.venvRoot).toBe(root);
    expect(res!.binDir).toBe(path.join(root, "bin"));
    expect(res!.pythonBin).toBe(path.join(root, "bin", "python3"));
  });

  it("prefers python3 over python when both exist at the venv root", () => {
    const root = makeFakeVenv(); // creates python3
    fs.writeFileSync(path.join(root, "bin", "python"), "#!/bin/sh\n", { mode: 0o755 });
    const res = resolvePythonVenv(root);
    expect(res!.pythonBin).toBe(path.join(root, "bin", "python3"));
  });

  it("falls back to python when only python exists", () => {
    const root = makeFakeVenv({ interpreterName: "python" });
    const res = resolvePythonVenv(root);
    expect(res!.pythonBin).toBe(path.join(root, "bin", "python"));
  });

  it("expands ~ as the supplied home dir", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nango-home-"));
    cleanup.push(home);
    const venvRel = "my-venv";
    const root = path.join(home, venvRel);
    fs.mkdirSync(path.join(root, "bin"), { recursive: true });
    fs.writeFileSync(path.join(root, "bin", "python3"), "#!/bin/sh\n", { mode: 0o755 });

    const res = resolvePythonVenv(`~/${venvRel}`, home);
    expect(res).not.toBeNull();
    expect(res!.venvRoot).toBe(root);
  });

  it("expands a bare ~ as the home dir itself", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nango-home-"));
    fs.mkdirSync(path.join(home, "bin"));
    fs.writeFileSync(path.join(home, "bin", "python3"), "#!/bin/sh\n", { mode: 0o755 });
    cleanup.push(home);

    const res = resolvePythonVenv("~", home);
    expect(res).not.toBeNull();
    expect(res!.venvRoot).toBe(home);
  });

  it("returns null when the inferred interpreter does not exist", () => {
    const res = resolvePythonVenv("/nonexistent/path/does/not/exist");
    expect(res).toBeNull();
  });
});
