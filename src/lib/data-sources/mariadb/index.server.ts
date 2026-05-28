/**
 * MariaDB data-source — server-side `DataSourceModule` aggregator.
 *
 * @see docs/data-sources.md §3
 */

import "server-only";

import type { DataSourceModule } from "../types";

import { mariadbAdapter } from "./adapter";
import {
  extractFromMariadb,
  testMariadbConnection,
} from "./extract.server";

export const mariadbSource: DataSourceModule = {
  id: "mariadb",
  adapter: mariadbAdapter,
  extract: extractFromMariadb,
  testConnection: testMariadbConnection,
};
