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
import { TEST_EMAIL_SUFFIX } from "../constants/test-users";
import { sweepTestResources } from "./sweep";

config();

const { Client } = pg;

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
