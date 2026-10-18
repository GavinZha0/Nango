/**
 * Server-side `extract_dataset_by_sql` agent tool. Auto-mounted
 * whenever an agent has any data_source binding; not user-selectable
 * via the built-in tool catalog. See docs/data-sources.md.
 */

import "server-only";

import * as path from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";

import { defineTool } from "@/lib/copilot/index.server";
import type { ToolDefinition } from "@/lib/copilot/index.server";
import { childLogger } from "@/lib/observability/logger";
import { z } from "zod";

import {
  abortWriteSlot,
  acquireWriteSlot,
  commitWriteSlot,
  datasetDir,
  getCacheStatus,
  hashQuery,
  validateDatasetName,
  InvalidCacheKeyError,
} from "./cache";
import { resolveDataSourceByName } from "./lookup";
import { validateSqlAgainstPolicy } from "./policy";
import { getDataSource } from "./registry.server";
import type { ColumnSchema, ExtractResult } from "./types";
import { getExtractLimits } from "./limits";
import { sanitizeConnectionStringError } from "./sanitization";

// Caps

import { getConfigNumber } from "@/lib/config";

/** Hard server-side caps applied to any LLM-supplied row_limit. */
const PREVIEW_HARD_CAP_ROWS = (): number => getConfigNumber("datasource.preview.max_rows", 200);
const PREVIEW_HARD_CAP_BYTES = (): number => getConfigNumber("datasource.preview.max_bytes", 50_000);

const log = childLogger({ component: "extract-dataset-by-sql" });

// Args / result shapes

const PREVIEW_ROWS_DEFAULT = (): number => getConfigNumber("datasource.preview.default_rows", 5);

const ExtractDatasetArgs = z.object({
  dataset_name: z
    .string()
    .min(1)
    .max(128)
    .describe(
      "Stable cache key for this dataset. Pick a name that clearly identifies the slice (source + scope + time), e.g. 'sales_q1_2025' or 'users_dev'. Reusing the same name + same query is cheap (cache hit). Inside run_code_in_sandbox, the dataset appears at ./tmp/data/<name>/ (relative to the sandbox's current working directory).",
    ),
  data_source_name: z
    .string()
    .min(1)
    .describe(
      "Name of the data source to query — exactly the slug shown in the 'Available data sources' block (e.g. 'prod_pg_readonly'). Do NOT pass a uuid. Picks the data_source row whose `name` matches; the runtime applies that source's policy (read-only, table allow/deny lists) before issuing the query.",
    ),
  sql_text: z
    .string()
    .min(1)
    .describe(
      "SQL query the source executes. Result rows are materialised as Parquet. Bake parameter values into the SQL — bound parameters are not supported in V1.",
    ),
  row_limit: z
    .number()
    .int()
    .nonnegative()
    .max(PREVIEW_HARD_CAP_ROWS())
    .default(PREVIEW_ROWS_DEFAULT())
    .describe(
      `Number of rows to return inline in 'rows' so a small dataset can be inspected without entering the sandbox. Default ${PREVIEW_ROWS_DEFAULT()}; pass 0 to skip inline rows, or up to ${PREVIEW_HARD_CAP_ROWS()}. Capped server-side at ${PREVIEW_HARD_CAP_ROWS()} rows / ${PREVIEW_HARD_CAP_BYTES()} bytes; oversize previews come back with returned_rows < total_rows.`,
    ),
  force_refresh: z
    .boolean()
    .default(false)
    .describe(
      "If true, skip the cache and re-extract from source even when a fresh snapshot exists. Use sparingly — usually the cache is what makes repeat analysis cheap. Default false.",
    ),
});

export interface ExtractDatasetResult {
  cache_hit: boolean;
  dataset_name: string;
  /** Total rows in the materialised dataset; check 0 to short-circuit empty queries. */
  total_rows: number;
  /** Number of rows actually returned in `rows`. Equal to total_rows
   *  when the result fit inline; less when capped by row_limit /
   *  preview byte budget. */
  returned_rows: number;
  /** Row-of-objects projection of the top `returned_rows` rows. Each
   *  entry is `Record<columnName, cellValue>`. Chart nodes consume
   *  this directly via `inputs.dataset: "@nodes.X.rows"`. */
  rows: Array<Record<string, unknown>>;
  /** Per-column type metadata. Populated even for empty results on
   *  fresh extracts; cache hits return an empty array because the
   *  cache sidecar does not persist column types. */
  row_schema: { columns: ColumnSchema[] };
  ttl_hours: number;
  /** Set when this call REPLACED a different prior snapshot under
   *  the same name (different query hash). Always paired with
   *  cache_hit:false. In-flight sandbox runs still see the old bytes
   *  via OS open-FD / page-cache semantics; only new runs see the
   *  new snapshot. Same-query refresh does NOT set this. */
  replaced_prior?: boolean;
}

// Tool

/**
 * @param allowedDataSourceIds - the caller's approved binding set. The
 *   tool resolves data sources by global name, so this Set is the
 *   authorization boundary (BUG-1): agent path passes the agent's bound
 *   `dataSourceIds`; workflow path passes the owner-visible ids. Mirrors
 *   the SSH `allowedIds` pattern.
 */
export interface ExtractDatasetForAgentArgs {
  dataSourceName: string;
  datasetName: string;
  sqlText: string;
  rowLimit?: number;
  forceRefresh?: boolean;
}

export interface ExtractDatasetErrorResult {
  ok: false;
  error: { code: string; message: string };
}

export type ExtractDatasetForAgentResult =
  | ExtractDatasetResult
  | ExtractDatasetErrorResult;

/**
 * Shared extraction path used by `extract_dataset_by_sql` and the
 * `run_skill_sql_script` skill tool.
 *
 * CONTRACT: the caller already authorized the data source binding; this
 * function enforces the allowed-ID set, SQL policy, cache, and extraction.
 */
export async function extractDatasetForAgent(
  args: ExtractDatasetForAgentArgs,
  allowedDataSourceIds: readonly string[],
): Promise<ExtractDatasetForAgentResult> {
  const allowed = new Set(allowedDataSourceIds);
  // The adapter wraps the query in `COPY (...)`; a trailing semicolon would
  // make that invalid, and a multi-statement file is rejected by the policy.
  const sqlText = args.sqlText.trim().replace(/;\s*$/, "");
  if (sqlText.length === 0) {
    return {
      ok: false,
      error: { code: "EMPTY_SQL", message: "SQL is empty." },
    };
  }

  try {
    validateDatasetName(args.datasetName);
  } catch (err) {
    if (err instanceof InvalidCacheKeyError) {
      return {
        ok: false,
        error: { code: "INVALID_NAME", message: err.message },
      };
    }
    throw err;
  }

  const lookup = await resolveDataSourceByName(args.dataSourceName);
  if (!lookup.ok) {
    return {
      ok: false,
      error: { code: lookup.error, message: lookup.message },
    };
  }
  const resolved = lookup.resolved;

  // SECURITY (BUG-1): the editor/admin-approved binding is the
  // authorization boundary. The name lookup is global, so reject any
  // source outside the caller's allowed set. Return NOT_FOUND (not
  // "forbidden") so we don't leak the existence of unbound sources.
  if (!allowed.has(resolved.id)) {
    return {
      ok: false,
      error: {
        code: "NOT_FOUND",
        message: `Data source "${args.dataSourceName}" not found.`,
      },
    };
  }

  // Policy gate: parse the SQL and reject before touching the cache so
  // writes / disallowed tables / multi-statement scripts fail fast. The
  // adapter ALSO wraps in a read-only transaction when policy.readOnly
  // — defence in depth.
  const policyCheck = validateSqlAgainstPolicy(
    sqlText,
    resolved.provider,
    resolved.policy,
    { singleStatement: true },
  );
  if (!policyCheck.ok) {
    return {
      ok: false,
      error: { code: policyCheck.code, message: policyCheck.message },
    };
  }

  const limits = getExtractLimits();
  const ttlHours = limits.defaultTtlHours;
  const queryHash = hashQuery(sqlText);
  const rowLimit = Math.min(
    args.rowLimit ?? PREVIEW_ROWS_DEFAULT(),
    PREVIEW_HARD_CAP_ROWS(),
  );
  const forceRefresh = args.forceRefresh ?? false;

  // We DO NOT re-validate policy on cache hits: the Parquet
  // snapshot is a historical artefact, and re-checking would
  // force a re-extract every time the policy tightens. The next
  // miss naturally re-applies the new policy.
  // CONTRACT: A cache hit requires the query hash AND data source ID to match.
  // Reusing the same dataset name with a different source or different query
  // is a slot reassignment and must re-extract.
  const status = await getCacheStatus(args.datasetName);
  if (
    !forceRefresh &&
    status.exists &&
    status.isFresh &&
    status.meta &&
    status.meta.queryHash === queryHash &&
    status.meta.dataSourceId === resolved.id
  ) {
    const preview =
      rowLimit > 0 && status.meta.rowCount > 0
        ? await readPreview(args.datasetName, rowLimit)
        : [];
    return {
      cache_hit: true,
      dataset_name: args.datasetName,
      total_rows: status.meta.rowCount,
      returned_rows: preview.length,
      rows: preview,
      // Sidecar persists totals only; columns are not preserved
      // on hits. Agents needing the column list must force a
      // fresh extraction.
      row_schema: { columns: [] },
      ttl_hours: status.meta.ttlHours,
    } satisfies ExtractDatasetResult;
  }

  // Slot semantics: same name + different query or different source
  // is a slot reassignment, not an error. commitWriteSlot does `rm -rf
  // <final> && rename(tmp, final)` atomically. The log line
  // preserves observability so an admin can audit reassignments.
  const replacedPrior: boolean =
    status.exists &&
    status.meta != null &&
    (status.meta.queryHash !== queryHash ||
      status.meta.dataSourceId !== resolved.id);
  if (replacedPrior && status.meta) {
    log.info(
      {
        event: "dataset_replaced",
        name: args.datasetName,
        oldQueryHash: status.meta.queryHash,
        newQueryHash: queryHash,
        oldDataSourceId: status.meta.dataSourceId,
        newDataSourceId: resolved.id,
        oldRowCount: status.meta.rowCount,
        dataSourceName: args.dataSourceName,
      },
      `dataset "${args.datasetName}" slot reassigned (${
        status.meta.dataSourceId !== resolved.id
          ? "different data source"
          : "different query"
      })`,
    );
  }

  const source = getDataSource(resolved.provider);
  const slot = await acquireWriteSlot(args.datasetName);
  const ac = new AbortController();

  let extracted: ExtractResult;
  try {
    extracted = await source.extract(resolved, {
      datasetName: args.datasetName,
      query: sqlText,
      outputPath: slot.outputPath,
      timeoutMs: limits.timeoutMs,
      maxRows: limits.maxRows,
      previewRows: rowLimit,
      signal: ac.signal,
    });
  } catch (err) {
    await abortWriteSlot(slot);
    const rawMessage = err instanceof Error ? err.message : String(err);
    log.error(
      { err, dataSourceName: args.dataSourceName, datasetName: args.datasetName },
      "extract_dataset_by_sql failed",
    );
    return {
      ok: false,
      error: {
        code: "EXTRACT_FAILED",
        message: sanitizeConnectionStringError(rawMessage, args.dataSourceName),
      },
    };
  }

  await commitWriteSlot({
    name: args.datasetName,
    slot,
    source: resolved.provider,
    dataSourceId: resolved.id,
    queryHash,
    ttlHours,
    rowCount: extracted.schema.rowCount,
    byteSize: extracted.schema.byteSize,
  });

  const preview = extracted.rows ?? [];

  const result: ExtractDatasetResult = {
    cache_hit: false,
    dataset_name: args.datasetName,
    total_rows: extracted.schema.rowCount,
    returned_rows: preview.length,
    rows: preview,
    row_schema: { columns: extracted.schema.columns },
    ttl_hours: ttlHours,
  };
  if (replacedPrior) {
    result.replaced_prior = true;
  }
  return result;
}

export function buildExtractDatasetTool(
  allowedDataSourceIds: readonly string[],
): ToolDefinition {
  return defineTool({
    name: "extract_dataset_by_sql",
    description:
      "Materialise a SQL query result from an external data source as a " +
      "Parquet snapshot in the shared cache. Cache-aware: repeat calls " +
      "with the same dataset_name + sql_text are cheap (cache hit, no " +
      "source roundtrip); pass force_refresh=true to bypass the cache " +
      "when fresh data is required. " +
      "Returns { cache_hit, dataset_name, total_rows, returned_rows, " +
      "rows, row_schema, ttl_hours, replaced_prior? } — check " +
      "`total_rows === 0` to short-circuit empty results without " +
      "entering the sandbox. `rows` is an array of row objects " +
      "(`Record<columnName, cellValue>`) carrying the top " +
      "`returned_rows` rows; pass row_limit=0 to skip inline rows " +
      "when you only want metadata, or up to 200 to peek at more " +
      "rows inline. When `returned_rows < total_rows` the result was " +
      "truncated by row_limit / byte budget — read the full dataset " +
      "from the parquet handle via run_code_in_sandbox.datasets. " +
      "Name semantics: `dataset_name` is a SLOT (think variable name), " +
      "not an identifier. Re-using the same name with a DIFFERENT " +
      "sql_text REPLACES the prior snapshot under that slot " +
      "(last-write-wins); the result carries `replaced_prior: true` " +
      "so you know it happened. Re-using the same name with the SAME " +
      "sql_text returns the cached snapshot (cache_hit: true). " +
      "To run analysis on the full dataset, pass `dataset_name` to " +
      "run_code_in_sandbox.datasets[]; the Parquet files become " +
      "readable at ./tmp/data/<dataset_name>/ in the sandbox's working " +
      "directory. For a reviewed SQL script declared by a bound skill " +
      "under scripts-on-db, prefer run_skill_sql_script; use this tool " +
      "for ad-hoc or modified SQL.",
    parameters: ExtractDatasetArgs,
    execute: async (args) =>
      extractDatasetForAgent(
        {
          dataSourceName: args.data_source_name,
          datasetName: args.dataset_name,
          sqlText: args.sql_text,
          rowLimit: args.row_limit,
          forceRefresh: args.force_refresh,
        },
        allowedDataSourceIds,
      ),
  });
}

// Preview reader

/**
 * Read the first `requested` rows from the dataset's Parquet files
 * via duckdb-engine container service and return them as a row-of-objects array
 * (`Record<columnName, cellValue>[]`). Drops rows from the tail
 * until the JSON serialisation fits in
 * {@link PREVIEW_HARD_CAP_BYTES}.
 */
async function readPreview(
  name: string,
  requestedRows: number,
): Promise<Array<Record<string, unknown>>> {
  const limit = Math.min(requestedRows, PREVIEW_HARD_CAP_ROWS());
  const glob = path.join(datasetDir(name), "**", "*.parquet");

  const db = await DuckDBInstance.create(":memory:");
  const conn = await db.connect();
  try {
    const previewRel = await conn.runAndReadAll(
      `SELECT * FROM read_parquet('${escapeSingleQuotes(glob)}') LIMIT ${limit}`,
    );
    const rows = previewRel.getRowObjectsJson() as Array<Record<string, unknown>>;
    while (
      rows.length > 0 &&
      JSON.stringify(rows).length > PREVIEW_HARD_CAP_BYTES()
    ) {
      rows.pop();
    }
    return rows;
  } catch {
    return [];
  } finally {
    conn.closeSync();
    db.closeSync();
  }
}

function escapeSingleQuotes(s: string): string {
  return s.replaceAll("'", "''");
}
