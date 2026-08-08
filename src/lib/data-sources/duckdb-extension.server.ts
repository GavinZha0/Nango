/**
 * Shared extraction logic for adapters backed by a DuckDB scanner
 * extension (postgres, mysql), delegating to external duckdb-engine service.
 * See docs/data-sources.md.
 */

import "server-only";

import type { ExtractInput, ExtractResult, ResolvedDataSource } from "./types";
import { hashQuery } from "./cache";
import { extractViaDuckdbEngine } from "./duckdb-engine-client.server";

export type DuckdbExtensionName = "postgres" | "mysql";

export interface ExtractViaDuckdbInput {
  /** DuckDB scanner extension to install/load. */
  extension: DuckdbExtensionName;
  /** Resolved data source containing structured connection fields. */
  resolved: ResolvedDataSource;
  /** Optional schema default override. */
  defaultSchema?: string;
  /** Public extract input from the adapter caller. */
  input: ExtractInput;
}

/**
 * Run extraction via duckdb-engine container service using structured connection config.
 */
export async function extractViaDuckdb(
  args: ExtractViaDuckdbInput,
): Promise<ExtractResult> {
  const { extension, resolved, defaultSchema, input } = args;

  if (input.params && Object.keys(input.params).length > 0) {
    throw new Error(
      `DuckDB-extension adapters do not support bound parameters; bake values into the query.`,
    );
  }

  const configObj: Record<string, unknown> = {
    host: resolved.host,
    port: resolved.port,
    user: resolved.username,
    password: resolved.password,
    database: resolved.database,
    schema: defaultSchema ?? (resolved.params.schema as string | undefined) ?? "public",
  };

  const res = await extractViaDuckdbEngine({
    query: input.query,
    datasetName: input.datasetName,
    provider: extension,
    config: configObj,
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
}

/** Test connection via DuckDB extension using structured connection config. */
export async function testConnectionViaDuckdb(args: {
  extension: DuckdbExtensionName;
  resolved: ResolvedDataSource;
  signal: AbortSignal;
}): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
  const startedAt = Date.now();
  try {
    await extractViaDuckdbEngine({
      query: "SELECT 1",
      provider: args.extension,
      config: {
        host: args.resolved.host,
        port: args.resolved.port,
        user: args.resolved.username,
        password: args.resolved.password,
        database: args.resolved.database,
        schema: (args.resolved.params.schema as string | undefined) ?? "public",
      },
      previewRows: 1,
      maxRows: 10,
      timeoutMs: 30000,
      signal: args.signal,
    });
    return { ok: true, latencyMs: Date.now() - startedAt };
  } catch (err) {
    return {
      ok: false,
      latencyMs: Date.now() - startedAt,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
