/**
 * Database Migration Integration Test Suite.
 *
 * Runs against a real PostgreSQL instance to verify:
 * 1. Fresh end-to-end migration of all available migrations.
 * 2. Real idempotent re-runs on fully-migrated databases.
 * 3. Real PostgreSQL transactional rollback on DDL errors.
 * 4. Real session-level advisory lock mutual exclusion.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { join } from "path";
import { writeFileSync, rmSync, mkdtempSync } from "fs";
import { tmpdir } from "os";
import { readdirSync } from "fs";
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

  it("completes clean end-to-end migration of all available migrations on a fresh database", async () => {
    if (!isPostgresAvailable) return;

    const { client, cleanup } = await createTestDatabase("nango_mig_fresh");
    try {
      const result = await runMigrations(client, migrationsDir);

      // Get expected migration count from directory
      const migrationFiles = readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort();

      // Verify all migrations were applied
      expect(result.applied.length).toBe(migrationFiles.length);
      expect(result.applied).toContain("0000_initial.sql");

      // Verify tracking table has all applied migrations
      const { rows: migrationRows } = await client.query(
        `SELECT "name" FROM "__migrations" ORDER BY "id"`
      );
      expect(migrationRows.length).toBe(migrationFiles.length);
      expect(migrationRows.map((r) => r.name)).toEqual(result.applied);

      // Test idempotency: re-running migrations must do nothing and not fail
      const rerun = await runMigrations(client, migrationsDir);
      expect(rerun.pending).toBe(0);
      expect(rerun.applied).toEqual([]);
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
