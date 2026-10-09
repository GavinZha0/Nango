import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { join } from "path";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";

// CONTRACT: runMigrations must be imported dynamically or statically from docker/migrate.mjs
// without triggering direct CLI invocation.
import { runMigrations, MIGRATION_LOCK_ID } from "../../../docker/migrate.mjs";

describe("docker/migrate.mjs — Transaction and Lock Harness", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "nango-mig-test-"));
  });

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignored in test cleanup
    }
  });

  it("acquires and releases session-level advisory lock when all migrations are already applied", async () => {
    const executedQueries: Array<{ sql: string; params?: unknown[] }> = [];

    const mockClient = {
      query: vi.fn(async (queryText: string, params?: unknown[]) => {
        executedQueries.push({ sql: queryText.trim(), params });
        if (queryText.includes("SELECT \"name\" FROM \"__migrations\"")) {
          return { rows: [{ name: "0000_initial.sql" }] };
        }
        return { rows: [] };
      }),
    };

    // Create a dummy migration file that is already applied
    writeFileSync(join(tempDir, "0000_initial.sql"), "SELECT 1;");

    const result = await runMigrations(mockClient as unknown as import("pg").Client, tempDir);

    expect(result.pending).toBe(0);
    expect(result.applied).toEqual([]);

    // SECURITY: Advisory lock must be acquired first and unlocked in finally
    expect(executedQueries[0].sql).toContain("SELECT pg_advisory_lock");
    expect(executedQueries[0].params).toEqual([MIGRATION_LOCK_ID]);

    const unlockQuery = executedQueries.find((q) => q.sql.includes("SELECT pg_advisory_unlock"));
    expect(unlockQuery).toBeDefined();
    expect(unlockQuery?.params).toEqual([MIGRATION_LOCK_ID]);
  });

  it("runs pending migrations in per-file transactions and commits on success", async () => {
    const executedQueries: string[] = [];

    const mockClient = {
      query: vi.fn(async (queryText: string) => {
        executedQueries.push(queryText.trim());
        if (queryText.includes("SELECT \"name\" FROM \"__migrations\"")) {
          return { rows: [] };
        }
        return { rows: [] };
      }),
    };

    writeFileSync(
      join(tempDir, "0001_test.sql"),
      "CREATE TABLE test_table (id int);\n--> statement-breakpoint\nALTER TABLE test_table ADD COLUMN val text;"
    );

    const result = await runMigrations(mockClient as unknown as import("pg").Client, tempDir);

    expect(result.pending).toBe(1);
    expect(result.applied).toEqual(["0001_test.sql"]);

    // CONTRACT: BEGIN must precede statements, and COMMIT must follow __migrations insertion
    const beginIdx = executedQueries.indexOf("BEGIN");
    const stmt1Idx = executedQueries.findIndex((q) => q.includes("CREATE TABLE test_table"));
    const stmt2Idx = executedQueries.findIndex((q) => q.includes("ALTER TABLE test_table ADD COLUMN val text"));
    const insertIdx = executedQueries.findIndex((q) => q.includes('INSERT INTO "__migrations"'));
    const commitIdx = executedQueries.indexOf("COMMIT");

    expect(beginIdx).toBeGreaterThan(-1);
    expect(stmt1Idx).toBeGreaterThan(beginIdx);
    expect(stmt2Idx).toBeGreaterThan(stmt1Idx);
    expect(insertIdx).toBeGreaterThan(stmt2Idx);
    expect(commitIdx).toBeGreaterThan(insertIdx);
  });

  it("rolls back transaction and does NOT record migration on statement failure", async () => {
    const executedQueries: string[] = [];

    const mockClient = {
      query: vi.fn(async (queryText: string) => {
        executedQueries.push(queryText.trim());
        if (queryText.includes("SELECT \"name\" FROM \"__migrations\"")) {
          return { rows: [] };
        }
        if (queryText.includes("INVALID_SQL_BREAKPOINT")) {
          throw new Error("syntax error at or near INVALID_SQL_BREAKPOINT");
        }
        return { rows: [] };
      }),
    };

    writeFileSync(
      join(tempDir, "0002_fail.sql"),
      "CREATE TABLE half_created (id int);\n--> statement-breakpoint\nINVALID_SQL_BREAKPOINT;\n--> statement-breakpoint\nCREATE TABLE never_reached (id int);"
    );

    await expect(
      runMigrations(mockClient as unknown as import("pg").Client, tempDir)
    ).rejects.toThrow("syntax error at or near INVALID_SQL_BREAKPOINT");

    // CONTRACT: ROLLBACK must be called and __migrations must never be recorded
    expect(executedQueries).toContain("BEGIN");
    expect(executedQueries).toContain("ROLLBACK");
    expect(executedQueries).not.toContain("COMMIT");

    const migrationInserted = executedQueries.some((q) =>
      q.includes('INSERT INTO "__migrations"') && q.includes("0002_fail.sql")
    );
    expect(migrationInserted).toBe(false);

    // SECURITY: Advisory lock must be released even on failure
    const unlockQuery = executedQueries.find((q) => q.includes("SELECT pg_advisory_unlock"));
    expect(unlockQuery).toBeDefined();
  });
});
