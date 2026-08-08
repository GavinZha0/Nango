/**
 * Postgres extraction — defers to the shared DuckDB-extension factory.
 */

import "server-only";

import { createDuckdbExtensionAdapter } from "../duckdb-extension-adapter.server";

const adapter = createDuckdbExtensionAdapter({
  extension: "postgres",
  // Postgres distinguishes `database` and `schema`; pinning the
  // default schema to the database name would be a category error.
  pinDefaultSchema: false,
});

export const extractFromPostgres = adapter.extract;
export const testPostgresConnection = adapter.testConnection;
