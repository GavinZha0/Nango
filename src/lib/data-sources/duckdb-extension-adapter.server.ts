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
  /** Per-provider connection-string builder. Keeps the libpq vs
   *  mysql_scanner attach grammar isolated per provider. */
  buildAttachString: (resolved: ResolvedDataSource) => string;
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
  const { extension, buildAttachString, pinDefaultSchema } = config;

  return {
    async extract(resolved, input) {
      return extractViaDuckdb({
        extension,
        attachString: buildAttachString(resolved),
        defaultSchema: pinDefaultSchema ? resolved.database : undefined,
        input,
      });
    },

    async testConnection(resolved, signal) {
      // testConnectionViaDuckdb has its own try/catch; the outer
      // try/catch here only covers the pre-call path (e.g.
      // attach-string builder throwing on malformed `params`).
      try {
        return await testConnectionViaDuckdb({
          extension,
          attachString: buildAttachString(resolved),
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
