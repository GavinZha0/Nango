import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  generateDesktopSecrets,
  isValidDesktopSecrets,
  loadOrCreateDesktopSecrets,
  type SafeStorageAdapter,
} from "../../../desktop/keyring";
import {
  DesktopAppCoordinator,
  resolveBundledResourcePaths,
} from "../../../desktop/main";
import {
  findAvailablePort,
  isPortAvailable,
  resolveDesktopPorts,
} from "../../../desktop/port-finder";
import {
  cleanStalePostmasterPid,
  DEFAULT_PG_READY_TIMEOUT_MS,
  parsePostmasterPid,
  verifyPgVersion,
} from "../../../desktop/postgres-manager";
import {
  IPC_CHANNELS,
  registerPreloadBridge,
} from "../../../desktop/preload";
import {
  buildDesktopServerEnv,
  computeBackoffDelayMs,
  DEFAULT_SERVER_READY_TIMEOUT_MS,
  ensureDesktopWritableDirs,
} from "../../../desktop/server-manager";
import {
  bindCloseToTray,
  buildTrayMenuTemplate,
  showAndFocusMainWindow,
} from "../../../desktop/tray";

describe("desktop/port-finder", () => {
  it("detects occupied ports and advances to the next free port", async () => {
    const blocker = net.createServer();
    await new Promise<void>((resolve) => {
      blocker.listen(0, "127.0.0.1", () => resolve());
    });
    const address = blocker.address() as net.AddressInfo;
    const occupiedPort = address.port;

    try {
      expect(await isPortAvailable(occupiedPort, "127.0.0.1")).toBe(false);
      const nextFree = await findAvailablePort(occupiedPort, {
        host: "127.0.0.1",
        maxAttempts: 20,
      });
      expect(nextFree).toBeGreaterThan(occupiedPort);
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  });

  it("allocates non-overlapping pgPort and appPort with matching BETTER_AUTH_URL", async () => {
    const allocation = await resolveDesktopPorts({
      preferredPgPort: 25432,
      preferredAppPort: 25432,
      host: "127.0.0.1",
    });

    expect(allocation.pgPort).not.toBe(allocation.appPort);
    expect(allocation.betterAuthUrl).toBe(
      `http://127.0.0.1:${allocation.appPort}`,
    );
  });
});

describe("desktop/keyring", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nango-desktop-keyring-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("generates valid desktop secrets and persists encrypted payload via safeStorage", () => {
    const fakeSafeStorage: SafeStorageAdapter = {
      isEncryptionAvailable: () => true,
      encryptString: (plain) =>
        Buffer.from(plain.split("").reverse().join(""), "utf8"),
      decryptString: (buf) =>
        buf.toString("utf8").split("").reverse().join(""),
    };

    const first = loadOrCreateDesktopSecrets(tmpDir, fakeSafeStorage);
    expect(isValidDesktopSecrets(first)).toBe(true);
    expect(first.credentialEncryptionKeyring).toMatch(/^k1=[0-9a-f]{64}$/);

    // Verify secrets.bin on disk does not contain plaintext keyring
    const rawDisk = fs.readFileSync(path.join(tmpDir, "secrets.bin"), "utf8");
    expect(rawDisk).not.toContain(first.credentialEncryptionKeyring);

    // Second call reloads identical secrets
    const second = loadOrCreateDesktopSecrets(tmpDir, fakeSafeStorage);
    expect(second).toEqual(first);
  });

  it("migrates legacy secrets.bin with v1: prefix to k1= format cleanly", () => {
    const fakeSafeStorage: SafeStorageAdapter = {
      isEncryptionAvailable: () => true,
      encryptString: (plain) => Buffer.from(plain, "utf8"),
      decryptString: (buf) => buf.toString("utf8"),
    };

    const legacyPayload = {
      credentialEncryptionKeyring: `v1:${"a".repeat(64)}`,
      betterAuthSecret: "b".repeat(32),
      postgresPassword: "c".repeat(16),
    };
    const envelope = {
      version: 1,
      encrypted: true,
      payloadBase64: Buffer.from(JSON.stringify(legacyPayload), "utf8").toString("base64"),
    };
    fs.writeFileSync(path.join(tmpDir, "secrets.bin"), JSON.stringify(envelope));

    const loaded = loadOrCreateDesktopSecrets(tmpDir, fakeSafeStorage);
    expect(loaded.credentialEncryptionKeyring).toBe(`k1=${"a".repeat(64)}`);
    expect(isValidDesktopSecrets(loaded)).toBe(true);
  });

  it("fails closed if secrets.bin was encrypted with safeStorage but decryption is unavailable", () => {
    const encryptingStorage: SafeStorageAdapter = {
      isEncryptionAvailable: () => true,
      encryptString: (plain) => Buffer.from(plain, "utf8"),
      decryptString: (buf) => buf.toString("utf8"),
    };
    loadOrCreateDesktopSecrets(tmpDir, encryptingStorage);

    const unavailableStorage: SafeStorageAdapter = {
      isEncryptionAvailable: () => false,
      encryptString: () => Buffer.alloc(0),
      decryptString: () => "",
    };

    expect(() =>
      loadOrCreateDesktopSecrets(tmpDir, unavailableStorage),
    ).toThrow(/safeStorage decryption is currently unavailable/);
  });

  it("refuses plaintext keyring creation by default when safeStorage is unavailable, and warns when opted in", () => {
    const unavailableStorage: SafeStorageAdapter = {
      isEncryptionAvailable: () => false,
      encryptString: () => Buffer.alloc(0),
      decryptString: () => "",
    };

    expect(() =>
      loadOrCreateDesktopSecrets(tmpDir, unavailableStorage),
    ).toThrow(/Refusing to persist plaintext desktop secrets/);

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const secrets = loadOrCreateDesktopSecrets(tmpDir, unavailableStorage, {
        allowPlaintextFallback: true,
      });
      expect(isValidDesktopSecrets(secrets)).toBe(true);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("OS safeStorage encryption is unavailable"),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe("desktop/postgres-manager helpers", () => {
  let tmpPgDir: string;

  beforeEach(() => {
    tmpPgDir = fs.mkdtempSync(path.join(os.tmpdir(), "nango-desktop-pg-"));
  });

  afterEach(() => {
    fs.rmSync(tmpPgDir, { recursive: true, force: true });
  });

  it("parses postmaster.pid first line and cleans up stale lock files", () => {
    expect(
      parsePostmasterPid("43210\n/var/lib/postgresql/data\n1700000000\n5432\n"),
    ).toBe(43210);
    expect(parsePostmasterPid("invalid-pid\n")).toBeNull();

    const pidFile = path.join(tmpPgDir, "postmaster.pid");
    fs.writeFileSync(pidFile, "99999\n/pgdata\n", "utf8");

    // Dead PID -> removes postmaster.pid and returns true
    const cleaned = cleanStalePostmasterPid(tmpPgDir, () => false);
    expect(cleaned).toBe(true);
    expect(fs.existsSync(pidFile)).toBe(false);

    // Live PID -> throws error and preserves postmaster.pid
    fs.writeFileSync(pidFile, "88888\n/pgdata\n", "utf8");
    expect(() => cleanStalePostmasterPid(tmpPgDir, () => true)).toThrow(
      /PostgreSQL postmaster \(PID 88888\) is already running/,
    );
    expect(fs.existsSync(pidFile)).toBe(true);
  });

  it("validates PG_VERSION against expected major version 18", () => {
    expect(() => verifyPgVersion(tmpPgDir)).toThrow(/Missing PG_VERSION/);

    fs.writeFileSync(path.join(tmpPgDir, "PG_VERSION"), "18\n", "utf8");
    expect(() => verifyPgVersion(tmpPgDir)).not.toThrow();

    fs.writeFileSync(path.join(tmpPgDir, "PG_VERSION"), "16\n", "utf8");
    expect(() => verifyPgVersion(tmpPgDir)).toThrow(
      /Incompatible PostgreSQL data directory version.*found PG_VERSION=16, expected 18/,
    );
  });
});

describe("desktop/server-manager helpers", () => {
  let tmpUserDir: string;

  beforeEach(() => {
    tmpUserDir = fs.mkdtempSync(path.join(os.tmpdir(), "nango-desktop-srv-"));
  });

  afterEach(() => {
    fs.rmSync(tmpUserDir, { recursive: true, force: true });
  });

  it("creates writable directories and builds complete desktop server environment", () => {
    const workspaceDir = path.join(tmpUserDir, "NangoWorkspace");
    const dirs = ensureDesktopWritableDirs({
      userDataDir: tmpUserDir,
      workspaceDir,
    });

    expect(fs.existsSync(dirs.workspaceDir)).toBe(true);
    expect(fs.existsSync(dirs.datasourceCacheDir)).toBe(true);
    expect(fs.existsSync(dirs.playwrightStorageDir)).toBe(true);
    expect(fs.existsSync(dirs.logsDir)).toBe(true);

    const secrets = generateDesktopSecrets();
    const env = buildDesktopServerEnv({
      appPort: 9305,
      pgPort: 15433,
      betterAuthUrl: "http://127.0.0.1:9305",
      secrets,
      userDataDir: tmpUserDir,
      workspaceDir,
      bundledNodeExe: "/resources/node/bin/node",
      bundledNodeBinDir: "/resources/node/bin",
      duckdbExtensionDir: "/resources/duckdb-extensions",
      baseEnv: { PATH: "/usr/bin" },
    });

    expect(env.NANGO_DESKTOP).toBe("1");
    expect(env.NANGO_ALLOW_STDIO_MCP).toBe("true");
    expect(env.PORT).toBe("9305");
    expect(env.BETTER_AUTH_URL).toBe("http://127.0.0.1:9305");
    expect(env.POSTGRES_PORT).toBe("15433");
    expect(env.CREDENTIAL_ENCRYPTION_KEYRING).toBe(
      secrets.credentialEncryptionKeyring,
    );
    expect(env.CREDENTIAL_ENCRYPTION_ACTIVE_KEY_ID).toBe("k1");
    expect(env.NANGO_DEFAULT_HOST_FILE_ROOT).toBe(workspaceDir);
    expect(env.NANGO_DEFAULT_CACHE_ROOT).toBe(dirs.datasourceCacheDir);
    expect(env.NANGO_PLAYWRIGHT_STORAGE_DIR).toBe(dirs.playwrightStorageDir);
    expect(env.NANGO_BUNDLED_NODE_EXE).toBe("/resources/node/bin/node");
    expect(env.NANGO_BUNDLED_NODE_BIN_DIR).toBe("/resources/node/bin");
    expect(env.NANGO_DUCKDB_EXTENSION_DIR).toBe("/resources/duckdb-extensions");
    expect(env.NANGO_PGDATA_DIR).toBeUndefined();
    expect(DEFAULT_PG_READY_TIMEOUT_MS).toBe(45_000);
    expect(DEFAULT_SERVER_READY_TIMEOUT_MS).toBe(60_000);
  });

  it("computes exponential crash backoff delays (1s -> 2s -> 4s)", () => {
    expect(computeBackoffDelayMs(1)).toBe(1000);
    expect(computeBackoffDelayMs(2)).toBe(2000);
    expect(computeBackoffDelayMs(3)).toBe(4000);
  });
});

describe("desktop/preload, tray & main coordinator", () => {
  it("exposes window.nangoDesktop via contextBridge and routes selectFolder IPC", async () => {
    const exposed: Record<string, unknown> = {};
    const invokeMock = vi.fn(async (channel: string) => {
      if (channel === IPC_CHANNELS.SELECT_FOLDER) return "D:\\NangoWorkspace";
      if (channel === IPC_CHANNELS.GET_APP_VERSION) return "1.0.0";
      return null;
    });

    const bridge = registerPreloadBridge(
      {
        exposeInMainWorld: (key, api) => {
          exposed[key] = api;
        },
      },
      { invoke: invokeMock },
    );

    expect(exposed.nangoDesktop).toBeDefined();
    expect(await bridge.selectFolder()).toBe("D:\\NangoWorkspace");
    expect(await bridge.getAppVersion()).toBe("1.0.0");
  });

  it("intercepts window close to hide to tray while not quitting", () => {
    let closeHandler: ((event: { preventDefault(): void }) => void) | null =
      null;
    const hideMock = vi.fn();
    const showMock = vi.fn();
    const focusMock = vi.fn();
    const restoreMock = vi.fn();

    const fakeWin = {
      loadURL: vi.fn(async () => {}),
      show: showMock,
      hide: hideMock,
      focus: focusMock,
      isMinimized: () => true,
      restore: restoreMock,
      isDestroyed: () => false,
      on: (_event: "close" | "closed", listener: (e: { preventDefault(): void }) => void) => {
        closeHandler = listener;
      },
    };

    let quitting = false;
    bindCloseToTray(fakeWin, () => quitting);

    const preventDefault1 = vi.fn();
    closeHandler!({ preventDefault: preventDefault1 });
    expect(preventDefault1).toHaveBeenCalledTimes(1);
    expect(hideMock).toHaveBeenCalledTimes(1);

    // When quitting is true, close is allowed through
    quitting = true;
    const preventDefault2 = vi.fn();
    closeHandler!({ preventDefault: preventDefault2 });
    expect(preventDefault2).not.toHaveBeenCalled();

    showAndFocusMainWindow(fakeWin);
    expect(restoreMock).toHaveBeenCalledTimes(1);
    expect(showMock).toHaveBeenCalledTimes(1);
    expect(focusMock).toHaveBeenCalledTimes(1);

    const menuItems = buildTrayMenuTemplate({
      workspaceDir: "/workspace",
      logsDir: "/logs",
      shell: { openPath: vi.fn(async () => "") },
      getMainWindow: () => fakeWin,
      onRequestQuit: vi.fn(),
    });
    expect(menuItems.length).toBe(6);
  });

  it("resolves platform-specific bundled resource paths and enforces single-instance lock", async () => {
    const winPaths = resolveBundledResourcePaths("C:\\Program Files\\Nango\\resources", "win32");
    expect(winPaths.bundledNodeExe).toContain("node.exe");

    const macPaths = resolveBundledResourcePaths("/Applications/Nango.app/Contents/Resources", "darwin");
    expect(macPaths.bundledNodeExe).toBe(
      path.join("/Applications/Nango.app/Contents/Resources", "node", "bin", "node"),
    );

    const quitMock = vi.fn();
    const coordinator = new DesktopAppCoordinator({
      resourcesPath: "/resources",
      electron: {
        app: {
          requestSingleInstanceLock: () => false,
          quit: quitMock,
          getVersion: () => "1.0.0",
          getPath: () => "/tmp",
          whenReady: async () => {},
          on: vi.fn(),
        },
        BrowserWindow: vi.fn() as unknown as never,
        Tray: vi.fn() as unknown as never,
        Menu: { buildFromTemplate: vi.fn() },
        dialog: { showOpenDialog: vi.fn(), showErrorBox: vi.fn() },
        shell: { openPath: vi.fn(async () => "") },
        ipcMain: { handle: vi.fn() },
        safeStorage: {
          isEncryptionAvailable: () => false,
          encryptString: () => Buffer.alloc(0),
          decryptString: () => "",
        },
      },
    });

    const started = await coordinator.bootstrap();
    expect(started).toBe(false);
    expect(quitMock).toHaveBeenCalledTimes(1);
  });

  it("catches startup errors in bootstrap(), displays showErrorBox, and shuts down cleanly", async () => {
    const tmpUserData = fs.mkdtempSync(
      path.join(os.tmpdir(), "nango-desktop-boot-err-"),
    );
    try {
      const quitMock = vi.fn();
      const showErrorBoxMock = vi.fn();
      const coordinator = new DesktopAppCoordinator({
        resourcesPath: "/resources",
        electron: {
          app: {
            requestSingleInstanceLock: () => true,
            quit: quitMock,
            getVersion: () => "1.0.0",
            getPath: () => tmpUserData,
            whenReady: async () => {},
            on: vi.fn(),
          },
          BrowserWindow: vi.fn() as unknown as never,
          Tray: vi.fn() as unknown as never,
          Menu: { buildFromTemplate: vi.fn() },
          dialog: {
            showOpenDialog: vi.fn(),
            showErrorBox: showErrorBoxMock,
          },
          shell: { openPath: vi.fn(async () => "") },
          ipcMain: { handle: vi.fn() },
          safeStorage: {
            // Unavailable safeStorage causes loadOrCreateDesktopSecrets to throw during startup
            isEncryptionAvailable: () => false,
            encryptString: () => Buffer.alloc(0),
            decryptString: () => "",
          },
        },
      });

      const started = await coordinator.bootstrap();
      expect(started).toBe(false);
      expect(showErrorBoxMock).toHaveBeenCalledWith(
        "Nango 启动失败",
        expect.stringContaining("Refusing to persist plaintext desktop secrets"),
      );
      expect(quitMock).toHaveBeenCalledTimes(1);
    } finally {
      fs.rmSync(tmpUserData, { recursive: true, force: true });
    }
  });
});
