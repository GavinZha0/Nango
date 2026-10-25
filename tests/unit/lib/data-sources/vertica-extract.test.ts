import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Vertica extraction runs the real DuckDB engine (NDJSON → Parquet →
 * DESCRIBE → preview) and only mocks the upstream Vertica client, so
 * this suite doubles as the offline regression check for the native
 * `@duckdb/node-api` upgrade.
 */
const h = vi.hoisted(() => ({
  clientConfigs: [] as Array<Record<string, unknown>>,
  queries: [] as string[],
  connectCalls: 0,
  endCalls: 0,
  rows: [] as Array<Record<string, unknown>>,
  rowCount: null as number | null,
  failConnect: false,
  failOnQuery: null as RegExp | null,
}));

vi.mock("vertica-nodejs", () => {
  class FakeClient {
    constructor(config: Record<string, unknown>) {
      h.clientConfigs.push(config);
    }

    async connect(): Promise<void> {
      h.connectCalls += 1;
      if (h.failConnect) throw new Error("connect refused");
    }

    async query(arg: string | { text: string }) {
      const sql = typeof arg === "string" ? arg : arg.text;
      h.queries.push(sql);
      if (h.failOnQuery?.test(sql)) throw new Error("vertica exploded");
      if (sql.trim().toUpperCase().startsWith("SELECT")) {
        return {
          rows: h.rows,
          fields: [],
          rowCount: h.rowCount ?? h.rows.length,
        };
      }
      return { rows: [], fields: [], rowCount: 0 };
    }

    async end(): Promise<void> {
      h.endCalls += 1;
    }
  }

  return { default: { Client: FakeClient } };
});

import { hashQuery } from "@/lib/data-sources/cache";
import type { ExtractInput, ResolvedDataSource } from "@/lib/data-sources/types";
import {
  extractFromVertica,
  testVerticaConnection,
} from "@/lib/data-sources/vertica/extract.server";

let tmpDir: string;
let outputPath: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "nango-vertica-"));
  outputPath = path.join(tmpDir, "part-001.parquet");
  h.clientConfigs.length = 0;
  h.queries.length = 0;
  h.connectCalls = 0;
  h.endCalls = 0;
  h.rows = [];
  h.rowCount = null;
  h.failConnect = false;
  h.failOnQuery = null;
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function fakeResolved(
  overrides: Partial<ResolvedDataSource> = {},
): ResolvedDataSource {
  return {
    id: "ds-uuid-1",
    name: "sales_dev",
    provider: "vertica",
    host: "vertica.local",
    port: 5433,
    database: "warehouse",
    params: {},
    username: "svc",
    password: "secret",
    policy: { readOnly: false, tableAllowlist: null, tableDenylist: [] },
    ...overrides,
  };
}

function makeInput(overrides: Partial<ExtractInput> = {}): ExtractInput {
  return {
    datasetName: "sales",
    query: "SELECT * FROM sales",
    outputPath,
    timeoutMs: 10_000,
    maxRows: 1_000,
    signal: new AbortController().signal,
    ...overrides,
  };
}

describe("extractFromVertica — conversion", () => {
  it("writes Parquet, introspects the schema, and returns preview rows", async () => {
    h.rows = [
      { id: 1, name: "alice", active: true, score: 1.5 },
      { id: 2, name: "bob", active: false, score: 2.5 },
    ];

    const result = await extractFromVertica(
      fakeResolved(),
      makeInput({ previewRows: 1 }),
    );

    expect(result.schema.rowCount).toBe(2);
    expect(result.schema.columns).toEqual([
      { name: "id", type: "int64", nullable: true },
      { name: "name", type: "string", nullable: true },
      { name: "active", type: "bool", nullable: true },
      { name: "score", type: "float64", nullable: true },
    ]);
    expect(result.schema.byteSize).toBeGreaterThan(0);
    expect(result.rows).toHaveLength(1);
    expect(result.rows?.[0]).toMatchObject({
      id: "1",
      name: "alice",
      active: true,
      score: 1.5,
    });
    expect(result.queryHash).toBe(hashQuery("SELECT * FROM sales"));
    expect(h.connectCalls).toBe(1);
    expect(h.endCalls).toBe(1);
  });

  it("leaves only the Parquet file behind (NDJSON temp is removed)", async () => {
    h.rows = [{ id: 1, name: "alice" }];

    await extractFromVertica(fakeResolved(), makeInput());

    await expect(fs.readdir(tmpDir)).resolves.toEqual(["part-001.parquet"]);
  });

  it("applies params.schema as the search_path before the query", async () => {
    h.rows = [{ id: 1 }];

    await extractFromVertica(
      fakeResolved({ params: { schema: "analytics" } }),
      makeInput(),
    );

    expect(h.queries).toEqual([
      'SET search_path TO "analytics"',
      "SELECT * FROM sales",
    ]);
  });

  it("omits the preview query when previewRows is not requested", async () => {
    h.rows = [{ id: 1, name: "alice" }];

    const result = await extractFromVertica(fakeResolved(), makeInput());

    expect(result.rows).toEqual([]);
  });
});

describe("extractFromVertica — guards", () => {
  it("rejects bound params before opening a Vertica client", async () => {
    await expect(
      extractFromVertica(fakeResolved(), makeInput({ params: { id: 1 } })),
    ).rejects.toThrow(/does not support bound parameters/);

    expect(h.connectCalls).toBe(0);
    expect(h.clientConfigs).toHaveLength(0);
  });

  it("aborts when Vertica returns more rows than maxRows", async () => {
    h.rows = [{ id: 1 }, { id: 2 }, { id: 3 }];

    await expect(
      extractFromVertica(fakeResolved(), makeInput({ maxRows: 2 })),
    ).rejects.toThrow(/exceeds maxRows=2/);

    await expect(fs.stat(outputPath)).rejects.toThrow();
    await expect(fs.readdir(tmpDir)).resolves.toEqual([]);
    expect(h.endCalls).toBe(1);
  });

  it("rejects immediately when the signal is already aborted", async () => {
    h.rows = [{ id: 1 }];
    const controller = new AbortController();
    controller.abort();

    await expect(
      extractFromVertica(fakeResolved(), makeInput({ signal: controller.signal })),
    ).rejects.toThrow(/cancelled/);

    await expect(fs.stat(outputPath)).rejects.toThrow();
    expect(h.endCalls).toBe(1);
  });

  it("propagates a query failure and still closes the client", async () => {
    h.failOnQuery = /SELECT \* FROM sales/;

    await expect(extractFromVertica(fakeResolved(), makeInput())).rejects.toThrow(
      /vertica exploded/,
    );

    await expect(fs.stat(outputPath)).rejects.toThrow();
    expect(h.endCalls).toBe(1);
  });
});

describe("testVerticaConnection", () => {
  it("reports ok and passes connection params with tls disabled by default", async () => {
    const result = await testVerticaConnection(
      fakeResolved(),
      new AbortController().signal,
    );

    expect(result.ok).toBe(true);
    expect(h.clientConfigs[0]).toEqual({
      host: "vertica.local",
      port: 5433,
      user: "svc",
      password: "secret",
      database: "warehouse",
      tls_mode: "disable",
    });
    expect(h.endCalls).toBe(1);
  });

  it("returns ok:false when the client cannot connect", async () => {
    h.failConnect = true;

    const result = await testVerticaConnection(
      fakeResolved(),
      new AbortController().signal,
    );

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/connect refused/);
  });
});
