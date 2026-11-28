import * as fs from "node:fs";
import * as os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let mockHostRoot: string | null = null;

vi.mock("@/lib/host-files/jail.server", () => ({
  getHostFileRoot: () => mockHostRoot,
}));

import { detectLocalBrowsers } from "@/lib/playwright/browser-detect.server";
import {
  applyPlaywrightStdioDefaults,
  assembleSafeChildEnv,
  isPlaywrightMcpStdio,
} from "@/lib/mcp/stdio-spawn.server";

describe("detectLocalBrowsers", () => {
  it("prefers chrome when both Chrome and Edge are installed on Windows", () => {
    const res = detectLocalBrowsers({
      platform: "win32",
      env: {
        ProgramFiles: "C:\\Program Files",
        "ProgramFiles(x86)": "C:\\Program Files (x86)",
      },
      exists: (p) =>
        p === "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
        || p === "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    });

    expect(res.detected).toEqual(["chrome", "msedge"]);
    expect(res.recommendedBrowser).toBe("chrome");
  });

  it("recommends msedge when only Edge is installed on Windows", () => {
    const res = detectLocalBrowsers({
      platform: "win32",
      env: {
        ProgramFiles: "C:\\Program Files",
        "ProgramFiles(x86)": "C:\\Program Files (x86)",
      },
      exists: (p) =>
        p === "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    });

    expect(res.detected).toEqual(["msedge"]);
    expect(res.recommendedBrowser).toBe("msedge");
  });

  it("returns null recommendation when no supported browser is found", () => {
    const res = detectLocalBrowsers({
      platform: "darwin",
      env: { HOME: "/Users/dev" },
      exists: () => false,
    });

    expect(res.detected).toEqual([]);
    expect(res.recommendedBrowser).toBeNull();
  });
});

describe("Playwright stdio alignment & safe proxy forwarding", () => {
  let tmpRoot: string;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nango-pw-mcp-"));
    mockHostRoot = tmpRoot;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    mockHostRoot = null;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("identifies @playwright/mcp stdio commands", () => {
    expect(isPlaywrightMcpStdio("npx", ["-y", "@playwright/mcp@latest"])).toBe(true);
    expect(isPlaywrightMcpStdio("npx", ["-y", "@modelcontextprotocol/server-github"])).toBe(false);
  });

  it("injects --output-dir and cwd pointing to <host.file.root>/playwright when absent", () => {
    const res = applyPlaywrightStdioDefaults({
      command: "npx",
      args: ["-y", "@playwright/mcp@latest", "--browser", "chrome"],
      cwd: undefined,
    });

    const expectedDir = path.join(path.resolve(tmpRoot), "playwright");
    expect(res.cwd).toBe(expectedDir);
    expect(res.args).toContain("--output-dir");
    expect(res.args).toContain(expectedDir);
    expect(fs.existsSync(expectedDir)).toBe(true);
  });

  it("preserves explicit --output-dir and cwd when already configured", () => {
    const customDir = path.join(tmpRoot, "custom");
    const res = applyPlaywrightStdioDefaults({
      command: "npx",
      args: ["-y", "@playwright/mcp@latest", "--output-dir", customDir],
      cwd: customDir,
    });

    expect(res.cwd).toBe(customDir);
    expect(res.args).toEqual(["-y", "@playwright/mcp@latest", "--output-dir", customDir]);
  });

  it("forwards credential-free proxy vars while refusing embedded credentials", () => {
    process.env.HTTP_PROXY = "http://127.0.0.1:7890";
    process.env.HTTPS_PROXY = "http://user:secret@proxy.corp:8080";
    process.env.NO_PROXY = "127.0.0.1,localhost";

    const env = assembleSafeChildEnv();
    expect(env.HTTP_PROXY).toBe("http://127.0.0.1:7890");
    expect(env.HTTPS_PROXY).toBeUndefined();
    expect(env.NO_PROXY).toBe("127.0.0.1,localhost");
  });
});
