/**
 * Cross-platform shell resolution for local command execution.
 *
 * Ensures deterministic UTF-8 output on Windows PowerShell and CMD so
 * CJK text and JSON outputs never arrive garbled.
 */

import "server-only";

import { existsSync } from "node:fs";
import path from "node:path";

import type { LocalShellKind } from "./schema";

export interface ResolvedShellInvocation {
  bin: string;
  args: string[];
  resolvedShell: string;
}

const POWERSHELL_UTF8_PREAMBLE =
  "[Console]::InputEncoding = [Console]::OutputEncoding = $OutputEncoding = [System.Text.UTF8Encoding]::new($false); $global:LASTEXITCODE = $null\n";
const POWERSHELL_EXIT_EPILOGUE =
  "\nif ($null -ne $LASTEXITCODE) { exit $LASTEXITCODE }";

let cachedWinPwsh: string | null | undefined;

function findExecutableOnPath(
  name: string,
  envPath: string,
  isWin: boolean,
): string | null {
  const dirs = envPath
    .split(isWin ? ";" : path.delimiter)
    .map((d) => d.trim())
    .filter(Boolean);
  const exts = isWin ? [".exe", ".cmd", ".bat", ""] : [""];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, name.endsWith(ext) ? name : `${name}${ext}`);
      try {
        if (existsSync(/*turbopackIgnore: true*/ candidate)) {
          return candidate;
        }
      } catch {
        // Ignore unreadable PATH entries
      }
    }
  }
  return null;
}

function resolveWindowsPowerShell(envPath: string): { bin: string; label: string } {
  if (cachedWinPwsh === undefined) {
    cachedWinPwsh = findExecutableOnPath("pwsh", envPath, true);
  }
  if (cachedWinPwsh) {
    return { bin: cachedWinPwsh, label: "pwsh" };
  }
  return { bin: "powershell.exe", label: "powershell" };
}

/** Reset cached pwsh detection (for unit tests). */
export function _resetShellDetectCache(): void {
  cachedWinPwsh = undefined;
}

export interface ResolveShellOptions {
  platform?: NodeJS.Platform;
  env?: Record<string, string | undefined>;
}

/**
 * Translate `(command, shell)` into an executable binary + argv array.
 */
export function resolveShellInvocation(
  command: string,
  shell: LocalShellKind = "auto",
  opts: ResolveShellOptions = {},
): ResolvedShellInvocation {
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  const isWin = platform === "win32";
  const pathKey =
    Object.keys(env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
  const envPath = env[pathKey] ?? "";

  if (isWin) {
    if (shell === "cmd") {
      const comspec = env.COMSPEC?.trim() || "cmd.exe";
      return {
        bin: comspec,
        args: ["/d", "/s", "/c", `chcp 65001 >nul & ${command}`],
        resolvedShell: "cmd",
      };
    }
    if (shell === "bash" || shell === "zsh" || shell === "sh") {
      return {
        bin: shell,
        args: ["-c", command],
        resolvedShell: shell,
      };
    }
    const ps = resolveWindowsPowerShell(envPath);
    return {
      bin: ps.bin,
      args: [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `${POWERSHELL_UTF8_PREAMBLE}${command}${POWERSHELL_EXIT_EPILOGUE}`,
      ],
      resolvedShell: ps.label,
    };
  }

  // POSIX (macOS / Linux)
  if (shell === "powershell") {
    return {
      bin: "pwsh",
      args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command],
      resolvedShell: "pwsh",
    };
  }
  if (shell === "bash" || shell === "zsh" || shell === "sh") {
    return {
      bin: shell,
      args: ["-c", command],
      resolvedShell: shell,
    };
  }
  if (shell === "cmd") {
    return {
      bin: "/bin/sh",
      args: ["-c", command],
      resolvedShell: "sh",
    };
  }

  // "auto" on POSIX: honour SHELL if valid, else platform default
  const envShell = env.SHELL?.trim();
  if (envShell && existsSync(/*turbopackIgnore: true*/ envShell)) {
    return {
      bin: envShell,
      args: ["-c", command],
      resolvedShell: path.basename(envShell),
    };
  }

  const fallbacks =
    platform === "darwin"
      ? ["/bin/zsh", "/bin/bash", "/bin/sh"]
      : ["/bin/bash", "/bin/sh"];
  for (const candidate of fallbacks) {
    if (existsSync(/*turbopackIgnore: true*/ candidate)) {
      return {
        bin: candidate,
        args: ["-c", command],
        resolvedShell: path.basename(candidate),
      };
    }
  }

  return {
    bin: "sh",
    args: ["-c", command],
    resolvedShell: "sh",
  };
}
