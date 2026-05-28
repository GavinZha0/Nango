/**
 * Shared input schemas for the data-source REST API.
 */

import "server-only";

import { z } from "zod";

import { DATA_SOURCE_IDS, type DataSourceId } from "./types";

/** Globally-unique LLM-facing name. The same regex is enforced at
 *  the cache layer (validateDatasetName), kept consistent so admins
 *  see one rule. */
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

/** URL-style connection params; single-valued only. The `?? {}`
 *  default lives in the route handler so this schema stays usable
 *  in PATCH bodies without injecting an empty object on every parse. */
export const dataSourceParams = z.record(z.string().min(1), z.string());

export const tableList = z.array(z.string().min(1));

/** Shared body for POST. */
export const createDataSourceSchema = z.object({
  name: dataSourceName,
  // `description` carries the human-friendly blurb (used to live in a
  // separate `displayName` field, dropped in D-2.5 as redundant —
  // the `name` regex is already legible enough for the panel label).
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

/** PATCH allows any subset.
 *
 *  `name` is fixed — renaming silently breaks every agent prompt /
 *  schedule that mentions it. Delete + recreate if a rename is
 *  really needed.
 *
 *  `provider` IS mutable. Cached Parquet snapshots are not purged
 *  automatically on provider change (separate admin "purge cache"
 *  action is planned); a stale dataset under the old name will keep
 *  serving the old dialect's data until re-extracted. The runtime
 *  always re-applies the new provider on cache miss. */
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
