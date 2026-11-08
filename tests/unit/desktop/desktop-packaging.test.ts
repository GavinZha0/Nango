import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  classifyMacSignTier,
  collectMacSignTargets,
  hasMachOMagic,
  notarizeAndStapleAppBundle,
  resolveMacSigningIdentity,
  runMacAfterSign,
} from "../../../desktop/scripts/after-sign.mjs";
import {
  collectDependencyTree,
  ensureDesktopIcons,
  stageUpdaterRuntimeDependencies,
} from "../../../desktop/scripts/stage-updater-runtime.mjs";
import {
  computeSha256Hex,
  DUCKDB_BUNDLED_EXTENSIONS,
  inspectMachOArchs,
  parseShasums256,
  pruneExtractedPostgresDir,
  resolveBinaryManifest,
  verifyMacBinaryArch,
  verifySha256,
} from "../../../desktop/scripts/fetch-binaries.mjs";
import { DesktopAppCoordinator } from "../../../desktop/main";
import {
  DesktopUpdateController,
  type AutoUpdaterLike,
  type UpdateState,
} from "../../../desktop/updater";
import {
  handleCopyError,
  stageStandaloneRuntimeAssets,
} from "../../../scripts/repair-standalone.mjs";
import { ensureStandaloneExtracted } from "../../../desktop/standalone-extractor";

describe("desktop/scripts/fetch-binaries.mjs", () => {
  it("resolves win32-x64, darwin-arm64, and darwin-x64 binary and DuckDB extension URLs", () => {
    const winManifest = resolveBinaryManifest({
      platform: "win32",
      arch: "x64",
      nodeVersion: "v24.22.2",
      pgVersion: "18.4-1",
      duckdbVersion: "v2.0.0",
    });
    expect(winManifest.targetKey).toBe("win32-x64");
    expect(winManifest.nodeArchiveUrl).toBe(
      "https://nodejs.org/dist/v24.22.2/node-v24.22.2-win-x64.zip",
    );
    expect(winManifest.pgArchiveUrl).toBe(
      "https://get.enterprisedb.com/postgresql/postgresql-18.4-1-windows-x64-binaries.zip",
    );
    expect(winManifest.duckdbPlatformSlug).toBe("windows_amd64");
    expect(winManifest.duckdbExtensions.map((e) => e.name)).toEqual(
      DUCKDB_BUNDLED_EXTENSIONS,
    );
    expect(winManifest.duckdbExtensions[0]?.url).toBe(
      "https://extensions.duckdb.org/v2.0.0/windows_amd64/postgres_scanner.duckdb_extension.gz",
    );

    const macArmManifest = resolveBinaryManifest({
      platform: "darwin",
      arch: "arm64",
    });
    expect(macArmManifest.duckdbPlatformSlug).toBe("osx_arm64");
    expect(macArmManifest.nodeArchiveUrl).toContain("darwin-arm64.tar.gz");
    expect(macArmManifest.pgArchiveUrl).toContain("-osx-binaries.zip");

    const macIntelManifest = resolveBinaryManifest({
      platform: "darwin",
      arch: "x64",
    });
    expect(macIntelManifest.duckdbPlatformSlug).toBe("osx_amd64");

    expect(() =>
      resolveBinaryManifest({ platform: "linux", arch: "ia32" }),
    ).toThrow(/Unsupported desktop packaging target/);
  });

  it("prunes non-runtime directories from extracted PostgreSQL tree while keeping bin/lib/share", () => {
    const tmpPg = fs.mkdtempSync(path.join(os.tmpdir(), "nango-pg-prune-"));
    try {
      for (const dir of [
        "bin",
        "lib",
        "share",
        "pgAdmin 4",
        "doc",
        "include",
        "symbols",
        "stackbuilder",
      ]) {
        fs.mkdirSync(path.join(tmpPg, dir), { recursive: true });
      }

      pruneExtractedPostgresDir(tmpPg);

      expect(fs.existsSync(path.join(tmpPg, "bin"))).toBe(true);
      expect(fs.existsSync(path.join(tmpPg, "lib"))).toBe(true);
      expect(fs.existsSync(path.join(tmpPg, "share"))).toBe(true);
      expect(fs.existsSync(path.join(tmpPg, "pgAdmin 4"))).toBe(false);
      expect(fs.existsSync(path.join(tmpPg, "doc"))).toBe(false);
      expect(fs.existsSync(path.join(tmpPg, "include"))).toBe(false);
      expect(fs.existsSync(path.join(tmpPg, "symbols"))).toBe(false);
      expect(fs.existsSync(path.join(tmpPg, "stackbuilder"))).toBe(false);
    } finally {
      fs.rmSync(tmpPg, { recursive: true, force: true });
    }
  });

  it("parses SHASUMS256.txt and verifies archive SHA-256 digests", () => {
    const payload = Buffer.from("nango-node-binary-payload", "utf8");
    const actualHex = computeSha256Hex(payload);

    const shasumsText = [
      `0000000000000000000000000000000000000000000000000000000000000000  node-v24.22.2-linux-x64.tar.xz`,
      `${actualHex} *node-v24.22.2-win-x64.zip`,
    ].join("\n");

    expect(
      parseShasums256(shasumsText, "node-v24.22.2-win-x64.zip"),
    ).toBe(actualHex);
    expect(parseShasums256(shasumsText, "nonexistent.zip")).toBeNull();

    expect(() =>
      verifySha256(payload, actualHex.toUpperCase(), "node.zip"),
    ).not.toThrow();
    expect(() =>
      verifySha256(
        payload,
        "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
        "node.zip",
      ),
    ).toThrow(/SHA-256 checksum mismatch/);
  });

  it("inspects single-arch and Universal/Fat Mach-O headers to guard macOS binary architecture", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nango-macho-arch-"));
    try {
      // 64-bit little-endian Mach-O (0xfeedfacf -> cf fa ed fe) with CPU_TYPE_ARM64 (0x0100000c)
      const arm64Buf = Buffer.alloc(16);
      arm64Buf.writeUInt32BE(0xcffaedfe, 0);
      arm64Buf.writeUInt32LE(0x0100000c, 4);
      expect(inspectMachOArchs(arm64Buf)).toEqual(["arm64"]);

      // 64-bit little-endian Mach-O with CPU_TYPE_X86_64 (0x01000007)
      const x64Buf = Buffer.alloc(16);
      x64Buf.writeUInt32BE(0xcffaedfe, 0);
      x64Buf.writeUInt32LE(0x01000007, 4);
      expect(inspectMachOArchs(x64Buf)).toEqual(["x64"]);

      // Universal/Fat Mach-O (0xcafebabe) containing both x64 and arm64 slices
      const fatBuf = Buffer.alloc(8 + 2 * 20);
      fatBuf.writeUInt32BE(0xcafebabe, 0);
      fatBuf.writeUInt32BE(2, 4); // nfat_arch = 2
      fatBuf.writeUInt32BE(0x01000007, 8); // slice 0: x64
      fatBuf.writeUInt32BE(0x0100000c, 28); // slice 1: arm64
      expect(inspectMachOArchs(fatBuf)).toEqual(["x64", "arm64"]);

      const arm64Bin = path.join(tmpDir, "postgres-arm64");
      const x64Bin = path.join(tmpDir, "postgres-x64");
      fs.writeFileSync(arm64Bin, arm64Buf);
      fs.writeFileSync(x64Bin, x64Buf);

      expect(() => verifyMacBinaryArch(arm64Bin, "arm64")).not.toThrow();
      expect(() => verifyMacBinaryArch(x64Bin, "arm64")).toThrow(
        /do not include target arch "arm64"/,
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("desktop/scripts/after-sign.mjs — Inside-Out Mach-O ordering", () => {
  let tmpResources: string;

  beforeEach(() => {
    tmpResources = fs.mkdtempSync(path.join(os.tmpdir(), "nango-mac-sign-"));
  });

  afterEach(() => {
    fs.rmSync(tmpResources, { recursive: true, force: true });
  });

  it("classifies shared libraries/addons as Tier 1 and bundled executables as Tier 2", () => {
    expect(classifyMacSignTier("/Resources/pg/lib/libpq.5.dylib")).toBe(1);
    expect(classifyMacSignTier("/Resources/pg/lib/postgresql/plpgsql.so")).toBe(1);
    expect(
      classifyMacSignTier(
        "/Resources/standalone/node_modules/@duckdb/node-bindings-darwin-arm64/duckdb.node",
      ),
    ).toBe(1);
    expect(
      classifyMacSignTier(
        "/Resources/duckdb-extensions/v2.0.0/osx_arm64/quack.duckdb_extension",
      ),
    ).toBe(1);

    expect(classifyMacSignTier("/Resources/pg/bin/postgres")).toBe(2);
    expect(classifyMacSignTier("/Resources/pg/bin/initdb")).toBe(2);
    expect(classifyMacSignTier("/Resources/node/bin/node")).toBe(2);
    expect(
      classifyMacSignTier("/Resources/pg/bin/pg_dump", {
        isExecutableMachO: true,
      }),
    ).toBe(2);

    expect(classifyMacSignTier("/Resources/standalone/server.js")).toBeNull();
  });

  it("detects Mach-O magic bytes (32-bit, 64-bit, Universal/Fat) while rejecting Java .class files", () => {
    const machO64 = Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0x0c, 0x00, 0x00, 0x01]);
    expect(hasMachOMagic(machO64)).toBe(true);

    const fatMachO = Buffer.from([0xca, 0xfe, 0xba, 0xbe, 0x00, 0x00, 0x00, 0x02]);
    expect(hasMachOMagic(fatMachO)).toBe(true);

    // Java .class file has 0xcafebabe followed by minor=0, major=52 (Java 8)
    const javaClass = Buffer.from([0xca, 0xfe, 0xba, 0xbe, 0x00, 0x00, 0x00, 0x34]);
    expect(hasMachOMagic(javaClass)).toBe(false);
  });

  it("collects all Tier 1 libraries before Tier 2 executables (including arbitrary Mach-O binaries in pg/bin)", () => {
    const filesToCreate = [
      "pg/bin/postgres",
      "pg/bin/initdb",
      "pg/lib/libpq.5.dylib",
      "pg/lib/postgresql/dict_snowball.so",
      "node/bin/node",
      "duckdb-extensions/v2.0.0/osx_arm64/quack.duckdb_extension",
      "standalone/node_modules/@duckdb/duckdb.node",
      "standalone/server.js",
    ];

    for (const rel of filesToCreate) {
      const full = path.join(tmpResources, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, "binary", "utf8");
    }

    // Write additional Mach-O binaries in pg/bin/ (pg_dump, pg_basebackup, pg_config)
    const machOHeader = Buffer.from([
      0xcf, 0xfa, 0xed, 0xfe, 0x0c, 0x00, 0x00, 0x01,
    ]);
    for (const extraBin of ["pg/bin/pg_dump", "pg/bin/pg_basebackup", "pg/bin/pg_config"]) {
      const full = path.join(tmpResources, extraBin);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, machOHeader);
    }

    const result = collectMacSignTargets(tmpResources);
    expect(result.tier1Libraries).toHaveLength(4);
    expect(result.tier2Executables).toHaveLength(6);
    expect(result.orderedTargets).toEqual([
      ...result.tier1Libraries,
      ...result.tier2Executables,
    ]);
  });

  it("archives .app via ditto into a .zip before calling xcrun notarytool submit and staples the .app", () => {
    const appDir = path.join(tmpResources, "Nango.app");
    const notarizeZipPath = path.join(tmpResources, "Nango-notarize.zip");
    fs.mkdirSync(appDir, { recursive: true });

    const invocations: Array<{ cmd: string; args: string[] }> = [];
    const fakeExecFile = (cmd: string, args: string[]) => {
      invocations.push({ cmd, args });
      if (cmd === "ditto") {
        const zipTarget = args[args.length - 1];
        if (zipTarget) {
          fs.writeFileSync(zipTarget, "fake-zip-bytes", "utf8");
        }
      }
      return Buffer.alloc(0);
    };

    notarizeAndStapleAppBundle({
      appBundlePath: appDir,
      notarizeZipPath,
      appleId: "dev@nango.ai",
      appleIdPassword: "app-specific-password",
      teamId: "TEAM123456",
      execSyncFn: fakeExecFile as unknown as typeof import("node:child_process").execFileSync,
    });

    expect(invocations).toHaveLength(3);
    expect(invocations[0]?.cmd).toBe("ditto");
    expect(invocations[0]?.args).toEqual([
      "-c",
      "-k",
      "--keepParent",
      appDir,
      notarizeZipPath,
    ]);

    expect(invocations[1]?.cmd).toBe("xcrun");
    expect(invocations[1]?.args).toContain("notarytool");
    expect(invocations[1]?.args).toContain("submit");
    expect(invocations[1]?.args).toContain(notarizeZipPath);
    expect(invocations[1]?.args).not.toContain(appDir);

    expect(invocations[2]?.cmd).toBe("xcrun");
    expect(invocations[2]?.args).toEqual(["stapler", "staple", appDir]);

    // Temporary notarization zip is cleaned up after submission
    expect(fs.existsSync(notarizeZipPath)).toBe(false);
  });

  it("fails fast on release builds when signing identity or notarization credentials are missing", async () => {
    const fakeContext = {
      electronPlatformName: "darwin",
      appOutDir: tmpResources,
      packager: {
        appInfo: {
          productFilename: "Nango",
        },
      },
    };

    // 1. Missing identity on release build (NANGO_REQUIRE_SIGNING="true") must throw
    await expect(
      runMacAfterSign({
        context: fakeContext,
        env: {
          NANGO_REQUIRE_SIGNING: "true",
        } as unknown as NodeJS.ProcessEnv,
      }),
    ).rejects.toThrow(/macOS release build requires code signing identity/);

    // 2. Missing identity on non-release build should gracefully skip
    await expect(
      runMacAfterSign({
        context: fakeContext,
        env: {} as unknown as NodeJS.ProcessEnv,
      }),
    ).resolves.toBeUndefined();

    // 3. Valid identity but missing Apple Notarization credentials on release build must throw
    const fakeCodesign = vi.fn();
    await expect(
      runMacAfterSign({
        context: fakeContext,
        env: {
          NANGO_REQUIRE_SIGNING: "true",
          CSC_NAME: "Developer ID Application: Nango Inc.",
        } as unknown as NodeJS.ProcessEnv,
        codesignFn: fakeCodesign,
      }),
    ).rejects.toThrow(/macOS release build requires Apple Notarization credentials/);
  });
});

describe("desktop/updater.ts — DesktopUpdateController", () => {
  it("runs prepareForInstall() graceful shutdown before quitAndInstall()", async () => {
    const listeners = new Map<string, (...args: unknown[]) => void>();
    const callOrder: string[] = [];

    const fakeUpdater: AutoUpdaterLike = {
      autoDownload: false,
      autoInstallOnAppQuit: true,
      on: (event, listener) => {
        listeners.set(event, listener);
      },
      checkForUpdates: vi.fn(async () => {
        listeners.get("update-available")?.({ version: "0.32.0" });
        listeners.get("update-downloaded")?.({ version: "0.32.0" });
      }),
      downloadUpdate: vi.fn(async () => {}),
      quitAndInstall: vi.fn(() => {
        callOrder.push("quitAndInstall");
      }),
    };

    const states: UpdateState[] = [];
    const controller = new DesktopUpdateController({
      updater: fakeUpdater,
      prepareForInstall: async () => {
        callOrder.push("prepareForInstall");
      },
      onStateChange: (s) => states.push(s),
    });

    expect(fakeUpdater.autoDownload).toBe(true);
    expect(fakeUpdater.autoInstallOnAppQuit).toBe(false);

    await expect(controller.installDownloadedUpdate()).rejects.toThrow(
      /Cannot install update when state is "idle"/,
    );

    const finalState = await controller.checkForUpdatesSafely();
    expect(finalState).toEqual({ status: "downloaded", version: "0.32.0" });

    await controller.installDownloadedUpdate();
    expect(callOrder).toEqual(["prepareForInstall", "quitAndInstall"]);
  });

  it("DesktopAppCoordinator exposes shutdownServicesOnly() for update pre-install without calling app.quit()", async () => {
    const quitFn = vi.fn();
    const coordinator = new DesktopAppCoordinator({
      electron: {
        app: {
          requestSingleInstanceLock: () => true,
          quit: quitFn,
          whenReady: async () => {},
          getPath: () => os.tmpdir(),
          getVersion: () => "0.31.0",
          on: () => {},
        },
        BrowserWindow: class {} as unknown as import("../../../desktop/electron-types").ElectronMainModule["BrowserWindow"],
        Tray: class {} as unknown as import("../../../desktop/electron-types").ElectronMainModule["Tray"],
        Menu: { buildFromTemplate: () => ({}) },
        dialog: {
          showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
          showErrorBox: () => {},
        },
        ipcMain: { handle: () => {} },
        shell: { openPath: async () => "" },
        safeStorage: {
          isEncryptionAvailable: () => true,
          encryptString: (s) => Buffer.from(s),
          decryptString: (b) => b.toString(),
        },
      },
      resourcesPath: os.tmpdir(),
    });

    await coordinator.shutdownServicesOnly();
    expect(quitFn).not.toHaveBeenCalled();

    await coordinator.shutdownAndQuit();
    expect(quitFn).toHaveBeenCalledTimes(1);
  });
});

describe("scripts/repair-standalone.mjs — stageStandaloneRuntimeAssets", () => {
  it("stages public, .next/static, migrations, and docker/migrate.mjs into standalone dir", () => {
    const tmpProject = fs.mkdtempSync(
      path.join(os.tmpdir(), "nango-stage-standalone-"),
    );
    try {
      const standaloneDir = path.join(tmpProject, ".next", "standalone");
      fs.mkdirSync(path.join(tmpProject, "public"), { recursive: true });
      fs.writeFileSync(path.join(tmpProject, "public", "logo.svg"), "<svg/>");

      fs.mkdirSync(path.join(tmpProject, ".next", "static", "chunks"), {
        recursive: true,
      });
      fs.writeFileSync(
        path.join(tmpProject, ".next", "static", "chunks", "main.js"),
        "// chunk",
      );

      fs.mkdirSync(path.join(tmpProject, "src", "lib", "db", "migrations"), {
        recursive: true,
      });
      fs.writeFileSync(
        path.join(
          tmpProject,
          "src",
          "lib",
          "db",
          "migrations",
          "0000_init.sql",
        ),
        "SELECT 1;",
      );

      fs.mkdirSync(path.join(tmpProject, "docker"), { recursive: true });
      fs.writeFileSync(
        path.join(tmpProject, "docker", "migrate.mjs"),
        "// migrate",
      );

      stageStandaloneRuntimeAssets(tmpProject, standaloneDir);

      expect(
        fs.existsSync(path.join(standaloneDir, "public", "logo.svg")),
      ).toBe(true);
      expect(
        fs.existsSync(
          path.join(standaloneDir, ".next", "static", "chunks", "main.js"),
        ),
      ).toBe(true);
      expect(
        fs.existsSync(
          path.join(
            standaloneDir,
            "src",
            "lib",
            "db",
            "migrations",
            "0000_init.sql",
          ),
        ),
      ).toBe(true);
      expect(
        fs.existsSync(path.join(standaloneDir, "docker", "migrate.mjs")),
      ).toBe(true);
    } finally {
      fs.rmSync(tmpProject, { recursive: true, force: true });
    }
  });

  it("handleCopyError ignores benign EEXIST and Windows native already-exists messages", () => {
    const stats = { failedCount: 0, sawWin32Eperm: false };

    // 1. Standard EEXIST code
    handleCopyError({ code: "EEXIST" }, stats, "sample");
    expect(stats.failedCount).toBe(0);

    // 2. Windows native message without error code
    handleCopyError(
      new Error(
        "Cannot create a file when that file already exists. '\\\\?\\D:\\AI\\nango\\.next\\standalone\\node_modules\\.pnpm\\pkg\\node_modules'",
      ),
      stats,
      "windows-symlink",
    );
    expect(stats.failedCount).toBe(0);

    // 3. Genuine fatal error (e.g. EACCES or ENOSPC) must increment failedCount
    handleCopyError({ code: "EACCES", message: "Permission denied" }, stats, "fatal");
    expect(stats.failedCount).toBe(1);
  });
});

describe("desktop/scripts/stage-updater-runtime.mjs — complete closure staging", () => {
  it("collects and stages all transitive production dependencies of electron-updater and tar", () => {
    const tmpTarget = fs.mkdtempSync(
      path.join(os.tmpdir(), "nango-stage-updater-"),
    );
    try {
      const updaterDeps = collectDependencyTree("electron-updater");
      const tarDeps = collectDependencyTree("tar");
      const deps = new Map([...updaterDeps, ...tarDeps]);
      expect(deps.size).toBeGreaterThanOrEqual(16);

      // Verify specific transitive modules named in review
      expect(deps.has("fs-extra")).toBe(true);
      expect(deps.has("lodash.isequal")).toBe(true);
      expect(deps.has("semver")).toBe(true);
      expect(deps.has("argparse")).toBe(true);
      expect(deps.has("builder-util-runtime")).toBe(true);
      expect(deps.has("lazy-val")).toBe(true);
      expect(deps.has("tiny-typed-emitter")).toBe(true);
      expect(deps.has("universalify")).toBe(true);
      expect(deps.has("graceful-fs")).toBe(true);
      expect(deps.has("jsonfile")).toBe(true);
      expect(deps.has("lodash.escaperegexp")).toBe(true);
      expect(deps.has("sax")).toBe(true);
      expect(deps.has("tar")).toBe(true);

      const result = stageUpdaterRuntimeDependencies({
        targetNodeModulesDir: tmpTarget,
      });

      expect(result.packageCount).toBe(deps.size);
      for (const reqDep of [
        "electron-updater",
        "tar",
        "fs-extra",
        "lodash.isequal",
        "semver",
        "argparse",
      ]) {
        expect(fs.existsSync(path.join(tmpTarget, reqDep, "package.json"))).toBe(
          true,
        );
      }
    } finally {
      fs.rmSync(tmpTarget, { recursive: true, force: true });
    }
  });

  it("resolves signing identity from CSC_NAME or security find-identity fallback", () => {
    expect(
      resolveMacSigningIdentity({
        CSC_NAME: "Developer ID Application: Nango Inc.",
      } as unknown as NodeJS.ProcessEnv),
    ).toBe("Developer ID Application: Nango Inc.");

    const fakeSecurityExec = vi.fn(() =>
      [
        '1) 1234567890ABCDEF "Developer ID Application: Auto Detected (TEAM123)"',
        "     1 valid identities found",
      ].join("\n"),
    );

    const detected = resolveMacSigningIdentity(
      {} as unknown as NodeJS.ProcessEnv,
      fakeSecurityExec as unknown as typeof import("node:child_process").execFileSync,
    );

    // On non-darwin OS it returns null unless on darwin, but passing fakeSecurityExec on darwin parses
    if (process.platform === "darwin") {
      expect(detected).toBe("Developer ID Application: Auto Detected (TEAM123)");
    } else {
      expect(detected).toBeNull();
    }
  });

  it("ensureDesktopIcons generates icon.ico, icon.png, tray.ico, and trayTemplate.png from public/logo.png", () => {
    const tmpProject = fs.mkdtempSync(
      path.join(os.tmpdir(), "nango-test-icons-"),
    );
    try {
      const publicDir = path.join(tmpProject, "public");
      fs.mkdirSync(publicDir, { recursive: true });

      // Create a dummy 1x1 PNG file
      const dummyPng = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
        "base64",
      );
      fs.writeFileSync(path.join(publicDir, "logo.png"), dummyPng);

      ensureDesktopIcons(tmpProject);

      const iconsDir = path.join(tmpProject, "desktop", "resources", "icons");
      expect(fs.existsSync(path.join(iconsDir, "icon.png"))).toBe(true);
      expect(fs.existsSync(path.join(iconsDir, "trayTemplate.png"))).toBe(true);
      expect(fs.existsSync(path.join(iconsDir, "icon.ico"))).toBe(true);
      expect(fs.existsSync(path.join(iconsDir, "tray.ico"))).toBe(true);

      const icoBuf = fs.readFileSync(path.join(iconsDir, "icon.ico"));
      expect(icoBuf.readUInt16LE(0)).toBe(0); // reserved
      expect(icoBuf.readUInt16LE(2)).toBe(1); // type 1 = icon
      expect(icoBuf.readUInt16LE(4)).toBe(1); // count = 1
    } finally {
      fs.rmSync(tmpProject, { recursive: true, force: true });
    }
  });

  it("stages tar runtime dependencies alongside electron-updater", () => {
    const tmpTarget = fs.mkdtempSync(
      path.join(os.tmpdir(), "nango-stage-tar-"),
    );
    try {
      const result = stageUpdaterRuntimeDependencies({
        targetNodeModulesDir: tmpTarget,
      });
      expect(result.stagedPackages).toContain("tar");
      expect(fs.existsSync(path.join(tmpTarget, "tar", "package.json"))).toBe(true);
    } finally {
      fs.rmSync(tmpTarget, { recursive: true, force: true });
    }
  });
});

describe("desktop/standalone-extractor.ts", () => {
  it("fast-paths when runtime .version matches appVersion without re-extracting", async () => {
    const tmpUser = fs.mkdtempSync(path.join(os.tmpdir(), "nango-extractor-fast-"));
    const tmpResources = fs.mkdtempSync(path.join(os.tmpdir(), "nango-extractor-res-"));
    try {
      const runtimeDir = path.join(tmpUser, "runtime", "standalone");
      fs.mkdirSync(runtimeDir, { recursive: true });
      fs.writeFileSync(path.join(runtimeDir, ".version"), "0.31.0", "utf8");

      const resolved = await ensureStandaloneExtracted({
        userDataDir: tmpUser,
        resourcesPath: tmpResources,
        appVersion: "0.31.0",
      });

      expect(resolved).toBe(runtimeDir);
    } finally {
      fs.rmSync(tmpUser, { recursive: true, force: true });
      fs.rmSync(tmpResources, { recursive: true, force: true });
    }
  });

  it("falls back to standalone directory if standalone.tar is absent (dev mode)", async () => {
    const tmpUser = fs.mkdtempSync(path.join(os.tmpdir(), "nango-extractor-dev-"));
    const tmpResources = fs.mkdtempSync(path.join(os.tmpdir(), "nango-extractor-dev-res-"));
    try {
      const devStandalone = path.join(tmpResources, "standalone");
      fs.mkdirSync(devStandalone, { recursive: true });

      const resolved = await ensureStandaloneExtracted({
        userDataDir: tmpUser,
        resourcesPath: tmpResources,
        appVersion: "0.31.0",
      });

      expect(resolved).toBe(devStandalone);
    } finally {
      fs.rmSync(tmpUser, { recursive: true, force: true });
      fs.rmSync(tmpResources, { recursive: true, force: true });
    }
  });
});
