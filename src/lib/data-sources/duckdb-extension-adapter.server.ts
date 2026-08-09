/**
 * Factory that turns per-provider DuckDB-extension wiring into a
 * uniform adapter (extract + testConnection).
 */

import "server-only";

import type {
  ConnectionTestResult,
  ExtractInput,
  ExtractResult,
  ResolvedDataSource,
} from "./types";
import {
  extractViaDuckdb,
  testConnectionViaDuckdb,
  type DuckdbExtensionName,
} from "./duckdb-extension.server";

export interface DuckdbExtensionAdapterConfig {
  /** DuckDB scanner extension to install/load. */
  extension: DuckdbExtensionName;
  /** Emit `USE src.<resolved.database>` after ATTACH so unqualified
   *  table refs resolve. Required for MySQL / MariaDB; wrong for
   *  Postgres. */
  pinDefaultSchema: boolean;
}

export interface DuckdbExtensionAdapterFns {
  extract(resolved: ResolvedDataSource, input: ExtractInput): Promise<ExtractResult>;
  testConnection(
    resolved: ResolvedDataSource,
    signal: AbortSignal,
  ): Promise<ConnectionTestResult>;
}

export function createDuckdbExtensionAdapter(
  config: DuckdbExtensionAdapterConfig,
): DuckdbExtensionAdapterFns {
  const { extension, pinDefaultSchema } = config;

  return {
    async extract(resolved, input) {
      const attachString = buildAttachString(extension, resolved);
      const defaultSchema = pinDefaultSchema
        ? resolved.database
        : (resolved.params.schema as string | undefined) ?? "public";

      return extractViaDuckdb({
        extension,
        attachString,
        defaultSchema,
        input,
      });
    },

    async testConnection(resolved, signal) {
      try {
        const attachString = buildAttachString(extension, resolved);
        return await testConnectionViaDuckdb({
          extension,
          attachString,
          signal,
        });
      } catch (err) {
        return {
          ok: false,
          latencyMs: 0,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  };
}

/**
 * Compose the DuckDB `ATTACH '...'` connection string (libpq-style).
 */
function buildAttachString(
  extension: DuckdbExtensionName,
  resolved: ResolvedDataSource,
): string {
  const host = resolved.host;
  const port = resolved.port;
  const user = resolved.username;
  const password = resolved.password;
  const database = resolved.database;

  if (extension === "postgres") {
    return `host=${host} port=${port} dbname=${database} user=${user} password=${password}`;
  } else {
    // mysql / mariadb
    return `host=${host} port=${port} database=${database} user=${user} password=${password}`;
  }
}
