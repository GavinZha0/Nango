/**
 * Command allow/deny policy evaluator for ssh_server runtime calls.
 *
 * See docs/ssh.md.
 */

import "server-only";

export interface PolicyDecision {
  allowed: boolean;
  /** Human-readable reason; populated when `allowed === false`. */
  reason?: string;
  /** Regex `source` of the matched pattern, useful for logs. */
  matchedPattern?: string;
}

/**
 * Compile a list of regex strings into RegExp objects. Throws the
 * first parse error verbatim — caller wraps to fail-closed.
 */
function compilePatterns(patterns: readonly string[]): RegExp[] {
  return patterns.map((p) => new RegExp(p));
}

/**
 * Evaluate a candidate command against an ssh_server's policy.
 *
 * @param command  — the literal shell string the agent wants to run
 * @param allow    — `commandAllow` from the row (null = unrestricted)
 * @param deny     — `commandDeny` from the row (always an array)
 */
export function evaluateCommandPolicy(
  command: string,
  allow: readonly string[] | null,
  deny: readonly string[],
): PolicyDecision {
  let allowRe: RegExp[] | null;
  let denyRe: RegExp[];
  try {
    denyRe = compilePatterns(deny);
    allowRe = allow === null ? null : compilePatterns(allow);
  } catch (err) {
    return {
      allowed: false,
      reason:
        "ssh_server policy contains an invalid regex: " +
        `${(err as Error).message}. Ask the admin to fix the row's ` +
        "commandAllow / commandDeny.",
    };
  }

  // Deny precedence — matches editor copy "always rejected; takes
  // precedence over allowlist".
  for (const re of denyRe) {
    if (re.test(command)) {
      return {
        allowed: false,
        reason: `Command rejected by denylist (pattern: ${re.source}).`,
        matchedPattern: re.source,
      };
    }
  }

  if (allowRe === null) return { allowed: true };

  if (allowRe.length === 0) {
    return {
      allowed: false,
      reason:
        "ssh_server has an explicit empty allowlist — no commands " +
        "are permitted. Ask the admin to widen the allowlist or set " +
        "it to null (no constraint) before retrying.",
    };
  }

  for (const re of allowRe) {
    if (re.test(command)) return { allowed: true };
  }
  return {
    allowed: false,
    reason:
      "Command did not match any allowlist pattern on this " +
      "ssh_server. Ask the admin to widen the allowlist if this " +
      "command is legitimate.",
  };
}
