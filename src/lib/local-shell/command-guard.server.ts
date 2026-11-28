/**
 * Pre-execution security guard for local shell commands and working directories.
 *
 * SECURITY: Blocks direct attempts to inspect `.env` files, Nango's own
 * secret storage (`secrets.bin` / `pgdata`), host credential stores, and
 * OS-level environment bypasses (Windows Registry env lookups, `/proc/environ`).
 */

import "server-only";

import { realpath, stat } from "node:fs/promises";
import path from "node:path";

import { getConfigBoolean } from "@/lib/config";
import { getHostFileRoot, isWithin } from "@/lib/host-files/jail.server";

import type { LocalShellErr } from "./schema";

export type CommandGuardResult =
  | { allowed: true }
  | { allowed: false; rule: string; reason: string };

interface SensitiveRule {
  id: string;
  pattern: RegExp;
  reason: string;
}

// Match `.env` and `.env.<suffix>` except safe template suffixes
// (`.env.example`, `.env.sample`, `.env.template`, `.env.dist`).
const DOTENV_ACCESS_RE =
  /(?:^|[\s"'`=;:,/\\(])\.env(?:\.(?!(?:example|sample|template|dist)\b)[a-zA-Z0-9._-]+)?(?=$|[\s"'`;|&>)\]}])/i;

const SENSITIVE_COMMAND_RULES: readonly SensitiveRule[] = [
  {
    id: "DOTENV_FILE",
    pattern: DOTENV_ACCESS_RE,
    reason:
      "Access to `.env` files is blocked to protect application and API secrets.",
  },
  {
    id: "NANGO_SECRET_STORE",
    pattern:
      /(?:^|[\s"'`/\\])secrets\.bin\b|\bCREDENTIAL_ENCRYPTION_KEYRING\b|\bBETTER_AUTH_SECRET\b|\bPOSTGRES_PASSWORD\b/i,
    reason:
      "Access to Nango internal secret files or master keys is blocked.",
  },
  {
    id: "WINDOWS_REGISTRY_ENV_BYPASS",
    pattern:
      /\bGetEnvironmentVariables?\b|HKCU:?\\Environment\b|HKLM:?\\[^\s"'`]*\\Environment\b|HKEY_CURRENT_USER\\Environment\b|HKEY_LOCAL_MACHINE\\[^\s"'`]*\\Environment\b|\breg(?:\.exe)?\s+query\b[^\n;|&]*\bEnvironment\b/i,
    reason:
      "Reading user or machine environment variables from the Windows Registry is blocked.",
  },
  {
    id: "PROC_ENVIRON_BYPASS",
    pattern: /\/proc\/(?:\d+|self|thread-self)\/environ\b|\/etc\/shadow\b/i,
    reason:
      "Reading process environment files (`/proc/*/environ`) or `/etc/shadow` is blocked.",
  },
  {
    id: "HOST_CREDENTIAL_FILES",
    pattern:
      /(?:^|[\s"'`/\\])(?:\.ssh[/\\]id_[a-z0-9._-]+|\.aws[/\\]credentials|\.netrc|\.npmrc|\.pypirc|\.docker[/\\]config\.json|\.git-credentials|login\.keychain(?:-db)?)\b/i,
    reason:
      "Direct access to host credential stores (SSH private keys, AWS credentials, .npmrc, .netrc, Docker config, keychain) is blocked.",
  },
  {
    id: "SENSITIVE_ENV_VAR_PROBE",
    pattern:
      /(?:\$env:|\$\{?|%)(?:OPENAI_API_KEY|ANTHROPIC_API_KEY|GEMINI_API_KEY|GOOGLE_API_KEY|DEEPSEEK_API_KEY|GROQ_API_KEY|XAI_API_KEY|OPENROUTER_API_KEY|AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN|GITHUB_TOKEN|GH_TOKEN|GITLAB_TOKEN|STRIPE_SECRET_KEY|DATABASE_URL|CREDENTIAL_ENCRYPTION_KEYRING|BETTER_AUTH_SECRET|POSTGRES_PASSWORD)\b/i,
    reason:
      "Directly probing sensitive API keys or secret environment variables is blocked.",
  },
];

/**
 * Inspect a command string against pre-execution secret-access guard rules.
 */
export function checkSensitiveCommand(command: string): CommandGuardResult {
  for (const rule of SENSITIVE_COMMAND_RULES) {
    if (rule.pattern.test(command)) {
      return {
        allowed: false,
        rule: rule.id,
        reason: rule.reason,
      };
    }
  }
  return { allowed: true };
}

export interface ResolveCwdOptions {
  /** Override configured `host.file.root` (tests). */
  hostFileRoot?: string | null;
  /** Override `host.shell.allow_any_cwd` (tests). */
  allowAnyCwd?: boolean;
  /** Override forbidden Nango userData directory (tests). */
  desktopUserDataDir?: string | null;
  /** Override app root directory (tests). */
  appRootDir?: string | null;
}

/**
 * Infer the desktop `userData` directory (holding `secrets.bin` and `pgdata`)
 * from desktop-injected env vars when running inside Nango Desktop.
 */
function inferDesktopUserDataDir(): string | null {
  const cacheRoot = process.env.NANGO_DEFAULT_CACHE_ROOT?.trim();
  if (cacheRoot) {
    // Desktop sets NANGO_DEFAULT_CACHE_ROOT = <userData>/cache/datasource
    return path.resolve(cacheRoot, "..", "..");
  }
  const pgData = process.env.NANGO_PGDATA_DIR?.trim();
  if (pgData) {
    return path.resolve(pgData, "..");
  }
  return null;
}

function normCase(p: string): string {
  const resolved = path.resolve(p);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/**
 * Validate and resolve the working directory for a local shell invocation.
 *
 * SECURITY: Always forbids running inside Nango's desktop `userData` directory
 * (`secrets.bin` / `pgdata`) and Nango's own application root (holding `.env`),
 * except when the target lives inside the operator-configured `host.file.root`.
 */
export async function validateLocalShellCwd(
  rawCwd: string | undefined,
  opts: ResolveCwdOptions = {},
): Promise<{ ok: true; cwd: string } | LocalShellErr> {
  const hostRoot =
    opts.hostFileRoot !== undefined ? opts.hostFileRoot : getHostFileRoot();
  const allowAnyCwd =
    opts.allowAnyCwd ??
    getConfigBoolean("host.shell.allow_any_cwd", process.env.NANGO_DESKTOP === "1");

  let candidate: string;
  if (!rawCwd || rawCwd.trim().length === 0) {
    if (!hostRoot) {
      return {
        ok: false,
        error: "CWD_NOT_FOUND",
        message:
          "No `cwd` was supplied and `host.file.root` is not configured. " +
          "Set `host.file.root` in Admin → Config or pass an explicit `cwd`.",
      };
    }
    candidate = hostRoot;
  } else {
    const trimmed = rawCwd.trim();
    if (trimmed.includes("\0")) {
      return {
        ok: false,
        error: "INVALID_CWD",
        message: "Working directory contains a NUL byte.",
      };
    }
    if (path.isAbsolute(trimmed)) {
      candidate = trimmed;
    } else {
      if (!hostRoot) {
        return {
          ok: false,
          error: "CWD_NOT_FOUND",
          message:
            `Relative cwd "${trimmed}" requires \`host.file.root\` to be configured.`,
        };
      }
      candidate = path.resolve(hostRoot, trimmed);
    }
  }

  let realTarget: string;
  try {
    realTarget = await realpath(/*turbopackIgnore: true*/ candidate);
    const st = await stat(/*turbopackIgnore: true*/ realTarget);
    if (!st.isDirectory()) {
      return {
        ok: false,
        error: "INVALID_CWD",
        message: `Working directory "${candidate}" is not a directory.`,
      };
    }
  } catch {
    return {
      ok: false,
      error: "CWD_NOT_FOUND",
      message: `Working directory "${candidate}" does not exist or is inaccessible.`,
    };
  }

  let realHostRoot: string | null = null;
  if (hostRoot) {
    try {
      realHostRoot = await realpath(/*turbopackIgnore: true*/ hostRoot);
    } catch {
      realHostRoot = null;
    }
  }

  if (!allowAnyCwd) {
    if (!realHostRoot || !isWithin(realHostRoot, realTarget)) {
      return {
        ok: false,
        error: "INVALID_CWD",
        message:
          `Working directory "${candidate}" is outside \`host.file.root\`. ` +
          "Enable `host.shell.allow_any_cwd` in Admin → Config to run outside the workspace folder.",
      };
    }
  }

  const insideConfiguredHostRoot =
    realHostRoot !== null && isWithin(realHostRoot, realTarget);

  // SECURITY: Block Nango's desktop userData directory (contains secrets.bin & pgdata).
  const rawUserData =
    opts.desktopUserDataDir !== undefined
      ? opts.desktopUserDataDir
      : inferDesktopUserDataDir();
  if (rawUserData && !insideConfiguredHostRoot) {
    try {
      const realUserData = await realpath(/*turbopackIgnore: true*/ rawUserData);
      if (isWithin(realUserData, realTarget)) {
        return {
          ok: false,
          error: "SENSITIVE_ACCESS_DENIED",
          rule: "NANGO_USER_DATA_DIR",
          message:
            "Cannot execute local commands inside Nango's application data directory (`secrets.bin` / `pgdata`).",
        };
      }
    } catch {
      // Directory does not exist; ignore
    }
  }

  // SECURITY: Block Nango's own application root (contains `.env` in dev/Docker
  // and standalone runtime files in desktop) unless inside `host.file.root`.
  const rawAppRoot =
    opts.appRootDir !== undefined ? opts.appRootDir : process.cwd();
  if (rawAppRoot && !insideConfiguredHostRoot) {
    try {
      const realAppRoot = await realpath(/*turbopackIgnore: true*/ rawAppRoot);
      if (normCase(realTarget) === normCase(realAppRoot)) {
        return {
          ok: false,
          error: "SENSITIVE_ACCESS_DENIED",
          rule: "NANGO_APP_ROOT",
          message:
            "Cannot execute local commands directly inside Nango's own application directory (contains `.env` and runtime files).",
        };
      }
    } catch {
      // Ignore
    }
  }

  return { ok: true, cwd: realTarget };
}
