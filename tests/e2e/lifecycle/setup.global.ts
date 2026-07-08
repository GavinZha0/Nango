/**
 * Global setup: clean up prior test users from the database before E2E tests start.
 * Ensures the admin test user becomes the first registered user and gets the admin role.
 */
import { config } from "dotenv";
import pg from "pg";

import { getPostgresUrl } from "../../../src/lib/db/postgres-url";

config();

const { Client } = pg;

const TEST_EMAIL_SUFFIX = "@test-e2e.local";

export default async function globalSetup() {
  console.log("E2E setup: pre-cleaning test users...");
  const client = new Client({ connectionString: getPostgresUrl() });
  try {
    await client.connect();
    // Delete sessions first (FK constraint), then accounts, then users
    const { rows } = await client.query(
      `SELECT id FROM "user" WHERE email LIKE $1`,
      [`%${TEST_EMAIL_SUFFIX}`],
    );
    if (rows.length === 0) {
      console.log("  No stale test users found in DB.");
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
    console.log(`  Successfully pre-cleaned ${ids.length} stale test user(s).`);
  } catch (err) {
    console.error("  Setup pre-clean error:", err);
  } finally {
    await client.end();
  }
}
