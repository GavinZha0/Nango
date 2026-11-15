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
  ElectronBrowserWindowConstructor,
  ElectronMainModule,
  ElectronTray,
} from "./electron-types";
import { loadOrCreateDesktopSecrets } from "./keyring";
import { resolveDesktopPorts } from "./port-finder";
import { PostgresManager } from "./postgres-manager";
import { IPC_CHANNELS } from "./preload";
import { ServerManager } from "./server-manager";
import { ensureStandaloneExtracted } from "./standalone-extractor";
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

function buildSplashDataUrl(version: string): string {
  const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<style>
  html, body {
    margin: 0; height: 100%; background: #0b0d12; color: #e5e7eb;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    display: flex; align-items: center; justify-content: center;
    user-select: none; overflow: hidden;
    -webkit-app-region: drag;
  }
  .box { text-align: center; padding: 24px; }
  .title { font-size: 22px; font-weight: 600; letter-spacing: 0.4px; margin-bottom: 6px; }
  .ver { font-size: 12px; color: #9ca3af; margin-bottom: 18px; }
  .status { font-size: 13px; color: #cbd5e1; }
</style>
</head>
<body>
  <div class="box">
    <div class="title">Nango</div>
    <div class="ver">v${version}</div>
    <div id="status" class="status">Starting local services…</div>
  </div>
</body>
</html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

interface SplashHandle {
  updateStatus(text: string): void;
  close(): void;
}

function createSplashWindow(
  BrowserWindow: ElectronBrowserWindowConstructor,
  version: string,
): SplashHandle | null {
  try {
    const splash = new BrowserWindow({
      width: 380,
      height: 220,
      frame: false,
      resizable: false,
      center: true,
      backgroundColor: "#0b0d12",
      show: true,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    splash.removeMenu?.();

    let loaded = false;
    let latestText: string | null = null;

    const applyStatus = (text: string) => {
      if (splash.isDestroyed()) return;
      try {
        void splash.webContents
          ?.executeJavaScript?.(
            `(() => { const el = document.getElementById("status"); if (el) el.textContent = ${JSON.stringify(text)}; })()`,
          )
          ?.catch(() => {});
      } catch {
        // Ignore splash update failures
      }
    };

    void splash
      .loadURL(buildSplashDataUrl(version))
      .then(() => {
        loaded = true;
        if (latestText !== null) {
          applyStatus(latestText);
        }
      })
      .catch(() => {});

    return {
      updateStatus(text: string) {
        latestText = text;
        if (loaded) {
          applyStatus(text);
        }
      },
      close() {
        if (!splash.isDestroyed()) {
          splash.close?.();
        }
      },
    };
  } catch {
    return null;
  }
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
        "Nango Startup Failed",
        `${msg}\n\nIf the service exited unexpectedly, a local port may be in use or data directory permissions may be restricted.\nLogs directory: ${logsDir}`,
      );
      await this.shutdownAndQuit();
      return false;
    }
  }

  private async startServicesAndCreateWindow(): Promise<void> {
    const { app, BrowserWindow, Tray, Menu, dialog, shell, safeStorage } =
      this.electron;

    const appVersion = app.getVersion();
    const splashWin = createSplashWindow(BrowserWindow, appVersion);

    try {
      const userDataDir = app.getPath("userData");
      const documentsDir = app.getPath("documents");
      const workspaceDir = path.join(documentsDir, "NangoWorkspace");
      const logsDir = path.join(userDataDir, "logs");
      const pgDataDir =
        process.env.NANGO_PGDATA_DIR?.trim() || path.join(userDataDir, "pgdata");

      const bundled = resolveBundledResourcePaths(this.resourcesPath);

      splashWin?.updateStatus("Initializing secrets and ports…");
      const [secrets, ports] = await Promise.all([
        Promise.resolve().then(() =>
          loadOrCreateDesktopSecrets(userDataDir, safeStorage),
        ),
        resolveDesktopPorts(),
      ]);
      if (this.isQuitting) return;

      const handleFatalServiceError = (err: Error) => {
        if (this.isQuitting) return;
        dialog.showErrorBox(
          "Nango Background Service Exited Unexpectedly",
          `${err.message}\n\nLogs directory: ${logsDir}`,
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

      splashWin?.updateStatus("Starting database and runtime…");
      const [standaloneDir] = await Promise.all([
        ensureStandaloneExtracted({
          userDataDir,
          resourcesPath: this.resourcesPath,
          appVersion,
        }),
        this.pgManager.start(),
      ]);
      if (this.isQuitting) return;

      splashWin?.updateStatus("Starting application server…");
      this.serverManager = new ServerManager({
        standaloneDir,
        appPort: ports.appPort,
        pgPort: ports.pgPort,
        betterAuthUrl: ports.betterAuthUrl,
        secrets,
        userDataDir,
        workspaceDir,
        bundledNodeExe: bundled.bundledNodeExe,
        bundledNodeBinDir: bundled.bundledNodeBinDir,
        duckdbExtensionDir: bundled.duckdbExtensionDir,
        appVersion,
        forceMigrate: this.pgManager.wasNewlyInitialized(),
        onFatalExit: handleFatalServiceError,
        onRestarted: () => {
          if (this.mainWindow && !this.mainWindow.isDestroyed()) {
            this.mainWindow.webContents?.reload();
          }
        },
      });
      await this.serverManager.start();
      if (this.isQuitting) return;

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
      // Remove the default application menu bar (File/Edit/View/Window) on Windows/Linux
      win.removeMenu?.();
      bindReloadShortcuts(win);
      // SECURITY: Confine renderer navigation to the local app origin; open
      // external HTTP(S) links in the OS browser instead of an in-app window.
      const isHttpUrl = (url: string): boolean =>
        url.startsWith("http://") || url.startsWith("https://");
      win.webContents?.setWindowOpenHandler?.(({ url }) => {
        if (isHttpUrl(url)) {
          void shell.openExternal?.(url);
        }
        return { action: "deny" };
      });
      win.webContents?.on("will-navigate", (event, url) => {
        if (!url.startsWith(ports.betterAuthUrl)) {
          event.preventDefault();
          if (isHttpUrl(url)) {
            void shell.openExternal?.(url);
          }
        }
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

      splashWin?.updateStatus("Loading workspace…");
      await win.loadURL(ports.betterAuthUrl);
      if (this.isQuitting) {
        if (!win.isDestroyed()) {
          win.close?.();
        }
        return;
      }
      win.show();
      win.focus();
      splashWin?.close();

      if (this.autoUpdater) {
        this.updateController = new DesktopUpdateController({
          updater: this.autoUpdater,
          prepareForInstall: () => this.shutdownServicesOnly(),
        });
        // Auto-update checks/downloads at boot are intentionally disabled until
        // an explicit install/restart UI is wired; avoids downloading updates on
        // every launch only to discard them on exit.
      }
    } catch (err) {
      splashWin?.close();
      throw err;
    }
  }

  private registerIpcHandlers(defaultWorkspaceDir: string): void {
    const { app, dialog, ipcMain } = this.electron;

    ipcMain.handle(IPC_CHANNELS.SELECT_FOLDER, async () => {
      const result = await dialog.showOpenDialog(this.mainWindow, {
        title: "Select Local Shared Folder (host.file.root)",
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
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      // Show indeterminate taskbar progress so the user gets immediate feedback
      // while server.js and PostgreSQL flush and exit.
      this.mainWindow.setProgressBar?.(2);
    }
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

/**
 * Restore standard browser reload shortcuts (`F5`, `Ctrl+F5`, `Ctrl/Cmd+R`,
 * `Ctrl/Cmd+Shift+R`) after `win.removeMenu()` strips the default Electron menu.
 */
export function bindReloadShortcuts(win: ElectronBrowserWindow): void {
  const wc = win.webContents;
  if (!wc) return;

  wc.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown") return;

    const key = input.key.toLowerCase();
    const hasPrimaryModifier = Boolean(input.control || input.meta);

    // Hard reload (ignore cache): Ctrl+F5 or Ctrl/Cmd+Shift+R
    if (
      (key === "f5" && hasPrimaryModifier && !input.alt) ||
      (key === "r" && hasPrimaryModifier && input.shift && !input.alt)
    ) {
      event.preventDefault();
      wc.reloadIgnoringCache();
      return;
    }

    // Standard reload: F5 or Ctrl/Cmd+R
    if (
      (key === "f5" && !hasPrimaryModifier && !input.shift && !input.alt) ||
      (key === "r" && hasPrimaryModifier && !input.shift && !input.alt)
    ) {
      event.preventDefault();
      wc.reload();
    }
  });
}
