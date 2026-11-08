#!/usr/bin/env node
/**
 * macOS Inside-Out deep code signing and Apple Notarization hook for electron-builder.
 *
 * macOS Gatekeeper inspects every Mach-O binary inside `Nango.app/Contents/Resources/`.
 * Because `extraResources` (`pg/`, `node/`, `standalone/`, `duckdb-extensions/`) are
 * copied outside the main Electron framework bundle, we must sign all nested dynamic
 * libraries (`.dylib`, `.so`, `.node`, `.duckdb_extension`) BEFORE signing the
 * executables (`postgres`, `initdb`, `pg_ctl`, `pg_isready`, `createdb`, `node`),
 * and finally re-sign the top-level `.app` bundle before submitting for notarization.
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

const BUNDLED_EXECUTABLE_NAMES = new Set([
  "postgres",
  "initdb",
  "pg_ctl",
  "pg_isready",
  "createdb",
  "psql",
  "node",
]);

/**
 * Classify a file inside `Contents/Resources` into an Inside-Out signing tier:
 * - Tier 1: Shared libraries and native addons (`.dylib`, `.so`, `.node`, `.duckdb_extension`)
 * - Tier 2: Standalone Mach-O executables in `pg/bin/` and `node/bin/`
 * - `null`: Non-Mach-O asset (JS, SQL, JSON, CSS, etc.)
 */
export function classifyMacSignTier(filePath) {
  const normalized = filePath.replace(/\\/g, "/");
  const ext = path.posix.extname(normalized);
  if (SHARED_LIB_EXTENSIONS.has(ext)) {
    return 1;
  }

  const base = path.posix.basename(normalized);
  if (
    BUNDLED_EXECUTABLE_NAMES.has(base) &&
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
export function collectMacSignTargets(resourcesDir) {
  const tier1 = [];
  const tier2 = [];

  for (const filePath of walkFiles(resourcesDir)) {
    const tier = classifyMacSignTier(filePath);
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
 * electron-builder `afterSign` hook entry point.
 */
export default async function afterSign(context) {
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

  const identity = process.env.CSC_NAME || process.env.APPLE_SIGNING_IDENTITY;
  if (!identity) {
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
    codesignFile(libPath, identity, entitlementsPath);
  }
  for (const binPath of tier2Executables) {
    codesignFile(binPath, identity, entitlementsPath);
  }

  // Re-sign the top-level .app bundle after nested resources have been modified
  codesignFile(appBundlePath, identity, entitlementsPath);

  const appleId = process.env.APPLE_ID;
  const appleIdPassword = process.env.APPLE_APP_SPECIFIC_PASSWORD;
  const teamId = process.env.APPLE_TEAM_ID;

  if (!appleId || !appleIdPassword || !teamId) {
    console.log(
      "[after-sign] APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID not set; skipping Apple Notarization.",
    );
    return;
  }

  console.log(`[after-sign] Submitting ${appBundlePath} for Apple Notarization...`);
  execFileSync(
    "xcrun",
    [
      "notarytool",
      "submit",
      appBundlePath,
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
  execFileSync("xcrun", ["stapler", "staple", appBundlePath], {
    stdio: "inherit",
  });
  console.log("[after-sign] macOS Notarization and stapling complete.");
}
