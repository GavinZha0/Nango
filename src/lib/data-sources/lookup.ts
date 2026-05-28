/**
 * Server-only DataSource lookup — name / id → fully-hydrated
 */

import "server-only";

import { and, eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { DataSourceTable } from "@/lib/db/schema";
import { getCredentialFieldsById } from "@/lib/credentials/lookup";

import { DatabaseConnectionBase } from "./secrets-base";
import type { DataSourceId, ResolvedDataSource } from "./types";
import { isSupportedDataSource } from "./types";

/**
 * Why two errors instead of one: callers (the agent tool, the
 * test-connection endpoint, the admin UI) report distinct messages
 * to the LLM / user — "data source not found" vs "data source
 * disabled" vs "data source has no credential" all surface as
 * different actionable hints.
 */
export type DataSourceLookupError =
  | "NOT_FOUND"
  | "DISABLED"
  | "UNSUPPORTED_PROVIDER"
  | "CREDENTIAL_MISSING"
  | "CREDENTIAL_DECRYPT_FAILED";

export interface DataSourceLookupOk {
  ok: true;
  resolved: ResolvedDataSource;
}
export interface DataSourceLookupFail {
  ok: false;
  error: DataSourceLookupError;
  /** Friendly message to surface in UI / tool result. */
  message: string;
}
export type DataSourceLookupResult = DataSourceLookupOk | DataSourceLookupFail;

/**
 * Resolve by LLM-facing name. Honours the `enabled` flag — disabled
 * data sources return `DISABLED` so the caller can produce a
 * targeted error instead of a generic "not found" leak.
 */
export async function resolveDataSourceByName(
  name: string,
): Promise<DataSourceLookupResult> {
  const rows = await db
    .select()
    .from(DataSourceTable)
    .where(eq(DataSourceTable.name, name))
    .limit(1);
  return rowsToResult(rows[0], `Data source "${name}"`);
}

/**
 * Resolve by uuid id (admin / API path). Same `enabled` enforcement
 * as resolveDataSourceByName.
 */
export async function resolveDataSourceById(
  id: string,
): Promise<DataSourceLookupResult> {
  const rows = await db
    .select()
    .from(DataSourceTable)
    .where(eq(DataSourceTable.id, id))
    .limit(1);
  return rowsToResult(rows[0], `Data source ${id}`);
}

/**
 * Variant of {@link resolveDataSourceById} that *includes* disabled
 * rows. Used by the admin write paths (e.g. PATCH enabled=true) where
 * the caller explicitly wants to act on a disabled source.
 */
export async function resolveDataSourceByIdIncludingDisabled(
  id: string,
): Promise<DataSourceLookupResult> {
  const rows = await db
    .select()
    .from(DataSourceTable)
    .where(and(eq(DataSourceTable.id, id)))
    .limit(1);
  return rowsToResult(rows[0], `Data source ${id}`, { skipEnabledCheck: true });
}

// Internals

interface ResolveOpts {
  skipEnabledCheck?: boolean;
}

async function rowsToResult(
  row: typeof DataSourceTable.$inferSelect | undefined,
  label: string,
  opts: ResolveOpts = {},
): Promise<DataSourceLookupResult> {
  if (!row) {
    return { ok: false, error: "NOT_FOUND", message: `${label} not found.` };
  }
  if (!opts.skipEnabledCheck && !row.enabled) {
    return {
      ok: false,
      error: "DISABLED",
      message: `${label} is disabled.`,
    };
  }
  if (!isSupportedDataSource(row.provider)) {
    return {
      ok: false,
      error: "UNSUPPORTED_PROVIDER",
      message:
        `${label} provider "${row.provider}" is not registered. ` +
        `Did the row outlive its adapter removal?`,
    };
  }

  const cred = await getCredentialFieldsById(row.credentialId);
  if (!cred) {
    return {
      ok: false,
      error: "CREDENTIAL_MISSING",
      message:
        `${label} references credential ${row.credentialId} which is ` +
        `missing or disabled.`,
    };
  }

  const parsed = DatabaseConnectionBase.safeParse(cred.fields);
  if (!parsed.success) {
    return {
      ok: false,
      error: "CREDENTIAL_DECRYPT_FAILED",
      message:
        `${label} credential payload is malformed (missing user / password).`,
    };
  }

  return {
    ok: true,
    resolved: {
      id: row.id,
      name: row.name,
      provider: row.provider as DataSourceId,
      host: row.host,
      port: row.port,
      database: row.database,
      params: row.params ?? {},
      username: parsed.data.username,
      password: parsed.data.password,
      policy: {
        readOnly: row.readOnly,
        tableAllowlist: row.tableAllowlist,
        tableDenylist: row.tableDenylist ?? [],
      },
    },
  };
}
