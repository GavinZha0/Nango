/**
 * App-layer DataSource policy enforcement. See docs/data-sources.md.
 */

import { Parser, type AST } from "node-sql-parser";

import type { DataSourceId, DataSourcePolicy } from "./types";

const parser = new Parser();

/** Map our provider id to node-sql-parser's dialect string. Vertica
 *  speaks Postgres-compatible SQL so it parses under PostgreSQL. */
function dialectFor(provider: DataSourceId): string {
  switch (provider) {
    case "postgres":
      return "PostgreSQL";
    case "mysql":
      return "MySQL";
    case "mariadb":
      return "MariaDB";
    case "vertica":
      return "PostgreSQL";
  }
}

export type PolicyViolationCode =
  | "PARSE_ERROR"
  | "WRITE_NOT_ALLOWED"
  | "TABLE_NOT_ALLOWED"
  | "TABLE_DENIED";

export interface PolicyOk {
  ok: true;
}
export interface PolicyFail {
  ok: false;
  code: PolicyViolationCode;
  message: string;
}
export type PolicyResult = PolicyOk | PolicyFail;

export function validateSqlAgainstPolicy(
  sql: string,
  provider: DataSourceId,
  policy: DataSourcePolicy,
): PolicyResult {
  const dialect = dialectFor(provider);

  let astResult: AST[] | AST;
  let entries: string[];
  try {
    astResult = parser.astify(sql, { database: dialect });
    entries = parser.tableList(sql, { database: dialect });
  } catch (err) {
    // Fail closed: if we can't parse, we can't reason about safety.
    return {
      ok: false,
      code: "PARSE_ERROR",
      message:
        `Failed to parse SQL for policy check: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const cteNames = collectCteNames(astResult);
  const allowSet = policy.tableAllowlist
    ? new Set(policy.tableAllowlist)
    : null;
  const denySet = new Set(policy.tableDenylist);

  for (const entry of entries) {
    // Format: "<type>::<db>::<table>", e.g. "select::null::users".
    const [type, , table] = entry.split("::");
    if (!table) continue;

    // CTE names appear as fake table refs; skip — the inner SELECT
    // body's actual tables are listed separately.
    if (cteNames.has(table)) continue;

    if (policy.readOnly && type !== "select") {
      return {
        ok: false,
        code: "WRITE_NOT_ALLOWED",
        message:
          `Data source is read-only; ${type.toUpperCase()} on ` +
          `"${table}" is not permitted.`,
      };
    }
    if (denySet.has(table)) {
      return {
        ok: false,
        code: "TABLE_DENIED",
        message:
          `Table "${table}" is on the data source's deny list and ` +
          `cannot be queried.`,
      };
    }
    if (allowSet && !allowSet.has(table)) {
      return {
        ok: false,
        code: "TABLE_NOT_ALLOWED",
        message:
          `Table "${table}" is not in the data source's allow list.`,
      };
    }
  }

  return { ok: true };
}

// Internals

/**
 * Walk the AST's WITH clauses and collect declared CTE names so they
 * can be subtracted from the `tableList()` output (which would
 * otherwise treat them as real tables).
 */
function collectCteNames(ast: AST[] | AST): Set<string> {
  const out = new Set<string>();
  const stmts = Array.isArray(ast) ? ast : [ast];
  for (const stmt of stmts) {
    const withs = (stmt as { with?: unknown }).with;
    if (!Array.isArray(withs)) continue;
    for (const w of withs) {
      const name = (w as { name?: { value?: string } }).name?.value;
      if (typeof name === "string") out.add(name);
    }
  }
  return out;
}
