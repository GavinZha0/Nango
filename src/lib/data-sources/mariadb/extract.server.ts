/**
 * MariaDB extraction — same DuckDB `mysql` extension as MySQL.
 */

import "server-only";

import { createDuckdbExtensionAdapter } from "../duckdb-extension-adapter.server";
import { buildMysqlAttachString } from "../mysql/extract.server";

const adapter = createDuckdbExtensionAdapter({
  extension: "mysql",
  buildAttachString: buildMysqlAttachString,
  // Same MySQL-equivalent semantics — DB == schema, must pin.
  pinDefaultSchema: true,
});

export const extractFromMariadb = adapter.extract;
export const testMariadbConnection = adapter.testConnection;
