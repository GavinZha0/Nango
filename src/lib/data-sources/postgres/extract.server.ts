/**
 * Postgres extraction — defers to the shared DuckDB-extension factory.
 */

import "server-only";

import type { ResolvedDataSource } from "../types";
import { createDuckdbExtensionAdapter } from "../duckdb-extension-adapter.server";

/**
 * Build a libpq-style connection string. `sslmode` gets a default
 * when missing — it is the one libpq option whose absence silently
 * changes security posture. Everything else in `params` is passed
 * through as-is.
 */
function buildAttachString(resolved: ResolvedDataSource): string {
  const sslmode = resolved.params.sslmode ?? "prefer";
  const passthrough = Object.entries(resolved.params)
    .filter(([k]) => k !== "sslmode")
    .map(([k, v]) => `${k}=${v}`);
  return [
    `host=${resolved.host}`,
    `port=${resolved.port}`,
    `user=${resolved.username}`,
    `password=${resolved.password}`,
    `dbname=${resolved.database}`,
    `sslmode=${sslmode}`,
    ...passthrough,
  ].join(" ");
}

const adapter = createDuckdbExtensionAdapter({
  extension: "postgres",
  buildAttachString,
  // Postgres distinguishes `database` and `schema`; pinning the
  // default schema to the database name would be a category error.
  pinDefaultSchema: false,
});

export const extractFromPostgres = adapter.extract;
export const testPostgresConnection = adapter.testConnection;
