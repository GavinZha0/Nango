/**
 * System tray integration and background close-to-tray behavior for Nango Desktop.
 *
 * Keeping the Electron process resident in the system tray when the main window
 * is closed ensures in-process `schedule` jobs and asynchronous `entity_run`
 * tasks continue executing uninterrupted.
 *
 * See docs/desktop-architecture.md.
 */

import type {
  ElectronBrowserWindow,
  ElectronMenu,
  ElectronMenuItemConstructorOptions,
  ElectronShell,
  ElectronTray,
  ElectronTrayConstructor,
} from "./electron-types";

export interface TrayControllerOptions {
  iconPath: string;
  workspaceDir: string;
  logsDir: string;
  TrayClass: ElectronTrayConstructor;
  Menu: ElectronMenu;
  shell: ElectronShell;
  getMainWindow: () => ElectronBrowserWindow | null;
  onRequestQuit: () => void;
}

/**
 * Restore and focus the main window if it exists.
 */
export function showAndFocusMainWindow(
  win: ElectronBrowserWindow | null,
): void {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) {
    win.restore();
  }
  win.show();
  win.focus();
}

/**
 * Wire the main window's `close` event so clicking the window close button
 * hides the window to the system tray instead of terminating the background
 * Node/Postgres services while `isQuitting()` is false.
 */
export function bindCloseToTray(
  win: ElectronBrowserWindow,
  isQuitting: () => boolean,
): void {
  win.on("close", (event) => {
    if (!isQuitting()) {
      event.preventDefault();
      win.hide();
    }
  });
}

/**
 * Build the tray context menu template.
 */
export function buildTrayMenuTemplate(
  opts: Pick<
    TrayControllerOptions,
    "workspaceDir" | "logsDir" | "shell" | "getMainWindow" | "onRequestQuit"
  >,
): ElectronMenuItemConstructorOptions[] {
  return [
    {
      label: "显示 Nango 主窗口",
      click: () => {
        showAndFocusMainWindow(opts.getMainWindow());
      },
    },
    {
      type: "separator",
    },
    {
      label: "打开工作区文件夹 (NangoWorkspace)",
      click: () => {
        void opts.shell.openPath(opts.workspaceDir);
      },
    },
    {
      label: "打开运行日志目录",
      click: () => {
        void opts.shell.openPath(opts.logsDir);
      },
    },
    {
      type: "separator",
    },
    {
      label: "退出 Nango",
      click: () => {
        opts.onRequestQuit();
      },
    },
  ];
}

/**
 * Create and configure the Nango Desktop system tray icon and context menu.
 */
export function createSystemTray(opts: TrayControllerOptions): ElectronTray {
  const tray = new opts.TrayClass(opts.iconPath);
  tray.setToolTip("Nango AI Agent Workspace");

  const template = buildTrayMenuTemplate(opts);
  const contextMenu = opts.Menu.buildFromTemplate(template);
  tray.setContextMenu(contextMenu);

  tray.on("click", () => {
    showAndFocusMainWindow(opts.getMainWindow());
  });
  tray.on("double-click", () => {
    showAndFocusMainWindow(opts.getMainWindow());
  });

  return tray;
}
