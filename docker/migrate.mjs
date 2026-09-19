/**
 * Lightweight database migration runner — the single migration applier for
 * BOTH the Docker container (docker/start.sh) and host dev (`pnpm db:migrate`).
 *
 * Maintains a `__migrations` table to track which files have been applied.
 * Only runs new migrations. Each SQL file is split on '--> statement-breakpoint'
 * and executed statement by statement inside an isolated transaction.
 *
 * Uses the `pg` package which is already bundled in the standalone build.
 * Env on host is loaded via `node --env-file-if-exists=.env` (see package.json);
 * in the container env comes from docker-compose. No `dotenv` import here on
 * purpose — `dotenv` is a devDependency and is absent from the standalone
 * runtime closure, so importing it would crash container startup.
 *
 * Usage: node docker/migrate.mjs
 */

import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import pg from "pg";

const { Client } = pg;

// SECURITY: Static 64-bit bigint identifier for session-level PostgreSQL advisory lock.
// Prevents race conditions and corrupted schema states if multiple containers start concurrently.
const MIGRATION_LOCK_ID = "8246019247192841";

function getPostgresUrl() {
  const url = process.env.POSTGRES_URL;
  if (url && url.trim()) return url;
  const user = process.env.POSTGRES_USER || "nango";
  const password = process.env.POSTGRES_PASSWORD || "nango";
  const host = process.env.POSTGRES_HOST || "localhost";
  const port = process.env.POSTGRES_PORT || "5433";
  const db = process.env.POSTGRES_DB || "nango";
  return `postgres://${user}:${password}@${host}:${port}/${db}`;
}

async function connectWithRetry(url, maxRetries = 10, delayMs = 3000) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const client = new Client({ connectionString: url });
      await client.connect();
      return client;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (attempt === maxRetries) {
        throw new Error(`Failed to connect after ${maxRetries} attempts: ${msg}`);
      }
      console.log(`  DB not ready (attempt ${attempt}/${maxRetries}): ${msg}. Retrying in ${delayMs / 1000}s...`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw new Error("Unreachable");
}

/**
 * Executes pending SQL migrations using per-file transactions protected by an advisory lock.
 *
 * @param {import("pg").Client} client
 * @param {string} migrationsDir
 */
async function runMigrations(client, migrationsDir) {
  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  if (files.length === 0) {
    console.log("No migration files found.");
    return { applied: [], pending: 0 };
  }

  let lockAcquired = false;
  try {
    // SECURITY: Acquire session-level advisory lock to serialize migrations across concurrent containers.
    await client.query("SELECT pg_advisory_lock($1::bigint)", [MIGRATION_LOCK_ID]);
    lockAcquired = true;

    // Create migrations tracking table if it doesn't exist
    await client.query(`
      CREATE TABLE IF NOT EXISTS "__migrations" (
        "id" serial PRIMARY KEY,
        "name" text NOT NULL UNIQUE,
        "applied_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL
      )
    `);

    // Get already-applied migrations
    const { rows: applied } = await client.query(
      `SELECT "name" FROM "__migrations" ORDER BY "name"`
    );
    const appliedSet = new Set(applied.map((r) => r.name));

    const pending = files.filter((f) => !appliedSet.has(f));

    if (pending.length === 0) {
      console.log(`All ${files.length} migration(s) already applied.`);
      return { applied: [], pending: 0 };
    }

    console.log(`Found ${pending.length} pending migration(s) (${files.length} total).`);

    const appliedThisRun = [];

    for (const file of pending) {
      const filePath = join(migrationsDir, file);
      const sql = readFileSync(filePath, "utf8");
      const statements = sql
        .split("--> statement-breakpoint")
        .map((s) => s.trim())
        .filter(Boolean);

      // CONTRACT: Run each migration file in a single dedicated transaction.
      // If any statement fails, rollback completely so no half-applied state is left.
      await client.query("BEGIN");
      try {
        for (const stmt of statements) {
          await client.query(stmt);
        }

        // Record this migration as applied within the same transaction
        await client.query(
          `INSERT INTO "__migrations" ("name") VALUES ($1)`,
          [file]
        );

        await client.query("COMMIT");
        appliedThisRun.push(file);
        console.log(`  Applied: ${file}`);
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`Migration error in ${file}: ${msg}`);
        throw err;
      }
    }

    console.log("All migrations applied.");
    return { applied: appliedThisRun, pending: pending.length };
  } finally {
    if (lockAcquired) {
      try {
        await client.query("SELECT pg_advisory_unlock($1::bigint)", [MIGRATION_LOCK_ID]);
      } catch {
        // Ignored: closing connection will automatically release session advisory locks
      }
    }
  }
}

async function migrate() {
  const url = getPostgresUrl();
  const migrationsDir = join(process.cwd(), "src/lib/db/migrations");
  const client = await connectWithRetry(url);

  try {
    await runMigrations(client, migrationsDir);
  } finally {
    await client.end().catch(() => {});
  }
}

import { fileURLToPath } from "url";
import { resolve } from "path";

const isCli =
  Boolean(process.argv[1]) &&
  resolve(process.argv[1]).toLowerCase() ===
    resolve(fileURLToPath(import.meta.url)).toLowerCase();

if (isCli) {
  migrate().catch((err) => {
    console.error("Migration failed:", err);
    process.exit(1);
  });
}

export { runMigrations, getPostgresUrl, connectWithRetry, MIGRATION_LOCK_ID };
