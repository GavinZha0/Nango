#!/usr/bin/env node
/**
 * Restore `node_modules` inside the bundled Node.js runtime (`resources/node/`)
 * after `electron-builder` copies `extraResources`.
 *
 * `electron-builder` hardcodes a directory filter (`relative === "node_modules"`)
 * that silently drops `desktop/resources/node/node_modules` (containing `npm` and
 * `npx` CLIs), breaking `stdio` MCP servers that invoke `npx`. Running this in
 * `afterPack` bypasses the filter without runtime extraction overhead.
 *
 * See docs/desktop-architecture.md.
 */

import fs from "node:fs";
import path from "node:path";

/**
 * Resolve the packaged `resources/node` directory inside `appOutDir` for
 * Windows, Linux, or macOS `.app` bundles.
 */
export function resolveTargetNodeDir({
  appOutDir,
  electronPlatformName,
  productFilename = "Nango",
}) {
  if (electronPlatformName === "darwin") {
    const preferredApp = path.join(appOutDir, `${productFilename}.app`);
    let appBundleDir = fs.existsSync(preferredApp) ? preferredApp : null;
    if (!appBundleDir && fs.existsSync(appOutDir)) {
      const appEntry = fs
        .readdirSync(appOutDir, { withFileTypes: true })
        .find((d) => d.isDirectory() && d.name.endsWith(".app"));
      if (appEntry) {
        appBundleDir = path.join(appOutDir, appEntry.name);
      }
    }
    if (!appBundleDir) {
      throw new Error(
        `[after-pack] Could not locate .app bundle in ${appOutDir}`,
      );
    }
    return path.join(appBundleDir, "Contents", "Resources", "node");
  }

  return path.join(appOutDir, "resources", "node");
}

/**
 * Copy `node_modules` (Windows) and `lib/node_modules` (macOS/Linux) from
 * `sourceNodeDir` to `targetNodeDir` if present in source.
 */
export function restoreBundledNodeModules({ sourceNodeDir, targetNodeDir }) {
  const candidates = ["node_modules", path.join("lib", "node_modules")];
  const restored = [];

  for (const rel of candidates) {
    const src = path.join(sourceNodeDir, rel);
    if (!fs.existsSync(src)) continue;

    const dst = path.join(targetNodeDir, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.cpSync(src, dst, {
      recursive: true,
      force: true,
      verbatimSymlinks: true,
    });
    restored.push(rel);
  }

  return restored;
}

export default async function afterPack(context) {
  const projectDir = context.packager?.projectDir ?? process.cwd();
  const sourceNodeDir = path.join(projectDir, "desktop", "resources", "node");
  if (!fs.existsSync(sourceNodeDir)) {
    throw new Error(
      `[after-pack] Missing bundled Node directory at ${sourceNodeDir}`,
    );
  }

  const targetNodeDir = resolveTargetNodeDir({
    appOutDir: context.appOutDir,
    electronPlatformName: context.electronPlatformName,
    productFilename: context.packager?.appInfo?.productFilename,
  });

  const restored = restoreBundledNodeModules({ sourceNodeDir, targetNodeDir });
  console.log(
    `[after-pack] Restored bundled Node modules (${restored.join(", ") || "none"}) into ${targetNodeDir}`,
  );
}
