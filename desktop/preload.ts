/**
 * Electron preload script for Nango Desktop.
 *
 * Safely exposes a minimal IPC surface (`window.nangoDesktop`) to the renderer
 * under `contextIsolation: true` and `nodeIntegration: false`. Matches the
 * `window.nangoDesktop?.selectFolder` contract consumed by `ConfigManagement.tsx`.
 *
 * See docs/desktop-architecture.md.
 */

import type {
  ElectronContextBridge,
  ElectronIpcRenderer,
} from "./electron-types";

export const IPC_CHANNELS = {
  SELECT_FOLDER: "dialog:selectFolder",
  GET_APP_VERSION: "app:getVersion",
} as const;

export interface NangoDesktopBridge {
  /** Open the native OS folder picker and resolve to the chosen path (or null if cancelled). */
  selectFolder: () => Promise<string | null>;
  /** Return the Nango Desktop application version string. */
  getAppVersion: () => Promise<string>;
}

/**
 * Construct the `window.nangoDesktop` bridge object backed by `ipcRenderer.invoke`.
 */
export function createPreloadBridge(
  ipcRenderer: ElectronIpcRenderer,
): NangoDesktopBridge {
  return {
    selectFolder: async (): Promise<string | null> => {
      const result = await ipcRenderer.invoke(IPC_CHANNELS.SELECT_FOLDER);
      return typeof result === "string" && result.trim().length > 0
        ? result
        : null;
    },
    getAppVersion: async (): Promise<string> => {
      const result = await ipcRenderer.invoke(IPC_CHANNELS.GET_APP_VERSION);
      return typeof result === "string" ? result : "";
    },
  };
}

/**
 * Register `window.nangoDesktop` via `contextBridge.exposeInMainWorld`.
 */
export function registerPreloadBridge(
  contextBridge: ElectronContextBridge,
  ipcRenderer: ElectronIpcRenderer,
): NangoDesktopBridge {
  const bridge = createPreloadBridge(ipcRenderer);
  contextBridge.exposeInMainWorld(
    "nangoDesktop",
    bridge as unknown as Record<string, unknown>,
  );
  return bridge;
}
