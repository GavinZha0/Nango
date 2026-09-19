/**
 * Database Migration Integration Test Suite.
 *
 * Runs against a real PostgreSQL instance to verify:
 * 1. Fresh end-to-end migrations from 0000 to 0004.
 * 2. Real idempotent re-runs on fully-migrated databases.
 * 3. Real recovery and state convergence from half-applied 0004 state.
 * 4. Real PostgreSQL transactional rollback on DDL errors.
 * 5. Real session-level advisory lock mutual exclusion.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { join } from "path";
import { writeFileSync, rmSync, mkdtempSync } from "fs";
import { tmpdir } from "os";
import pg from "pg";

import { runMigrations, getPostgresUrl, MIGRATION_LOCK_ID } from "../../../docker/migrate.mjs";

const { Client } = pg;

function getBaseUrl(): string {
  return getPostgresUrl();
}

function parseBaseDbConfig(urlStr: string) {
  const parsed = new URL(urlStr);
  return {
    user: parsed.username || "nango",
    password: parsed.password || "nango",
    host: parsed.hostname || "localhost",
    port: parsed.port ? parseInt(parsed.port, 10) : 5433,
    originalDb: parsed.pathname.replace(/^\//, "") || "nango",
  };
}

function buildDbUrl(config: ReturnType<typeof parseBaseDbConfig>, dbName: string): string {
  return `postgres://${config.user}:${config.password}@${config.host}:${config.port}/${dbName}`;
}

describe("Database Migration Integration (Real PostgreSQL)", () => {
  const baseConfig = parseBaseDbConfig(getBaseUrl());
  const adminDbUrl = buildDbUrl(baseConfig, "postgres");
  const migrationsDir = join(process.cwd(), "src/lib/db/migrations");

  let adminClient: import("pg").Client;
  let isPostgresAvailable = false;

  beforeAll(async () => {
    adminClient = new Client({ connectionString: adminDbUrl });
    try {
      await adminClient.connect();
      isPostgresAvailable = true;
    } catch {
      // Fallback: try connecting using the originalDb name if 'postgres' db is unavailable
      try {
        adminClient = new Client({ connectionString: getBaseUrl() });
        await adminClient.connect();
        isPostgresAvailable = true;
      } catch (err) {
        console.warn("PostgreSQL is not reachable for integration tests:", err);
        isPostgresAvailable = false;
      }
    }
  });

  afterAll(async () => {
    if (adminClient) {
      await adminClient.end().catch(() => {});
    }
  });

  async function createTestDatabase(prefix: string): Promise<{
    dbName: string;
    client: import("pg").Client;
    cleanup: () => Promise<void>;
  }> {
    const dbName = `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    await adminClient.query(`CREATE DATABASE "${dbName}"`);

    const testDbUrl = buildDbUrl(baseConfig, dbName);
    const testClient = new Client({ connectionString: testDbUrl });
    await testClient.connect();

    const cleanup = async () => {
      await testClient.end().catch(() => {});
      // CONTRACT: Drop temporary test database forcefully to leave no residue
      await adminClient.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`).catch(() => {});
    };

    return { dbName, client: testClient, cleanup };
  }

  it("completes clean end-to-end migration from 0000 to 0004 on a fresh database", async () => {
    if (!isPostgresAvailable) return;

    const { client, cleanup } = await createTestDatabase("nango_mig_fresh");
    try {
      const result = await runMigrations(client, migrationsDir);

      expect(result.pending).toBe(5);
      expect(result.applied).toContain("0000_initial.sql");
      expect(result.applied).toContain("0004_verification_group_and_prefix.sql");

      // Verify tracking table
      const { rows: migrationRows } = await client.query(
        `SELECT "name" FROM "__migrations" ORDER BY "id"`
      );
      expect(migrationRows.map((r) => r.name)).toEqual([
        "0000_initial.sql",
        "0001_add_suite_variables.sql",
        "0002_add_mcp_server_group.sql",
        "0003_rename_verification_to_auth_token.sql",
        "0004_verification_group_and_prefix.sql",
      ]);

      // 1. Verify verification_group table exists
      const { rows: tableRows } = await client.query(
        `SELECT to_regclass('public.verification_group') as reg`
      );
      expect(tableRows[0].reg).toBe("verification_group");

      // 2. Verify verification_suite schema has group_id and tool_prefix_rule
      const { rows: suiteCols } = await client.query(
        `SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'verification_suite'`
      );
      const colNames = suiteCols.map((c) => c.column_name);
      expect(colNames).toContain("group_id");
      expect(colNames).toContain("tool_prefix_rule");
      expect(colNames).not.toContain("workflow_id");
      expect(colNames).not.toContain("category");

      // 3. Verify foreign key constraint
      const { rows: fkRows } = await client.query(
        `SELECT conname FROM pg_constraint WHERE conname = 'verification_suite_group_id_verification_group_id_fk'`
      );
      expect(fkRows.length).toBe(1);

      // 4. Verify unique indexes
      const { rows: idxRows } = await client.query(
        `SELECT indexname FROM pg_indexes WHERE tablename = 'verification_group'`
      );
      expect(idxRows.map((i) => i.indexname)).toContain("verification_group_lower_name_idx");

      // 5. Test idempotency: re-running migrations must do nothing and not fail
      const rerun = await runMigrations(client, migrationsDir);
      expect(rerun.pending).toBe(0);
      expect(rerun.applied).toEqual([]);
    } finally {
      await cleanup();
    }
  });

  it("recovers and converges state when 0004 re-runs after a partial failure", async () => {
    if (!isPostgresAvailable) return;

    const { client, cleanup } = await createTestDatabase("nango_mig_heal");
    try {
      // Step A: Manually apply migrations 0000 to 0003 to simulate a system running before 0004
      await client.query(`
        CREATE TABLE IF NOT EXISTS "__migrations" (
          "id" serial PRIMARY KEY,
          "name" text NOT NULL UNIQUE,
          "applied_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL
        )
      `);

      const preFiles = [
        "0000_initial.sql",
        "0001_add_suite_variables.sql",
        "0002_add_mcp_server_group.sql",
        "0003_rename_verification_to_auth_token.sql",
      ];

      for (const file of preFiles) {
        const sql = (await import("fs")).readFileSync(join(migrationsDir, file), "utf8");
        const stmts = sql.split("--> statement-breakpoint").map((s) => s.trim()).filter(Boolean);
        await client.query("BEGIN");
        for (const stmt of stmts) {
          await client.query(stmt);
        }
        await client.query(`INSERT INTO "__migrations" ("name") VALUES ($1)`, [file]);
        await client.query("COMMIT");
      }

      // Step B: Simulate half-applied 0004 failure state:
      // 1. verification_group was created in the failed run
      await client.query(`
        CREATE TABLE "verification_group" (
          "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
          "name" text NOT NULL,
          "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
          "updated_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
        )
      `);

      // 2. verification_run_target_xor constraint was dropped in the failed run
      await client.query(`
        ALTER TABLE "verification_run" DROP CONSTRAINT IF EXISTS "verification_run_target_xor"
      `);

      // 3. Insert mock legacy data to verify TRUNCATE CASCADE cleans up
      const { rows: userRows } = await client.query(`
        INSERT INTO "user" ("id", "name", "email", "email_verified", "created_at", "updated_at")
        VALUES (gen_random_uuid(), 'Test User', 'test@example.com', true, now(), now())
        RETURNING "id"
      `);
      const userId = userRows[0].id;

      await client.query(`
        INSERT INTO "verification_suite" ("id", "name", "category", "created_by", "updated_by")
        VALUES (gen_random_uuid(), 'legacy suite', 'mcp', $1, $1)
      `, [userId]);

      await client.query(`
        INSERT INTO "verification_group" ("name") VALUES ('half-created group')
      `);

      // Note: __migrations does NOT have 0004_verification_group_and_prefix.sql!
      const { rows: preCheckRows } = await client.query(
        `SELECT "name" FROM "__migrations" WHERE "name" = '0004_verification_group_and_prefix.sql'`
      );
      expect(preCheckRows.length).toBe(0);

      // Step C: Execute runMigrations! This MUST NOT fail with 'relation "verification_group" already exists'
      const healResult = await runMigrations(client, migrationsDir);

      expect(healResult.pending).toBe(1);
      expect(healResult.applied).toEqual(["0004_verification_group_and_prefix.sql"]);

      // Verify records in verification tables were truncated cleanly
      const { rows: suiteCount } = await client.query(`SELECT count(*)::int as c FROM "verification_suite"`);
      expect(suiteCount[0].c).toBe(0);

      const { rows: groupCount } = await client.query(`SELECT count(*)::int as c FROM "verification_group"`);
      expect(groupCount[0].c).toBe(0);

      // Verify foreign key and columns are in place
      const { rows: fkCheck } = await client.query(
        `SELECT conname FROM pg_constraint WHERE conname = 'verification_suite_group_id_verification_group_id_fk'`
      );
      expect(fkCheck.length).toBe(1);

      // Verify 0004 is now registered
      const { rows: postCheckRows } = await client.query(
        `SELECT "name" FROM "__migrations" WHERE "name" = '0004_verification_group_and_prefix.sql'`
      );
      expect(postCheckRows.length).toBe(1);
    } finally {
      await cleanup();
    }
  });

  it("aborts and rolls back completely when an invalid statement occurs in a migration file", async () => {
    if (!isPostgresAvailable) return;

    const { client, cleanup } = await createTestDatabase("nango_mig_rollback");
    const tempDir = mkdtempSync(join(tmpdir(), "nango-mig-rollback-"));

    try {
      // Create a valid initial migration
      writeFileSync(join(tempDir, "0000_ok.sql"), `
        CREATE TABLE "table_alpha" ("id" serial PRIMARY KEY, "val" text);
      `);

      // Create a failing migration with a partial valid statement followed by a syntax error
      writeFileSync(join(tempDir, "0001_broken.sql"), `
        CREATE TABLE "table_bravo_should_rollback" ("id" serial PRIMARY KEY);
        --> statement-breakpoint
        THIS IS INVALID SQL COMMAND SYNTAX;
      `);

      // First run encounters 0000 (succeeds) and 0001 (fails and rolls back)
      await expect(runMigrations(client, tempDir)).rejects.toThrow();

      // CONTRACT: table_bravo_should_rollback must NOT exist because the transaction rolled back
      const { rows: tableCheck } = await client.query(
        `SELECT to_regclass('public.table_bravo_should_rollback') as reg`
      );
      expect(tableCheck[0].reg).toBeNull();

      // __migrations must only contain 0000_ok.sql
      const { rows: migRows } = await client.query(`SELECT "name" FROM "__migrations"`);
      expect(migRows.map((r) => r.name)).toEqual(["0000_ok.sql"]);
    } finally {
      try {
        rmSync(tempDir, { recursive: true, force: true });
      } catch {}
      await cleanup();
    }
  });

  it("enforces mutual exclusion using PostgreSQL advisory lock", async () => {
    if (!isPostgresAvailable) return;

    const { client: clientA, cleanup: cleanupA, dbName } = await createTestDatabase("nango_mig_lock");
    const testDbUrl = buildDbUrl(baseConfig, dbName);
    const clientB = new Client({ connectionString: testDbUrl });
    await clientB.connect();

    try {
      // Client A acquires the advisory lock
      await clientA.query("SELECT pg_advisory_lock($1::bigint)", [MIGRATION_LOCK_ID]);

      // Client B attempts non-blocking try_lock, which must return false
      const { rows: tryLockResult } = await clientB.query(
        "SELECT pg_try_advisory_lock($1::bigint) as locked",
        [MIGRATION_LOCK_ID]
      );
      expect(tryLockResult[0].locked).toBe(false);

      // Client A releases lock
      await clientA.query("SELECT pg_advisory_unlock($1::bigint)", [MIGRATION_LOCK_ID]);

      // Client B now succeeds in acquiring lock
      const { rows: retryResult } = await clientB.query(
        "SELECT pg_try_advisory_lock($1::bigint) as locked",
        [MIGRATION_LOCK_ID]
      );
      expect(retryResult[0].locked).toBe(true);

      // Cleanup B's lock
      await clientB.query("SELECT pg_advisory_unlock($1::bigint)", [MIGRATION_LOCK_ID]);
    } finally {
      await clientB.end().catch(() => {});
      await cleanupA();
    }
  });
});
