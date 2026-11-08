/**
 * Runtime Electron main-process bootstrap entry (`package.json` -> `"main": "desktop/dist/index.js"`).
 *
 * Bridges the runtime `electron` module (and optional `electron-updater`) into
 * `DesktopAppCoordinator` and invokes `bootstrap()`.
 *
 * See docs/desktop-architecture.md.
 */

/* eslint-disable @typescript-eslint/no-require-imports */
import path from "node:path";
import type { ElectronMainModule } from "./electron-types";
import { DesktopAppCoordinator } from "./main";
import type { AutoUpdaterLike } from "./updater";

function loadOptionalAutoUpdater(): AutoUpdaterLike | undefined {
  try {
    const mod = require("electron-updater") as { autoUpdater?: AutoUpdaterLike };
    return mod?.autoUpdater;
  } catch {
    return undefined;
  }
}

export function launchDesktopApp(): Promise<boolean> {
  const electron = require("electron") as ElectronMainModule;
  const resourcesPath =
    (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath ??
    path.resolve(__dirname, "..", "resources");

  const coordinator = new DesktopAppCoordinator({
    electron,
    resourcesPath,
    preloadPath: path.join(__dirname, "preload.js"),
    autoUpdater: loadOptionalAutoUpdater(),
  });

  return coordinator.bootstrap();
}

if (require.main === module) {
  void launchDesktopApp();
}
