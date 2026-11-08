#!/usr/bin/env node
/**
 * macOS Inside-Out deep code signing and Apple Notarization hook for electron-builder.
 *
 * macOS Gatekeeper inspects every Mach-O binary inside `Nango.app/Contents/Resources/`.
 * Because `extraResources` (`pg/`, `node/`, `standalone/`, `duckdb-extensions/`) are
 * copied outside the main Electron framework bundle, we must:
 * 1. Sign all nested dynamic libraries and addons (`.dylib`, `.so`, `.node`, `.duckdb_extension`) — Tier 1
 * 2. Sign all Mach-O executables (`pg/bin/*`, `node/bin/*`, and any Mach-O binary detected by magic bytes) — Tier 2
 * 3. Re-sign the top-level `Nango.app` bundle
 * 4. Archive `Nango.app` into a temporary `.zip` via `ditto -c -k --keepParent`, submit the `.zip`
 *    to `xcrun notarytool submit --wait`, and run `xcrun stapler staple Nango.app`.
 *
 * See docs/desktop-architecture.md.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const SHARED_LIB_EXTENSIONS = new Set([
  ".dylib",
  ".so",
  ".node",
  ".duckdb_extension",
]);

const NON_BINARY_EXTENSIONS = new Set([
  ".js",
  ".mjs",
  ".cjs",
  ".ts",
  ".json",
  ".sql",
  ".md",
  ".txt",
  ".css",
  ".html",
  ".map",
  ".svg",
  ".png",
  ".ico",
  ".icns",
  ".plist",
  ".sh",
  ".bat",
  ".cmd",
  ".py",
  ".pl",
  ".sample",
  ".conf",
  ".h",
  ".a",
]);

/**
 * Inspect the first 8 bytes of a file buffer to determine whether it is a
 * Mach-O binary (32-bit, 64-bit, or Universal/Fat binary).
 */
export function hasMachOMagic(headerBytes) {
  if (!headerBytes || headerBytes.length < 4) return false;
  const magicBE = headerBytes.readUInt32BE(0);

  // Mach-O 32-bit (MH_MAGIC / MH_CIGAM) and 64-bit (MH_MAGIC_64 / MH_CIGAM_64)
  if (
    magicBE === 0xfeedface ||
    magicBE === 0xcefaedfe ||
    magicBE === 0xfeedfacf ||
    magicBE === 0xcffaedfe
  ) {
    return true;
  }

  // Universal / Fat binary (FAT_MAGIC = 0xcafebabe, FAT_CIGAM = 0xbebafeca).
  // Distinguish from Java .class files (also 0xcafebabe) by checking that
  // nfat_arch (bytes 4..8) is between 1 and 20 (Java class files have major
  // version >= 44 in bytes 6..8).
  if (magicBE === 0xcafebabe && headerBytes.length >= 8) {
    const nfatArch = headerBytes.readUInt32BE(4);
    return nfatArch >= 1 && nfatArch <= 20;
  }
  if (magicBE === 0xbebafeca && headerBytes.length >= 8) {
    const nfatArch = headerBytes.readUInt32LE(4);
    return nfatArch >= 1 && nfatArch <= 20;
  }

  return false;
}

/**
 * Read the first 8 bytes of `filePath` and check for Mach-O magic bytes.
 */
export function isMachOFile(filePath) {
  let fd;
  try {
    fd = fs.openSync(filePath, "r");
    const buf = Buffer.alloc(8);
    const bytesRead = fs.readSync(fd, buf, 0, 8, 0);
    if (bytesRead < 4) return false;
    return hasMachOMagic(buf.subarray(0, bytesRead));
  } catch {
    return false;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // Ignore close error
      }
    }
  }
}

/**
 * Classify a file inside `Contents/Resources` into an Inside-Out signing tier:
 * - Tier 1: Shared libraries and native addons (`.dylib`, `.so`, `.node`, `.duckdb_extension`)
 * - Tier 2: Mach-O executables (detected via Mach-O magic bytes or extensionless binaries in `pg/bin/` and `node/bin/`)
 * - `null`: Non-Mach-O asset
 */
export function classifyMacSignTier(filePath, opts = {}) {
  const normalized = filePath.replace(/\\/g, "/");
  const ext = path.posix.extname(normalized).toLowerCase();

  if (SHARED_LIB_EXTENSIONS.has(ext)) {
    return 1;
  }

  if (NON_BINARY_EXTENSIONS.has(ext)) {
    return null;
  }

  if (opts.checkMagic !== false && isMachOFile(filePath)) {
    return 2;
  }

  if (
    ext === "" &&
    (normalized.includes("/pg/bin/") || normalized.includes("/node/bin/"))
  ) {
    return 2;
  }

  return null;
}

function* walkFiles(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    let lst;
    try {
      lst = fs.lstatSync(fullPath);
    } catch {
      continue;
    }
    if (lst.isSymbolicLink()) {
      continue;
    }
    if (lst.isDirectory()) {
      yield* walkFiles(fullPath);
    } else if (lst.isFile()) {
      yield fullPath;
    }
  }
}

/**
 * Collect all Mach-O targets under `resourcesDir` ordered strictly Inside-Out:
 * all Tier 1 shared libraries/addons first (deepest path first), followed by
 * all Tier 2 executables.
 */
export function collectMacSignTargets(resourcesDir, opts = {}) {
  const tier1 = [];
  const tier2 = [];

  for (const filePath of walkFiles(resourcesDir)) {
    const tier = classifyMacSignTier(filePath, opts);
    if (tier === 1) {
      tier1.push(filePath);
    } else if (tier === 2) {
      tier2.push(filePath);
    }
  }

  const byDepthDesc = (a, b) =>
    b.split(/[\\/]/).length - a.split(/[\\/]/).length || a.localeCompare(b);

  tier1.sort(byDepthDesc);
  tier2.sort(byDepthDesc);

  return {
    tier1Libraries: tier1,
    tier2Executables: tier2,
    orderedTargets: [...tier1, ...tier2],
  };
}

function codesignFile(targetPath, identity, entitlementsPath) {
  const args = [
    "--sign",
    identity,
    "--force",
    "--timestamp",
    "--options",
    "runtime",
  ];
  if (entitlementsPath) {
    args.push("--entitlements", entitlementsPath);
  }
  args.push(targetPath);
  execFileSync("codesign", args, { stdio: "inherit" });
}

/**
 * Archive `.app` bundle using `ditto`, submit the `.zip` to Apple `notarytool`,
 * and staple the ticket back onto the `.app` bundle.
 */
export function notarizeAndStapleAppBundle({
  appBundlePath,
  notarizeZipPath,
  appleId,
  appleIdPassword,
  teamId,
  execSyncFn = execFileSync,
}) {
  try {
    // QUIRK: `xcrun notarytool submit` rejects raw `.app` directories; the bundle
    // must be packaged as a `.zip` with `ditto -c -k --keepParent` first, and
    // after notarization succeeds `stapler staple` is run on the `.app` directory.
    execSyncFn(
      "ditto",
      ["-c", "-k", "--keepParent", appBundlePath, notarizeZipPath],
      { stdio: "inherit" },
    );

    execSyncFn(
      "xcrun",
      [
        "notarytool",
        "submit",
        notarizeZipPath,
        "--apple-id",
        appleId,
        "--password",
        appleIdPassword,
        "--team-id",
        teamId,
        "--wait",
      ],
      { stdio: "inherit" },
    );

    execSyncFn("xcrun", ["stapler", "staple", appBundlePath], {
      stdio: "inherit",
    });
  } finally {
    fs.rmSync(notarizeZipPath, { force: true });
  }
}

/**
 * Resolve the macOS Developer ID code signing identity string.
 * Checks `CSC_NAME` / `APPLE_SIGNING_IDENTITY` first, then falls back to querying
 * the macOS Keychain (`security find-identity -v -p codesigning`) if available.
 */
export function resolveMacSigningIdentity(
  env = process.env,
  execSyncFn = execFileSync,
) {
  if (env.CSC_NAME?.trim()) return env.CSC_NAME.trim();
  if (env.APPLE_SIGNING_IDENTITY?.trim()) return env.APPLE_SIGNING_IDENTITY.trim();

  if (process.platform === "darwin") {
    try {
      const output = execSyncFn(
        "security",
        ["find-identity", "-v", "-p", "codesigning"],
        { encoding: "utf8" },
      );
      const match = output.match(/"(Developer ID Application: [^"]+)"/);
      if (match && match[1]) {
        return match[1];
      }
    } catch {
      // Ignore keychain inspection errors
    }
  }

  return null;
}

/**
 * electron-builder `afterSign` hook logic with strict fail-fast validation
 * for release builds.
 */
export async function runMacAfterSign({
  context,
  env = process.env,
  codesignFn = codesignFile,
  notarizeFn = notarizeAndStapleAppBundle,
  execSyncFn = execFileSync,
}) {
  const { electronPlatformName, appOutDir, packager } = context;
  if (electronPlatformName !== "darwin") {
    return;
  }

  const appName = packager.appInfo.productFilename;
  const appBundlePath = path.join(appOutDir, `${appName}.app`);
  const resourcesDir = path.join(appBundlePath, "Contents", "Resources");
  const entitlementsPath = path.resolve(
    process.cwd(),
    "desktop",
    "entitlements.mac.plist",
  );

  const requireSigning =
    env.NANGO_REQUIRE_SIGNING === "true" ||
    env.GITHUB_REF?.startsWith("refs/tags/v");
  const identity = resolveMacSigningIdentity(env, execSyncFn);
  if (!identity) {
    if (requireSigning) {
      throw new Error(
        "[after-sign] FATAL: macOS release build requires code signing identity (CSC_NAME / APPLE_SIGNING_IDENTITY), but none was configured and no Developer ID certificate was found in Keychain. Refusing to produce an unsigned bundle.",
      );
    }
    console.log(
      "[after-sign] No CSC_NAME / APPLE_SIGNING_IDENTITY set; skipping macOS deep codesign & notarization.",
    );
    return;
  }

  const { tier1Libraries, tier2Executables } =
    collectMacSignTargets(resourcesDir);
  console.log(
    `[after-sign] Signing ${tier1Libraries.length} shared libraries/addons (Tier 1) and ${tier2Executables.length} executables (Tier 2)...`,
  );

  for (const libPath of tier1Libraries) {
    codesignFn(libPath, identity, entitlementsPath);
  }
  for (const binPath of tier2Executables) {
    codesignFn(binPath, identity, entitlementsPath);
  }

  // Re-sign the top-level .app bundle after nested resources have been modified
  codesignFn(appBundlePath, identity, entitlementsPath);

  const appleId = env.APPLE_ID;
  const appleIdPassword = env.APPLE_APP_SPECIFIC_PASSWORD;
  const teamId = env.APPLE_TEAM_ID;

  if (!appleId || !appleIdPassword || !teamId) {
    if (requireSigning) {
      throw new Error(
        "[after-sign] FATAL: macOS release build requires Apple Notarization credentials (APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID), but they are missing. Refusing to produce an unnotarized bundle.",
      );
    }
    console.log(
      "[after-sign] APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID not set; skipping Apple Notarization.",
    );
    return;
  }

  const notarizeZipPath = path.join(appOutDir, `${appName}-notarize.zip`);
  console.log(
    `[after-sign] Submitting ${appBundlePath} (via ${notarizeZipPath}) for Apple Notarization...`,
  );
  notarizeFn({
    appBundlePath,
    notarizeZipPath,
    appleId,
    appleIdPassword,
    teamId,
  });
  console.log("[after-sign] macOS Notarization and stapling complete.");
}

/**
 * electron-builder `afterSign` hook entry point.
 */
export default async function afterSign(context) {
  return runMacAfterSign({ context });
}
