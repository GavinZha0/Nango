import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mockRun = vi.fn();
const mockCloseSyncConn = vi.fn();
const mockCloseSyncDb = vi.fn();

vi.mock("@duckdb/node-api", () => ({
  DuckDBInstance: {
    create: vi.fn(async () => ({
      connect: vi.fn(async () => ({
        run: (...args: unknown[]) => mockRun(...args),
        closeSync: () => mockCloseSyncConn(),
      })),
      closeSync: () => mockCloseSyncDb(),
    })),
  },
}));

const mockGetEnabledInfrastructureCredentialByProvider = vi.fn();
vi.mock("@/lib/credentials/lookup", () => ({
  getEnabledInfrastructureCredentialByProvider: (...args: unknown[]) =>
    mockGetEnabledInfrastructureCredentialByProvider(...args),
}));

import {
  normalizeAndValidateQuackHost,
  openDuckdbConnection,
  validateQuackToken,
} from "@/lib/data-sources/duckdb-connection.server";
import { extractViaDuckdb } from "@/lib/data-sources/duckdb-extension.server";

describe("duckdb-connection.server — validation helpers", () => {
  it("normalizes and validates Quack host:port strings", () => {
    expect(normalizeAndValidateQuackHost("127.0.0.1:9494")).toBe(
      "127.0.0.1:9494",
    );
    expect(normalizeAndValidateQuackHost("quack:duck.internal:9494")).toBe(
      "duck.internal:9494",
    );
    expect(normalizeAndValidateQuackHost("http://127.0.0.1:9494/")).toBe(
      "127.0.0.1:9494",
    );

    expect(() => normalizeAndValidateQuackHost("localhost")).toThrow(
      /Invalid duckdb-server host:port format/,
    );
    expect(() =>
      normalizeAndValidateQuackHost("127.0.0.1:9494'; DROP TABLE x; --"),
    ).toThrow(/Invalid duckdb-server host:port format/);
  });

  it("validates Quack tokens and never echoes rejected token values", () => {
    expect(validateQuackToken("quack_tok-123.abc+def/xyz=")).toBe(
      "quack_tok-123.abc+def/xyz=",
    );

    const malicious = "secret' OR '1'='1";
    try {
      validateQuackToken(malicious);
      expect.unreachable("should have thrown");
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toMatch(/Invalid duckdb-server token characters/);
      expect(msg).not.toContain(malicious);
    }
  });
});

describe("duckdb-connection.server — openDuckdbConnection", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.NANGO_DUCKDB_EXTENSION_DIR;
    mockRun.mockReset();
    mockCloseSyncConn.mockReset();
    mockCloseSyncDb.mockReset();
    mockGetEnabledInfrastructureCredentialByProvider.mockReset();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("defaults to Mode A (local in-process) when no duckdb-server credential is enabled", async () => {
    mockGetEnabledInfrastructureCredentialByProvider.mockResolvedValueOnce(null);

    const handle = await openDuckdbConnection();

    expect(handle.isRemoteQuack).toBe(false);
    expect(mockRun).not.toHaveBeenCalled();
  });

  it("sets extension_directory when NANGO_DUCKDB_EXTENSION_DIR is configured", async () => {
    process.env.NANGO_DUCKDB_EXTENSION_DIR = "C:\\Users\\O'Connor\\ext";
    mockGetEnabledInfrastructureCredentialByProvider.mockResolvedValueOnce(null);

    const handle = await openDuckdbConnection();

    expect(handle.isRemoteQuack).toBe(false);
    expect(mockRun).toHaveBeenCalledWith(
      "SET extension_directory = 'C:\\Users\\O''Connor\\ext';",
    );
  });

  it("routes via Mode B (ATTACH quack + CONNECT remote_db) when duckdb-server credential is enabled", async () => {
    mockGetEnabledInfrastructureCredentialByProvider.mockResolvedValueOnce({
      id: "cred-duck",
      provider: "duckdb-server",
      host: "127.0.0.1:9494",
      apiKey: "super_secret_quack_token",
    });

    const handle = await openDuckdbConnection();

    expect(handle.isRemoteQuack).toBe(true);
    expect(mockRun).toHaveBeenNthCalledWith(
      1,
      "ATTACH 'quack:127.0.0.1:9494' AS remote_db (TOKEN 'super_secret_quack_token');",
    );
    expect(mockRun).toHaveBeenNthCalledWith(2, "CONNECT remote_db;");
  });

  it("omits TOKEN clause in Mode B when duckdb-server apiKey is empty", async () => {
    mockGetEnabledInfrastructureCredentialByProvider.mockResolvedValueOnce({
      id: "cred-duck",
      provider: "duckdb-server",
      host: "127.0.0.1:9494",
      apiKey: "",
    });

    const handle = await openDuckdbConnection();

    expect(handle.isRemoteQuack).toBe(true);
    expect(mockRun).toHaveBeenNthCalledWith(
      1,
      "ATTACH 'quack:127.0.0.1:9494' AS remote_db;",
    );
    expect(mockRun).toHaveBeenNthCalledWith(2, "CONNECT remote_db;");
  });

  it("fails fast in extractViaDuckdb when Mode B COPY output is missing from local filesystem", async () => {
    mockGetEnabledInfrastructureCredentialByProvider.mockResolvedValueOnce({
      id: "cred-duck",
      provider: "duckdb-server",
      host: "127.0.0.1:9494",
      apiKey: "super_secret_quack_token",
    });

    await expect(
      extractViaDuckdb({
        extension: "postgres",
        attachString: "host=localhost port=5432 dbname=app",
        input: {
          datasetName: "ds_remote_missing",
          query: "SELECT 1 AS id",
          outputPath: "/nonexistent/remote-only-cache/part-001.parquet",
          timeoutMs: 5000,
          maxRows: 1000,
          signal: new AbortController().signal,
        },
      }),
    ).rejects.toThrow(
      /Remote DuckDB Server \(Mode B\) writes COPY output to the remote server's filesystem and requires a shared cache directory/,
    );
  });

  it("bypasses remote Quack routing when forceLocal: true is passed (Vertica path)", async () => {
    const handle = await openDuckdbConnection({ forceLocal: true });

    expect(handle.isRemoteQuack).toBe(false);
    expect(mockGetEnabledInfrastructureCredentialByProvider).not.toHaveBeenCalled();
    expect(mockRun).not.toHaveBeenCalled();
  });

  it("scrubs secret token and closes handles if ATTACH fails", async () => {
    mockGetEnabledInfrastructureCredentialByProvider.mockResolvedValueOnce({
      id: "cred-duck",
      provider: "duckdb-server",
      host: "127.0.0.1:9494",
      apiKey: "my_secret_token_value",
    });
    mockRun.mockRejectedValueOnce(
      new Error("Syntax error near TOKEN 'my_secret_token_value'"),
    );

    await expect(openDuckdbConnection()).rejects.toThrow(
      /Failed to connect to remote DuckDB Quack server at 127\.0\.0\.1:9494:.*\*\*\*/,
    );
    expect(mockCloseSyncConn).toHaveBeenCalledTimes(1);
    expect(mockCloseSyncDb).toHaveBeenCalledTimes(1);
  });
});
