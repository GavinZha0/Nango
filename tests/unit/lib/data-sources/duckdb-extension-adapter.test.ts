import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Wiring tests for the DuckDB-extension adapter factory: ATTACH string
 * shape, default-schema policy per provider, and admin-facing error
 * sanitization. The DuckDB engine itself is mocked out — these are
 * pure contract assertions.
 */
const h = vi.hoisted(() => ({
  extractCalls: [] as Array<Record<string, unknown>>,
  testCalls: [] as Array<Record<string, unknown>>,
  testError: null as Error | null,
}));

vi.mock("@/lib/data-sources/duckdb-extension.server", () => ({
  extractViaDuckdb: async (args: Record<string, unknown>) => {
    h.extractCalls.push(args);
    return {
      schema: { columns: [], rowCount: 0, byteSize: 0 },
      rows: [],
      queryHash: "hash",
    };
  },
  testConnectionViaDuckdb: async (args: Record<string, unknown>) => {
    h.testCalls.push(args);
    if (h.testError) throw h.testError;
    return { ok: true, latencyMs: 7 };
  },
}));

import { createDuckdbExtensionAdapter } from "@/lib/data-sources/duckdb-extension-adapter.server";
import { extractFromMariadb } from "@/lib/data-sources/mariadb/extract.server";
import { extractFromMysql } from "@/lib/data-sources/mysql/extract.server";
import { extractFromPostgres } from "@/lib/data-sources/postgres/extract.server";
import type { ExtractInput, ResolvedDataSource } from "@/lib/data-sources/types";

const input: ExtractInput = {
  datasetName: "users",
  query: "SELECT * FROM users",
  outputPath: "/tmp/users/part-001.parquet",
  timeoutMs: 10_000,
  maxRows: 100,
  signal: new AbortController().signal,
};

function fakeResolved(
  overrides: Partial<ResolvedDataSource> = {},
): ResolvedDataSource {
  return {
    id: "ds-uuid-1",
    name: "users_dev",
    provider: "postgres",
    host: "db.local",
    port: 5432,
    database: "app",
    params: {},
    username: "svc",
    password: "secret",
    policy: { readOnly: false, tableAllowlist: null, tableDenylist: [] },
    ...overrides,
  };
}

beforeEach(() => {
  h.extractCalls.length = 0;
  h.testCalls.length = 0;
  h.testError = null;
});

describe("createDuckdbExtensionAdapter — extract wiring", () => {
  it("postgres uses dbname and falls back to params.schema", async () => {
    const adapter = createDuckdbExtensionAdapter({
      extension: "postgres",
      pinDefaultSchema: false,
    });

    await adapter.extract(
      fakeResolved({ params: { schema: "analytics" } }),
      input,
    );

    expect(h.extractCalls[0]).toEqual({
      extension: "postgres",
      attachString:
        "host=db.local port=5432 dbname=app user=svc password=secret",
      defaultSchema: "analytics",
      input,
    });
  });

  it("postgres defaults the schema to public", async () => {
    const adapter = createDuckdbExtensionAdapter({
      extension: "postgres",
      pinDefaultSchema: false,
    });

    await adapter.extract(fakeResolved(), input);

    expect(h.extractCalls[0]).toMatchObject({ defaultSchema: "public" });
  });

  it("mysql pins the database as schema even when params.schema is set", async () => {
    const adapter = createDuckdbExtensionAdapter({
      extension: "mysql",
      pinDefaultSchema: true,
    });

    await adapter.extract(
      fakeResolved({
        provider: "mysql",
        port: 3306,
        database: "shop",
        params: { schema: "ignored" },
      }),
      input,
    );

    expect(h.extractCalls[0]).toEqual({
      extension: "mysql",
      attachString:
        "host=db.local port=3306 database=shop user=svc password=secret",
      defaultSchema: "shop",
      input,
    });
  });
});

describe("createDuckdbExtensionAdapter — testConnection wiring", () => {
  it("forwards the attach string and abort signal", async () => {
    const adapter = createDuckdbExtensionAdapter({
      extension: "postgres",
      pinDefaultSchema: false,
    });
    const controller = new AbortController();

    const result = await adapter.testConnection(
      fakeResolved(),
      controller.signal,
    );

    expect(result).toEqual({ ok: true, latencyMs: 7 });
    expect(h.testCalls[0]).toEqual({
      extension: "postgres",
      attachString:
        "host=db.local port=5432 dbname=app user=svc password=secret",
      signal: controller.signal,
    });
  });

  it("converts a thrown error into a sanitized ok:false result", async () => {
    h.testError = new Error("failed: password=hunter2 host=db.local");
    const adapter = createDuckdbExtensionAdapter({
      extension: "postgres",
      pinDefaultSchema: false,
    });

    const result = await adapter.testConnection(
      fakeResolved(),
      new AbortController().signal,
    );

    expect(result.ok).toBe(false);
    expect(result.latencyMs).toBe(0);
    expect(result.error).toContain("password=******");
    expect(result.error).not.toContain("hunter2");
  });
});

describe("provider extract modules", () => {
  it("wire postgres to the postgres extension and public schema", async () => {
    await extractFromPostgres(fakeResolved(), input);

    expect(h.extractCalls[0]).toMatchObject({
      extension: "postgres",
      defaultSchema: "public",
    });
  });

  it("wire mysql to the mysql extension and the database schema", async () => {
    await extractFromMysql(
      fakeResolved({ provider: "mysql", database: "shop" }),
      input,
    );

    expect(h.extractCalls[0]).toMatchObject({
      extension: "mysql",
      defaultSchema: "shop",
    });
  });

  it("wire mariadb to the mysql extension and the database schema", async () => {
    await extractFromMariadb(
      fakeResolved({ provider: "mariadb", database: "erp" }),
      input,
    );

    expect(h.extractCalls[0]).toMatchObject({
      extension: "mysql",
      defaultSchema: "erp",
    });
  });
});
