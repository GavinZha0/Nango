/**
 * Host ↔ in-sandbox path mapping.
 *
 * The sandbox layer surfaces declared datasets at a *current-working-
 * directory-relative* path (`./data/<name>/`) inside the sandbox.
 * Both adapters honour the same in-sandbox contract:
 *
 *   - Subprocess: child cwd is a per-call `tmpHostDir`; we create
 *     `tmpHostDir/data/<name>` as a symlink to the shared cache's
 *     `parquet/<name>/` directory.
 *   - Docker:     container cwd is `/work` (`--workdir /work`); each
 *     dataset is bind-mounted read-only at `/work/data/<name>/`.
 *
 * LLM-generated code therefore always reads `./data/<name>/...`,
 * regardless of the active backend. `maskOutput` rewrites any host /
 * container absolute paths that leak into stderr / stdout back to the
 * same cwd-relative form so the LLM never sees backend-specific noise.
 *
 * Pre-data-dir versions used `/mnt/cache/<name>/` as the in-sandbox
 * contract. The historical absolute-path convention has been dropped
 * (D38, W1.8.x sandbox redesign) — Docker's bind mount and the
 * subprocess symlink target both live under the sandbox's cwd, so a
 * `./data/<name>` reference resolves to a real file in every mode.
 */

import * as path from "node:path";

import { resolveCacheRoot } from "@/lib/data-sources/cache-root";

/** Subdirectory under the sandbox cwd where declared datasets are
 *  exposed. Used by both adapters as the target path:
 *
 *    subprocess:  `<tmpHostDir>/data/<name>` (symlink)
 *    docker:      `/work/data/<name>` (bind mount)
 *
 *  LLM-facing tool descriptions instruct code to read
 *  `./data/<name>/**.parquet` — i.e. relative to cwd. */
export const SANDBOX_DATA_DIR = "data";

/** Container working directory used by the docker adapter. Set via
 *  `--workdir /work` on `docker run`; the in-container Python
 *  process's cwd is therefore `/work`, and `./data/<name>` resolves
 *  to `/work/data/<name>`. Kept short to minimise the chance of
 *  collision with user-written paths. */
export const DOCKER_CONTAINER_WORKDIR = "/work";

function getCacheHostRoot(): string {
  return resolveCacheRoot();
}

/**
 * Map a dataset name to its host directory under the shared cache.
 * Mirrors `data-sources/cache.ts → datasetDir` so the sandbox sees
 * exactly what the data-source layer wrote.
 */
export function resolveDatasetHostDir(datasetName: string): string {
  return path.join(getCacheHostRoot(), "parquet", datasetName);
}

/**
 * Per-call mapping table. Built by the backend before exec; captures
 * the dynamic per-call host work-dir and the requested dataset →
 * host parquet pairs.
 */
export interface PathMapping {
  /** Per-call work directory on the host (auto-cleaned after run).
   *
   *  Subprocess: child cwd === `tmpHostDir`.
   *  Docker:     `tmpHostDir` is bind-mounted to `/work` in the
   *              container; the container's cwd is `/work`, not the
   *              host path. */
  tmpHostDir: string;
  /** datasetName → absolute host parquet directory. */
  datasetHostDirs: Record<string, string>;
}

/**
 * Build a fresh mapping for a sandbox run. `tmpHostDir` is supplied
 * by the backend (e.g. `mkdtemp`); `datasetNames` is the user's
 * request from `SandboxInput.datasets`.
 */
export function buildMapping(
  tmpHostDir: string,
  datasetNames: readonly string[] = [],
): PathMapping {
  const datasetHostDirs: Record<string, string> = {};
  for (const name of datasetNames) {
    datasetHostDirs[name] = resolveDatasetHostDir(name);
  }
  return { tmpHostDir, datasetHostDirs };
}

/**
 * Rewrite host / container absolute paths in stdout / stderr back to
 * the in-sandbox cwd-relative form (`./data/<name>` or `.`). Replacements
 * are applied longest-first so a `/path/to/parquet/sales/foo` host
 * path resolves to `./data/sales/foo` rather than the shorter cache-
 * root fallback `./data/parquet/sales/foo`.
 *
 * Concrete examples of paths this masks:
 *
 *   - `<cacheRoot>/parquet/<name>/x.parquet`     (subprocess: symlink
 *                                                  target deref)
 *   - `<tmpHostDir>/data/<name>/x.parquet`       (subprocess: symlink
 *                                                  path itself)
 *   - `/work/data/<name>/x.parquet`              (docker: container
 *                                                  absolute path)
 *   - `<tmpHostDir>/script.py`                   (subprocess: anything
 *                                                  the child writes
 *                                                  under cwd)
 *   - `<cacheRoot>/parquet/<other>/x.parquet`    (undeclared dataset
 *                                                  fallback)
 *
 * Result in every case is a `./...`-rooted relative path the LLM can
 * round-trip into its next call without translation.
 */
export function maskOutput(text: string, mapping: PathMapping): string {
  if (text.length === 0) return text;
  const replacements = collectReplacements(mapping);
  let out = text;
  for (const [from, to] of replacements) {
    out = out.split(from).join(to);
  }
  return out;
}

function collectReplacements(mapping: PathMapping): Array<[string, string]> {
  const r: Array<[string, string]> = [];

  // Per-dataset replacements (longest, most specific first). Three
  // forms per declared dataset because the path that leaks depends on
  // which adapter ran AND whether Python dereferenced symlinks:
  //
  //   1. <cacheRoot>/parquet/<name>     — subprocess symlink target
  //   2. <tmpHostDir>/data/<name>       — subprocess symlink path
  //   3. /work/data/<name>              — docker container path
  for (const [name, hostDir] of Object.entries(mapping.datasetHostDirs)) {
    const dataRelative = `./${SANDBOX_DATA_DIR}/${name}`;
    r.push([hostDir, dataRelative]);
    r.push([path.join(mapping.tmpHostDir, SANDBOX_DATA_DIR, name), dataRelative]);
    r.push([
      `${DOCKER_CONTAINER_WORKDIR}/${SANDBOX_DATA_DIR}/${name}`,
      dataRelative,
    ]);
  }

  // Cache-root fallback for undeclared datasets (e.g. an error
  // message mentions a dataset the caller didn't put in `datasets`).
  // Surfaces as `./data/<otherName>/...` even though we didn't mount
  // it — keeps the masked form consistent with the in-sandbox view.
  r.push([path.join(getCacheHostRoot(), "parquet"), `./${SANDBOX_DATA_DIR}`]);

  // Per-call work-dir / cwd. Subprocess: the host tmp dir IS the
  // child's cwd. Docker: /work is the container's cwd. Replace both
  // with `.` so absolute-path logging (`os.getcwd()`, `os.path.
  // abspath('foo')`, …) round-trips to the cwd-relative form.
  r.push([mapping.tmpHostDir, "."]);
  r.push([DOCKER_CONTAINER_WORKDIR, "."]);

  // Sort longest-first so nested replacements don't cascade. E.g.
  // `<cacheRoot>/parquet/sales/foo` must match the dataset entry
  // before the cache-root fallback rewrites just `<cacheRoot>/parquet`.
  r.sort((a, b) => b[0].length - a[0].length);
  return r;
}
