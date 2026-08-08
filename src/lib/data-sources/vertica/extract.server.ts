/**
 * Vertica extraction — `vertica-nodejs` query → NDJSON → DuckDB Engine → Parquet.
 */

import "server-only";

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

import type {
  ConnectionTestResult,
  ExtractInput,
  ExtractResult,
  ResolvedDataSource,
} from "../types";
import { hashQuery } from "../cache";
import { extractViaDuckdbEngine } from "../duckdb-engine-client.server";

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

async function openClient(resolved: ResolvedDataSource): Promise<VerticaClient> {
  const mod = (await import("vertica-nodejs")) as unknown as { default: VerticaModule };
  const Vertica = mod.default;
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

  try {
    const searchPath = resolved.params.schema;
    if (searchPath) {
      await client.query(`SET search_path TO "${searchPath}"`);
    }

    const work = (async () => {
      const result = await client.query(input.query);
      const rowCount = result.rowCount;
      if (rowCount > input.maxRows) {
        throw new Error(
          `Vertica returned ${rowCount} rows, exceeds maxRows=${input.maxRows}.`,
        );
      }
      const lines = result.rows.map((r) => JSON.stringify(r)).join("\n");
      await fs.writeFile(tmpJson, lines + (lines.length > 0 ? "\n" : ""));
    })();
    await raceWithTimeoutAndAbort(work, input.timeoutMs, input.signal);

    const convertQuery = `SELECT * FROM read_json_auto('${escapeSingleQuotes(tmpJson)}', format='newline_delimited')`;

    const res = await extractViaDuckdbEngine({
      query: convertQuery,
      datasetName: input.datasetName,
      provider: "standalone",
      previewRows: input.previewRows ?? 0,
      maxRows: input.maxRows,
      timeoutMs: input.timeoutMs,
      signal: input.signal,
    });

    return {
      schema: {
        columns: res.rowSchema.columns,
        rowCount: res.totalRows,
        byteSize: res.byteSize,
      },
      rows: res.rows,
      queryHash: hashQuery(input.query),
    };
  } finally {
    await fs.rm(tmpJson, { force: true }).catch(() => {});
    await client.end().catch(() => {});
  }
}

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
