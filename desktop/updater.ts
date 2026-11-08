/**
 * Auto-update controller for Nango Desktop.
 *
 * Wraps `electron-updater` (via a typed adapter interface) so background update
 * checks are non-blocking, safe when no update feed is configured, and always
 * run the ordered graceful shutdown (`ServerManager.stop()` -> `PostgresManager.stop()`)
 * before invoking `quitAndInstall()` so the PostgreSQL 18 WAL flushes cleanly
 * before the installer replaces the application binaries.
 *
 * See docs/desktop-architecture.md.
 */

export interface AutoUpdaterLike {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  on(event: "update-available" | "update-downloaded" | "error", listener: (...args: unknown[]) => void): void;
  checkForUpdates(): Promise<unknown>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
}

export type UpdateState =
  | { status: "idle" }
  | { status: "checking" }
  | { status: "available"; version: string }
  | { status: "downloaded"; version: string }
  | { status: "error"; message: string };

export interface DesktopUpdateControllerOptions {
  updater: AutoUpdaterLike;
  /**
   * Graceful shutdown callback that stops `server.js` and `postgres` before
   * the installer replaces binaries on disk.
   */
  prepareForInstall: () => Promise<void>;
  onStateChange?: (state: UpdateState) => void;
}

function extractVersion(info: unknown): string {
  if (info && typeof info === "object" && "version" in info) {
    const v = (info as { version?: unknown }).version;
    if (typeof v === "string" && v.trim().length > 0) {
      return v.trim();
    }
  }
  return "unknown";
}

export class DesktopUpdateController {
  private readonly updater: AutoUpdaterLike;
  private readonly prepareForInstall: () => Promise<void>;
  private readonly onStateChange?: (state: UpdateState) => void;
  private state: UpdateState = { status: "idle" };

  constructor(opts: DesktopUpdateControllerOptions) {
    this.updater = opts.updater;
    this.prepareForInstall = opts.prepareForInstall;
    this.onStateChange = opts.onStateChange;

    // Disable automatic install-on-quit until we have explicitly stopped
    // PostgreSQL 18 and Next.js standalone.
    this.updater.autoDownload = true;
    this.updater.autoInstallOnAppQuit = false;

    this.updater.on("update-available", (info: unknown) => {
      this.setState({ status: "available", version: extractVersion(info) });
    });

    this.updater.on("update-downloaded", (info: unknown) => {
      this.setState({ status: "downloaded", version: extractVersion(info) });
    });

    this.updater.on("error", (err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      this.setState({ status: "error", message: msg });
    });
  }

  getState(): UpdateState {
    return this.state;
  }

  private setState(next: UpdateState): void {
    this.state = next;
    this.onStateChange?.(next);
  }

  /**
   * Perform a non-throwing background check for updates.
   */
  async checkForUpdatesSafely(): Promise<UpdateState> {
    this.setState({ status: "checking" });
    try {
      await this.updater.checkForUpdates();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.setState({ status: "error", message: msg });
    }
    return this.state;
  }

  /**
   * Stop `server.js` and `postgres` cleanly before triggering `quitAndInstall`
   * so Windows NSIS / macOS Squirrel never collides with locked database files.
   */
  async installDownloadedUpdate(): Promise<void> {
    if (this.state.status !== "downloaded") {
      throw new Error(
        `Cannot install update when state is "${this.state.status}" (expected "downloaded").`,
      );
    }

    await this.prepareForInstall();
    this.updater.quitAndInstall(false, true);
  }
}
