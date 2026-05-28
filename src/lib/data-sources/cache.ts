/**
 * Parquet cache layer for the data-source integration.
 */

import "server-only";

import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

import { resolveCacheRoot } from "./cache-root";

// Path layout

/** Shared with the sandbox layer's bind-mount source. Single source
 *  of truth for the env var + default lives in `cache-root.ts`. */
export function getCacheRoot(): string {
  return resolveCacheRoot();
}

/** Final dataset directory: `<root>/parquet/<name>/`. Sandbox mounts this. */
export function datasetDir(name: string): string {
  return path.join(getCacheRoot(), "parquet", name);
}

/** Sidecar metadata file: `<root>/parquet/<name>.meta.json`. */
function metaPath(name: string): string {
  return path.join(getCacheRoot(), "parquet", `${name}.meta.json`);
}

/** Tmp directory the writer uses before atomic rename. Random uuid
 *  suffix lets two writers race without colliding. */
function tmpDir(name: string): string {
  return path.join(
    getCacheRoot(),
    "parquet",
    `.tmp-${name}-${randomUUID()}`,
  );
}

// Naming and validation

/**
 * Cache-key validation. Same shape rules as Skill names: kebab/snake
 * slug, length capped, no path traversal possible by construction.
 */
const NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,127}$/;

export class InvalidCacheKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidCacheKeyError";
  }
}

export function validateDatasetName(name: string): void {
  if (!NAME_PATTERN.test(name)) {
    throw new InvalidCacheKeyError(
      `Dataset name "${name}" must match /^[a-z0-9][a-z0-9_-]{0,127}$/.`,
    );
  }
}

// Sidecar metadata

export interface DatasetMeta {
  /** Cache key. Must match the parent directory name. */
  name: string;
  /** Adapter id used to materialise this dataset (postgres / mysql / ...). */
  source: string;
  /** uuid of the `data_source` row that produced this dataset.
   *  Stored for diagnostics (admin "which source did this come from?")
   *  and for the cleanup hook that purges cache when a data source
   *  is deleted. Null is reserved for sources that don't bind to a
   *  data_source row (e.g. future ad-hoc CLI imports). */
  dataSourceId: string | null;
  /** sha256 of the canonicalised query text. Mismatched hash on a
   *  same-name refresh request is a hard error: pick a new name or
   *  invalidate first. */
  queryHash: string;
  /** ISO-8601 string. */
  createdAt: string;
  /** Time-to-live in hours from createdAt. */
  ttlHours: number;
  /** Row count + byte size; lets list endpoints answer without re-reading
   *  the Parquet metadata. */
  rowCount: number;
  byteSize: number;
}

async function readMeta(name: string): Promise<DatasetMeta | null> {
  try {
    const text = await fs.readFile(metaPath(name), "utf-8");
    return JSON.parse(text) as DatasetMeta;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

async function writeMeta(name: string, meta: DatasetMeta): Promise<void> {
  await fs.writeFile(metaPath(name), JSON.stringify(meta, null, 2), "utf-8");
}

// TTL check

export interface CacheStatus {
  exists: boolean;
  meta: DatasetMeta | null;
  /** True iff the file exists AND has not exceeded its TTL. */
  isFresh: boolean;
  /** Now - createdAt, milliseconds. -1 when meta is missing. */
  ageMs: number;
}

export async function getCacheStatus(name: string): Promise<CacheStatus> {
  validateDatasetName(name);
  const meta = await readMeta(name);
  if (!meta) {
    return { exists: false, meta: null, isFresh: false, ageMs: -1 };
  }
  const ageMs = Date.now() - new Date(meta.createdAt).getTime();
  const ttlMs = meta.ttlHours * 3_600_000;
  return { exists: true, meta, isFresh: ageMs < ttlMs, ageMs };
}

// Write protocol

export interface AcquiredSlot {
  /** Tmp directory the adapter writes Parquet into. */
  tmpDir: string;
  /** Full path the adapter is told to write to (inside tmpDir). */
  outputPath: string;
}

/**
 * Acquire a tmp slot for writing a fresh extract. Caller is the
 * data-source adapter; it writes a single Parquet file at
 * `slot.outputPath` (currently `<tmpDir>/part-001.parquet`).
 *
 * Atomic-rename on commit means concurrent writers do not see each
 * other's half-written files.
 */
export async function acquireWriteSlot(name: string): Promise<AcquiredSlot> {
  validateDatasetName(name);
  const t = tmpDir(name);
  await fs.mkdir(t, { recursive: true });
  return { tmpDir: t, outputPath: path.join(t, "part-001.parquet") };
}

export interface CommitInput {
  name: string;
  slot: AcquiredSlot;
  source: string;
  dataSourceId: string | null;
  queryHash: string;
  ttlHours: number;
  rowCount: number;
  byteSize: number;
}

/**
 * Atomically promote a tmp slot to the final dataset directory.
 * Replaces any existing directory of the same name (TTL-driven
 * refresh path). Writes the sidecar after the rename so a partial
 * crash leaves either no meta (= cache miss) or a meta pointing at
 * actual files.
 */
export async function commitWriteSlot(input: CommitInput): Promise<DatasetMeta> {
  validateDatasetName(input.name);
  const final = datasetDir(input.name);

  // Remove any prior version. `rm -rf` semantics; ENOENT is ok.
  await fs.rm(final, { recursive: true, force: true });
  // Atomic rename of the directory.
  await fs.rename(input.slot.tmpDir, final);

  const meta: DatasetMeta = {
    name: input.name,
    source: input.source,
    dataSourceId: input.dataSourceId,
    queryHash: input.queryHash,
    createdAt: new Date().toISOString(),
    ttlHours: input.ttlHours,
    rowCount: input.rowCount,
    byteSize: input.byteSize,
  };
  await writeMeta(input.name, meta);
  return meta;
}

/** Best-effort cleanup of a tmp slot on failure. */
export async function abortWriteSlot(slot: AcquiredSlot): Promise<void> {
  await fs.rm(slot.tmpDir, { recursive: true, force: true }).catch(() => {});
}

// Invalidation

/** Drop the dataset and its meta. Idempotent. */
export async function invalidateDataset(name: string): Promise<void> {
  validateDatasetName(name);
  await fs.rm(datasetDir(name), { recursive: true, force: true });
  await fs.rm(metaPath(name), { force: true });
}

/**
 * Drop every cached dataset whose sidecar references the given
 * `data_source.id`. Called by the data source DELETE API path; the
 * data_source row → cache relationship is by file content
 * (sidecar.dataSourceId), not by FK, so cleanup is filesystem-driven.
 *
 * Idempotent + best-effort: missing parquet root or unreadable
 * sidecars are skipped silently. Returns the list of names that
 * were removed for caller-side logging.
 */
export async function purgeDatasetsForDataSource(
  dataSourceId: string,
): Promise<string[]> {
  const removed: string[] = [];
  const root = path.join(getCacheRoot(), "parquet");
  let entries: string[];
  try {
    entries = await fs.readdir(root);
  } catch {
    return removed;
  }
  for (const entry of entries) {
    if (entry.endsWith(".meta.json")) continue;
    try {
      const meta = await readMeta(entry);
      if (meta?.dataSourceId === dataSourceId) {
        await invalidateDataset(entry);
        removed.push(entry);
      }
    } catch {
      // Skip unparseable / orphan entries; the next sweep will try
      // again. We don't fail the delete API on a single bad sidecar.
    }
  }
  return removed;
}

/**
 * Drop EVERY cached dataset + sidecar under `<cacheRoot>/parquet/`.
 *
 * Called once on Node boot from `instrumentation.ts` to make the
 * dataset cache lifetime equal the Node process lifetime. Two
 * operational problems disappear together:
 *
 *   1. Disk accumulation — without TTL-driven GC, cache files grew
 *      monotonically across the life of a long-running process /
 *      cluster of restarts.
 *   2. Cross-restart name collisions — `extract_dataset_by_sql`
 *      treats `same-name + different-queryHash` as a hard
 *      `QUERY_HASH_MISMATCH` error to defend against in-session
 *      ambiguity. The same guard backfired after a restart: the LLM
 *      has no memory of names from the prior process, so it would
 *      cheerfully reuse a slug and the runtime would refuse.
 *
 * Idempotent + best-effort: a missing parquet root is fine (first
 * boot), and a half-deleted directory just gets re-deleted on the
 * next call. Returns the number of top-level entries removed for
 * caller-side logging — does NOT block boot on rm failures.
 *
 * @see docs/data-sources.md §"Cache lifecycle"
 */
export async function purgeAllDatasets(): Promise<number> {
  const root = path.join(getCacheRoot(), "parquet");
  let entries: string[];
  try {
    entries = await fs.readdir(root);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const entry of entries) {
    try {
      await fs.rm(path.join(root, entry), { recursive: true, force: true });
      removed += 1;
    } catch {
      // Best-effort: a single failed rm shouldn't stop the sweep.
      // The next boot tries again.
    }
  }
  return removed;
}

// Query hash (canonicalised)

/**
 * Stable hash for the SQL text that produced a dataset. Used by the
 * cache to detect "same name, different query" mismatches and force
 * the caller to either reuse-as-is or pick a new name.
 *
 * Canonicalisation: collapse runs of whitespace and trim; everything
 * else is byte-identical. Comments / case / quoting are preserved on
 * purpose so a user-meaningful change always changes the hash.
 */
export function hashQuery(query: string): string {
  const canonical = query.replace(/\s+/g, " ").trim();
  return `sha256:${createHash("sha256").update(canonical, "utf-8").digest("hex")}`;
}
