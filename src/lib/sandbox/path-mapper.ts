/**
 * Host ↔ in-sandbox path mapping for the cwd-relative
 * `./data/<name>/` contract. See docs/sandbox.md.
 */

import * as path from "node:path";

import { resolveCacheRoot } from "@/lib/data-sources/cache-root";

/** Subdirectory under the sandbox cwd where declared datasets are
 *  exposed. Reads as `./data/<name>/` from in-sandbox code. */
export const SANDBOX_DATA_DIR = "data";

/** Container working directory set via `--workdir /work` on
 *  `docker run`. Kept short to minimise collision with user paths. */
export const DOCKER_CONTAINER_WORKDIR = "/work";

function getCacheHostRoot(): string {
  return resolveCacheRoot();
}

/** Mirrors `data-sources/cache.ts → datasetDir` so the sandbox
 *  sees exactly what the data-source layer wrote. */
export function resolveDatasetHostDir(datasetName: string): string {
  return path.join(getCacheHostRoot(), "parquet", datasetName);
}

/** Per-call mapping built by the backend before exec. */
export interface PathMapping {
  /** Per-call work directory on the host (auto-cleaned after run). */
  tmpHostDir: string;
  /** datasetName → absolute host parquet directory. */
  datasetHostDirs: Record<string, string>;
}

/** Build a fresh mapping. `tmpHostDir` comes from the backend's
 *  `mkdtemp`; `datasetNames` comes from `SandboxInput.datasets`. */
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
 * Rewrite host / container absolute paths in stdout / stderr back
 * to the cwd-relative form (`./data/<name>` or `.`). Replacements
 * are applied longest-first so `<cacheRoot>/parquet/<name>/foo`
 * resolves to `./data/<name>/foo`, not the cache-root fallback
 * `./data/parquet/<name>/foo`. Output is always a `./…`-rooted
 * relative path the LLM can round-trip into its next call.
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
