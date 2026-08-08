/**
/**
 * Server-only HTTP Client for the external `duckdb-engine` container service.
 * Looks up endpoint credentials from `CredentialTable` (provider: "duckdb-engine").
 */

import "server-only";

import { getEnabledInfrastructureCredentialByProvider } from "@/lib/credentials/lookup";
import { getConfigMs } from "@/lib/config";
import type { ColumnSchema } from "./types";

const DEFAULT_SERVICE_URL = "http://duckdb-engine:8526";
const DEFAULT_API_KEY = "my-local-duckdb-engine-secret";
const DEFAULT_TIMEOUT_MS = 60000;

export interface DuckdbEngineExtractInput {
  query: string;
  datasetName?: string;
  provider?: "standalone" | "postgres" | "mysql" | "s3" | string;
  config?: Record<string, unknown>;
  previewRows?: number;
  maxRows?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface DuckdbEngineExtractResult {
  ok: boolean;
  datasetName: string;
  outputPath: string;
  totalRows: number;
  returnedRows: number;
  byteSize: number;
  rows: Array<Record<string, unknown>>;
  rowSchema: { columns: ColumnSchema[] };
}

export async function extractViaDuckdbEngine(
  input: DuckdbEngineExtractInput,
): Promise<DuckdbEngineExtractResult> {
  const cred = await getEnabledInfrastructureCredentialByProvider("duckdb-engine");
  const baseUrl = (cred?.host ?? DEFAULT_SERVICE_URL).replace(/\/+$/, "");
  const apiKey = cred?.apiKey ?? DEFAULT_API_KEY;
  const timeoutMs = input.timeoutMs ?? getConfigMs("datasource.timeout", DEFAULT_TIMEOUT_MS);

  const endpoint = `${baseUrl}/v1/extract`;

  const payload = {
    query: input.query,
    dataset_name: input.datasetName,
    provider: input.provider ?? "standalone",
    config: input.config ?? {},
    preview_rows: input.previewRows ?? 5,
    max_rows: input.maxRows ?? 500000,
  };

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-DuckDB-Api-Key": apiKey,
  };

  const res = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
    signal: input.signal ?? AbortSignal.timeout(timeoutMs),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`DuckDB Engine returned HTTP ${res.status}: ${errText}`);
  }

  const json = (await res.json()) as {
    ok: boolean;
    dataset_name: string;
    output_path: string;
    total_rows: number;
    returned_rows: number;
    byte_size: number;
    rows: Array<Record<string, unknown>>;
    row_schema: { columns: ColumnSchema[] };
  };

  if (!json.ok) {
    throw new Error("DuckDB Engine reported non-ok status");
  }

  return {
    ok: json.ok,
    datasetName: json.dataset_name,
    outputPath: json.output_path,
    totalRows: json.total_rows,
    returnedRows: json.returned_rows,
    byteSize: json.byte_size,
    rows: json.rows ?? [],
    rowSchema: json.row_schema ?? { columns: [] },
  };
}
