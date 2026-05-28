/**
 * Shared extraction logic for adapters backed by a DuckDB scanner
 */

import "server-only";

import { DuckDBInstance } from "@duckdb/node-api";
import * as fs from "node:fs/promises";

import type { ExtractInput, ExtractResult, DatasetSchema } from "./types";
import { hashQuery } from "./cache";

export type DuckdbExtensionName = "postgres" | "mysql";

export interface ExtractViaDuckdbInput {
  /** DuckDB scanner extension to install/load. */
  extension: DuckdbExtensionName;
  /** Connection string the ATTACH statement consumes (libpq-style). */
  attachString: string;
  /**
   * Optional `USE src."<schema>"` after ATTACH. Required for MySQL/MariaDB
   * because DuckDB's MySQL extension exposes databases as schemas under `src`
   * catalog; ATTACH `database=...` only sets MySQL session default, not DuckDB.
   * Postgres adapter doesn't set this (schema-qualified names expected).
   */
  defaultSchema?: string;
  /** Public extract input from the adapter caller. */
  input: ExtractInput;
}

/**
 * Run extraction: DuckDB in-memory → install extension → ATTACH upstream →
 * COPY query TO ZSTD Parquet → introspect schema.
 *
 * CONTRACT: throws on failure. Caller cleans up tmp slot via `abortWriteSlot()`.
 */
export async function extractViaDuckdb(
  args: ExtractViaDuckdbInput,
): Promise<ExtractResult> {
  const { extension, attachString, defaultSchema, input } = args;

  if (input.params && Object.keys(input.params).length > 0) {
    // DuckDB COPY does not accept bound parameters; agent must inline values.
    throw new Error(
      `DuckDB-extension adapters do not support bound parameters; bake values into the query.`,
    );
  }

  const db = await DuckDBInstance.create(":memory:");
  const conn = await db.connect();

  try {
    // Race DuckDB work against wall-clock timer (no native AbortSignal support).
    const work = (async () => {
      await conn.run(`INSTALL ${extension};`);
      await conn.run(`LOAD ${extension};`);
      await conn.run(
        `ATTACH '${escapeSingleQuotes(attachString)}' AS src (TYPE ${extension.toUpperCase()}, READ_ONLY);`,
      );
      if (defaultSchema && defaultSchema.length > 0) {
        await conn.run(`USE src.${quoteIdent(defaultSchema)};`);
      }

      // COPY target path is single-quoted; the path is server-built
      // (cache layer chose it), so single-quote escaping is enough.
      const copySql =
        `COPY (${input.query}) TO '${escapeSingleQuotes(input.outputPath)}' ` +
        `(FORMAT PARQUET, COMPRESSION ZSTD, ROW_GROUP_SIZE 100000)`;
      await conn.run(copySql);
    })();

    await raceWithTimeoutAndAbort(work, input.timeoutMs, input.signal);

    const schema = await introspectParquet(conn, input.outputPath);
    if (schema.rowCount > input.maxRows) {
      throw new Error(
        `Extracted ${schema.rowCount} rows exceeds maxRows=${input.maxRows}.`,
      );
    }

    return { schema, queryHash: hashQuery(input.query) };
  } finally {
    conn.closeSync();
    db.closeSync();
  }
}

// Connection test

/** Test connection via DuckDB extension. Exercises credential + network path. */
export async function testConnectionViaDuckdb(args: {
  extension: DuckdbExtensionName;
  attachString: string;
  signal: AbortSignal;
}): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
  const startedAt = Date.now();
  const db = await DuckDBInstance.create(":memory:");
  const conn = await db.connect();
  try {
    const work = (async () => {
      await conn.run(`INSTALL ${args.extension};`);
      await conn.run(`LOAD ${args.extension};`);
      await conn.run(
        `ATTACH '${escapeSingleQuotes(args.attachString)}' AS probe (TYPE ${args.extension.toUpperCase()}, READ_ONLY);`,
      );
      await conn.runAndReadAll(`SELECT 1 FROM probe.information_schema.tables LIMIT 1`);
    })();
    // 30s: first call downloads scanner extension (~5-15 MB); subsequent calls reuse cache.
    await raceWithTimeoutAndAbort(work, 30_000, args.signal);
    return { ok: true, latencyMs: Date.now() - startedAt };
  } catch (err) {
    return {
      ok: false,
      latencyMs: Date.now() - startedAt,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    conn.closeSync();
    db.closeSync();
  }
}

// Helpers

/**
 * SECURITY: ATTACH connection strings are a SQL string literal, not a
 * shell command. We single-quote the value and escape embedded
 * single quotes. The ATTACH string itself is NOT user-controlled —
 * it is composed by the adapter from credential fields the admin
 * stored — so this is defence-in-depth.
 */
function escapeSingleQuotes(s: string): string {
  return s.replaceAll("'", "''");
}

/**
 * Wrap an identifier in double quotes (DuckDB's default) and escape
 * any embedded `"`. The schema name comes from the data_source row
 * (admin-controlled) so this is defence-in-depth, not a primary
 * untrusted-input boundary.
 */
function quoteIdent(s: string): string {
  return `"${s.replaceAll('"', '""')}"`;
}

async function raceWithTimeoutAndAbort<T>(
  work: Promise<T>,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Operation exceeded ${timeoutMs}ms wall-clock budget.`));
    }, timeoutMs);
    // Distinct from the timeout message above — the AbortSignal is
    // wired to client cancellation (route forwards `req.signal`), not
    // to our own timer. If you see this in production it means the
    // browser closed the connection mid-call.
    const onAbort = () =>
      reject(new Error("Operation cancelled (request aborted by client)."));
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

/**
 * Read the Parquet file metadata DuckDB just wrote and project it
 * onto our ColumnSchema vocabulary. This is the only place where
 * DuckDB type names cross into our typed surface.
 */
async function introspectParquet(
  conn: Awaited<ReturnType<DuckDBInstance["connect"]>>,
  outputPath: string,
): Promise<DatasetSchema> {
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
}

/** Coarse mapping; anything we don't recognise becomes `binary`. */
function mapDuckdbType(t: string): import("./types").ColumnSchema["type"] {
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
