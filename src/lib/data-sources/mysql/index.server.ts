/**
 * MySQL data-source — server-side `DataSourceModule` aggregator.
 *
 * @see docs/data-sources.md §3
 */

import "server-only";

import type { DataSourceModule } from "../types";

import { mysqlAdapter } from "./adapter";
import { extractFromMysql, testMysqlConnection } from "./extract.server";

export const mysqlSource: DataSourceModule = {
  id: "mysql",
  adapter: mysqlAdapter,
  extract: extractFromMysql,
  testConnection: testMysqlConnection,
};
