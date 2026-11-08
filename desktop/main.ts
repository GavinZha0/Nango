/**
 * Electron main process entry and lifecycle orchestrator for Nango Desktop.
 *
 * Orchestrates:
 * 1. Single-instance lock (`requestSingleInstanceLock`) to prevent dual-boot `pgdata` corruption
 * 2. Bundled resource path resolution (`pg`, `node`, `standalone`, `duckdb-extensions`)
 * 3. OS-encrypted secret loading (`keyring.ts`) and dynamic port allocation (`port-finder.ts`)
 * 4. Portable PostgreSQL 18 startup -> Drizzle migration -> Next.js standalone startup
 * 5. Native folder-picker IPC (`dialog:selectFolder`), system tray, and ordered graceful shutdown
 *
 * See docs/desktop-architecture.md.
 */

import path from "node:path";
import type {
  ElectronBrowserWindow,
  ElectronMainModule,
  ElectronTray,
} from "./electron-types";
import { loadOrCreateDesktopSecrets } from "./keyring";
import { resolveDesktopPorts } from "./port-finder";
import { PostgresManager } from "./postgres-manager";
import { IPC_CHANNELS } from "./preload";
import { ServerManager } from "./server-manager";
import {
  bindCloseToTray,
  createSystemTray,
  showAndFocusMainWindow,
} from "./tray";
import {
  type AutoUpdaterLike,
  DesktopUpdateController,
} from "./updater";

export interface BundledResourcePaths {
  pgBinDir: string;
  bundledNodeBinDir: string;
  bundledNodeExe: string;
  standaloneDir: string;
  duckdbExtensionDir: string;
  trayIconPath: string;
}

/**
 * Resolve bundled `extraResources` paths for the current platform (`win32` vs POSIX).
 */
export function resolveBundledResourcePaths(
  resourcesPath: string,
  platform: NodeJS.Platform = process.platform,
): BundledResourcePaths {
  const isWin = platform === "win32";
  const bundledNodeBinDir = isWin
    ? path.join(resourcesPath, "node")
    : path.join(resourcesPath, "node", "bin");
  const bundledNodeExe = path.join(
    bundledNodeBinDir,
    isWin ? "node.exe" : "node",
  );

  return {
    pgBinDir: path.join(resourcesPath, "pg", "bin"),
    bundledNodeBinDir,
    bundledNodeExe,
    standaloneDir: path.join(resourcesPath, "standalone"),
    duckdbExtensionDir: path.join(resourcesPath, "duckdb-extensions"),
    trayIconPath: path.join(
      resourcesPath,
      "icons",
      isWin ? "tray.ico" : "trayTemplate.png",
    ),
  };
}

export interface DesktopCoordinatorDeps {
  electron: ElectronMainModule;
  resourcesPath: string;
  preloadPath?: string;
  autoUpdater?: AutoUpdaterLike;
}

export class DesktopAppCoordinator {
  private readonly electron: ElectronMainModule;
  private readonly resourcesPath: string;
  private readonly preloadPath: string;
  private readonly autoUpdater?: AutoUpdaterLike;

  private mainWindow: ElectronBrowserWindow | null = null;
  private tray: ElectronTray | null = null;
  private pgManager: PostgresManager | null = null;
  private serverManager: ServerManager | null = null;
  private updateController: DesktopUpdateController | null = null;
  private isQuitting = false;
  private shutdownPromise: Promise<void> | null = null;

  constructor(deps: DesktopCoordinatorDeps) {
    this.electron = deps.electron;
    this.resourcesPath = deps.resourcesPath;
    this.preloadPath =
      deps.preloadPath ?? path.join(__dirname, "preload.js");
    this.autoUpdater = deps.autoUpdater;
  }

  getUpdateController(): DesktopUpdateController | null {
    return this.updateController;
  }

  /**
   * Entry point called immediately on main process launch.
   * Returns `false` if another instance already holds the single-instance lock.
   */
  async bootstrap(): Promise<boolean> {
    const { app } = this.electron;

    // SECURITY / CONTRACT: Acquire the single-instance lock before touching
    // `<userData>/pgdata` so a second launch can never race or corrupt the
    // embedded PostgreSQL data directory.
    const gotLock = app.requestSingleInstanceLock();
    if (!gotLock) {
      app.quit();
      return false;
    }

    app.on("second-instance", () => {
      showAndFocusMainWindow(this.mainWindow);
    });

    app.on("activate", () => {
      showAndFocusMainWindow(this.mainWindow);
    });

    app.on("before-quit", (event: unknown) => {
      if (this.isQuitting) return;
      if (
        event &&
        typeof event === "object" &&
        "preventDefault" in event &&
        typeof (event as { preventDefault?: () => void }).preventDefault ===
          "function"
      ) {
        (event as { preventDefault: () => void }).preventDefault();
      }
      void this.shutdownAndQuit();
    });

    await app.whenReady();
    try {
      await this.startServicesAndCreateWindow();
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const userDataDir = app.getPath("userData");
      const logsDir = path.join(userDataDir, "logs");
      this.electron.dialog.showErrorBox(
        "Nango 启动失败",
        `${msg}\n\n日志目录：${logsDir}`,
      );
      await this.shutdownAndQuit();
      return false;
    }
  }

  private async startServicesAndCreateWindow(): Promise<void> {
    const { app, BrowserWindow, Tray, Menu, dialog, shell, safeStorage } =
      this.electron;

    const userDataDir = app.getPath("userData");
    const documentsDir = app.getPath("documents");
    const workspaceDir = path.join(documentsDir, "NangoWorkspace");
    const logsDir = path.join(userDataDir, "logs");
    const pgDataDir =
      process.env.NANGO_PGDATA_DIR?.trim() || path.join(userDataDir, "pgdata");

    const bundled = resolveBundledResourcePaths(this.resourcesPath);
    const secrets = loadOrCreateDesktopSecrets(userDataDir, safeStorage);
    const ports = await resolveDesktopPorts();

    const handleFatalServiceError = (err: Error) => {
      dialog.showErrorBox(
        "Nango 后台服务异常退出",
        `${err.message}\n\n日志目录：${logsDir}`,
      );
      void shell.openPath(logsDir);
      void this.shutdownAndQuit();
    };

    this.pgManager = new PostgresManager({
      pgBinDir: bundled.pgBinDir,
      pgDataDir,
      pgPort: ports.pgPort,
      pgPassword: secrets.postgresPassword,
      onFatalExit: handleFatalServiceError,
    });
    await this.pgManager.start();

    this.serverManager = new ServerManager({
      standaloneDir: bundled.standaloneDir,
      appPort: ports.appPort,
      pgPort: ports.pgPort,
      betterAuthUrl: ports.betterAuthUrl,
      secrets,
      userDataDir,
      workspaceDir,
      bundledNodeExe: bundled.bundledNodeExe,
      bundledNodeBinDir: bundled.bundledNodeBinDir,
      duckdbExtensionDir: bundled.duckdbExtensionDir,
      onFatalExit: handleFatalServiceError,
    });
    await this.serverManager.start();

    this.registerIpcHandlers(workspaceDir);

    const win = new BrowserWindow({
      width: 1440,
      height: 900,
      minWidth: 1024,
      minHeight: 680,
      title: "Nango",
      show: false,
      webPreferences: {
        preload: this.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    this.mainWindow = win;
    bindCloseToTray(win, () => this.isQuitting);

    this.tray = createSystemTray({
      iconPath: bundled.trayIconPath,
      workspaceDir,
      logsDir,
      TrayClass: Tray,
      Menu,
      shell,
      getMainWindow: () => this.mainWindow,
      onRequestQuit: () => {
        void this.shutdownAndQuit();
      },
    });

    await win.loadURL(ports.betterAuthUrl);
    win.show();
    win.focus();

    if (this.autoUpdater) {
      this.updateController = new DesktopUpdateController({
        updater: this.autoUpdater,
        prepareForInstall: () => this.shutdownServicesOnly(),
      });
      void this.updateController.checkForUpdatesSafely();
    }
  }

  private registerIpcHandlers(defaultWorkspaceDir: string): void {
    const { app, dialog, ipcMain } = this.electron;

    ipcMain.handle(IPC_CHANNELS.SELECT_FOLDER, async () => {
      const result = await dialog.showOpenDialog(this.mainWindow, {
        title: "选择本地共享文件夹 (host.file.root)",
        defaultPath: defaultWorkspaceDir,
        properties: ["openDirectory", "createDirectory", "dontAddToRecent"],
      });
      if (result.canceled || result.filePaths.length === 0) {
        return null;
      }
      return result.filePaths[0] ?? null;
    });

    ipcMain.handle(IPC_CHANNELS.GET_APP_VERSION, () => {
      return app.getVersion();
    });
  }

  /**
   * Stop `server.js` and `postgres` cleanly and destroy the tray without calling
   * `app.quit()` (used by both `shutdownAndQuit` and `DesktopUpdateController.prepareForInstall`).
   */
  async shutdownServicesOnly(): Promise<void> {
    if (this.shutdownPromise) {
      return this.shutdownPromise;
    }

    this.isQuitting = true;
    this.shutdownPromise = (async () => {
      try {
        if (this.serverManager) {
          await this.serverManager.stop();
        }
      } catch {
        // Ignore shutdown errors so Postgres still stops cleanly
      }

      try {
        if (this.pgManager) {
          await this.pgManager.stop();
        }
      } catch {
        // Ignore shutdown errors on final exit
      }

      if (this.tray) {
        this.tray.destroy();
        this.tray = null;
      }
    })();

    return this.shutdownPromise;
  }

  /**
   * Ordered graceful shutdown sequence:
   * 1. Stop Next.js `server.js` (triggers `mcpProviderPool.shutdown()` & `shutdownScheduler()`)
   * 2. Stop PostgreSQL 18 via `pg_ctl stop -D <pgdata> -m fast` so WAL flushes cleanly
   * 3. Destroy tray and quit Electron
   */
  async shutdownAndQuit(): Promise<void> {
    await this.shutdownServicesOnly();
    this.electron.app.quit();
  }
}
