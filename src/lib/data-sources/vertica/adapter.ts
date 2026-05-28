/**
 * Vertica data-source adapter — client-safe metadata.
 */

import { DatabaseConnectionBase } from "../secrets-base";
import type { IDataSourceAdapter } from "../types";

export const VerticaSecretsSchema = DatabaseConnectionBase;
export type VerticaSecrets = typeof DatabaseConnectionBase._output;

export const verticaAdapter: IDataSourceAdapter = {
  id: "vertica",
  category: "database",
  displayName: "Vertica",
  secretsSchema: VerticaSecretsSchema,
};
