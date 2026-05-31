/**
 * PostgreSQL data-source adapter — client-safe metadata.
 * See docs/data-sources.md.
 */

import { DatabaseConnectionBase } from "../secrets-base";
import type { IDataSourceAdapter } from "../types";

/** Encrypted-payload shape for a `provider="postgres"` credential.
 *  Just the auth material; connection metadata lives on the
 *  `data_source` row. */
export const PostgresSecretsSchema = DatabaseConnectionBase;
export type PostgresSecrets = typeof DatabaseConnectionBase._output;

export const postgresAdapter: IDataSourceAdapter = {
  id: "postgres",
  category: "database",
  displayName: "PostgreSQL",
  secretsSchema: PostgresSecretsSchema,
};
