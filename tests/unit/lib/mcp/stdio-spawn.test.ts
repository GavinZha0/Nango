import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mockGetCredentialFieldsById = vi.fn();
const mockGetOAuthAccessToken = vi.fn();

vi.mock("@/lib/credentials/lookup", () => ({
  getCredentialFieldsById: (...args: unknown[]) =>
    mockGetCredentialFieldsById(...args),
}));

vi.mock("@/lib/credentials/oauth-token-manager", () => ({
  getOAuthAccessToken: (...args: unknown[]) => mockGetOAuthAccessToken(...args),
}));

import {
  assembleSafeChildEnv,
  buildMcpStdioEnv,
  DEFAULT_STDIO_CREDENTIAL_ENV_NAME,
  isStdioMcpAllowed,
} from "@/lib/mcp/stdio-spawn.server";
import { extractPnpmStoreComponent } from "../../../../scripts/repair-standalone.mjs";

describe("stdio-spawn.server — isStdioMcpAllowed", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.NANGO_DESKTOP;
    delete process.env.NANGO_ALLOW_STDIO_MCP;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("defaults to false when neither NANGO_DESKTOP nor NANGO_ALLOW_STDIO_MCP is set", () => {
    expect(isStdioMcpAllowed()).toBe(false);
  });

  it("returns true when NANGO_DESKTOP=1", () => {
    process.env.NANGO_DESKTOP = "1";
    expect(isStdioMcpAllowed()).toBe(true);
  });

  it("returns true when NANGO_ALLOW_STDIO_MCP=true or 1", () => {
    process.env.NANGO_ALLOW_STDIO_MCP = "true";
    expect(isStdioMcpAllowed()).toBe(true);

    process.env.NANGO_ALLOW_STDIO_MCP = "1";
    expect(isStdioMcpAllowed()).toBe(true);
  });

  it("allows explicit NANGO_ALLOW_STDIO_MCP=false to override NANGO_DESKTOP=1", () => {
    process.env.NANGO_DESKTOP = "1";
    process.env.NANGO_ALLOW_STDIO_MCP = "false";
    expect(isStdioMcpAllowed()).toBe(false);
  });
});

describe("stdio-spawn.server — assembleSafeChildEnv", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("does not leak server secrets from process.env into child environment", () => {
    process.env.CREDENTIAL_ENCRYPTION_KEYRING = "v1:secret-keyring";
    process.env.BETTER_AUTH_SECRET = "super-secret-auth";
    process.env.POSTGRES_PASSWORD = "pg-secret-password";

    const childEnv = assembleSafeChildEnv({ CUSTOM_FLAG: "enabled" });

    expect(childEnv.CREDENTIAL_ENCRYPTION_KEYRING).toBeUndefined();
    expect(childEnv.BETTER_AUTH_SECRET).toBeUndefined();
    expect(childEnv.POSTGRES_PASSWORD).toBeUndefined();
    expect(childEnv.CUSTOM_FLAG).toBe("enabled");
  });

  it("prepends NANGO_BUNDLED_NODE_BIN_DIR to PATH when configured", () => {
    const fakeBinDir =
      process.platform === "win32"
        ? "C:\\Program Files\\Nango\\resources\\node-bin"
        : "/Applications/Nango.app/Contents/Resources/node-bin";
    process.env.NANGO_BUNDLED_NODE_BIN_DIR = fakeBinDir;

    const childEnv = assembleSafeChildEnv();
    const pathKey =
      Object.keys(childEnv).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
    const pathValue = childEnv[pathKey] ?? "";

    expect(pathValue.startsWith(`${fakeBinDir}${path.delimiter}`) || pathValue === fakeBinDir).toBe(true);
  });
});

describe("stdio-spawn.server — buildMcpStdioEnv", () => {
  beforeEach(() => {
    mockGetCredentialFieldsById.mockReset();
    mockGetOAuthAccessToken.mockReset();
  });

  it("returns a copy of server.env when credentialId is null", async () => {
    const env = await buildMcpStdioEnv({
      env: { PLAYWRIGHT_HEADLESS: "1" },
      credentialId: null,
      credentialEnvName: null,
    });
    expect(env).toEqual({ PLAYWRIGHT_HEADLESS: "1" });
    expect(mockGetCredentialFieldsById).not.toHaveBeenCalled();
  });

  it("injects credential token into DEFAULT_STDIO_CREDENTIAL_ENV_NAME when credentialEnvName is null", async () => {
    mockGetCredentialFieldsById.mockResolvedValueOnce({
      type: "api_key",
      provider: "custom",
      fields: { token: "sec-token-123" },
    });

    const env = await buildMcpStdioEnv({
      env: { BASE_VAR: "abc" },
      credentialId: "cred-1",
      credentialEnvName: null,
    });

    expect(env).toEqual({
      BASE_VAR: "abc",
      [DEFAULT_STDIO_CREDENTIAL_ENV_NAME]: "sec-token-123",
    });
  });

  it("injects credential token into custom credentialEnvName when specified", async () => {
    mockGetCredentialFieldsById.mockResolvedValueOnce({
      type: "api_key",
      provider: "github",
      fields: { key: "ghp_secret" },
    });

    const env = await buildMcpStdioEnv({
      env: null,
      credentialId: "cred-2",
      credentialEnvName: "GITHUB_PERSONAL_ACCESS_TOKEN",
    });

    expect(env).toEqual({
      GITHUB_PERSONAL_ACCESS_TOKEN: "ghp_secret",
    });
  });
});

describe("repair-standalone — extractPnpmStoreComponent", () => {
  it("extracts package store component from POSIX and Windows relative symlink targets", () => {
    expect(
      extractPnpmStoreComponent(
        "../../@duckdb+node-api@2.0.0-r.1/node_modules/@duckdb/node-api",
      ),
    ).toBe("@duckdb+node-api@2.0.0-r.1");

    expect(
      extractPnpmStoreComponent(
        "..\\..\\@duckdb+node-bindings-win32-x64@2.0.0-r.1\\node_modules\\@duckdb\\node-bindings-win32-x64",
      ),
    ).toBe("@duckdb+node-bindings-win32-x64@2.0.0-r.1");

    expect(extractPnpmStoreComponent("./unrelated-file.js")).toBeNull();
  });
});
