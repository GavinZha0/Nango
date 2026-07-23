/**
 * Static Security Scan — Lightweight AST & pattern inspection before code execution.
 *
 * Implements Nango Node 9 G21 static safety scan for python and javascript code text
 * prior to dispatching into sandbox containers or subprocesses.
 *
 * See docs/architecture-improvements.md (G21 Skill-script & code scan).
 */

import "server-only";

export interface StaticScanViolation {
  ruleId: string;
  message: string;
  severity: "error" | "warning";
}

export interface StaticScanResult {
  passed: boolean;
  violations: StaticScanViolation[];
}

/** Default forbidden call & import patterns for Python */
const PYTHON_FORBIDDEN_PATTERNS: Array<{ id: string; pattern: RegExp; message: string }> = [
  {
    id: "BANNED_SUBPROCESS",
    pattern: /\b(subprocess|os\.system|os\.popen|os\.spawn|os\.exec|pty\.spawn)\b/,
    message: "Use of subprocess or shell command execution is prohibited.",
  },
  {
    id: "BANNED_DYNAMIC_EVAL",
    pattern: /\b(eval\s*\(|exec\s*\(|compile\s*\(|__import__\s*\()\b/,
    message: "Dynamic code execution (eval/exec/__import__) is prohibited.",
  },
  {
    id: "BANNED_RAW_SOCKET",
    pattern: /\b(socket\.socket|urllib\.request|requests\.(get|post|put|delete)|aiohttp)\b/,
    message: "Raw network socket or outbound HTTP requests in sandbox code are prohibited.",
  },
  {
    id: "BANNED_DUNDER_REFLECT",
    pattern: /__subclasses__|__globals__|__code__|__builtins__/,
    message: "Reflection/dunder attribute access for sandbox escape is prohibited.",
  },
];

/** Default forbidden patterns for JavaScript */
const JS_FORBIDDEN_PATTERNS: Array<{ id: string; pattern: RegExp; message: string }> = [
  {
    id: "BANNED_CHILD_PROCESS",
    pattern: /\b(child_process|spawn|execFile|fork)\b/,
    message: "Use of child_process in sandbox scripts is prohibited.",
  },
  {
    id: "BANNED_DYNAMIC_EVAL",
    pattern: /\b(eval\s*\(|Function\s*\()\b/,
    message: "Dynamic JS code execution (eval/Function) is prohibited.",
  },
];

/**
 * Perform a fast, deterministic pre-execution static scan on code text.
 */
export function scanCodeStatic(
  codeText: string,
  language: "python" | "javascript" = "python",
): StaticScanResult {
  const violations: StaticScanViolation[] = [];
  const patterns = language === "python" ? PYTHON_FORBIDDEN_PATTERNS : JS_FORBIDDEN_PATTERNS;

  for (const item of patterns) {
    if (item.pattern.test(codeText)) {
      violations.push({
        ruleId: item.id,
        message: item.message,
        severity: "error",
      });
    }
  }

  return {
    passed: violations.length === 0,
    violations,
  };
}
