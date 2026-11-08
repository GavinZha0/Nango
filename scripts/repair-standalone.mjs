#!/usr/bin/env node
/**
 * Cross-platform repair for Next.js standalone `.pnpm` symlink closure.
 *
 * `@vercel/nft` traces only files touched at build time and leaves sibling
 * dependency symlinks inside `.next/standalone/node_modules/.pnpm/<pkg>/node_modules/`
 * omitted or dangling. This script performs the same bounded transitive closure
 * repair as `docker/Dockerfile` across Windows, macOS, and Linux.
 *
 * See docs/docker-deployment.md and docs/desktop-architecture.md.
 */

import {
  cpSync,
  existsSync,
  lstatSync,
  readdirSync,
  readlinkSync,
  statSync,
} from "node:fs";
import path from "node:path";

const rootDir = process.cwd();
const storeDir = path.join(rootDir, "node_modules", ".pnpm");
const standaloneNodeModules = path.join(
  rootDir,
  ".next",
  "standalone",
  "node_modules",
);
const standaloneStoreDir = path.join(standaloneNodeModules, ".pnpm");

/**
 * List direct `<pkg>@<ver>` subdirectories in `.pnpm`.
 */
function listPnpmPackageDirs(pnpmDir) {
  return readdirSync(pnpmDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name.includes("@"))
    .map((d) => d.name);
}

/**
 * Recursively find all symbolic links under `dir`.
 */
function* walkSymlinks(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    let lst;
    try {
      lst = lstatSync(fullPath);
    } catch {
      continue;
    }
    if (lst.isSymbolicLink()) {
      yield fullPath;
    } else if (lst.isDirectory()) {
      yield* walkSymlinks(fullPath);
    }
  }
}

/**
 * Extract the `<dep>@<ver>` directory name from a `.pnpm` relative symlink target.
 * Matches both POSIX (`../../<dep>@<ver>/node_modules/...`) and Windows (`..\\..\\<dep>@<ver>\\node_modules\\...`).
 */
export function extractPnpmStoreComponent(linkTarget) {
  const normalized = linkTarget.replace(/\\/g, "/");
  const match = normalized.match(/(?:^|\/)([^/]+@[^/]+)\/node_modules\/.+/);
  return match ? match[1] : null;
}

/**
 * Compute total byte size of real files under `dir` (not following symlinks).
 */
function computeDirectorySizeBytes(dir) {
  let total = 0;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    let lst;
    try {
      lst = lstatSync(fullPath);
    } catch {
      continue;
    }
    if (lst.isSymbolicLink()) {
      continue;
    }
    if (lst.isDirectory()) {
      total += computeDirectorySizeBytes(fullPath);
    } else if (lst.isFile()) {
      total += lst.size;
    }
  }
  return total;
}

/**
 * Classify a `cpSync` error during standalone `.pnpm` closure repair.
 * Only `EEXIST` (benign race when a symlink/file already exists at destination)
 * is ignored; all other errors (`EPERM`, `EACCES`, `ENOSPC`, etc.) are counted
 * and reported so broken closures never pass the build silently.
 */
export function handleCopyError(err, stats, contextLabel = "") {
  const code = err && typeof err === "object" && "code" in err ? err.code : undefined;
  if (code === "EEXIST") {
    return;
  }
  stats.failedCount++;
  if (code === "EPERM" && process.platform === "win32") {
    stats.sawWin32Eperm = true;
  }
  const msg = err instanceof Error ? err.message : String(err);
  console.error(
    `[repair-standalone] ERROR copying ${contextLabel}: ${code ? `(${code}) ` : ""}${msg}`,
  );
}

export function repairStandaloneClosure() {
  if (!existsSync(standaloneStoreDir)) {
    console.error(
      `[repair-standalone] ERROR: ${standaloneStoreDir} does not exist. Run "pnpm build" with output: "standalone" first.`,
    );
    process.exit(1);
  }

  if (!existsSync(storeDir)) {
    console.error(
      `[repair-standalone] ERROR: ${storeDir} does not exist.`,
    );
    process.exit(1);
  }

  const copyStats = {
    failedCount: 0,
    sawWin32Eperm: false,
  };

  let iteration = 0;
  while (true) {
    iteration++;
    const beforeDirs = listPnpmPackageDirs(standaloneStoreDir);
    const beforeCount = beforeDirs.length;

    // 1. Backfill missing files and peer symlinks in every existing `.pnpm/<pkg>@<ver>` dir.
    for (const dirName of beforeDirs) {
      const srcPkgDir = path.join(storeDir, dirName);
      const dstPkgDir = path.join(standaloneStoreDir, dirName);
      if (existsSync(srcPkgDir) && statSync(srcPkgDir).isDirectory()) {
        try {
          cpSync(srcPkgDir, dstPkgDir, {
            recursive: true,
            force: false,
            errorOnExist: false,
            verbatimSymlinks: true,
          });
        } catch (err) {
          handleCopyError(err, copyStats, dirName);
        }
      }
    }

    // 2. Follow every symlink inside `.pnpm` and pull in any referenced `<dep>@<ver>` store entry.
    for (const symlinkPath of walkSymlinks(standaloneStoreDir)) {
      let target;
      try {
        target = readlinkSync(symlinkPath);
      } catch {
        continue;
      }
      const comp = extractPnpmStoreComponent(target);
      if (!comp) continue;

      const dstCompDir = path.join(standaloneStoreDir, comp);
      const srcCompDir = path.join(storeDir, comp);
      if (!existsSync(dstCompDir) && existsSync(srcCompDir)) {
        try {
          cpSync(srcCompDir, dstCompDir, {
            recursive: true,
            force: false,
            errorOnExist: false,
            verbatimSymlinks: true,
          });
        } catch (err) {
          handleCopyError(err, copyStats, comp);
        }
      }
    }

    const afterCount = listPnpmPackageDirs(standaloneStoreDir).length;
    console.log(
      `[repair-standalone] pass ${iteration}: ${beforeCount} -> ${afterCount} .pnpm packages`,
    );
    if (afterCount === beforeCount) {
      break;
    }
  }

  if (copyStats.failedCount > 0) {
    if (copyStats.sawWin32Eperm) {
      console.error(
        "[repair-standalone] HINT: Windows EPERM encountered while copying symlinks. Enable Windows Developer Mode (Settings -> System -> For developers) or run the build in an elevated terminal with SeCreateSymbolicLinkPrivilege.",
      );
    }
    console.error(
      `[repair-standalone] ERROR: ${copyStats.failedCount} copy operation(s) failed during .pnpm closure repair.`,
    );
    process.exit(1);
  }

  const sizeBytes = computeDirectorySizeBytes(standaloneNodeModules);
  const sizeMb = Math.round(sizeBytes / (1024 * 1024));
  console.log(
    `[repair-standalone] standalone runtime node_modules: ${sizeMb} MB`,
  );

  if (sizeMb < 200 || sizeMb > 1000) {
    console.error(
      `[repair-standalone] ERROR: standalone node_modules is ${sizeMb} MB, expected 200-1000 MB (see docs/docker-deployment.md).`,
    );
    process.exit(1);
  }

  stageStandaloneRuntimeAssets(rootDir, path.join(rootDir, ".next", "standalone"));
}

/**
 * Copy `public/`, `.next/static/`, `src/lib/db/migrations/`, and `docker/migrate.mjs`
 * into `.next/standalone/` so the standalone bundle is self-contained for both
 * local validation and Nango Desktop `extraResources` packaging.
 */
export function stageStandaloneRuntimeAssets(projectRoot, standaloneDir) {
  const pairs = [
    {
      src: path.join(projectRoot, "public"),
      dst: path.join(standaloneDir, "public"),
    },
    {
      src: path.join(projectRoot, ".next", "static"),
      dst: path.join(standaloneDir, ".next", "static"),
    },
    {
      src: path.join(projectRoot, "src", "lib", "db", "migrations"),
      dst: path.join(standaloneDir, "src", "lib", "db", "migrations"),
    },
    {
      src: path.join(projectRoot, "docker", "migrate.mjs"),
      dst: path.join(standaloneDir, "docker", "migrate.mjs"),
    },
  ];

  for (const { src, dst } of pairs) {
    if (!existsSync(src)) continue;
    cpSync(src, dst, {
      recursive: true,
      force: true,
    });
  }
}

if (
  import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}`
  || process.argv[1]?.endsWith("repair-standalone.mjs")
) {
  repairStandaloneClosure();
}
