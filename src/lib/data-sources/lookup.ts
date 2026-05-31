/**
 * Server-only DataSource lookup — name / id → fully-hydrated
 * `ResolvedDataSource` (row + credential payload + policy).
 *
 * See docs/data-sources.md.
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
 * Distinct error codes (vs one bucket) so the agent tool, the
 * test-connection endpoint and the admin UI can surface different
 * actionable hints — "not found" vs "disabled" vs "no credential".
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
 * rows return `DISABLED` instead of leaking as "not found".
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

/** Resolve by uuid id (admin / API path). Same `enabled` enforcement. */
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
 * rows. Used by the admin write paths (e.g. PATCH enabled=true) that
 * need to act on a currently-disabled source.
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
