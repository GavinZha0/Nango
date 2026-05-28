/**
 * Client-safe data-source adapter registry.
 */

import type { IDataSourceAdapter } from "./types";
import type { DataSourceId } from "./types";

import { postgresAdapter } from "./postgres/adapter";
import { mysqlAdapter } from "./mysql/adapter";
import { mariadbAdapter } from "./mariadb/adapter";
import { verticaAdapter } from "./vertica/adapter";

export const ADAPTERS = {
  postgres: postgresAdapter,
  mysql: mysqlAdapter,
  mariadb: mariadbAdapter,
  vertica: verticaAdapter,
} as const satisfies Record<DataSourceId, IDataSourceAdapter>;

export function getDataSourceAdapter(id: DataSourceId): IDataSourceAdapter {
  return ADAPTERS[id];
}
