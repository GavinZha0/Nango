/**
 * Postgres extraction — defers to the shared DuckDB-extension factory.
 */

import "server-only";

import type { ResolvedDataSource } from "../types";
import { createDuckdbExtensionAdapter } from "../duckdb-extension-adapter.server";

/**
 * Build a libpq-style connection string from a resolved data source.
 * `params` is forwarded as-is; only `sslmode` gets a sensible
 * default when missing — it is the one libpq option whose absence
 * silently changes security posture.
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
  // Postgres distinguishes `database` and `schema` — pinning the
  // default schema to the database name would be a category error.
  // See the factory's file-header comment for context.
  pinDefaultSchema: false,
});

export const extractFromPostgres = adapter.extract;
export const testPostgresConnection = adapter.testConnection;
