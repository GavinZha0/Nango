/**
 * Vertica extraction — `vertica-nodejs` query → DuckDB → Parquet.
 */

import "server-only";

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

import { DuckDBInstance } from "@duckdb/node-api";

import type {
  ConnectionTestResult,
  ExtractInput,
  ExtractResult,
  ResolvedDataSource,
} from "../types";
import { hashQuery } from "../cache";

// Minimal type slice for vertica-nodejs (no upstream .d.ts)

interface VerticaQueryResult {
  rows: Array<Record<string, unknown>>;
  fields: Array<{ name: string; dataTypeID: number }>;
  rowCount: number;
}

interface VerticaClient {
  connect(): Promise<void>;
  query(text: string): Promise<VerticaQueryResult>;
  query(config: { text: string; values?: unknown[] }): Promise<VerticaQueryResult>;
  end(): Promise<void>;
}

interface VerticaModule {
  Client: new (config: {
    host: string;
    port: number;
    user: string;
    password: string;
    database: string;
    tls_mode?: string;
  }) => VerticaClient;
}

// Connection

async function openClient(resolved: ResolvedDataSource): Promise<VerticaClient> {
  // Lazy import: keeps `vertica-nodejs` (CommonJS, no types) out of the
  // hot import graph for processes that never touch a Vertica credential.
  const mod = (await import("vertica-nodejs")) as unknown as { default: VerticaModule };
  const Vertica = mod.default;
  // tls_mode default: "disable" rather than "prefer" because:
  //   1. vertica-nodejs's "prefer" attempts TLS first and does NOT
  //      gracefully fall back if the server lacks TLS — it returns
  //      "The server does not support TLS connections" instead.
  //   2. Most dev Vertica clusters don't enable TLS by default.
  //   3. Admins running a TLS-enabled cluster opt in explicitly via
  //      params.tls_mode = "require" / "verify-ca" / "verify-full".
  const client = new Vertica.Client({
    host: resolved.host,
    port: resolved.port,
    user: resolved.username,
    password: resolved.password,
    database: resolved.database,
    tls_mode: resolved.params.tls_mode ?? "disable",
  });
  await client.connect();
  return client;
}

// Extraction

export async function extractFromVertica(
  resolved: ResolvedDataSource,
  input: ExtractInput,
): Promise<ExtractResult> {
  if (input.params && Object.keys(input.params).length > 0) {
    throw new Error(
      "VerticaAdapter does not support bound parameters in V1; bake values into the query.",
    );
  }

  const client = await openClient(resolved);

  const tmpJson = path.join(
    path.dirname(input.outputPath),
    `vertica-${randomUUID()}.ndjson`,
  );

  const startedAt = Date.now();
  let rowCount = 0;

  try {
    const searchPath = resolved.params.schema;
    if (searchPath) {
      await client.query(`SET search_path TO "${searchPath}"`);
    }

    const work = (async () => {
      const result = await client.query(input.query);
      rowCount = result.rowCount;
      if (rowCount > input.maxRows) {
        throw new Error(
          `Vertica returned ${rowCount} rows, exceeds maxRows=${input.maxRows}.`,
        );
      }
      // Stream-write NDJSON to disk so the DuckDB reader does the
      // type coercion in its own process (no JS-side type juggling).
      const lines = result.rows.map((r) => JSON.stringify(r)).join("\n");
      await fs.writeFile(tmpJson, lines + (lines.length > 0 ? "\n" : ""));
    })();
    await raceWithTimeoutAndAbort(work, input.timeoutMs, input.signal);

    // Convert NDJSON → Parquet via DuckDB. `read_json_auto` infers
    // column types from the JSON sample; this loses some fidelity
    // (e.g. dates may end up as VARCHAR) but is sufficient for V1.
    const db = await DuckDBInstance.create(":memory:");
    const conn = await db.connect();
    try {
      const copySql =
        `COPY (SELECT * FROM read_json_auto('${escapeSingleQuotes(tmpJson)}', format='newline_delimited')) ` +
        `TO '${escapeSingleQuotes(input.outputPath)}' ` +
        `(FORMAT PARQUET, COMPRESSION ZSTD, ROW_GROUP_SIZE 100000)`;
      await conn.run(copySql);
    } finally {
      conn.closeSync();
      db.closeSync();
    }

    const schema = await introspectFromDuckdb(input.outputPath);
    void startedAt; // reserved for telemetry hook
    return { schema, queryHash: hashQuery(input.query) };
  } finally {
    await fs.rm(tmpJson, { force: true }).catch(() => {});
    await client.end().catch(() => {});
  }
}

// Connection test

export async function testVerticaConnection(
  resolved: ResolvedDataSource,
  signal: AbortSignal,
): Promise<ConnectionTestResult> {
  const startedAt = Date.now();
  let client: VerticaClient | null = null;
  try {
    const work = (async () => {
      client = await openClient(resolved);
      await client.query("SELECT 1");
    })();
    await raceWithTimeoutAndAbort(work, 30_000, signal);
    return { ok: true, latencyMs: Date.now() - startedAt };
  } catch (err) {
    return {
      ok: false,
      latencyMs: Date.now() - startedAt,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    if (client) await (client as VerticaClient).end().catch(() => {});
  }
}

// Helpers

function escapeSingleQuotes(s: string): string {
  return s.replaceAll("'", "''");
}

async function raceWithTimeoutAndAbort<T>(
  work: Promise<T>,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Vertica operation exceeded ${timeoutMs}ms wall-clock budget.`));
    }, timeoutMs);
    const onAbort = () =>
      reject(new Error("Vertica operation cancelled (request aborted by client)."));
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });

    work.then(
      (v) => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

async function introspectFromDuckdb(
  outputPath: string,
): Promise<import("../types").DatasetSchema> {
  const db = await DuckDBInstance.create(":memory:");
  const conn = await db.connect();
  try {
    const cols = await conn.runAndReadAll(
      `DESCRIBE SELECT * FROM read_parquet('${escapeSingleQuotes(outputPath)}')`,
    );
    const colRows = cols.getRowObjectsJson() as Array<{
      column_name: string;
      column_type: string;
      null: string;
    }>;
    const columns = colRows.map((r) => ({
      name: String(r.column_name),
      type: mapDuckdbType(String(r.column_type)),
      nullable: String(r.null).toUpperCase() === "YES",
    }));

    const counts = await conn.runAndReadAll(
      `SELECT count(*) AS n FROM read_parquet('${escapeSingleQuotes(outputPath)}')`,
    );
    const countRows = counts.getRowObjectsJson() as Array<{ n: number | bigint | string }>;
    const rowCount = Number(countRows[0]?.n ?? 0);

    let byteSize = 0;
    try {
      const stat = await fs.stat(outputPath);
      byteSize = stat.size;
    } catch {
      /* ignore */
    }

    return { columns, rowCount, byteSize };
  } finally {
    conn.closeSync();
    db.closeSync();
  }
}

function mapDuckdbType(t: string): import("../types").ColumnSchema["type"] {
  const u = t.toUpperCase();
  if (u === "BOOLEAN") return "bool";
  if (u === "INTEGER" || u === "INT4") return "int32";
  if (u === "BIGINT" || u === "INT8" || u === "HUGEINT") return "int64";
  if (u === "FLOAT" || u === "REAL") return "float32";
  if (u === "DOUBLE") return "float64";
  if (u.startsWith("DECIMAL")) return "decimal";
  if (u === "DATE") return "date";
  if (u.startsWith("TIMESTAMP")) return "timestamp";
  if (u === "VARCHAR" || u === "TEXT" || u === "STRING") return "string";
  if (u === "BLOB" || u === "BYTEA") return "binary";
  return "binary";
}
