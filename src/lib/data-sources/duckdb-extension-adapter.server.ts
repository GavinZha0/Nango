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
      return extractViaDuckdb({
        extension,
        resolved,
        defaultSchema: pinDefaultSchema ? resolved.database : undefined,
        input,
      });
    },

    async testConnection(resolved, signal) {
      try {
        return await testConnectionViaDuckdb({
          extension,
          resolved,
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
