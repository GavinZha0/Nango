/**
 * MySQL data-source adapter — client-safe metadata.
 */

import { DatabaseConnectionBase } from "../secrets-base";
import type { IDataSourceAdapter } from "../types";

export const MysqlSecretsSchema = DatabaseConnectionBase;
export type MysqlSecrets = typeof DatabaseConnectionBase._output;

export const mysqlAdapter: IDataSourceAdapter = {
  id: "mysql",
  category: "database",
  displayName: "MySQL",
  secretsSchema: MysqlSecretsSchema,
};
