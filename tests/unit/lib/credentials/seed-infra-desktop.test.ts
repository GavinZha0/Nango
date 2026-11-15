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
    delete process.env.NANGO_SEED_SANDBOX_API_KEY;
    delete process.env.NANGO_SEED_SENSEVOICE_URL;
    delete process.env.NANGO_SEED_SENSEVOICE_API_KEY;
    delete process.env.NANGO_SEED_PLAYWRIGHT_MCP_URL;
    delete process.env.NANGO_ALLOW_STDIO_MCP;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("returns null seed values by default in both Docker and Desktop when NANGO_SEED_* vars are unset", () => {
    expect(resolveBuiltinInfraSeedValues()).toEqual({
      sandbox: null,
      senseVoice: null,
      playwrightMcp: null,
    });

    process.env.NANGO_DESKTOP = "1";
    expect(resolveBuiltinInfraSeedValues()).toEqual({
      sandbox: null,
      senseVoice: null,
      playwrightMcp: null,
    });
  });

  it("resolves infrastructure seed values only when NANGO_SEED_* env vars are explicitly provided", () => {
    process.env.NANGO_SEED_SANDBOX_URL = "http://sandbox:8194";
    process.env.NANGO_SEED_SANDBOX_API_KEY = "dify-sandbox";
    process.env.NANGO_SEED_SENSEVOICE_URL = "http://sensevoice:8000";
    process.env.NANGO_SEED_SENSEVOICE_API_KEY = "MySuperSafeApiKey";
    process.env.NANGO_SEED_PLAYWRIGHT_MCP_URL = "http://playwright:8931/mcp";

    expect(resolveBuiltinInfraSeedValues()).toEqual({
      sandbox: { url: "http://sandbox:8194", apiKey: "dify-sandbox" },
      senseVoice: { url: "http://sensevoice:8000", apiKey: "MySuperSafeApiKey" },
      playwrightMcp: {
        type: "http",
        url: "http://playwright:8931/mcp",
        command: null,
        args: null,
      },
    });
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
