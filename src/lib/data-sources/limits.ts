/**
 * System-level resource bounds for the data-source extract pipeline.
 */

import "server-only";

import { getConfigMs, getConfigNumber } from "@/lib/config";

const DEFAULT_TIMEOUT_S = 60;
const DEFAULT_MAX_ROWS = 1_000_000;
const DEFAULT_TTL_HOURS = 24;

export interface ExtractLimits {
  /** Wall-clock budget for one extract roundtrip. */
  timeoutMs: number;
  /** Hard row cap; the adapter aborts the extract if exceeded. */
  maxRows: number;
  /** Default cache lifetime when forceRefresh is false. */
  defaultTtlHours: number;
}

export function getExtractLimits(): ExtractLimits {
  return {
    timeoutMs: getConfigMs("datasource.extract.timeout", DEFAULT_TIMEOUT_S),
    maxRows: getConfigNumber("datasource.extract.max_rows", DEFAULT_MAX_ROWS),
    defaultTtlHours: getConfigNumber("datasource.extract.ttl_hours", DEFAULT_TTL_HOURS),
  };
}

/** Test seam: no-op now (config service handles caching). */
export function __resetExtractLimitsCache(): void {
  // Kept for backward compat with existing tests.
}
