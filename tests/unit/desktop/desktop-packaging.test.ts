import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  classifyMacSignTier,
  collectMacSignTargets,
} from "../../../desktop/scripts/after-sign.mjs";
import {
  DUCKDB_BUNDLED_EXTENSIONS,
  pruneExtractedPostgresDir,
  resolveBinaryManifest,
} from "../../../desktop/scripts/fetch-binaries.mjs";
import {
  DesktopUpdateController,
  type AutoUpdaterLike,
  type UpdateState,
} from "../../../desktop/updater";
import { stageStandaloneRuntimeAssets } from "../../../scripts/repair-standalone.mjs";

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

    expect(classifyMacSignTier("/Resources/standalone/server.js")).toBeNull();
  });

  it("collects all Tier 1 libraries before Tier 2 executables (Inside-Out order)", () => {
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

    const result = collectMacSignTargets(tmpResources);
    expect(result.tier1Libraries).toHaveLength(4);
    expect(result.tier2Executables).toHaveLength(3);
    expect(result.orderedTargets).toEqual([
      ...result.tier1Libraries,
      ...result.tier2Executables,
    ]);
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
});
