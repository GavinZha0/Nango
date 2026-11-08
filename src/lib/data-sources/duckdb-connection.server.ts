/**
 * Unified DuckDB 2.0 connection factory supporting both in-process `:memory:`
 * execution (Mode A, default) and experimental Quack remote server routing
 * via `CONNECT remote_db` (Mode B, opt-in via enabled `duckdb-server` credential).
 *
 * See docs/desktop-architecture.md and docs/data-sources.md.
 */

import "server-only";

import { DuckDBInstance } from "@duckdb/node-api";
import { getEnabledInfrastructureCredentialByProvider } from "@/lib/credentials/lookup";

const HOST_PORT_RE = /^[a-zA-Z0-9.-]+:\d{1,5}$/;
const SAFE_TOKEN_RE = /^[a-zA-Z0-9._~+/-]+=*$/;

export interface OpenDuckdbConnectionOptions {
  /**
   * When true, always use the local in-process `:memory:` instance (Mode A)
   * and skip Quack remote server routing. Used by Vertica extraction, which
   * writes temporary local NDJSON files before converting to Parquet.
   */
  forceLocal?: boolean;
}

export interface DuckdbConnectionHandle {
  db: DuckDBInstance;
  conn: Awaited<ReturnType<DuckDBInstance["connect"]>>;
  isRemoteQuack: boolean;
}

/**
 * Normalize an optional `quack:` or `http(s)://` prefix on a configured
 * DuckDB Server host string and validate strictly against `host:port`.
 */
export function normalizeAndValidateQuackHost(rawHost: string): string {
  const trimmed = rawHost
    .trim()
    .replace(/^(?:quack:|https?:\/\/)/i, "")
    .replace(/\/+$/, "");
  if (!HOST_PORT_RE.test(trimmed)) {
    throw new Error(
      `Invalid duckdb-server host:port format: "${trimmed}". Expected "<host>:<port>".`,
    );
  }
  return trimmed;
}

/**
 * Validate a Quack server authentication token against a strict character
 * allowlist so it can never break out of the SQL `TOKEN '...'` literal.
 *
 * SECURITY: Never include the token value itself in thrown error messages.
 */
export function validateQuackToken(rawToken: string): string {
  const trimmed = rawToken.trim();
  if (!SAFE_TOKEN_RE.test(trimmed)) {
    throw new Error(
      "Invalid duckdb-server token characters; only alphanumeric and standard token symbols (._~+/-=) are permitted.",
    );
  }
  return trimmed;
}

/**
 * Open a DuckDB 2.0 connection, applying local offline extension directory
 * configuration (`NANGO_DUCKDB_EXTENSION_DIR`) and optional Quack remote
 * server routing (`duckdb-server` infrastructure credential).
 */
export async function openDuckdbConnection(
  opts?: OpenDuckdbConnectionOptions,
): Promise<DuckdbConnectionHandle> {
  const db = await DuckDBInstance.create(":memory:");
  const conn = await db.connect();

  try {
    const extDir = process.env.NANGO_DUCKDB_EXTENSION_DIR?.trim();
    if (extDir && extDir.length > 0) {
      const escapedExtDir = extDir.replaceAll("'", "''");
      await conn.run(`SET extension_directory = '${escapedExtDir}';`);
    }

    if (!opts?.forceLocal) {
      let cred: Awaited<
        ReturnType<typeof getEnabledInfrastructureCredentialByProvider>
      > = null;
      try {
        cred =
          await getEnabledInfrastructureCredentialByProvider("duckdb-server");
      } catch {
        // Fall back to in-process Mode A if the credential store is unreachable
        cred = null;
      }
      if (cred?.host && cred.host.trim().length > 0) {
        const hostPort = normalizeAndValidateQuackHost(cred.host);
        const tokenClause =
          cred.apiKey && cred.apiKey.trim().length > 0
            ? `, TOKEN '${validateQuackToken(cred.apiKey)}'`
            : "";

        try {
          await conn.run(
            `ATTACH 'quack:${hostPort}' AS remote_db (TYPE quack${tokenClause});`,
          );
          await conn.run("CONNECT remote_db;");
        } catch (err) {
          // SECURITY: Scrub any potential token echo from upstream DuckDB error strings
          const rawMsg = err instanceof Error ? err.message : String(err);
          const safeMsg =
            cred.apiKey && cred.apiKey.length > 0
              ? rawMsg.replaceAll(cred.apiKey, "***")
              : rawMsg;
          throw new Error(
            `Failed to connect to remote DuckDB Quack server at ${hostPort}: ${safeMsg}`,
          );
        }

        return { db, conn, isRemoteQuack: true };
      }
    }

    return { db, conn, isRemoteQuack: false };
  } catch (err) {
    conn.closeSync();
    db.closeSync();
    throw err;
  }
}
