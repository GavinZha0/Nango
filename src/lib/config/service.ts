/**
 * Config service — process-wide configuration backed by the DB.
 *
 * Resolution: code default (fallback) → DB value (authoritative).
 * Loaded at boot; cached in-process. Admin writes invalidate the cache.
 *
 * @see docs/config.md (to be created)
 */

import { db } from "@/lib/db";
import { ConfigTable } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { CONFIG_DEFAULTS, CONFIG_DEFAULTS_MAP } from "./defaults";

/**
 * In-memory config cache: key → value string.
 *
 * Pinned to `globalThis` so the SAME Map + `loaded` flag are
 * visible from every module realm in the Node process. Next.js
 * dev + Turbopack instantiate `service.ts` multiple times (once
 * for the instrumentation hook's module graph, once per API
 * route bundle, …); module-scope `let` state is per-realm and
 * therefore not shared, which manifests as "config probe at
 * boot shows the right value, then a request later reads empty"
 * — see `instrumentation.ts` boot trace.
 *
 * In production (`next start`) the realm split is less aggressive,
 * but the globalThis pin is harmless: the process is single-tenant,
 * one boot, one cache. Same pattern is used by Drizzle's
 * "dev-safe singleton" recipe and the standard Prisma client
 * pattern.
 */
interface ConfigCacheState {
  cache: Map<string, string>;
  loaded: boolean;
}
const G = globalThis as { __nango_config_state?: ConfigCacheState };
G.__nango_config_state ??= { cache: new Map(), loaded: false };
const state: ConfigCacheState = G.__nango_config_state;

/** Load all config rows from DB into memory. Called once at boot. */
export async function loadAllConfigs(): Promise<void> {
  try {
    const rows = await db
      .select({ key: ConfigTable.key, value: ConfigTable.value })
      .from(ConfigTable);

    // Mutate the SAME map instance pinned to globalThis so every
    // module realm sees the update — don't reassign `state.cache`
    // to a fresh Map (other realms would keep their stale reference).
    state.cache.clear();
    for (const row of rows) {
      state.cache.set(row.key, row.value);
    }
    state.loaded = true;
    console.log(`[config] loaded ${rows.length} config(s) from DB`);
  } catch (err) {
    console.warn(
      `[config] failed to load from DB; falling back to code defaults: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Seed default config rows into DB. Only inserts keys that are in
 * CONFIG_DEFAULTS but missing from the DB — admin-modified values
 * are never overwritten. The initial 31 defaults are also in
 * migration 0028; this function handles keys added in future releases.
 */
export async function seedDefaults(): Promise<void> {
  try {
    const existingRows = await db
      .select({ key: ConfigTable.key })
      .from(ConfigTable);
    const existingKeys = new Set(existingRows.map((r) => r.key));
    const missing = CONFIG_DEFAULTS.filter((d) => !existingKeys.has(d.key));

    if (missing.length === 0) return;

    for (const def of missing) {
      await db.insert(ConfigTable).values({
        key: def.key,
        value: def.value,
        valueType: def.valueType,
        description: def.description,
        options: def.options ?? null,
      });
    }
    console.log(`[config] seeded ${missing.length} new default(s)`);
  } catch (err) {
    console.warn(
      `[config] seed failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** Clear in-memory cache. Call after any config write. */
export function invalidateConfigCache(): void {
  state.cache.clear();
  state.loaded = false;
}

// ── Read helpers ──────────────────────────────────────────────────────

/** Resolve a config value: DB cache → code default. */
function resolve(key: string): string | undefined {
  if (state.loaded) {
    const dbVal = state.cache.get(key);
    if (dbVal !== undefined) return dbVal;
  }
  return CONFIG_DEFAULTS_MAP.get(key)?.value;
}

/** Get a string config value. */
export function getConfig(key: string, defaultValue: string): string {
  return resolve(key) ?? defaultValue;
}

/** Get a number config value. */
export function getConfigNumber(key: string, defaultValue: number): number {
  const raw = resolve(key);
  if (raw === undefined) return defaultValue;
  const n = Number(raw);
  return Number.isFinite(n) ? n : defaultValue;
}

/** Get a number config stored in seconds, returned as milliseconds. */
export function getConfigMs(key: string, defaultSeconds: number): number {
  return getConfigNumber(key, defaultSeconds) * 1000;
}

/** Get a boolean config value. */
export function getConfigBoolean(key: string, defaultValue: boolean): boolean {
  const raw = resolve(key);
  if (raw === undefined) return defaultValue;
  return raw === "true" || raw === "1";
}

/** Get a JSON config value with type assertion. */
export function getConfigJson<T>(key: string, defaultValue: T): T {
  const raw = resolve(key);
  if (raw === undefined) return defaultValue;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return defaultValue;
  }
}

// ── Write helpers (used by admin API) ─────────────────────────────────

export interface UpdateConfigInput {
  key: string;
  value: string;
  updatedBy: string;
}

/** Update a config value. Stores previous value for rollback. */
export async function updateConfig(input: UpdateConfigInput): Promise<void> {
  const [existing] = await db
    .select({ value: ConfigTable.value })
    .from(ConfigTable)
    .where(eq(ConfigTable.key, input.key))
    .limit(1);

  if (!existing) {
    throw new Error(`Config key not found: ${input.key}`);
  }

  await db
    .update(ConfigTable)
    .set({
      value: input.value,
      prevValue: existing.value,
      updatedBy: input.updatedBy,
      updatedAt: new Date(),
    })
    .where(eq(ConfigTable.key, input.key));

  // Refresh cache inline — config changes are rare.
  await loadAllConfigs();
}

/** Insert a custom config key (admin-defined). */
export async function createConfig(input: {
  key: string;
  value: string;
  valueType: string;
  description?: string;
  updatedBy: string;
}): Promise<string> {
  const [row] = await db
    .insert(ConfigTable)
    .values({
      key: input.key,
      value: input.value,
      valueType: input.valueType,
      description: input.description,
      updatedBy: input.updatedBy,
    })
    .returning({ id: ConfigTable.id });

  await loadAllConfigs();
  return row.id;
}

/** Delete a config key. Only custom (non-default) keys can be deleted. */
export async function deleteConfig(key: string): Promise<boolean> {
  if (CONFIG_DEFAULTS_MAP.has(key)) {
    throw new Error(`Cannot delete predefined config key: ${key}`);
  }
  const result = await db
    .delete(ConfigTable)
    .where(eq(ConfigTable.key, key))
    .returning({ id: ConfigTable.id });

  await loadAllConfigs();
  return result.length > 0;
}

// ── Test helpers ──────────────────────────────────────────────────────

/** @internal */
export function _isLoaded(): boolean {
  return state.loaded;
}

/** @internal */
export function _cacheSize(): number {
  return state.cache.size;
}

/** @internal Reset for tests. */
export function __resetConfigForTests(): void {
  state.cache.clear();
  state.loaded = false;
}
