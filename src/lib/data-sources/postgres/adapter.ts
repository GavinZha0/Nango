/**
 * PostgreSQL data-source adapter — client-safe metadata.
 */

import { DatabaseConnectionBase } from "../secrets-base";
import type { IDataSourceAdapter } from "../types";

/**
 * Encrypted-payload shape for a `provider="postgres"` credential.
 * Just the auth material — host / port / database / sslmode / params
 * live on the `data_source` row that references the credential.
 */
export const PostgresSecretsSchema = DatabaseConnectionBase;
export type PostgresSecrets = typeof DatabaseConnectionBase._output;

export const postgresAdapter: IDataSourceAdapter = {
  id: "postgres",
  category: "database",
  displayName: "PostgreSQL",
  secretsSchema: PostgresSecretsSchema,
};
