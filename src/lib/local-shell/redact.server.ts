/**
 * Output redaction for local shell subprocess stdout/stderr.
 *
 * SECURITY: Scrubs credential/secret patterns (API keys, tokens, PEM private
 * keys, `.env`-style secret assignments) AND exact values of sensitive parent
 * environment variables. Intentionally omits phone/email PII patterns so
 * normal timestamps, numeric IDs, and git author lines are not corrupted.
 */

import "server-only";

import { collectParentSensitiveValues } from "./env.server";

interface ShellRedactionRule {
  name: string;
  pattern: RegExp;
  replace: string;
}

const SHELL_SECRET_REDACTION_RULES: readonly ShellRedactionRule[] = [
  {
    name: "private_key_block",
    pattern:
      /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
    replace: "[REDACTED_PRIVATE_KEY]",
  },
  {
    name: "anthropic_api_key",
    pattern: /sk-ant-[a-zA-Z0-9_-]{20,}/g,
    replace: "[REDACTED_API_KEY]",
  },
  {
    name: "openai_api_key",
    pattern: /sk-[a-zA-Z0-9_-]{20,}/g,
    replace: "[REDACTED_API_KEY]",
  },
  {
    name: "aws_access_key",
    pattern: /\bAKIA[0-9A-Z]{16}\b/g,
    replace: "[REDACTED_AWS_KEY]",
  },
  {
    name: "github_token",
    pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[a-zA-Z0-9]{20,}\b/g,
    replace: "[REDACTED_GITHUB_TOKEN]",
  },
  {
    name: "github_fine_grained_pat",
    pattern: /\bgithub_pat_[a-zA-Z0-9_]{20,}\b/g,
    replace: "[REDACTED_GITHUB_TOKEN]",
  },
  {
    name: "google_api_key",
    pattern: /\bAIza[0-9A-Za-z_-]{30,}\b/g,
    replace: "[REDACTED_GOOGLE_KEY]",
  },
  {
    name: "bearer_token",
    pattern: /Bearer\s+[a-zA-Z0-9._~+/-]{20,}=*/gi,
    replace: "Bearer [REDACTED_TOKEN]",
  },
  {
    name: "dotenv_secret_assignment",
    pattern:
      /\b([A-Z0-9_]*(?:API_KEY|SECRET_KEY|ACCESS_KEY|AUTH_TOKEN|ACCESS_TOKEN|PRIVATE_KEY|PASSWORD|PASSWD|KEYRING)[A-Z0-9_]*)\s*=\s*(['"]?)[^\s'"]{8,}\2/gi,
    replace: "$1=[REDACTED_SECRET]",
  },
];

export interface RedactShellOutputOptions {
  /** Override parent environment for exact-value scrubbing (tests). */
  sourceEnv?: Record<string, string | undefined>;
}

/**
 * Scrub secrets from shell output before returning it to the LLM or UI.
 */
export function redactShellOutput(
  text: string,
  opts: RedactShellOutputOptions = {},
): string {
  if (!text) return text;

  let out = text;
  for (const rule of SHELL_SECRET_REDACTION_RULES) {
    out = out.replace(rule.pattern, rule.replace);
  }

  // Exact-value scrub against sensitive values in the parent process env.
  const sensitiveValues = collectParentSensitiveValues(opts.sourceEnv);
  for (const secret of sensitiveValues) {
    if (out.includes(secret)) {
      out = out.split(secret).join("[REDACTED_SECRET]");
    }
  }

  return out;
}
