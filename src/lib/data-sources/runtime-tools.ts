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

// Caps

import { getConfigNumber } from "@/lib/config";

/** Hard server-side caps applied to any LLM-supplied previewRows. */
const PREVIEW_HARD_CAP_ROWS = (): number => getConfigNumber("datasource.preview.max_rows", 200);
const PREVIEW_HARD_CAP_BYTES = (): number => getConfigNumber("datasource.preview.max_bytes", 50_000);

const log = childLogger({ component: "extract-dataset-by-sql" });

// Args / result shapes

const PREVIEW_ROWS_DEFAULT = (): number => getConfigNumber("datasource.preview.default_rows", 5);

const ExtractDatasetArgs = z.object({
  name: z
    .string()
    .min(1)
    .max(128)
    .describe(
      "Stable cache key for this dataset. Pick a name that clearly identifies the slice (source + scope + time), e.g. 'sales_q1_2025' or 'users_dev'. Reusing the same name + same query is cheap (cache hit). Inside run_code_in_sandbox, the dataset appears at ./data/<name>/ (relative to the sandbox's current working directory).",
    ),
  dataSourceName: z
    .string()
    .min(1)
    .describe(
      "Name of the data source to query — exactly the slug shown in the 'Available data sources' block (e.g. 'prod_pg_readonly'). Do NOT pass a uuid. Picks the data_source row whose `name` matches; the runtime applies that source's policy (read-only, table allow/deny lists) before issuing the query.",
    ),
  query: z
    .string()
    .min(1)
    .describe(
      "SQL query the source executes. Result rows are materialised as Parquet. Bake parameter values into the SQL — bound parameters are not supported in V1.",
    ),
  previewRows: z
    .number()
    .int()
    .nonnegative()
    .max(PREVIEW_HARD_CAP_ROWS())
    .default(PREVIEW_ROWS_DEFAULT())
    .describe(
      `Number of rows to return inline so a small dataset can be inspected without entering the sandbox. Default ${PREVIEW_ROWS_DEFAULT()}; pass 0 to skip the preview, or up to ${PREVIEW_HARD_CAP_ROWS()}. Capped server-side at ${PREVIEW_HARD_CAP_ROWS()} rows / ${PREVIEW_HARD_CAP_BYTES()} bytes; oversize previews come back with truncated=true.`,
    ),
  forceRefresh: z
    .boolean()
    .default(false)
    .describe(
      "If true, skip the cache and re-extract from source even when a fresh snapshot exists. Use sparingly — usually the cache is what makes repeat analysis cheap. Default false.",
    ),
});

export interface PreviewBlock {
  /** Column names in the same order as each row in {@link rows}. */
  columns: string[];
  /** Row-major 2D array of cell values. `rows[r][c]` is the cell at
   *  row `r`, column `columns[c]`. Column-oriented saves ~50% tokens
   *  vs row-of-objects while keeping full type fidelity. */
  rows: unknown[][];
  /** True iff capped by row count or byte budget — agent should
   *  enter the sandbox for the rest. */
  truncated: boolean;
}

export interface ExtractDatasetResult {
  cacheHit: boolean;
  name: string;
  /** Total rows in the materialised dataset; check 0 to short-circuit empty queries. */
  rowCount: number;
  schema: { columns: ColumnSchema[] };
  ttlHours: number;
  preview?: PreviewBlock;
  /** Set when this call REPLACED a different prior snapshot under
   *  the same name (different query hash). Always paired with
   *  cacheHit:false. In-flight sandbox runs still see the old bytes
   *  via OS open-FD / page-cache semantics; only new runs see the
   *  new snapshot. Same-query refresh does NOT set this. */
  replacedPrior?: boolean;
}

// Tool

export function buildExtractDatasetTool(): ToolDefinition {
  return defineTool({
    name: "extract_dataset_by_sql",
    description:
      "Materialise a SQL query result from an external data source as a " +
      "Parquet snapshot in the shared cache. Cache-aware: repeat calls " +
      "with the same name + query are cheap (cache hit, no source roundtrip); " +
      "pass forceRefresh=true to bypass the cache when fresh data is required. " +
      "Returns { cacheHit, name, rowCount, schema, ttlHours, preview?, replacedPrior? } — " +
      "check `rowCount === 0` to short-circuit empty results without " +
      "entering the sandbox. The returned `preview` (default 5 rows) is " +
      "COLUMN-ORIENTED: `preview.columns` lists field names; " +
      "`preview.rows` is a 2D array where `rows[r][c]` matches " +
      "`columns[c]` (DataFrame-style, types preserved as JSON values). " +
      "Set previewRows=0 to skip the preview when you only want metadata, " +
      "or up to 200 to peek at more rows inline. " +
      "Name semantics: `name` is a SLOT (think variable name), not an " +
      "identifier. Re-using the same `name` with a DIFFERENT query " +
      "REPLACES the prior snapshot under that slot (last-write-wins); " +
      "the result carries `replacedPrior: true` so you know it happened. " +
      "Re-using the same `name` with the SAME query returns the cached " +
      "snapshot (cacheHit: true). " +
      "To run analysis on the full dataset, pass `name` to " +
      "run_code_in_sandbox.datasets[]; the Parquet files become " +
      "readable at ./data/<name>/ in the sandbox's working directory.",
    parameters: ExtractDatasetArgs,
    execute: async (args) => {
      try {
        validateDatasetName(args.name);
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

      // Policy gate: parse the SQL and reject before touching the
      // cache so writes / disallowed tables fail fast. The adapter
      // ALSO wraps in a read-only transaction when policy.readOnly
      // — defence in depth.
      const policyCheck = validateSqlAgainstPolicy(
        args.query,
        resolved.provider,
        resolved.policy,
      );
      if (!policyCheck.ok) {
        return {
          ok: false,
          error: { code: policyCheck.code, message: policyCheck.message },
        };
      }

      const limits = getExtractLimits();
      const ttlHours = limits.defaultTtlHours;
      const queryHash = hashQuery(args.query);
      const previewRows = args.previewRows;

      // We DO NOT re-validate policy on cache hits: the Parquet
      // snapshot is a historical artefact, and re-checking would
      // force a re-extract every time the policy tightens. The next
      // miss naturally re-applies the new policy.
      const status = await getCacheStatus(args.name);
      if (
        !args.forceRefresh &&
        status.exists &&
        status.isFresh &&
        status.meta &&
        status.meta.queryHash === queryHash
      ) {
        const result: ExtractDatasetResult = {
          cacheHit: true,
          name: args.name,
          rowCount: status.meta.rowCount,
          // Sidecar persists totals only; columns are not preserved
          // on hits. Agents needing the column list must force a
          // fresh extraction.
          schema: { columns: [] },
          ttlHours: status.meta.ttlHours,
        };
        if (previewRows > 0 && status.meta.rowCount > 0) {
          result.preview = await readPreview(
            args.name,
            previewRows,
            status.meta.rowCount,
          );
        }
        return result;
      }

      // Slot semantics: same name + different query is a slot
      // reassignment, not an error. commitWriteSlot does `rm -rf
      // <final> && rename(tmp, final)` atomically. The log line
      // preserves observability so an admin can audit reassignments.
      const replacedPrior: boolean =
        status.exists &&
        status.meta != null &&
        status.meta.queryHash !== queryHash;
      if (replacedPrior && status.meta) {
        log.info(
          {
            event: "dataset_replaced",
            name: args.name,
            oldQueryHash: status.meta.queryHash,
            newQueryHash: queryHash,
            oldRowCount: status.meta.rowCount,
            dataSourceName: args.dataSourceName,
          },
          `dataset "${args.name}" slot reassigned (different query)`,
        );
      }


      const source = getDataSource(resolved.provider);
      const slot = await acquireWriteSlot(args.name);
      const ac = new AbortController();

      let extracted: ExtractResult;
      try {
        extracted = await source.extract(resolved, {
          datasetName: args.name,
          query: args.query,
          outputPath: slot.outputPath,
          timeoutMs: limits.timeoutMs,
          maxRows: limits.maxRows,
          signal: ac.signal,
        });
      } catch (err) {
        await abortWriteSlot(slot);
        return {
          ok: false,
          error: {
            code: "EXTRACT_FAILED",
            message: err instanceof Error ? err.message : String(err),
          },
        };
      }

      await commitWriteSlot({
        name: args.name,
        slot,
        source: resolved.provider,
        dataSourceId: resolved.id,
        queryHash,
        ttlHours,
        rowCount: extracted.schema.rowCount,
        byteSize: extracted.schema.byteSize,
      });

      const result: ExtractDatasetResult = {
        cacheHit: false,
        name: args.name,
        rowCount: extracted.schema.rowCount,
        schema: { columns: extracted.schema.columns },
        ttlHours,
      };
      if (replacedPrior) {
        result.replacedPrior = true;
      }
      if (previewRows > 0 && extracted.schema.rowCount > 0) {
        result.preview = await readPreview(
          args.name,
          previewRows,
          extracted.schema.rowCount,
        );
      }
      return result;
    },
  });
}

// Preview reader

/**
 * Read the first `requested` rows from the dataset's Parquet files
 * via DuckDB and return them column-oriented. Drops rows from the
 * tail until the JSON serialisation fits in {@link PREVIEW_HARD_CAP_BYTES};
 * sets `truncated = true` when either cap engages or when the dataset
 * has more rows than we returned.
 */
async function readPreview(
  name: string,
  requestedRows: number,
  totalRowCount: number,
): Promise<PreviewBlock> {
  const limit = Math.min(requestedRows, PREVIEW_HARD_CAP_ROWS());
  const glob = path.join(datasetDir(name), "**", "*.parquet");

  const db = await DuckDBInstance.create(":memory:");
  const conn = await db.connect();
  let columns: string[];
  let rows: unknown[][];
  try {
    const result = await conn.runAndReadAll(
      `SELECT * FROM read_parquet('${escapeSingleQuotes(glob)}') LIMIT ${limit}`,
    );
    columns = result.columnNames();
    rows = result.getRowsJson() as unknown[][];
  } finally {
    conn.closeSync();
    db.closeSync();
  }

  // Byte budget covers BOTH columns + rows since both are emitted
  // to the LLM; pathological wide schemas need the same protection.
  let byteCapped = false;
  while (
    rows.length > 0 &&
    JSON.stringify({ columns, rows }).length > PREVIEW_HARD_CAP_BYTES()
  ) {
    rows.pop();
    byteCapped = true;
  }

  const rowCapped = totalRowCount > rows.length;
  return { columns, rows, truncated: byteCapped || rowCapped };
}

function escapeSingleQuotes(s: string): string {
  return s.replaceAll("'", "''");
}
