/**
 * Vertica data-source — server-side `DataSourceModule` aggregator.
 *
 * @see docs/data-sources.md §3.2
 */

import "server-only";

import type { DataSourceModule } from "../types";

import { verticaAdapter } from "./adapter";
import {
  extractFromVertica,
  testVerticaConnection,
} from "./extract.server";

export const verticaSource: DataSourceModule = {
  id: "vertica",
  adapter: verticaAdapter,
  extract: extractFromVertica,
  testConnection: testVerticaConnection,
};
