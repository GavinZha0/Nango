/**
 * Global teardown: clean up test users from the database after E2E tests.
 */
import { config } from "dotenv";
import pg from "pg";

import { getPostgresUrl } from "@/lib/db/postgres-url";

config();

const { Client } = pg;

const TEST_EMAIL_SUFFIX = "@test-e2e.local";

export default async function globalTeardown() {
  console.log("E2E teardown: cleaning up test users...");
  const client = new Client({ connectionString: getPostgresUrl() });
  try {
    await client.connect();
    // Delete sessions first (FK constraint), then accounts, then users
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
