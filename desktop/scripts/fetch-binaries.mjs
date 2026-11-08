#!/usr/bin/env node
/**
 * Build-time resource fetcher for Nango Desktop.
 *
 * Downloads, verifies, and prepares platform-specific bundled binaries under `desktop/resources/`:
 * 1. Official Node.js 24 LTS runtime (`node/`, verified against official `SHASUMS256.txt`)
 * 2. Portable PostgreSQL 18 binaries (`pg/`, stripped of non-runtime directories and verified for target CPU arch)
 * 3. DuckDB 2.0 offline extensions (`duckdb-extensions/{postgres_scanner,mysql_scanner,quack}.duckdb_extension`)
 *
 * See docs/desktop-architecture.md.
 */

import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
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
 * Compute lowercase hex SHA-256 digest of a Buffer.
 */
export function computeSha256Hex(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

/**
 * Parse an official Node.js `SHASUMS256.txt` manifest and return the expected
 * lowercase hex SHA-256 for `targetFileName` (or `null` if not present).
 */
export function parseShasums256(shasumsText, targetFileName) {
  for (const rawLine of shasumsText.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const match = line.match(/^([0-9a-fA-F]{64})\s+\*?(.+)$/);
    if (!match) continue;
    const [, hash, fileName] = match;
    if (fileName.trim() === targetFileName) {
      return hash.toLowerCase();
    }
  }
  return null;
}

/**
 * Verify that `buffer` matches `expectedSha256Hex`. Throws on mismatch.
 */
export function verifySha256(buffer, expectedSha256Hex, label) {
  const actual = computeSha256Hex(buffer);
  const expected = expectedSha256Hex.trim().toLowerCase();
  if (actual !== expected) {
    throw new Error(
      `SHA-256 checksum mismatch for ${label}: expected ${expected}, got ${actual}.`,
    );
  }
}

const CPU_TYPE_X86_64 = 0x01000007;
const CPU_TYPE_ARM64 = 0x0100000c;

function cpuTypeToArch(cpuType) {
  if (cpuType === CPU_TYPE_X86_64) return "x64";
  if (cpuType === CPU_TYPE_ARM64) return "arm64";
  return null;
}

/**
 * Parse the CPU architectures (`"x64"`, `"arm64"`) supported by a macOS Mach-O
 * (64-bit single-arch or Universal/Fat) binary header buffer.
 */
export function inspectMachOArchs(headerBytes) {
  if (!headerBytes || headerBytes.length < 8) return [];
  const magicBE = headerBytes.readUInt32BE(0);

  // 64-bit little-endian Mach-O (0xcffaedfe on disk -> readUInt32LE(0) === 0xfeedfacf)
  if (magicBE === 0xcffaedfe) {
    const cpuType = headerBytes.readUInt32LE(4);
    const arch = cpuTypeToArch(cpuType);
    return arch ? [arch] : [];
  }

  // 64-bit big-endian Mach-O
  if (magicBE === 0xfeedfacf) {
    const cpuType = headerBytes.readUInt32BE(4);
    const arch = cpuTypeToArch(cpuType);
    return arch ? [arch] : [];
  }

  // Universal / Fat binary (FAT_MAGIC = 0xcafebabe):
  // Header is 8 bytes (magic + nfat_arch), followed by nfat_arch * 20-byte fat_arch structs
  // where the first 4 bytes of each fat_arch struct is big-endian cputype.
  if (magicBE === 0xcafebabe) {
    const nfatArch = headerBytes.readUInt32BE(4);
    if (nfatArch < 1 || nfatArch > 20) return [];
    const archs = [];
    for (let i = 0; i < nfatArch; i++) {
      const offset = 8 + i * 20;
      if (offset + 4 > headerBytes.length) break;
      const cpuType = headerBytes.readUInt32BE(offset);
      const arch = cpuTypeToArch(cpuType);
      if (arch && !archs.includes(arch)) {
        archs.push(arch);
      }
    }
    return archs;
  }

  return [];
}

/**
 * Verify that a macOS Mach-O binary on disk contains a slice for `expectedArch` (`"arm64"` or `"x64"`).
 */
export function verifyMacBinaryArch(binaryPath, expectedArch) {
  const fd = fs.openSync(binaryPath, "r");
  try {
    const buf = Buffer.alloc(256);
    const bytesRead = fs.readSync(fd, buf, 0, 256, 0);
    const archs = inspectMachOArchs(buf.subarray(0, bytesRead));
    if (!archs.includes(expectedArch)) {
      throw new Error(
        `macOS binary "${binaryPath}" architectures [${archs.join(", ") || "unknown"}] do not include target arch "${expectedArch}".`,
      );
    }
  } finally {
    fs.closeSync(fd);
  }
}

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
    pgArchiveUrl =
      process.env.NANGO_PG_ARCHIVE_URL ||
      `https://get.enterprisedb.com/postgresql/postgresql-${pgVersion}-windows-x64-binaries.zip`;
    duckdbPlatformSlug = "windows_amd64";
  } else if (targetKey === "darwin-arm64") {
    nodeArchiveName = `node-${normalizedNodeVersion}-darwin-arm64.tar.gz`;
    pgArchiveUrl =
      process.env.NANGO_PG_ARCHIVE_URL ||
      `https://get.enterprisedb.com/postgresql/postgresql-${pgVersion}-osx-binaries.zip`;
    duckdbPlatformSlug = "osx_arm64";
  } else if (targetKey === "darwin-x64") {
    nodeArchiveName = `node-${normalizedNodeVersion}-darwin-x64.tar.gz`;
    pgArchiveUrl =
      process.env.NANGO_PG_ARCHIVE_URL ||
      `https://get.enterprisedb.com/postgresql/postgresql-${pgVersion}-osx-binaries.zip`;
    duckdbPlatformSlug = "osx_amd64";
  } else {
    throw new Error(
      `Unsupported desktop packaging target "${targetKey}". Supported targets: win32-x64, darwin-arm64, darwin-x64.`,
    );
  }

  const nodeArchiveUrl = `https://nodejs.org/dist/${normalizedNodeVersion}/${nodeArchiveName}`;
  const nodeShasumsUrl = `https://nodejs.org/dist/${normalizedNodeVersion}/SHASUMS256.txt`;
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
    nodeShasumsUrl,
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
    if (uncompressed.length < 1024) {
      throw new Error(
        `Decompressed DuckDB extension ${ext.fileName} is unexpectedly small (${uncompressed.length} bytes).`,
      );
    }
    fs.writeFileSync(outPath, uncompressed);
    console.log(
      `[fetch-binaries] Installed DuckDB extension: ${ext.fileName} (${Math.round(uncompressed.length / 1024)} KB, sha256=${computeSha256Hex(uncompressed).slice(0, 12)}...)`,
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

  // 2. Node.js 24 LTS (verified against official SHASUMS256.txt)
  const nodeDestDir = path.join(resourcesRoot, "node");
  const expectedNodeBin =
    manifest.platform === "win32"
      ? path.join(nodeDestDir, "node.exe")
      : path.join(nodeDestDir, "bin", "node");

  if (!fs.existsSync(expectedNodeBin)) {
    const archivePath = path.join(cacheDir, manifest.nodeArchiveName);
    if (!fs.existsSync(archivePath)) {
      const [buf, shasumsBuf] = await Promise.all([
        downloadFileBuffer(manifest.nodeArchiveUrl),
        downloadFileBuffer(manifest.nodeShasumsUrl),
      ]);
      const expectedSha = parseShasums256(
        shasumsBuf.toString("utf8"),
        manifest.nodeArchiveName,
      );
      if (!expectedSha) {
        throw new Error(
          `Could not find SHA-256 entry for ${manifest.nodeArchiveName} in ${manifest.nodeShasumsUrl}.`,
        );
      }
      verifySha256(buf, expectedSha, manifest.nodeArchiveName);
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
    if (manifest.platform === "darwin") {
      verifyMacBinaryArch(expectedNodeBin, manifest.arch);
    }
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
      if (process.env.NANGO_PG_ARCHIVE_SHA256) {
        verifySha256(
          buf,
          process.env.NANGO_PG_ARCHIVE_SHA256,
          path.basename(pgArchivePath),
        );
      }
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
    if (manifest.platform === "darwin") {
      verifyMacBinaryArch(expectedPgBin, manifest.arch);
    }
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
