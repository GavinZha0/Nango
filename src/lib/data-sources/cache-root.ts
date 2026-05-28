/**
 * Shared cache-root resolution.
 *
 * The cache root holds:
 *   - `parquet/<name>/...`      Materialised dataset snapshots (one per
 *                               `extract_dataset_by_sql` call)
 *   - `parquet/<name>.json`     Sidecar metadata (rowCount, query hash,
 *                               capturedAt)
 *   - `.write-slots/<uuid>/`    Per-call write staging dir (atomic
 *                               rename → `parquet/<name>/` on commit)
 *
 * The sandbox layer surfaces `parquet/<name>/` to in-sandbox code at
 * `./data/<name>/` (subprocess: symlink; docker: bind mount → `/work/
 * data/<name>`). See `docs/sandbox.md` §3.
 */

import * as path from "node:path";

import { getConfig } from "@/lib/config";

/**
 * Resolve the cache root from config; empty config value falls back to
 * the project-root default `<repoRoot>/.cache/datasource/`.
 *
 * Why `process.cwd()` based:
 *   - In `pnpm dev` / `pnpm test` / `pnpm start` the Node process is
 *     launched from the repo root, so `process.cwd()` resolves to the
 *     same directory regardless of the running command.
 *   - In Docker production the Dockerfile sets `WORKDIR /app`, so the
 *     cache lives at `/app/.cache/datasource/` — same self-contained
 *     layout, scoped to the container.
 *   - Putting the cache under the repo root (not `os.tmpdir()`) makes
 *     it trivially inspectable from VSCode / Finder, and `rm -rf
 *     .cache/datasource/parquet/` is a one-liner reset.
 *
 * Existing deployments can still override with the `datasource.
 * cache_root` config key from the admin UI; the override takes
 * precedence when non-empty.
 */
export function resolveCacheRoot(): string {
  const fromConfig = getConfig("datasource.cache_root", "");
  if (fromConfig.length > 0) return path.resolve(fromConfig);
  return path.join(process.cwd(), ".cache", "datasource");
}
