#!/usr/bin/env node
/**
 * Build-time resource fetcher for Nango Desktop.
 *
 * Downloads and prepares platform-specific bundled binaries under `desktop/resources/`:
 * 1. Official Node.js 24 LTS runtime (`node/`)
 * 2. Portable PostgreSQL 18 binaries (`pg/`, stripped of pgAdmin/docs/headers/symbols)
 * 3. DuckDB 2.0 offline extensions (`duckdb-extensions/{postgres_scanner,mysql_scanner,quack}.duckdb_extension`)
 *
 * See docs/desktop-architecture.md.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

export const DEFAULT_NODE_VERSION =
  process.env.NANGO_BUNDLE_NODE_VERSION || "v24.22.2";
export const DEFAULT_PG_VERSION =
  process.env.NANGO_BUNDLE_PG_VERSION || "18.4-1";
export const DEFAULT_DUCKDB_VERSION =
  process.env.NANGO_BUNDLE_DUCKDB_VERSION || "v2.0.0";

export const DUCKDB_BUNDLED_EXTENSIONS = [
  "postgres_scanner",
  "mysql_scanner",
  "quack",
];

export const PG_REQUIRED_BINARIES = [
  "postgres",
  "initdb",
  "pg_ctl",
  "pg_isready",
  "createdb",
];

/**
 * Directories inside EnterpriseDB PostgreSQL archives that are not needed at
 * runtime and should be stripped before packaging to keep the installer compact.
 */
export const PG_STRIP_TOP_DIRS = [
  "pgAdmin 4",
  "doc",
  "include",
  "symbols",
  "stackbuilder",
];

/**
 * Resolve the target `(platform, arch)` pair and corresponding download URLs
 * for Node.js 24 LTS, Portable PostgreSQL 18, and DuckDB 2.0 extensions.
 */
export function resolveBinaryManifest({
  platform = process.platform,
  arch = process.arch,
  nodeVersion = DEFAULT_NODE_VERSION,
  pgVersion = DEFAULT_PG_VERSION,
  duckdbVersion = DEFAULT_DUCKDB_VERSION,
} = {}) {
  const normalizedNodeVersion = nodeVersion.startsWith("v")
    ? nodeVersion
    : `v${nodeVersion}`;
  const targetKey = `${platform}-${arch}`;

  let nodeArchiveName;
  let pgArchiveUrl;
  let duckdbPlatformSlug;

  if (targetKey === "win32-x64") {
    nodeArchiveName = `node-${normalizedNodeVersion}-win-x64.zip`;
    pgArchiveUrl = `https://get.enterprisedb.com/postgresql/postgresql-${pgVersion}-windows-x64-binaries.zip`;
    duckdbPlatformSlug = "windows_amd64";
  } else if (targetKey === "darwin-arm64") {
    nodeArchiveName = `node-${normalizedNodeVersion}-darwin-arm64.tar.gz`;
    pgArchiveUrl = `https://get.enterprisedb.com/postgresql/postgresql-${pgVersion}-osx-binaries.zip`;
    duckdbPlatformSlug = "osx_arm64";
  } else if (targetKey === "darwin-x64") {
    nodeArchiveName = `node-${normalizedNodeVersion}-darwin-x64.tar.gz`;
    pgArchiveUrl = `https://get.enterprisedb.com/postgresql/postgresql-${pgVersion}-osx-binaries.zip`;
    duckdbPlatformSlug = "osx_amd64";
  } else {
    throw new Error(
      `Unsupported desktop packaging target "${targetKey}". Supported targets: win32-x64, darwin-arm64, darwin-x64.`,
    );
  }

  const nodeArchiveUrl = `https://nodejs.org/dist/${normalizedNodeVersion}/${nodeArchiveName}`;
  const duckdbExtensions = DUCKDB_BUNDLED_EXTENSIONS.map((extName) => ({
    name: extName,
    fileName: `${extName}.duckdb_extension`,
    url: `https://extensions.duckdb.org/${duckdbVersion}/${duckdbPlatformSlug}/${extName}.duckdb_extension.gz`,
  }));

  return {
    targetKey,
    platform,
    arch,
    nodeVersion: normalizedNodeVersion,
    pgVersion,
    duckdbVersion,
    duckdbPlatformSlug,
    nodeArchiveName,
    nodeArchiveUrl,
    pgArchiveUrl,
    duckdbExtensions,
  };
}

/**
 * Prune non-runtime directories (`pgAdmin 4`, `doc`, `include`, `symbols`, `stackbuilder`)
 * from an extracted PostgreSQL directory tree.
 */
export function pruneExtractedPostgresDir(pgRootDir) {
  for (const dirName of PG_STRIP_TOP_DIRS) {
    const candidate = path.join(pgRootDir, dirName);
    if (fs.existsSync(candidate)) {
      fs.rmSync(candidate, { recursive: true, force: true });
    }
  }
}

async function downloadFileBuffer(url) {
  console.log(`[fetch-binaries] Downloading ${url} ...`);
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) {
    throw new Error(
      `Failed to download ${url}: HTTP ${res.status} ${res.statusText}`,
    );
  }
  const arrayBuf = await res.arrayBuffer();
  return Buffer.from(arrayBuf);
}

function extractArchive(archivePath, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  if (archivePath.endsWith(".tar.gz") || archivePath.endsWith(".tgz")) {
    execFileSync("tar", ["-xzf", archivePath, "-C", destDir], {
      stdio: "inherit",
    });
    return;
  }
  if (process.platform === "win32") {
    execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `Expand-Archive -LiteralPath '${archivePath.replaceAll("'", "''")}' -DestinationPath '${destDir.replaceAll("'", "''")}' -Force`,
      ],
      { stdio: "inherit" },
    );
  } else {
    execFileSync("unzip", ["-q", "-o", archivePath, "-d", destDir], {
      stdio: "inherit",
    });
  }
}

/**
 * Download and unpack DuckDB `.duckdb_extension.gz` files into `destDir`.
 */
export async function fetchDuckdbExtensions(manifest, destDir) {
  const versionedDir = path.join(
    destDir,
    manifest.duckdbVersion,
    manifest.duckdbPlatformSlug,
  );
  fs.mkdirSync(versionedDir, { recursive: true });

  for (const ext of manifest.duckdbExtensions) {
    const outPath = path.join(versionedDir, ext.fileName);
    if (fs.existsSync(outPath) && fs.statSync(outPath).size > 0) {
      console.log(`[fetch-binaries] DuckDB extension cached: ${outPath}`);
      continue;
    }
    const gzBuffer = await downloadFileBuffer(ext.url);
    const uncompressed = zlib.gunzipSync(gzBuffer);
    fs.writeFileSync(outPath, uncompressed);
    console.log(
      `[fetch-binaries] Installed DuckDB extension: ${ext.fileName} (${Math.round(uncompressed.length / 1024)} KB)`,
    );
  }
}

/**
 * Main CLI orchestration to download Node 24, Portable PG 18, and DuckDB extensions.
 */
export async function fetchAllDesktopBinaries(opts = {}) {
  const manifest = resolveBinaryManifest(opts);
  const resourcesRoot =
    opts.resourcesDir ?? path.join(process.cwd(), "desktop", "resources");
  const cacheDir = path.join(resourcesRoot, ".download-cache");
  fs.mkdirSync(cacheDir, { recursive: true });

  // 1. DuckDB offline extensions
  await fetchDuckdbExtensions(
    manifest,
    path.join(resourcesRoot, "duckdb-extensions"),
  );

  // 2. Node.js 24 LTS
  const nodeDestDir = path.join(resourcesRoot, "node");
  const expectedNodeBin =
    manifest.platform === "win32"
      ? path.join(nodeDestDir, "node.exe")
      : path.join(nodeDestDir, "bin", "node");

  if (!fs.existsSync(expectedNodeBin)) {
    const archivePath = path.join(cacheDir, manifest.nodeArchiveName);
    if (!fs.existsSync(archivePath)) {
      const buf = await downloadFileBuffer(manifest.nodeArchiveUrl);
      fs.writeFileSync(archivePath, buf);
    }
    const tmpExtract = path.join(cacheDir, "node-extract");
    fs.rmSync(tmpExtract, { recursive: true, force: true });
    extractArchive(archivePath, tmpExtract);

    const innerFolder = fs
      .readdirSync(tmpExtract)
      .find((entry) => entry.startsWith("node-"));
    if (!innerFolder) {
      throw new Error("Unexpected Node.js archive layout: missing node-* root folder.");
    }
    fs.rmSync(nodeDestDir, { recursive: true, force: true });
    fs.renameSync(path.join(tmpExtract, innerFolder), nodeDestDir);
    console.log(`[fetch-binaries] Installed bundled Node.js at ${nodeDestDir}`);
  }

  // 3. Portable PostgreSQL 18
  const pgDestDir = path.join(resourcesRoot, "pg");
  const expectedPgBin =
    manifest.platform === "win32"
      ? path.join(pgDestDir, "bin", "postgres.exe")
      : path.join(pgDestDir, "bin", "postgres");

  if (!fs.existsSync(expectedPgBin)) {
    const pgArchivePath = path.join(
      cacheDir,
      `postgresql-${manifest.pgVersion}-${manifest.targetKey}.zip`,
    );
    if (!fs.existsSync(pgArchivePath)) {
      const buf = await downloadFileBuffer(manifest.pgArchiveUrl);
      fs.writeFileSync(pgArchivePath, buf);
    }
    const tmpPgExtract = path.join(cacheDir, "pg-extract");
    fs.rmSync(tmpPgExtract, { recursive: true, force: true });
    extractArchive(pgArchivePath, tmpPgExtract);

    const innerPgDir = path.join(tmpPgExtract, "pgsql");
    const sourcePgRoot = fs.existsSync(innerPgDir) ? innerPgDir : tmpPgExtract;
    pruneExtractedPostgresDir(sourcePgRoot);

    fs.rmSync(pgDestDir, { recursive: true, force: true });
    fs.renameSync(sourcePgRoot, pgDestDir);
    console.log(`[fetch-binaries] Installed portable PostgreSQL 18 at ${pgDestDir}`);
  }
}

if (
  import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}` ||
  process.argv[1]?.endsWith("fetch-binaries.mjs")
) {
  const args = process.argv.slice(2);
  const platformArg = args
    .find((a) => a.startsWith("--platform="))
    ?.split("=")[1];
  const archArg = args.find((a) => a.startsWith("--arch="))?.split("=")[1];

  fetchAllDesktopBinaries({
    platform: platformArg || process.platform,
    arch: archArg || process.arch,
  }).catch((err) => {
    console.error("[fetch-binaries] Fatal error:", err);
    process.exit(1);
  });
}
