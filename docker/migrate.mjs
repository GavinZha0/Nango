/**
 * Lightweight database migration runner — the single migration applier for
 * BOTH the Docker container (docker/start.sh) and host dev (`pnpm db:migrate`).
 *
 * Maintains a `__migrations` table to track which files have been applied.
 * Only runs new migrations. Each SQL file is split on '--> statement-breakpoint'
 * and executed statement by statement.
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

async function migrate() {
  const url = getPostgresUrl();
  const migrationsDir = join(process.cwd(), "src/lib/db/migrations");
  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  if (files.length === 0) {
    console.log("No migration files found.");
    return;
  }

  const client = await connectWithRetry(url);

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
    await client.end();
    return;
  }

  console.log(`Found ${pending.length} pending migration(s) (${files.length} total).`);

  for (const file of pending) {
    const filePath = join(migrationsDir, file);
    const sql = readFileSync(filePath, "utf8");
    const statements = sql
      .split("--> statement-breakpoint")
      .map((s) => s.trim())
      .filter(Boolean);

    for (const stmt of statements) {
      try {
        await client.query(stmt);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`Migration error in ${file}: ${msg}`);
        await client.end();
        process.exit(1);
      }
    }

    // Record this migration as applied
    await client.query(
      `INSERT INTO "__migrations" ("name") VALUES ($1)`,
      [file]
    );
    console.log(`  Applied: ${file}`);
  }

  await client.end();
  console.log("All migrations applied.");
}

migrate().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
