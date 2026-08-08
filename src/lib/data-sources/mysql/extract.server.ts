/**
 * MySQL extraction — defers to the shared DuckDB-extension factory.
 */

import "server-only";

import { createDuckdbExtensionAdapter } from "../duckdb-extension-adapter.server";

const adapter = createDuckdbExtensionAdapter({
  extension: "mysql",
  // MySQL conflates `database` and `schema` — DuckDB's mysql_scanner
  // exposes every database on the server as a sub-schema of `src`,
  // so we MUST `USE src.<resolved.database>` after ATTACH or
  // unqualified `FROM users` will miss the table.
  pinDefaultSchema: true,
});

export const extractFromMysql = adapter.extract;
export const testMysqlConnection = adapter.testConnection;
