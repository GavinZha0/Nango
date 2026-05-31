/**
 * Vertica data-source — server-side `DataSourceModule` aggregator.
 * See docs/data-sources.md.
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
