/**
 * Global teardown: clean up test users and test-created resources from the
 * database after E2E tests.
 *
 * Resource sweep: every test-created resource is named via uniqueName()
 * (helpers/data.ts), which embeds the "-e2e-" marker. We delete rows whose
 * name matches across all domain tables, in FK-safe order — dependent
 * tables first (via cascade), credentials last because builtin_agent
 * references them. User deletion cascades cover anything the sweep misses.
 */
import { config } from "dotenv";
import pg from "pg";

import { getPostgresUrl } from "@/lib/db/postgres-url";

config();

const { Client } = pg;

const TEST_EMAIL_SUFFIX = "@test-e2e.local";
const E2E_NAME_MARKER = "-e2e-";

// Tables swept by name marker, in FK-safe deletion order. `nameColumn` is
// the column that carries the resource name.
const SWEPT_TABLES: Array<{ table: string; nameColumn: string }> = [
  { table: "schedule", nameColumn: "name" },
  { table: "ssh_server", nameColumn: "name" },
  { table: "mcp_server", nameColumn: "name" },
  { table: "skill", nameColumn: "name" },
  { table: "data_source", nameColumn: "name" },
  { table: "builtin_agent", nameColumn: "name" },
  { table: "credential", nameColumn: "name" },
];

async function sweepTestResources(client: pg.Client): Promise<number> {
  let total = 0;
  for (const { table, nameColumn } of SWEPT_TABLES) {
    const result = await client.query(
      `DELETE FROM ${table} WHERE ${nameColumn} LIKE $1`,
      [`%${E2E_NAME_MARKER}%`],
    );
    if (result.rowCount && result.rowCount > 0) {
      console.log(`  Swept ${result.rowCount} row(s) from ${table}.`);
      total += result.rowCount;
    }
  }
  return total;
}

export default async function globalTeardown() {
  console.log("E2E teardown: cleaning up test users...");
  const client = new Client({ connectionString: getPostgresUrl() });
  try {
    await client.connect();

    // 1. Sweep test-created resources (marked by uniqueName()).
    const swept = await sweepTestResources(client);
    if (swept === 0) {
      console.log("  No marked test resources to clean up.");
    }

    // 2. Delete test users (sessions first — FK constraint — then accounts,
    //    then users).
    const { rows } = await client.query(
      `SELECT id FROM "user" WHERE email LIKE $1`,
      [`%${TEST_EMAIL_SUFFIX}`],
    );
    if (rows.length === 0) {
      console.log("  No test users to clean up.");
      return;
    }
    const ids = rows.map((r: { id: string }) => r.id);
    await client.query(
      `DELETE FROM "session" WHERE user_id = ANY($1)`,
      [ids],
    );
    await client.query(
      `DELETE FROM "account" WHERE user_id = ANY($1)`,
      [ids],
    );
    await client.query(
      `DELETE FROM "user" WHERE id = ANY($1)`,
      [ids],
    );
    console.log(`  Cleaned up ${ids.length} test user(s).`);
  } catch (err) {
    console.error("  Teardown error:", err);
  } finally {
    await client.end();
  }
}
