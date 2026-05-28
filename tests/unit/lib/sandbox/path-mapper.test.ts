import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/config", () => ({
  getConfig: (key: string, defaultValue: string) => {
    if (key === "datasource.cache_root") return "/data/cache-test";
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

describe("path resolution", () => {
  it("resolveDatasetHostDir composes <root>/parquet/<name>", () => {
    expect(resolveDatasetHostDir("sales_q1")).toBe(
      "/data/cache-test/parquet/sales_q1",
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
    const m = buildMapping("/tmp/sandbox-abc", []);
    expect(maskOutput("hello world", m)).toBe("hello world");
  });

  it("rewrites the per-call tmp dir to `.`", () => {
    const m = buildMapping("/tmp/sandbox-abc", []);
    expect(maskOutput("error at /tmp/sandbox-abc/script.py:5", m)).toBe(
      "error at ./script.py:5",
    );
  });

  it("rewrites a declared dataset's host path (symlink-target form) to ./data/<name>", () => {
    const m = buildMapping("/tmp/sandbox-abc", ["sales_q1"]);
    const out = maskOutput(
      "read from /data/cache-test/parquet/sales_q1/part-001.parquet",
      m,
    );
    expect(out).toBe("read from ./data/sales_q1/part-001.parquet");
  });

  it("rewrites a declared dataset's symlink-path form (subprocess in-cwd absolute)", () => {
    const m = buildMapping("/tmp/sandbox-abc", ["sales_q1"]);
    const out = maskOutput(
      "FileNotFoundError: '/tmp/sandbox-abc/data/sales_q1/x.parquet'",
      m,
    );
    expect(out).toBe(
      "FileNotFoundError: './data/sales_q1/x.parquet'",
    );
  });

  it("rewrites docker container-path form (/work/data/<name>) to ./data/<name>", () => {
    const m = buildMapping("/tmp/sandbox-abc", ["sales_q1"]);
    const out = maskOutput(
      "duckdb: /work/data/sales_q1/part-001.parquet not found",
      m,
    );
    expect(out).toBe("duckdb: ./data/sales_q1/part-001.parquet not found");
  });

  it("rewrites the docker container's cwd /work to `.`", () => {
    const m = buildMapping("/tmp/sandbox-abc", []);
    expect(maskOutput("cwd: /work", m)).toBe("cwd: .");
  });

  it("masks multiple host paths in one string", () => {
    const m = buildMapping("/tmp/sandbox-abc", ["sales_q1"]);
    const out = maskOutput(
      "loaded /data/cache-test/parquet/sales_q1/part-001.parquet from " +
        "/tmp/sandbox-abc/script.py",
      m,
    );
    expect(out).toBe(
      "loaded ./data/sales_q1/part-001.parquet from ./script.py",
    );
  });

  it("falls back to ./data when an UNDECLARED dataset is mentioned", () => {
    const m = buildMapping("/tmp/sandbox-abc", []);
    const out = maskOutput(
      "found /data/cache-test/parquet/sales_q1/x.parquet",
      m,
    );
    expect(out).toBe("found ./data/sales_q1/x.parquet");
  });

  it("longest-host-path wins (declared dataset path over cache-root fallback)", () => {
    const m = buildMapping("/tmp/sandbox-abc", ["sales_q1"]);
    // Both `/data/cache-test/parquet` (cache-root fallback) and
    // `/data/cache-test/parquet/sales_q1` (declared dataset) match
    // the string `.../parquet/sales_q1`. The dataset rewrite must
    // win to avoid the cache-root rule producing `./data/parquet/
    // sales_q1`.
    const out = maskOutput(
      "x /data/cache-test/parquet/sales_q1 y",
      m,
    );
    expect(out).toBe("x ./data/sales_q1 y");
  });
});
