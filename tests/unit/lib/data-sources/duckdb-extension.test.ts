import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * SQL-contract tests for the DuckDB scanner-extension path. The native
 * module is mocked because a real `INSTALL postgres|mysql` needs
 * network access and an upstream database; the actual DuckDB engine is
 * exercised by the Vertica conversion suite instead.
 */
const h = vi.hoisted(() => ({
  sql: [] as string[],
  closed: [] as string[],
  created: 0,
  schemaRows: [] as Array<{ column_name: string; column_type: string; null: string }>,
  rowCount: 0 as number | string | bigint,
  previewRows: [] as Array<Record<string, unknown>>,
  failOn: null as RegExp | null,
  hangOn: null as RegExp | null,
}));

vi.mock("@duckdb/node-api", () => {
  class FakeConnection {
    async run(sql: string): Promise<void> {
      h.sql.push(sql);
      if (h.hangOn?.test(sql)) return new Promise<void>(() => {});
      if (h.failOn?.test(sql)) throw new Error(`mock duckdb failure: ${sql}`);
    }

    async runAndReadAll(sql: string) {
      h.sql.push(sql);
      if (h.failOn?.test(sql)) throw new Error(`mock duckdb failure: ${sql}`);
      if (sql.startsWith("DESCRIBE")) {
        return { getRowObjectsJson: () => h.schemaRows };
      }
      if (/SELECT count\(\*\)/.test(sql)) {
        return { getRowObjectsJson: () => [{ n: h.rowCount }] };
      }
      if (sql.startsWith("SELECT * FROM read_parquet")) {
        return { getRowObjectsJson: () => h.previewRows };
      }
      return { getRowObjectsJson: () => [] };
    }

    closeSync(): void {
      h.closed.push("connection");
    }
  }

  class FakeInstance {
    async connect(): Promise<FakeConnection> {
      return new FakeConnection();
    }

    closeSync(): void {
      h.closed.push("instance");
    }
  }

  return {
    DuckDBInstance: {
      async create(_path: string): Promise<FakeInstance> {
        h.created += 1;
        return new FakeInstance();
      },
    },
  };
});

import type { ExtractInput } from "@/lib/data-sources/types";
import {
  extractViaDuckdb,
  testConnectionViaDuckdb,
} from "@/lib/data-sources/duckdb-extension.server";

let tmpDir: string;
let outputPath: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "nango-duckdb-ext-"));
  outputPath = path.join(tmpDir, "part-001.parquet");
  h.sql.length = 0;
  h.closed.length = 0;
  h.created = 0;
  h.schemaRows = [];
  h.rowCount = 0;
  h.previewRows = [];
  h.failOn = null;
  h.hangOn = null;
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function makeInput(overrides: Partial<ExtractInput> = {}): ExtractInput {
  return {
    datasetName: "users",
    query: "SELECT * FROM users",
    outputPath,
    timeoutMs: 5_000,
    maxRows: 1_000,
    signal: new AbortController().signal,
    ...overrides,
  };
}

describe("extractViaDuckdb — bound parameters", () => {
  it("rejects params before creating a DuckDB instance", async () => {
    await expect(
      extractViaDuckdb({
        extension: "postgres",
        attachString: "host=db",
        input: makeInput({ params: { id: 1 } }),
      }),
    ).rejects.toThrow(/do not support bound parameters/);
    expect(h.created).toBe(0);
  });
});

describe("extractViaDuckdb — SQL sequence", () => {
  it("runs INSTALL → LOAD → ATTACH → COPY → introspect for postgres", async () => {
    await fs.writeFile(outputPath, "PAR1payload");
    h.schemaRows = [
      { column_name: "id", column_type: "INTEGER", null: "NO" },
      { column_name: "big", column_type: "BIGINT", null: "YES" },
      { column_name: "score", column_type: "DECIMAL(10,2)", null: "YES" },
      { column_name: "created", column_type: "TIMESTAMP WITH TIME ZONE", null: "YES" },
      { column_name: "day", column_type: "DATE", null: "YES" },
      { column_name: "ratio", column_type: "DOUBLE", null: "YES" },
      { column_name: "ok", column_type: "BOOLEAN", null: "YES" },
      { column_name: "doc", column_type: "JSON", null: "YES" },
    ];
    h.rowCount = "3";

    const result = await extractViaDuckdb({
      extension: "postgres",
      attachString: "host=db port=5432 dbname=app user=svc password=p'w",
      input: makeInput(),
    });

    expect(h.sql).toEqual([
      "INSTALL postgres;",
      "LOAD postgres;",
      "ATTACH 'host=db port=5432 dbname=app user=svc password=p''w' AS src (TYPE POSTGRES, READ_ONLY);",
      `COPY (SELECT * FROM users) TO '${outputPath}' (FORMAT PARQUET, COMPRESSION ZSTD, ROW_GROUP_SIZE 100000)`,
      `DESCRIBE SELECT * FROM read_parquet('${outputPath}')`,
      `SELECT count(*) AS n FROM read_parquet('${outputPath}')`,
    ]);
    expect(result.schema.columns).toEqual([
      { name: "id", type: "int32", nullable: false },
      { name: "big", type: "int64", nullable: true },
      { name: "score", type: "decimal", nullable: true },
      { name: "created", type: "timestamp", nullable: true },
      { name: "day", type: "date", nullable: true },
      { name: "ratio", type: "float64", nullable: true },
      { name: "ok", type: "bool", nullable: true },
      { name: "doc", type: "binary", nullable: true },
    ]);
    expect(result.schema.rowCount).toBe(3);
    expect(result.schema.byteSize).toBe(Buffer.byteLength("PAR1payload"));
    expect(result.rows).toEqual([]);
    expect(h.closed).toEqual(["connection", "instance"]);
  });

  it("quotes and pins the default schema for mysql", async () => {
    await extractViaDuckdb({
      extension: "mysql",
      attachString: "host=db port=3306 database=app user=svc password=p",
      defaultSchema: 'tenant"db',
      input: makeInput({ query: "SELECT 1" }),
    });

    expect(h.sql[3]).toBe('USE src."tenant""db";');
  });

  it("omits USE when no default schema is supplied", async () => {
    await extractViaDuckdb({
      extension: "postgres",
      attachString: "host=db",
      input: makeInput(),
    });

    expect(h.sql.some((sql) => sql.startsWith("USE "))).toBe(false);
  });
});

describe("extractViaDuckdb — preview rows", () => {
  it("returns at most previewRows rows from the written Parquet", async () => {
    h.rowCount = 10;
    h.previewRows = [{ id: "1" }, { id: "2" }];

    const result = await extractViaDuckdb({
      extension: "postgres",
      attachString: "host=db",
      input: makeInput({ previewRows: 2 }),
    });

    expect(result.rows).toEqual([{ id: "1" }, { id: "2" }]);
    expect(h.sql.at(-1)).toBe(
      `SELECT * FROM read_parquet('${outputPath}') LIMIT 2`,
    );
  });

  it("skips the preview query when previewRows is 0", async () => {
    h.rowCount = 10;
    h.previewRows = [{ id: "1" }];

    const result = await extractViaDuckdb({
      extension: "postgres",
      attachString: "host=db",
      input: makeInput({ previewRows: 0 }),
    });

    expect(result.rows).toEqual([]);
    expect(
      h.sql.some((sql) => sql.startsWith("SELECT * FROM read_parquet")),
    ).toBe(false);
  });

  it("skips the preview query when the result set is empty", async () => {
    h.rowCount = 0;
    h.previewRows = [{ id: "1" }];

    const result = await extractViaDuckdb({
      extension: "postgres",
      attachString: "host=db",
      input: makeInput({ previewRows: 5 }),
    });

    expect(result.rows).toEqual([]);
    expect(
      h.sql.some((sql) => sql.startsWith("SELECT * FROM read_parquet")),
    ).toBe(false);
  });
});

describe("extractViaDuckdb — guards", () => {
  it("aborts when the extracted row count exceeds maxRows", async () => {
    h.rowCount = 5;

    await expect(
      extractViaDuckdb({
        extension: "postgres",
        attachString: "host=db",
        input: makeInput({ maxRows: 4 }),
      }),
    ).rejects.toThrow(/exceeds maxRows=4/);
    expect(h.closed).toEqual(["connection", "instance"]);
  });

  it("rejects when the wall-clock budget is exceeded", async () => {
    h.hangOn = /^INSTALL/;

    await expect(
      extractViaDuckdb({
        extension: "postgres",
        attachString: "host=db",
        input: makeInput({ timeoutMs: 5 }),
      }),
    ).rejects.toThrow(/exceeded 5ms wall-clock budget/);
    expect(h.closed).toEqual(["connection", "instance"]);
  });

  it("rejects immediately when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      extractViaDuckdb({
        extension: "postgres",
        attachString: "host=db",
        input: makeInput({ signal: controller.signal }),
      }),
    ).rejects.toThrow(/cancelled/);
    expect(h.closed).toEqual(["connection", "instance"]);
  });
});

describe("testConnectionViaDuckdb", () => {
  it("installs the extension, attaches as probe, and reports ok", async () => {
    const result = await testConnectionViaDuckdb({
      extension: "mysql",
      attachString: "host=db port=3306 database=app user=svc password=p",
      signal: new AbortController().signal,
    });

    expect(result.ok).toBe(true);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(h.sql).toEqual([
      "INSTALL mysql;",
      "LOAD mysql;",
      "ATTACH 'host=db port=3306 database=app user=svc password=p' AS probe (TYPE MYSQL, READ_ONLY);",
      "SELECT 1 FROM probe.information_schema.tables LIMIT 1",
    ]);
    expect(h.closed).toEqual(["connection", "instance"]);
  });

  it("returns ok:false with the error message instead of throwing", async () => {
    h.failOn = /^INSTALL/;

    const result = await testConnectionViaDuckdb({
      extension: "postgres",
      attachString: "host=db",
      signal: new AbortController().signal,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/mock duckdb failure/);
    expect(h.closed).toEqual(["connection", "instance"]);
  });
});
