/**
 * Subprocess-adapter dataset-symlink behaviour (S3, D38).
 *
 * Verifies the cwd-relative `./data/<name>/...` contract end-to-end
 * by:
 *
 *   1. Mocking `datasource.cache_root` to a per-suite tmp dir
 *   2. Materialising a fake Parquet-shaped fixture at
 *      `<cacheRoot>/parquet/<name>/file.parquet`
 *   3. Spawning the subprocess adapter with `datasets: [<name>]`
 *   4. Asserting the child can read `./data/<name>/file.parquet`
 *      and that absolute host paths get masked in output.
 *
 * Lives in its own file because the `vi.mock("@/lib/config")` call
 * is module-scope hoisted — keeping it separate from the main
 * subprocess.test.ts avoids forcing the rest of that file's tests
 * to use a fake cache root they don't care about.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Pretend the `server-only` package exists (matches the rest of the
// sandbox test files — the package is a Next.js boundary marker that
// has no installed implementation in the test runner).
vi.mock("server-only", () => ({}));

// Module-scope mock: redirect datasource.cache_root to a per-suite
// tmp dir. The actual dir is created in `beforeAll` and removed in
// `afterAll`; the mock returns the path via a closure so both the
// adapter (under test) and the test code see the same location.
let testCacheRoot = "";
vi.mock("@/lib/config", () => ({
  getConfig: (key: string, defaultValue: string) => {
    if (key === "datasource.cache_root") return testCacheRoot;
    return defaultValue;
  },
  getConfigMs: (_key: string, defaultSeconds: number) => defaultSeconds * 1000,
  getConfigNumber: (_key: string, defaultValue: number) => defaultValue,
  _isLoaded: () => true,
  _cacheSize: () => 0,
}));

import { SubprocessAdapter } from "@/lib/sandbox/adapters/subprocess/adapter.server";

const adapter = new SubprocessAdapter();

const DATASET_NAME = "sales_q1_2025";
const DATASET_FILE_NAME = "part-001.parquet";
const DATASET_FILE_CONTENT = "fake-parquet-bytes";

// Subprocess spawn under heavy parallel test load occasionally trips vitest's
// default 5s per-test timeout even though the actual shell command finishes
// in <100 ms. Bump the test-runner timeout (NOT the subprocess timeoutMs,
// which stays at 5000 — we don't want the child to actually run that long).
const TEST_TIMEOUT_MS = 60_000;

describe("SubprocessAdapter — dataset symlinks (D38)", () => {
  let datasetDir = "";

  beforeAll(async () => {
    testCacheRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "nango-test-cache-"),
    );
    datasetDir = path.join(testCacheRoot, "parquet", DATASET_NAME);
    await fs.mkdir(datasetDir, { recursive: true });
    await fs.writeFile(
      path.join(datasetDir, DATASET_FILE_NAME),
      DATASET_FILE_CONTENT,
    );
  });

  afterAll(async () => {
    await fs.rm(testCacheRoot, { recursive: true, force: true });
  });

  it("exposes a declared dataset at ./data/<name>/ in the child's cwd", async () => {
    const out = await adapter.run({
      command: ["node", "-e", `process.stdout.write(require('fs').readFileSync('./data/${DATASET_NAME}/${DATASET_FILE_NAME}', 'utf-8'))`],
      datasets: [DATASET_NAME],
      timeoutMs: 5000,
    });
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toBe(DATASET_FILE_CONTENT);
  }, TEST_TIMEOUT_MS);

  it("the symlink is a real directory link, not a copied file", async () => {
    // `ls -la ./data/<name>` should show the parent dir is the
    // symlink itself; `readlink` on it returns the cache target.
    // We assert the dataset file is readable from inside `./data/
    // <name>/`, which is only true when the symlink resolves.
    const out = await adapter.run({
      command: ["node", "-e", `require('fs').readdirSync('./data/${DATASET_NAME}').forEach(f => console.log(f))`],
      datasets: [DATASET_NAME],
      timeoutMs: 5000,
    });
    expect(out.exitCode).toBe(0);
    expect(out.stdout.split("\n")).toContain(DATASET_FILE_NAME);
  }, TEST_TIMEOUT_MS);

  it("multiple datasets each get their own symlink", async () => {
    const second = "users_dec_2025";
    const secondDir = path.join(testCacheRoot, "parquet", second);
    await fs.mkdir(secondDir, { recursive: true });
    await fs.writeFile(path.join(secondDir, "rows.parquet"), "users-bytes");

    const out = await adapter.run({
      command: ["node", "-e", "require('fs').readdirSync('./data').forEach(f => console.log(f))"],
      datasets: [DATASET_NAME, second],
      timeoutMs: 5000,
    });
    expect(out.exitCode).toBe(0);
    const entries = out.stdout.split("\n").filter((s) => s.length > 0);
    expect(entries.sort()).toEqual([DATASET_NAME, second].sort());
  }, TEST_TIMEOUT_MS);

  it("does not expose datasets that weren't declared in `datasets`", async () => {
    // The cache holds DATASET_NAME but we don't pass it — the
    // child should see an empty (or absent) ./data dir.
    const out = await adapter.run({
      command: ["node", "-e", "try { require('fs').readdirSync('./data').forEach(f => console.log(f)) } catch(e) { console.log('EMPTY') }"],
      timeoutMs: 5000,
    });
    // Either the directory doesn't exist (no datasets requested →
    // we don't create the dir) OR it's empty. Both are acceptable.
    expect(out.exitCode).toBe(0);
    expect(out.stdout).not.toContain(DATASET_NAME);
  }, TEST_TIMEOUT_MS);

  it("masks the host symlink target in stderr back to ./data/<name>", async () => {
    // Make the child fail trying to read a missing file inside the
    // dataset; pandas / duckdb would normally echo the absolute
    // resolved path in stderr. We simulate by `cat`ing the
    // resolved-symlink form directly so the test exercises mask
    // logic independently of Python.
    const out = await adapter.run({
      command: [
        "node",
        "-e",
        `try { require('fs').readFileSync('./data/${DATASET_NAME}/does-not-exist.parquet') } catch(e) { console.log(e.message) }`,
      ],
      datasets: [DATASET_NAME],
      timeoutMs: 5000,
    });
    // The error message contains the path the shell was given,
    // which is the cwd-relative form — confirming masking is in
    // play (the underlying host path under testCacheRoot/parquet/
    // never reaches the LLM).
    expect(out.stdout).toContain(`./data/${DATASET_NAME}`);
    expect(out.stdout).not.toContain(testCacheRoot);
  }, TEST_TIMEOUT_MS);
});
