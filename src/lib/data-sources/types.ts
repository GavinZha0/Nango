/**
 * Data source integration layer — domain types and adapter interfaces.
 */

import type { z } from "zod";

/**
 * Data-source ids. Adding a new source: append here + both registry files
 * (`satisfies Record<DataSourceId, …>` enforces compile-time coverage).
 */
export const DATA_SOURCE_IDS = ["postgres", "mysql", "mariadb", "vertica"] as const;
export type DataSourceId = (typeof DATA_SOURCE_IDS)[number];

export function isSupportedDataSource(value: string): value is DataSourceId {
  return (DATA_SOURCE_IDS as readonly string[]).includes(value);
}

/** UI grouping label. Implementation lives in adapter. */
export type DataSourceCategory = "database" | "object-storage" | "http";

// Schema types

export interface ColumnSchema {
  name: string;
  /** Arrow-style type names; mirrors what DuckDB writes into Parquet. */
  type:
    | "bool"
    | "int32"
    | "int64"
    | "float32"
    | "float64"
    | "string"
    | "timestamp"
    | "date"
    | "decimal"
    | "binary";
  nullable: boolean;
}

export interface DatasetSchema {
  columns: ColumnSchema[];
  rowCount: number;
  byteSize: number;
}

// Extraction inputs / outputs

export interface ExtractInput {
  /** Cache key — also the dataset directory name under shared_cache/parquet/. */
  datasetName: string;
  /** SQL the adapter executes against the source. The adapter is
   *  free to rewrite for dialect compatibility; result semantics
   *  must match the agent's expectation. */
  query: string;
  /** Optional bound parameters. Adapters that do not support
   *  parameterisation MUST throw if `params` is non-empty rather than
   *  silently inlining. */
  params?: Record<string, string | number | boolean | null>;
  /** Absolute Parquet output path the adapter MUST write to. The
   *  cache layer is the path authority; adapters do not choose. */
  outputPath: string;
  /** Hard wall-clock budget. Adapter MUST cancel on overshoot. */
  timeoutMs: number;
  /** Hard row cap. Adapter aborts if exceeded. */
  maxRows: number;
  /** Plumbed through cancellable network clients. */
  signal: AbortSignal;
}

export interface ExtractResult {
  schema: DatasetSchema;
  /** sha256 of the canonicalised query text — used by the cache layer
   *  to detect slot reassignment (same name + different query). */
  queryHash: string;
}

// Connection test

export interface ConnectionTestResult {
  ok: boolean;
  latencyMs: number;
  error?: string;
}

// Resolved data source

/**
 * Access-policy slice of a `data_source` row. Enforced by
 * `validateSqlAgainstPolicy` at the runtime layer + by the adapter
 * (read-only transaction wrapping). See `policy.ts` for details.
 */
export interface DataSourcePolicy {
  readOnly: boolean;
  /** Allowed table names (no schema qualification — V1 single-DB).
   *  null means "no allowlist constraint" (everything not denied is
   *  permitted). */
  tableAllowlist: string[] | null;
  /** Denied table names; takes precedence over the allowlist. */
  tableDenylist: string[];
}

/**
 * Fully-hydrated data source ready for an extract / test call.
 * Combines the `data_source` row's connection metadata + policy with
 * the linked `credential`'s decrypted user/password. Adapters consume
 * this directly — no further DB access required.
 */
export interface ResolvedDataSource {
  /** uuid of the data_source row. Stable; UI / API use it. */
  id: string;
  /** LLM-facing name (`extract_dataset_by_sql.dataSourceName` carries
   *  this string, not the uuid). */
  name: string;
  provider: DataSourceId;

  // Connection ----------------------------------------------------
  host: string;
  port: number;
  database: string;
  /** Driver-specific URL parameters — timezone, charset,
   *  connectTimeout, … Adapter merges these into its connection
   *  string. Single-valued only. */
  params: Record<string, string>;

  // Auth ----------------------------------------------------------
  /** Adapters map this to their driver-native key (`user` for
   *  libpq / mysql / vertica) at connection-build time. */
  username: string;
  password: string;

  // Policy --------------------------------------------------------
  policy: DataSourcePolicy;
}

// Client-safe adapter slice

/**
 * Static metadata the client (admin form, label rendering) needs.
 * Never carries server-only references; safe to import from React
 * components.
 */
export interface IDataSourceAdapter {
  readonly id: DataSourceId;
  readonly category: DataSourceCategory;
  readonly displayName: string;
  /** Zod schema for the credential's `secrets` payload. The admin
   *  form renders fields from this schema; the server validates the
   *  same way. */
  readonly secretsSchema: z.ZodTypeAny;
}

// Server-only module aggregator

/**
 * Per-source server-side capability bundle. Aggregates the
 * client-safe adapter with server-only `extract` / `testConnection`
 * implementations. One entry per id in `SOURCES` (registry.server.ts).
 */
export interface DataSourceModule {
  readonly id: DataSourceId;
  readonly adapter: IDataSourceAdapter;

  /**
   * Pull data from the source and write it as Parquet at
   * `input.outputPath`. CONTRACT: throws on any failure (connection,
   * SQL, timeout, cap); never returns a partial file (atomic rename
   * is the cache layer's job, not the adapter's). The signal is
   * honoured. The `resolved` argument is fully prepared by the
   * runtime — adapters never touch the DB to fetch credential or
   * data_source rows.
   */
  readonly extract: (
    resolved: ResolvedDataSource,
    input: ExtractInput,
  ) => Promise<ExtractResult>;

  /** Quick connectivity probe; called by the admin "Test connection" button. */
  readonly testConnection: (
    resolved: ResolvedDataSource,
    signal: AbortSignal,
  ) => Promise<ConnectionTestResult>;
}
