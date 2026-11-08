import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { resolveDefaultConfigValue } from "@/lib/config/defaults";
import { resolveBuiltinInfraSeedValues } from "@/lib/credentials/seed-infra";
import { resolveCacheRoot } from "@/lib/data-sources/cache-root";
import { resolvePlaywrightOutputDir } from "@/lib/playwright/storage.server";

describe("Desktop runtime path & infrastructure seed resolution", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.NANGO_DESKTOP;
    delete process.env.NANGO_DEFAULT_HOST_FILE_ROOT;
    delete process.env.NANGO_DEFAULT_CACHE_ROOT;
    delete process.env.NANGO_PLAYWRIGHT_STORAGE_DIR;
    delete process.env.PLAYWRIGHT_OUTPUT_DIR;
    delete process.env.NANGO_SEED_SANDBOX_URL;
    delete process.env.NANGO_SEED_SENSEVOICE_URL;
    delete process.env.NANGO_BUNDLED_NODE_EXE;
    delete process.env.NANGO_BUNDLED_PLAYWRIGHT_MCP_CLI;
    delete process.env.NANGO_ALLOW_STDIO_MCP;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("resolves Docker infrastructure seed values by default", () => {
    const seed = resolveBuiltinInfraSeedValues();
    expect(seed).toEqual({
      sandboxUrl: "http://sandbox:8194",
      senseVoiceUrl: "http://sensevoice:8000",
      playwrightMcp: {
        type: "http",
        url: "http://playwright:8931/mcp",
        command: null,
        args: null,
      },
    });
  });

  it("resolves Desktop infrastructure seed values when NANGO_DESKTOP=1", () => {
    process.env.NANGO_DESKTOP = "1";
    const seed = resolveBuiltinInfraSeedValues();
    expect(seed).toEqual({
      sandboxUrl: "http://127.0.0.1:8194",
      senseVoiceUrl: "http://127.0.0.1:10085",
      playwrightMcp: {
        type: "stdio",
        url: "",
        command: "npx",
        args: ["-y", "@playwright/mcp@latest", "--browser", "chrome"],
      },
    });
  });

  it("uses bundled Node and pre-installed Playwright CLI in Desktop mode when provided", () => {
    process.env.NANGO_DESKTOP = "1";
    process.env.NANGO_BUNDLED_NODE_EXE = "C:\\Nango\\resources\\node\\node.exe";
    process.env.NANGO_BUNDLED_PLAYWRIGHT_MCP_CLI =
      "C:\\Nango\\resources\\mcp-playwright\\node_modules\\@playwright\\mcp\\cli.js";

    const seed = resolveBuiltinInfraSeedValues();
    expect(seed.playwrightMcp).toEqual({
      type: "stdio",
      url: "",
      command: "C:\\Nango\\resources\\node\\node.exe",
      args: [
        "C:\\Nango\\resources\\mcp-playwright\\node_modules\\@playwright\\mcp\\cli.js",
        "--browser",
        "chrome",
      ],
    });
  });

  it("skips seeding stdio Playwright MCP in Desktop mode when NANGO_ALLOW_STDIO_MCP=false", () => {
    process.env.NANGO_DESKTOP = "1";
    process.env.NANGO_ALLOW_STDIO_MCP = "false";

    const seed = resolveBuiltinInfraSeedValues();
    expect(seed.playwrightMcp).toBeNull();
  });

  it("honours NANGO_DEFAULT_HOST_FILE_ROOT and NANGO_DEFAULT_CACHE_ROOT in config defaults and resolveCacheRoot", () => {
    expect(resolveDefaultConfigValue("host.file.root")).toBe("/shared_folder");

    const customWorkspace = path.resolve("/tmp/NangoWorkspace");
    const customCache = path.resolve("/tmp/NangoCache");
    process.env.NANGO_DEFAULT_HOST_FILE_ROOT = customWorkspace;
    process.env.NANGO_DEFAULT_CACHE_ROOT = customCache;

    expect(resolveDefaultConfigValue("host.file.root")).toBe(customWorkspace);
    expect(resolveDefaultConfigValue("datasource.cache_root")).toBe(customCache);
    expect(resolveCacheRoot()).toBe(customCache);
  });

  it("honours NANGO_PLAYWRIGHT_STORAGE_DIR in resolvePlaywrightOutputDir", () => {
    const customPwDir = path.resolve("/tmp/NangoPlaywright");
    process.env.NANGO_PLAYWRIGHT_STORAGE_DIR = customPwDir;
    expect(resolvePlaywrightOutputDir()).toBe(customPwDir);
  });
});
