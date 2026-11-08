#!/usr/bin/env node
/**
 * Stage a self-contained, flat dependency closure for `electron-updater`
 * inside `desktop/dist/node_modules/`.
 *
 * In pnpm isolated layouts, transitive dependencies (e.g. `fs-extra`, `js-yaml`,
 * `lodash.isequal`, `semver`, `argparse`) reside strictly under `.pnpm/<pkg>@<ver>/`.
 * This script resolves the complete runtime dependency closure starting from
 * `electron-updater` and stages real, dereferenced package folders so the
 * Electron packaged ASAR (`desktop/dist/**`) contains all required modules
 * without relying on external symlink resolution or bundling.
 *
 * See docs/desktop-architecture.md.
 */

import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);

/**
 * Traverse the full transitive `dependencies` tree of `entryPkgName` using Node's
 * CJS resolver semantics and return a Map of `{ packageName: physicalDirectory }`.
 */
export function collectDependencyTree(
  entryPkgName,
  rootDir = process.cwd(),
) {
  const resolvedDirs = new Map();

  function walk(pkgName, searchDir) {
    let pkgJsonPath;
    try {
      pkgJsonPath = require.resolve(`${pkgName}/package.json`, {
        paths: searchDir ? [searchDir] : [rootDir],
      });
    } catch {
      return;
    }

    const pkgDir = path.dirname(pkgJsonPath);
    let pkgJson;
    try {
      pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, "utf8"));
    } catch {
      return;
    }

    const realName = pkgJson.name || pkgName;
    if (resolvedDirs.has(realName)) return;
    resolvedDirs.set(realName, pkgDir);

    const deps = Object.keys(pkgJson.dependencies || {});
    for (const dep of deps) {
      walk(dep, pkgDir);
    }
  }

  walk(entryPkgName);
  return resolvedDirs;
}

/**
 * Stage all resolved dependency directories into `targetNodeModulesDir`.
 */
export function stageUpdaterRuntimeDependencies({
  rootDir = process.cwd(),
  targetNodeModulesDir = path.join(process.cwd(), "desktop", "dist", "node_modules"),
} = {}) {
  const deps = collectDependencyTree("electron-updater", rootDir);
  if (!deps.has("electron-updater")) {
    throw new Error(
      "[stage-updater-runtime] Could not resolve 'electron-updater' dependency tree. Ensure 'pnpm install' has run.",
    );
  }

  fs.mkdirSync(targetNodeModulesDir, { recursive: true });

  for (const [name, srcDir] of deps.entries()) {
    const dstDir = path.join(targetNodeModulesDir, name);
    // Overwrite existing folder cleanly
    fs.rmSync(dstDir, { recursive: true, force: true });
    fs.cpSync(srcDir, dstDir, { recursive: true, dereference: true });
  }

  return {
    packageCount: deps.size,
    stagedPackages: Array.from(deps.keys()).sort(),
  };
}

if (
  import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}` ||
  process.argv[1]?.endsWith("stage-updater-runtime.mjs")
) {
  try {
    const result = stageUpdaterRuntimeDependencies();
    console.log(
      `[stage-updater-runtime] Staged ${result.packageCount} production dependencies into desktop/dist/node_modules:`,
    );
    console.log(result.stagedPackages.join(", "));
  } catch (err) {
    console.error("[stage-updater-runtime] Failed to stage updater runtime dependencies:", err);
    process.exit(1);
  }
}
