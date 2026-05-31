/**
 * Shared input schemas for the data-source REST API.
 */

import "server-only";

import { z } from "zod";

import { DATA_SOURCE_IDS, type DataSourceId } from "./types";

/** Globally-unique LLM-facing name. Kept consistent with the cache
 *  layer's `validateDatasetName` regex so admins see one rule. */
export const DATA_SOURCE_NAME_RE = /^[a-z][a-z0-9_-]{0,62}$/;

export const dataSourceName = z
  .string()
  .min(1, "name is required")
  .regex(
    DATA_SOURCE_NAME_RE,
    "name must start with a-z and contain only [a-z0-9_-] (max 63 chars)",
  );

export const dataSourceProvider = z.enum(
  DATA_SOURCE_IDS as unknown as readonly [DataSourceId, ...DataSourceId[]],
);

/** URL-style connection params; single-valued only. */
export const dataSourceParams = z.record(z.string().min(1), z.string());

export const tableList = z.array(z.string().min(1));

export const createDataSourceSchema = z.object({
  name: dataSourceName,
  // Accept null so the editor can clear the field with a single shape
  // (Zod 4 `.optional()` does NOT accept null).
  description: z.string().trim().max(1024).nullish(),

  provider: dataSourceProvider,
  credentialId: z.string().uuid("credentialId must be a UUID"),
  host: z.string().trim().min(1, "host is required"),
  port: z.number().int().positive().max(65535),
  database: z.string().trim().min(1, "database is required"),
  params: dataSourceParams.optional(),

  readOnly: z.boolean().optional(),
  tableAllowlist: tableList.nullable().optional(),
  tableDenylist: tableList.optional(),

  enabled: z.boolean().optional(),
  visibility: z.enum(["private", "public"]).optional(),
});

/**
 * PATCH allows any subset. `name` is fixed — renaming silently breaks
 * every agent prompt / schedule that mentions it; delete + recreate
 * if a rename is needed. `provider` IS mutable; cached Parquet under
 * the old name is NOT purged automatically (admin "purge cache"
 * action is separate). The runtime re-applies the new provider on
 * the next cache miss.
 */
export const updateDataSourceSchema = z
  .object({
    description: z.string().trim().max(1024).nullable().optional(),

    provider: dataSourceProvider.optional(),
    credentialId: z.string().uuid("credentialId must be a UUID").optional(),
    host: z.string().trim().min(1).optional(),
    port: z.number().int().positive().max(65535).optional(),
    database: z.string().trim().min(1).optional(),
    params: dataSourceParams.optional(),

    readOnly: z.boolean().optional(),
    tableAllowlist: tableList.nullable().optional(),
    tableDenylist: tableList.optional(),

    enabled: z.boolean().optional(),
    visibility: z.enum(["private", "public"]).optional(),
  })
  .strict();

export type CreateDataSourceInput = z.infer<typeof createDataSourceSchema>;
export type UpdateDataSourceInput = z.infer<typeof updateDataSourceSchema>;
