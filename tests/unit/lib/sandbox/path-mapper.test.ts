import { describe, expect, it, vi } from "vitest";
import * as path from "node:path";

const CACHE_ROOT = path.resolve("/data/cache-test");
const TMP_DIR = path.resolve("/tmp/sandbox-abc");

vi.mock("@/lib/config", () => ({
  getConfig: (key: string, defaultValue: string) => {
    if (key === "datasource.cache_root") return CACHE_ROOT;
    return defaultValue;
  },
}));

import {
  buildMapping,
  DOCKER_CONTAINER_WORKDIR,
  maskOutput,
  resolveDatasetHostDir,
  SANDBOX_DATA_DIR,
} from "@/lib/sandbox/path-mapper";

function normalizeSlashes(s: string) {
  return s.replace(/\\/g, "/");
}

describe("path resolution", () => {
  it("resolveDatasetHostDir composes <root>/parquet/<name>", () => {
    expect(normalizeSlashes(resolveDatasetHostDir("sales_q1"))).toBe(
      normalizeSlashes(path.join(CACHE_ROOT, "parquet", "sales_q1"))
    );
  });

  it("exposes the in-sandbox cwd-relative subdir name", () => {
    expect(SANDBOX_DATA_DIR).toBe("data");
  });

  it("exposes the docker container's working directory", () => {
    expect(DOCKER_CONTAINER_WORKDIR).toBe("/work");
  });
});

describe("maskOutput", () => {
  it("returns input unchanged when nothing matches", () => {
    const m = buildMapping(TMP_DIR, []);
    expect(maskOutput("hello world", m)).toBe("hello world");
  });

  it("rewrites the per-call tmp dir to `.`", () => {
    const m = buildMapping(TMP_DIR, []);
    expect(normalizeSlashes(maskOutput(`error at ${path.join(TMP_DIR, "script.py")}:5`, m))).toBe(
      "error at ./script.py:5"
    );
  });

  it("rewrites a declared dataset's host path (symlink-target form) to ./data/<name>", () => {
    const m = buildMapping(TMP_DIR, ["sales_q1"]);
    const out = maskOutput(
      `read from ${path.join(CACHE_ROOT, "parquet", "sales_q1", "part-001.parquet")}`,
      m
    );
    expect(normalizeSlashes(out)).toBe("read from ./data/sales_q1/part-001.parquet");
  });

  it("rewrites a declared dataset's symlink-path form (subprocess in-cwd absolute)", () => {
    const m = buildMapping(TMP_DIR, ["sales_q1"]);
    const out = maskOutput(
      `FileNotFoundError: '${path.join(TMP_DIR, "data", "sales_q1", "x.parquet")}'`,
      m
    );
    expect(normalizeSlashes(out)).toBe(
      "FileNotFoundError: './data/sales_q1/x.parquet'"
    );
  });

  it("rewrites docker container-path form (/work/data/<name>) to ./data/<name>", () => {
    const m = buildMapping(TMP_DIR, ["sales_q1"]);
    const out = maskOutput(
      "duckdb: /work/data/sales_q1/part-001.parquet not found",
      m
    );
    expect(out).toBe("duckdb: ./data/sales_q1/part-001.parquet not found");
  });

  it("rewrites the docker container's cwd /work to `.`", () => {
    const m = buildMapping(TMP_DIR, []);
    expect(maskOutput("cwd: /work", m)).toBe("cwd: .");
  });

  it("masks multiple host paths in one string", () => {
    const m = buildMapping(TMP_DIR, ["sales_q1"]);
    const out = maskOutput(
      `loaded ${path.join(CACHE_ROOT, "parquet", "sales_q1", "part-001.parquet")} from ` +
        path.join(TMP_DIR, "script.py"),
      m
    );
    expect(normalizeSlashes(out)).toBe(
      "loaded ./data/sales_q1/part-001.parquet from ./script.py"
    );
  });

  it("falls back to ./data when an UNDECLARED dataset is mentioned", () => {
    const m = buildMapping(TMP_DIR, []);
    const out = maskOutput(
      `found ${path.join(CACHE_ROOT, "parquet", "sales_q1", "x.parquet")}`,
      m
    );
    expect(normalizeSlashes(out)).toBe("found ./data/sales_q1/x.parquet");
  });

  it("longest-host-path wins (declared dataset path over cache-root fallback)", () => {
    const m = buildMapping(TMP_DIR, ["sales_q1"]);
    const out = maskOutput(
      `x ${path.join(CACHE_ROOT, "parquet", "sales_q1")} y`,
      m
    );
    expect(normalizeSlashes(out)).toBe("x ./data/sales_q1 y");
  });
});
