#!/usr/bin/env node
/**
 * Cross-platform builder for Next.js standalone bundle with automated .pnpm
 * closure repair and asset staging for Nango Desktop.
 *
 * Runs `pnpm build` under `NEXT_STANDALONE_OUTPUT=true`, followed by
 * `repairStandaloneClosure()` across Windows, macOS, and Linux.
 *
 * See docs/desktop-architecture.md.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import * as tar from "tar";
import { repairStandaloneClosure } from "./repair-standalone.mjs";

/**
 * Archive `.next/standalone` into `desktop/resources/standalone.tar` preserving
 * all internal symlinks for zero-loss electron-builder packaging.
 */
export function archiveStandaloneBundle(rootDir = process.cwd()) {
  const standaloneDir = path.join(rootDir, ".next", "standalone");
  const resourcesDir = path.join(rootDir, "desktop", "resources");
  const tarPath = path.join(resourcesDir, "standalone.tar");
  fs.mkdirSync(resourcesDir, { recursive: true });

  console.log(`[build-standalone] Archiving ${standaloneDir} to ${tarPath}...`);
  try {
    fs.unlinkSync(tarPath);
  } catch {
    // Ignored
  }

  tar.c(
    {
      sync: true,
      file: tarPath,
      cwd: standaloneDir,
    },
    ["."],
  );

  const sizeMb = Math.round(fs.statSync(tarPath).size / (1024 * 1024));
  console.log(
    `[build-standalone] Archived standalone.tar successfully (${sizeMb} MB).`,
  );
}

console.log("[build-standalone] Building Next.js standalone output (NEXT_STANDALONE_OUTPUT=true)...");

const buildResult =
  process.platform === "win32"
    ? spawnSync("cmd.exe", ["/d", "/s", "/c", "pnpm", "build"], {
        stdio: "inherit",
        env: {
          ...process.env,
          NEXT_STANDALONE_OUTPUT: "true",
          NEXT_TELEMETRY_DISABLED: "1",
        },
      })
    : spawnSync("pnpm", ["build"], {
        stdio: "inherit",
        env: {
          ...process.env,
          NEXT_STANDALONE_OUTPUT: "true",
          NEXT_TELEMETRY_DISABLED: "1",
        },
      });

if (buildResult.error) {
  console.error("[build-standalone] Failed to spawn Next.js build process:", buildResult.error);
  process.exit(1);
}

if (buildResult.status !== 0) {
  console.error(`[build-standalone] Next.js build failed with exit code ${buildResult.status}.`);
  process.exit(buildResult.status ?? 1);
}

console.log("[build-standalone] Build succeeded. Repairing standalone closure and staging runtime assets...");
repairStandaloneClosure();
archiveStandaloneBundle();
console.log("[build-standalone] Standalone bundle ready for Nango Desktop packaging.");
