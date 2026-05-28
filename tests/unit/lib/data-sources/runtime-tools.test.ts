import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

let mockCacheRoot = "";
vi.mock("@/lib/config", () => ({
  getConfig: (key: string, defaultValue: string) => {
    if (key === "datasource.cache_root") return mockCacheRoot;
    return defaultValue;
  },
  getConfigNumber: (_key: string, defaultValue: number) => defaultValue,
  getConfigMs: (_key: string, defaultSeconds: number) => defaultSeconds * 1000,
  getConfigBoolean: (_key: string, defaultValue: boolean) => defaultValue,
}));

import type { ResolvedDataSource } from "@/lib/data-sources/types";

const mockResolveByName = vi.fn();
vi.mock("@/lib/data-sources/lookup", () => ({
  resolveDataSourceByName: (n: string) => mockResolveByName(n),
}));

const mockExtract = vi.fn();
const mockTestConnection = vi.fn();
vi.mock("@/lib/data-sources/registry.server", () => ({
  getDataSource: (id: string) => ({
    id,
    adapter: { id, category: "database" as const },
    extract: mockExtract,
    testConnection: mockTestConnection,
  }),
  SOURCES: {} as Record<string, unknown>,
}));

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { DuckDBInstance } from "@duckdb/node-api";

import { buildExtractDatasetTool } from "@/lib/data-sources/runtime-tools";
import { hashQuery, validateDatasetName } from "@/lib/data-sources/cache";

let tmpRoot: string;

/** Build a fresh `ResolvedDataSource` with default permissive policy.
 *  Tests that need restricted policy override the relevant fields. */
function fakeResolved(overrides: Partial<ResolvedDataSource> = {}): ResolvedDataSource {
  return {
    id: "ds-uuid-1",
    name: "users_dev",
    provider: "postgres",
    host: "localhost",
    port: 5432,
    database: "app",
    params: {},
    username: "svc",
    password: "secret",
    policy: { readOnly: false, tableAllowlist: null, tableDenylist: [] },
    ...overrides,
  };
}

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "nango-extract-test-"));
  mockCacheRoot = tmpRoot;
  mockResolveByName.mockReset();
  mockExtract.mockReset();
});

afterEach(async () => {
  mockCacheRoot = "";
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

/** Write a real Parquet file at `outputPath` via DuckDB so the tool's
 *  preview reader can later open it. */
async function writeRealParquet(
  outputPath: string,
  rows: Array<Record<string, string | number>>,
): Promise<void> {
  const db = await DuckDBInstance.create(":memory:");
  const conn = await db.connect();
  try {
    if (rows.length === 0) {
      await conn.run(
        `COPY (SELECT 1::INTEGER AS id WHERE FALSE) TO '${outputPath}' (FORMAT PARQUET)`,
      );
      return;
    }
    const cols = Object.keys(rows[0]);
    const sql =
      `COPY (SELECT * FROM (VALUES ` +
      rows
        .map(
          (r) =>
            "(" +
            cols
              .map((c) => {
                const v = r[c];
                return typeof v === "number" ? String(v) : `'${String(v)}'`;
              })
              .join(", ") +
            ")",
        )
        .join(", ") +
      `) AS t(${cols.join(", ")})) TO '${outputPath}' (FORMAT PARQUET)`;
    await conn.run(sql);
  } finally {
    conn.closeSync();
    db.closeSync();
  }
}

/** Wire `mockResolveByName` to succeed and `mockExtract` to write a
 *  real Parquet file with the given rows. */
function arrangeSuccessfulExtract(
  rows: Array<Record<string, string | number>>,
  resolvedOverrides: Partial<ResolvedDataSource> = {},
): void {
  mockResolveByName.mockResolvedValue({
    ok: true,
    resolved: fakeResolved(resolvedOverrides),
  });
  mockExtract.mockImplementation(async (_resolved, input) => {
    await writeRealParquet(input.outputPath, rows);
    return {
      schema: {
        columns: Object.keys(rows[0] ?? { id: 0 }).map((name) => ({
          name,
          type: typeof rows[0]?.[name] === "number" ? "int64" : "string",
          nullable: false,
        })),
        rowCount: rows.length,
        byteSize: 100,
      },
      queryHash: hashQuery(input.query),
    };
  });
}

describe("extract_dataset_by_sql tool — argument validation", () => {
  const tool = buildExtractDatasetTool();
  const baseArgs = {
    name: "users_dev",
    dataSourceName: "users_dev",
    query: "SELECT * FROM users LIMIT 100",
  };

  it("declares the renamed name + dataSourceName parameter", () => {
    expect(tool.name).toBe("extract_dataset_by_sql");
    expect(typeof tool.description).toBe("string");
  });

  it("returns INVALID_NAME for malformed cache keys", async () => {
    const result = (await tool.execute({ ...baseArgs, name: "../escape" })) as {
      ok: false;
      error: { code: string };
    };
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("INVALID_NAME");
    expect(mockResolveByName).not.toHaveBeenCalled();
  });

  it("propagates lookup NOT_FOUND verbatim", async () => {
    mockResolveByName.mockResolvedValue({
      ok: false,
      error: "NOT_FOUND",
      message: "Data source not found.",
    });
    const result = (await tool.execute(baseArgs)) as {
      ok: false;
      error: { code: string; message: string };
    };
    expect(result.error.code).toBe("NOT_FOUND");
    expect(mockExtract).not.toHaveBeenCalled();
  });

  it("propagates lookup DISABLED verbatim", async () => {
    mockResolveByName.mockResolvedValue({
      ok: false,
      error: "DISABLED",
      message: "Disabled.",
    });
    const result = (await tool.execute(baseArgs)) as {
      ok: false;
      error: { code: string };
    };
    expect(result.error.code).toBe("DISABLED");
  });
});

describe("extract_dataset_by_sql tool — extraction path", () => {
  const tool = buildExtractDatasetTool();
  const baseArgs = {
    name: "users_dev",
    dataSourceName: "users_dev",
    query: "SELECT * FROM users LIMIT 100",
  };

  it("on cache miss, returns top-level rowCount + schema", async () => {
    arrangeSuccessfulExtract([
      { id: 1, name: "alice" },
      { id: 2, name: "bob" },
    ]);
    const result = (await tool.execute(baseArgs)) as {
      cacheHit: boolean;
      name: string;
      rowCount: number;
      schema: { columns: Array<{ name: string }> };
      ttlHours: number;
      preview?: unknown;
    };
    expect(result.cacheHit).toBe(false);
    expect(result.name).toBe("users_dev");
    expect(result.rowCount).toBe(2);
    expect(result.schema.columns.map((c) => c.name)).toEqual(["id", "name"]);
    expect(result.ttlHours).toBe(24);
    expect(result.preview).toBeUndefined();
  });

  it("returns cacheHit on the second call with the same name + query", async () => {
    arrangeSuccessfulExtract([{ id: 1, name: "alice" }]);
    await tool.execute(baseArgs);
    mockExtract.mockClear();
    const second = (await tool.execute(baseArgs)) as {
      cacheHit: boolean;
      rowCount: number;
    };
    expect(second.cacheHit).toBe(true);
    expect(second.rowCount).toBe(1);
    // Cache hit short-circuits before any extract call.
    expect(mockExtract).not.toHaveBeenCalled();
  });

  it("on same-name + different-query, replaces the prior snapshot and sets replacedPrior:true", async () => {
    // First call seeds "users_dev" with the 100-row query.
    arrangeSuccessfulExtract([{ id: 1, name: "alice" }]);
    const first = (await tool.execute(baseArgs)) as {
      cacheHit: boolean;
      replacedPrior?: boolean;
      rowCount: number;
    };
    expect(first.cacheHit).toBe(false);
    expect(first.replacedPrior).toBeUndefined();
    expect(first.rowCount).toBe(1);

    // Second call with a different query under the SAME name: the
    // slot is reassigned, prior bytes are gone, replacedPrior:true.
    arrangeSuccessfulExtract([
      { id: 1, name: "alice" },
      { id: 2, name: "bob" },
      { id: 3, name: "carol" },
    ]);
    const second = (await tool.execute({
      ...baseArgs,
      query: "SELECT * FROM users LIMIT 200",
    })) as {
      cacheHit: boolean;
      replacedPrior?: boolean;
      rowCount: number;
    };
    expect(second.cacheHit).toBe(false);
    expect(second.replacedPrior).toBe(true);
    expect(second.rowCount).toBe(3);

    // Sidecar now reflects the new query — a third call with the
    // SAME new query hits cache, a call with the ORIGINAL query
    // would re-extract and replace again.
    mockExtract.mockClear();
    const third = (await tool.execute({
      ...baseArgs,
      query: "SELECT * FROM users LIMIT 200",
    })) as { cacheHit: boolean; replacedPrior?: boolean };
    expect(third.cacheHit).toBe(true);
    expect(third.replacedPrior).toBeUndefined();
    expect(mockExtract).not.toHaveBeenCalled();
  });

  it("does NOT set replacedPrior on forceRefresh of an identical query", async () => {
    arrangeSuccessfulExtract([{ id: 1, name: "alice" }]);
    await tool.execute(baseArgs);

    arrangeSuccessfulExtract([{ id: 1, name: "alice" }]);
    const refresh = (await tool.execute({
      ...baseArgs,
      forceRefresh: true,
    })) as { cacheHit: boolean; replacedPrior?: boolean };
    expect(refresh.cacheHit).toBe(false);
    // Same query → not a slot reassignment, no replacedPrior signal.
    expect(refresh.replacedPrior).toBeUndefined();
  });

  it("does NOT set replacedPrior on first-ever extract (no prior to replace)", async () => {
    arrangeSuccessfulExtract([{ id: 1, name: "alice" }]);
    const result = (await tool.execute({
      ...baseArgs,
      name: "fresh_slot",
      dataSourceName: "fresh_slot",
    })) as { cacheHit: boolean; replacedPrior?: boolean };
    expect(result.cacheHit).toBe(false);
    expect(result.replacedPrior).toBeUndefined();
  });

  it("on adapter failure, returns EXTRACT_FAILED and aborts the slot", async () => {
    mockResolveByName.mockResolvedValue({ ok: true, resolved: fakeResolved() });
    mockExtract.mockRejectedValue(new Error("connection refused"));
    const result = (await tool.execute(baseArgs)) as {
      ok: false;
      error: { code: string };
    };
    expect(result.error.code).toBe("EXTRACT_FAILED");
    const datasetPath = path.join(tmpRoot, "parquet", "users_dev");
    await expect(fs.stat(datasetPath)).rejects.toThrow();
  });
});

describe("extract_dataset_by_sql tool — policy enforcement", () => {
  const tool = buildExtractDatasetTool();

  it("readOnly policy rejects INSERT before hitting the cache", async () => {
    mockResolveByName.mockResolvedValue({
      ok: true,
      resolved: fakeResolved({
        policy: { readOnly: true, tableAllowlist: null, tableDenylist: [] },
      }),
    });
    const result = (await tool.execute({
      name: "audit_writes",
      dataSourceName: "users_dev",
      query: "INSERT INTO users (id) VALUES (1)",
    })) as { ok: false; error: { code: string } };
    expect(result.error.code).toBe("WRITE_NOT_ALLOWED");
    expect(mockExtract).not.toHaveBeenCalled();
  });

  it("denylist rejects a SELECT against a denied table", async () => {
    mockResolveByName.mockResolvedValue({
      ok: true,
      resolved: fakeResolved({
        policy: {
          readOnly: true,
          tableAllowlist: null,
          tableDenylist: ["users_pii"],
        },
      }),
    });
    const result = (await tool.execute({
      name: "pii_grab",
      dataSourceName: "users_dev",
      query: "SELECT * FROM users_pii",
    })) as { ok: false; error: { code: string } };
    expect(result.error.code).toBe("TABLE_DENIED");
    expect(mockExtract).not.toHaveBeenCalled();
  });

  it("allowlist rejects tables not on the list", async () => {
    mockResolveByName.mockResolvedValue({
      ok: true,
      resolved: fakeResolved({
        policy: {
          readOnly: true,
          tableAllowlist: ["users", "orders"],
          tableDenylist: [],
        },
      }),
    });
    const result = (await tool.execute({
      name: "secret_grab",
      dataSourceName: "users_dev",
      query: "SELECT * FROM secrets",
    })) as { ok: false; error: { code: string } };
    expect(result.error.code).toBe("TABLE_NOT_ALLOWED");
  });

  it("allows queries hitting only allowlisted tables", async () => {
    arrangeSuccessfulExtract(
      [{ id: 1, name: "alice" }],
      {
        policy: {
          readOnly: true,
          tableAllowlist: ["users"],
          tableDenylist: [],
        },
      },
    );
    const result = (await tool.execute({
      name: "users_dev",
      dataSourceName: "users_dev",
      query: "SELECT * FROM users",
    })) as { cacheHit: boolean; rowCount: number };
    expect(result.cacheHit).toBe(false);
    expect(result.rowCount).toBe(1);
  });

  it("invalid SQL surfaces PARSE_ERROR", async () => {
    mockResolveByName.mockResolvedValue({ ok: true, resolved: fakeResolved() });
    const result = (await tool.execute({
      name: "bad_sql",
      dataSourceName: "users_dev",
      query: "SELEKT garble FRUM nowhere",
    })) as { ok: false; error: { code: string } };
    expect(result.error.code).toBe("PARSE_ERROR");
  });
});

describe("extract_dataset_by_sql — previewRows", () => {
  const tool = buildExtractDatasetTool();

  it("omits preview when previewRows is 0 / unset", async () => {
    arrangeSuccessfulExtract([
      { id: 1, name: "alice" },
      { id: 2, name: "bob" },
    ]);
    const result = (await tool.execute({
      name: "users_dev",
      dataSourceName: "users_dev",
      query: "SELECT * FROM users",
    })) as { preview?: unknown };
    expect(result.preview).toBeUndefined();
  });

  it("returns preview rows when previewRows > 0 (subset of total)", async () => {
    const rows = [
      { id: 1, name: "alice" },
      { id: 2, name: "bob" },
      { id: 3, name: "carol" },
      { id: 4, name: "dave" },
      { id: 5, name: "eve" },
    ];
    arrangeSuccessfulExtract(rows);
    const result = (await tool.execute({
      name: "users_dev",
      dataSourceName: "users_dev",
      query: "SELECT * FROM users",
      previewRows: 2,
    })) as {
      rowCount: number;
      preview: { columns: string[]; rows: unknown[][]; truncated: boolean };
    };
    expect(result.rowCount).toBe(5);
    expect(result.preview.columns).toEqual(["id", "name"]);
    expect(result.preview.rows).toHaveLength(2);
    const [firstId, firstName] = result.preview.rows[0];
    expect(firstId).toBe(1);
    expect(firstName).toBe("alice");
    expect(result.preview.truncated).toBe(true);
  });

  it("preview NOT truncated when previewRows >= rowCount", async () => {
    arrangeSuccessfulExtract([{ id: 1, name: "alice" }]);
    const result = (await tool.execute({
      name: "users_dev",
      dataSourceName: "users_dev",
      query: "SELECT * FROM users",
      previewRows: 50,
    })) as { preview: { rows: unknown[]; truncated: boolean } };
    expect(result.preview.rows).toHaveLength(1);
    expect(result.preview.truncated).toBe(false);
  });

  it("preview is omitted on empty datasets even when previewRows is set", async () => {
    arrangeSuccessfulExtract([]);
    const result = (await tool.execute({
      name: "users_dev",
      dataSourceName: "users_dev",
      query: "SELECT * FROM users",
      previewRows: 10,
    })) as { rowCount: number; preview?: unknown };
    expect(result.rowCount).toBe(0);
    expect(result.preview).toBeUndefined();
  });

  it("clamps previewRows to PREVIEW_HARD_CAP_ROWS (200) regardless of input", async () => {
    const rows = Array.from({ length: 250 }, (_, i) => ({
      id: i + 1,
      name: `u${i}`,
    }));
    arrangeSuccessfulExtract(rows);
    const result = (await tool.execute({
      name: "users_dev",
      dataSourceName: "users_dev",
      query: "SELECT * FROM users",
      previewRows: 10_000,
    })) as { preview: { rows: unknown[]; truncated: boolean } };
    expect(result.preview.rows.length).toBeLessThanOrEqual(200);
    expect(result.preview.truncated).toBe(true);
  });

  it("preview also works on cache-hit path", async () => {
    arrangeSuccessfulExtract([
      { id: 1, name: "alice" },
      { id: 2, name: "bob" },
    ]);
    await tool.execute({
      name: "users_dev",
      dataSourceName: "users_dev",
      query: "SELECT * FROM users",
    });
    mockExtract.mockClear();
    const result = (await tool.execute({
      name: "users_dev",
      dataSourceName: "users_dev",
      query: "SELECT * FROM users",
      previewRows: 5,
    })) as {
      cacheHit: boolean;
      preview: { rows: unknown[]; truncated: boolean };
    };
    expect(result.cacheHit).toBe(true);
    expect(result.preview.rows).toHaveLength(2);
    expect(result.preview.truncated).toBe(false);
    expect(mockExtract).not.toHaveBeenCalled();
  });
});

describe("validateDatasetName re-export sanity", () => {
  it("agrees with the cache module that ../ is rejected", () => {
    expect(() => validateDatasetName("../escape")).toThrow();
  });
});
