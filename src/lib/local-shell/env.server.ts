/**
 * Strict environment-variable allowlist for local shell subprocesses.
 *
 * SECURITY: Never spreads `process.env` into spawned child processes.
 * Only minimal OS runtime variables (plus explicitly admin-allowlisted
 * non-sensitive keys) are forwarded so host secrets such as
 * `OPENAI_API_KEY`, `CREDENTIAL_ENCRYPTION_KEYRING`, `BETTER_AUTH_SECRET`,
 * and `POSTGRES_PASSWORD` never enter the child environment.
 */

import "server-only";

import path from "node:path";

import { getConfig } from "@/lib/config";

const POSIX_BASE_ALLOWLIST = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TERM",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "TMPDIR",
  "TMP",
  "TEMP",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
  "XDG_RUNTIME_DIR",
] as const;

const WINDOWS_BASE_ALLOWLIST = [
  "SystemRoot",
  "SYSTEMDRIVE",
  "COMSPEC",
  "PATHEXT",
  "WINDIR",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "APPDATA",
  "LOCALAPPDATA",
  "PROGRAMDATA",
  "PROGRAMFILES",
  "PROGRAMFILES(X86)",
  "COMMONPROGRAMFILES",
  "COMMONPROGRAMFILES(X86)",
  "OS",
  "NUMBER_OF_PROCESSORS",
  "PROCESSOR_ARCHITECTURE",
  "PSModulePath",
] as const;

export const BASE_ENV_ALLOWLIST_UPPER: ReadonlySet<string> = new Set(
  [...POSIX_BASE_ALLOWLIST, ...WINDOWS_BASE_ALLOWLIST].map((k) =>
    k.toUpperCase(),
  ),
);

/**
 * SECURITY: Key names matching these patterns are ALWAYS refused in
 * `host.shell.env_passthrough` and harvested for output redaction.
 */
const FORBIDDEN_ENV_NAME_PATTERNS: readonly RegExp[] = [
  /(?:^|_)(?:KEY|KEYS|SECRET|SECRETS|TOKEN|TOKENS|PASSWORD|PASSWD|PWD|CREDENTIAL|CREDENTIALS|AUTH|PRIVATE|COOKIE|SESSION|JWT|BEARER|CERT|SIGNATURE|SIGNING|KEYRING|DSN|CONNSTR|CONNECTION_STRING)(?:$|_)/i,
  /^(?:NANGO_|POSTGRES_|PGPASSWORD|BETTER_AUTH_|CREDENTIAL_|DATABASE_URL$|REDIS_URL$|LANGFUSE_|OPENAI_|ANTHROPIC_|GEMINI_|GOOGLE_API_|DEEPSEEK_|GROQ_|XAI_|OPENROUTER_|TAVILY_|BRAVE_|EXA_|JINA_|DEEPGRAM_|SENSEVOICE_|AWS_|AZURE_|GCP_|GITHUB_|GITLAB_|SLACK_|FEISHU_|DINGTALK_|STRIPE_)/i,
];

/**
 * Returns true if an environment variable name is considered sensitive and
 * must never be forwarded to a local shell subprocess.
 */
export function isForbiddenEnvKey(key: string): boolean {
  const trimmed = key.trim();
  if (trimmed.length === 0) return true;
  if (BASE_ENV_ALLOWLIST_UPPER.has(trimmed.toUpperCase())) return false;
  return FORBIDDEN_ENV_NAME_PATTERNS.some((re) => re.test(trimmed));
}

/**
 * Parse comma-separated extra variable names from `host.shell.env_passthrough`,
 * dropping any blank entries or forbidden secret variable names.
 */
export function parseEnvPassthroughKeys(raw: string): string[] {
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0 && !isForbiddenEnvKey(entry));
}

export interface BuildSafeLocalEnvOptions {
  /** Override parent environment (primarily for unit tests). */
  sourceEnv?: Record<string, string | undefined>;
  /** Override platform (primarily for unit tests). */
  platform?: NodeJS.Platform;
  /** Override `host.shell.env_passthrough` config value (for tests). */
  passthroughRaw?: string;
}

/**
 * Construct a clean, minimal environment map for `execa(..., { extendEnv: false })`.
 */
export function buildSafeLocalEnv(
  opts: BuildSafeLocalEnvOptions = {},
): Record<string, string> {
  const sourceEnv = opts.sourceEnv ?? process.env;
  const platform = opts.platform ?? process.platform;
  const isWin = platform === "win32";

  const passthroughRaw =
    opts.passthroughRaw ?? getConfig("host.shell.env_passthrough", "");
  const passthroughUpper = new Set(
    parseEnvPassthroughKeys(passthroughRaw).map((k) => k.toUpperCase()),
  );

  const env: Record<string, string> = {};
  const allowKeys: readonly string[] = isWin
    ? [...POSIX_BASE_ALLOWLIST, ...WINDOWS_BASE_ALLOWLIST]
    : POSIX_BASE_ALLOWLIST;
  const allowUpper = new Set(allowKeys.map((k) => k.toUpperCase()));

  for (const [k, v] of Object.entries(sourceEnv)) {
    if (typeof v !== "string") continue;
    const upper = k.toUpperCase();
    if (allowUpper.has(upper) || passthroughUpper.has(upper)) {
      env[k] = v;
    }
  }

  // Prepend bundled Node binary dir in desktop mode so `node`/`npx` work
  // even when the host has no global Node installation.
  const bundledNodeBin = sourceEnv.NANGO_BUNDLED_NODE_BIN_DIR?.trim();
  if (bundledNodeBin) {
    const pathKey =
      Object.keys(env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
    const existingPath = env[pathKey] ?? "";
    const sep = isWin ? ";" : path.delimiter;
    env[pathKey] = existingPath
      ? `${bundledNodeBin}${sep}${existingPath}`
      : bundledNodeBin;
  }

  // Deterministic UTF-8 and non-interactive defaults for agent-driven CLI runs.
  env.PYTHONIOENCODING = "utf-8";
  env.PYTHONUTF8 = "1";
  env.NO_COLOR = "1";
  env.CI = "true";
  env.GIT_TERMINAL_PROMPT = "0";

  return env;
}

const MIN_SECRET_VALUE_LEN = 8;

/**
 * Collect exact sensitive values held in the parent process environment so
 * output redaction can scrub them if any command indirectly reads them from
 * disk (e.g. a `.env` file sharing values with the running server).
 */
export function collectParentSensitiveValues(
  sourceEnv: Record<string, string | undefined> = process.env,
): string[] {
  const unique = new Set<string>();
  for (const [k, v] of Object.entries(sourceEnv)) {
    if (typeof v !== "string") continue;
    if (!isForbiddenEnvKey(k)) continue;
    const trimmed = v.trim();
    if (trimmed.length >= MIN_SECRET_VALUE_LEN) {
      unique.add(trimmed);
    }
  }
  return [...unique].sort((a, b) => b.length - a.length);
}
