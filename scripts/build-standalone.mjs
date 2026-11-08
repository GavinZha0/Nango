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
import { repairStandaloneClosure } from "./repair-standalone.mjs";

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
console.log("[build-standalone] Standalone bundle ready for Nango Desktop packaging.");
