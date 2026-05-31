/**
 * MySQL extraction — defers to the shared DuckDB-extension factory.
 */

import "server-only";

import type { ResolvedDataSource } from "../types";
import { createDuckdbExtensionAdapter } from "../duckdb-extension-adapter.server";

/**
 * Build a connection string for DuckDB's `mysql` ATTACH. Exported so
 * the MariaDB adapter can reuse it (MariaDB shares the wire format).
 * `ssl_mode` defaults to "preferred" when not in `params.ssl_mode`.
 */
export function buildMysqlAttachString(resolved: ResolvedDataSource): string {
  const sslMode = resolved.params.ssl_mode ?? "preferred";
  const passthrough = Object.entries(resolved.params)
    .filter(([k]) => k !== "ssl_mode")
    .map(([k, v]) => `${k}=${v}`);
  return [
    `host=${resolved.host}`,
    `port=${resolved.port}`,
    `user=${resolved.username}`,
    `password=${resolved.password}`,
    `database=${resolved.database}`,
    `ssl_mode=${sslMode}`,
    ...passthrough,
  ].join(" ");
}

const adapter = createDuckdbExtensionAdapter({
  extension: "mysql",
  buildAttachString: buildMysqlAttachString,
  // MySQL conflates `database` and `schema` — DuckDB's mysql_scanner
  // exposes every database on the server as a sub-schema of `src`,
  // so we MUST `USE src.<resolved.database>` after ATTACH or
  // unqualified `FROM users` will miss the table.
  pinDefaultSchema: true,
});

export const extractFromMysql = adapter.extract;
export const testMysqlConnection = adapter.testConnection;
