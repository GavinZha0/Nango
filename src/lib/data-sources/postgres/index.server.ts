/**
 * PostgreSQL data-source — server-side `DataSourceModule` aggregator.
 */

import "server-only";

import type { DataSourceModule } from "../types";

import { postgresAdapter } from "./adapter";
import { extractFromPostgres, testPostgresConnection } from "./extract.server";

export const postgresSource: DataSourceModule = {
  id: "postgres",
  adapter: postgresAdapter,
  extract: extractFromPostgres,
  testConnection: testPostgresConnection,
};
