/**
 * MariaDB data-source adapter — client-safe metadata.
 * See docs/data-sources.md.
 */

import { DatabaseConnectionBase } from "../secrets-base";
import type { IDataSourceAdapter } from "../types";

export const MariadbSecretsSchema = DatabaseConnectionBase;

export const mariadbAdapter: IDataSourceAdapter = {
  id: "mariadb",
  category: "database",
  displayName: "MariaDB",
  secretsSchema: MariadbSecretsSchema,
};
