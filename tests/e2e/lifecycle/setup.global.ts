/**
 * Global setup: clean up prior test users from the database before E2E tests start.
 * Ensures the admin test user becomes the first registered user and gets the admin role.
 */
import { config } from "dotenv";
import pg from "pg";

import { getPostgresUrl } from "@/lib/db/postgres-url";
import { TEST_EMAIL_SUFFIX } from "../constants/test-users";
import { sweepTestResources } from "./sweep";

config();

const { Client } = pg;

export default async function globalSetup() {
  console.log("E2E setup: pre-cleaning test resources and users...");
  const client = new Client({ connectionString: getPostgresUrl() });
  try {
    await client.connect();

    // 1. Sweep stale test resources from prior crashed runs
    await sweepTestResources(client);

    // 2. Delete test users (sessions first, then accounts, then users)
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
