/**
 * Typed Electron runtime interfaces for Nango Desktop.
 *
 * Keeps `desktop/*.ts` strictly typed under `pnpm check-types` (`tsc --noEmit`)
 * and unit-testable in Node/Vitest without requiring the 200 MB `electron`
 * binary package to be installed during web/Docker CI builds.
 *
 * See docs/desktop-architecture.md.
 */

import type { SafeStorageAdapter } from "./keyring";

export interface ElectronDialog {
  showOpenDialog(
    window: ElectronBrowserWindow | null,
    options: {
      title?: string;
      defaultPath?: string;
      properties: Array<"openDirectory" | "createDirectory" | "dontAddToRecent">;
    },
  ): Promise<{ canceled: boolean; filePaths: string[] }>;
  showErrorBox(title: string, content: string): void;
}

export interface ElectronShell {
  openPath(path: string): Promise<string>;
}

export interface ElectronIpcMain {
  handle(
    channel: string,
    listener: (event: unknown, ...args: unknown[]) => Promise<unknown> | unknown,
  ): void;
}

export interface ElectronIpcRenderer {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
}

export interface ElectronContextBridge {
  exposeInMainWorld(apiKey: string, api: Record<string, unknown>): void;
}

export interface ElectronInputEvent {
  type: string;
  key: string;
  control?: boolean;
  meta?: boolean;
  shift?: boolean;
  alt?: boolean;
}

export interface ElectronWebContents {
  reload(): void;
  reloadIgnoringCache(): void;
  on(
    event: "before-input-event",
    listener: (event: { preventDefault(): void }, input: ElectronInputEvent) => void,
  ): void;
}

export interface ElectronBrowserWindow {
  loadURL(url: string): Promise<void>;
  show(): void;
  hide(): void;
  focus(): void;
  isMinimized(): boolean;
  restore(): void;
  isDestroyed(): boolean;
  removeMenu?: () => void;
  webContents?: ElectronWebContents;
  on(
    event: "close" | "closed",
    listener: (event: { preventDefault(): void }) => void,
  ): void;
}

export interface ElectronBrowserWindowConstructor {
  new (options: {
    width: number;
    height: number;
    minWidth?: number;
    minHeight?: number;
    title?: string;
    show?: boolean;
    webPreferences: {
      preload: string;
      contextIsolation: boolean;
      nodeIntegration: boolean;
      sandbox?: boolean;
    };
  }): ElectronBrowserWindow;
}

export interface ElectronMenuItemConstructorOptions {
  label?: string;
  type?: "normal" | "separator";
  click?: () => void;
}

export interface ElectronMenu {
  buildFromTemplate(template: ElectronMenuItemConstructorOptions[]): unknown;
}

export interface ElectronTray {
  setToolTip(toolTip: string): void;
  setContextMenu(menu: unknown): void;
  on(event: "click" | "double-click", listener: () => void): void;
  destroy(): void;
}

export interface ElectronTrayConstructor {
  new (iconPath: string): ElectronTray;
}

export interface ElectronApp {
  requestSingleInstanceLock(): boolean;
  quit(): void;
  getVersion(): string;
  getPath(name: "userData" | "documents" | "logs" | "exe"): string;
  whenReady(): Promise<void>;
  on(
    event: "second-instance" | "before-quit" | "window-all-closed" | "activate",
    listener: (...args: unknown[]) => void,
  ): void;
}

export interface ElectronMainModule {
  app: ElectronApp;
  BrowserWindow: ElectronBrowserWindowConstructor;
  Tray: ElectronTrayConstructor;
  Menu: ElectronMenu;
  dialog: ElectronDialog;
  shell: ElectronShell;
  ipcMain: ElectronIpcMain;
  safeStorage: SafeStorageAdapter;
}

export interface ElectronPreloadModule {
  contextBridge: ElectronContextBridge;
  ipcRenderer: ElectronIpcRenderer;
}
