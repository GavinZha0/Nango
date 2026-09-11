import type pg from "pg";
import { E2E_NAME_MARKER } from "../helpers/registry";
import { TEST_EMAIL_SUFFIX } from "../constants/test-users";

/**
 * Domain tables swept by name marker, in FK-safe deletion order.
 * `nameColumn` is the column that carries the resource name.
 */
export const SWEPT_TABLES: Array<{ table: string; nameColumn: string }> = [
  { table: "notification", nameColumn: "title" },
  { table: "schedule", nameColumn: "name" },
  { table: "ssh_server", nameColumn: "name" },
  { table: "verification_suite", nameColumn: "name" },
  { table: "eval_suite", nameColumn: "name" },
  { table: "web_auto_suite", nameColumn: "name" },
  { table: "mcp_server", nameColumn: "name" },
  { table: "skill", nameColumn: "name" },
  { table: "data_source", nameColumn: "name" },
  { table: "builtin_agent", nameColumn: "name" },
  { table: "credential", nameColumn: "name" },
];

/**
 * Sweep test-created resources whose names contain the E2E marker.
 * Deletion errors on a single table (e.g. orphan FK restrictions) are caught
 * and logged as warnings so subsequent tables and test-user cleanup are not blocked.
 */
export async function sweepTestResources(client: pg.Client): Promise<number> {
  let total = 0;
  for (const { table, nameColumn } of SWEPT_TABLES) {
    try {
      const isAgent = table === "builtin_agent";
      const query = isAgent
        ? `DELETE FROM ${table} WHERE ${nameColumn} LIKE $1 OR created_by IN (SELECT id FROM "user" WHERE email LIKE $2)`
        : `DELETE FROM ${table} WHERE ${nameColumn} LIKE $1`;
      const params = isAgent
        ? [`%${E2E_NAME_MARKER}%`, `%${TEST_EMAIL_SUFFIX}`]
        : [`%${E2E_NAME_MARKER}%`];
      const result = await client.query(query, params);
      if (result.rowCount && result.rowCount > 0) {
        console.log(`  Swept ${result.rowCount} row(s) from ${table}.`);
        total += result.rowCount;
      }
    } catch (err) {
      console.warn(`  [WARN] Failed to sweep ${table}:`, err);
    }
  }
  return total;
}
