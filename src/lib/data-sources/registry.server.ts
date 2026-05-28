/**
 * Server-only data-source registry.
 */

import "server-only";

import type { DataSourceId, DataSourceModule } from "./types";

import { postgresSource } from "./postgres/index.server";
import { mysqlSource } from "./mysql/index.server";
import { mariadbSource } from "./mariadb/index.server";
import { verticaSource } from "./vertica/index.server";

export const SOURCES = {
  postgres: postgresSource,
  mysql: mysqlSource,
  mariadb: mariadbSource,
  vertica: verticaSource,
} as const satisfies Record<DataSourceId, DataSourceModule>;

export function getDataSource(id: DataSourceId): DataSourceModule {
  return SOURCES[id];
}
