/**
 * One-shot local browser detection for Playwright / Chrome DevTools MCP install.
 *
 * Probes standard OS install locations for Google Chrome and Microsoft Edge so
 * the MCP Market install dialog can prefill `--browser chrome` or `--browser msedge`.
 */

import "server-only";

import { existsSync } from "node:fs";
import path from "node:path";

export type DetectedBrowserId = "chrome" | "msedge";

export interface LocalBrowserEnv {
  detected: DetectedBrowserId[];
  recommendedBrowser: DetectedBrowserId | null;
}

export interface DetectLocalBrowsersOptions {
  platform?: NodeJS.Platform;
  env?: Record<string, string | undefined>;
  exists?: (targetPath: string) => boolean;
}

function getBrowserCandidatePaths(
  platform: NodeJS.Platform,
  env: Record<string, string | undefined>,
): Record<DetectedBrowserId, string[]> {
  if (platform === "win32") {
    const programFiles = env.ProgramFiles || env.PROGRAMFILES || "C:\\Program Files";
    const programFilesX86 =
      env["ProgramFiles(x86)"] || env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)";
    const localAppData = env.LOCALAPPDATA || "";

    const chrome: string[] = [
      path.win32.join(programFiles, "Google", "Chrome", "Application", "chrome.exe"),
      path.win32.join(programFilesX86, "Google", "Chrome", "Application", "chrome.exe"),
    ];
    const msedge: string[] = [
      path.win32.join(programFilesX86, "Microsoft", "Edge", "Application", "msedge.exe"),
      path.win32.join(programFiles, "Microsoft", "Edge", "Application", "msedge.exe"),
    ];
    if (localAppData) {
      chrome.push(
        path.win32.join(localAppData, "Google", "Chrome", "Application", "chrome.exe"),
      );
      msedge.push(
        path.win32.join(localAppData, "Microsoft", "Edge", "Application", "msedge.exe"),
      );
    }
    return { chrome, msedge };
  }

  if (platform === "darwin") {
    const home = env.HOME || "";
    const chrome = [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      ...(home
        ? [`${home}/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`]
        : []),
    ];
    const msedge = [
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      ...(home
        ? [`${home}/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge`]
        : []),
    ];
    return { chrome, msedge };
  }

  // Linux
  return {
    chrome: [
      "/usr/bin/google-chrome",
      "/usr/bin/google-chrome-stable",
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
      "/snap/bin/chromium",
    ],
    msedge: ["/usr/bin/microsoft-edge", "/usr/bin/microsoft-edge-stable"],
  };
}

/**
 * Probe local Chrome and Edge installation paths.
 */
export function detectLocalBrowsers(
  opts: DetectLocalBrowsersOptions = {},
): LocalBrowserEnv {
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  const checkExists =
    opts.exists ?? ((p: string) => existsSync(/*turbopackIgnore: true*/ p));

  const candidates = getBrowserCandidatePaths(platform, env);
  const detected: DetectedBrowserId[] = [];

  for (const id of ["chrome", "msedge"] as const) {
    if (candidates[id].some((p) => checkExists(p))) {
      detected.push(id);
    }
  }

  const recommendedBrowser: DetectedBrowserId | null = detected.includes("chrome")
    ? "chrome"
    : detected.includes("msedge")
      ? "msedge"
      : null;

  return { detected, recommendedBrowser };
}
