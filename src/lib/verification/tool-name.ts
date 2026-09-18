/**
 * Verification Subsystem — Tool Prefix Conversion Engine
 *
 * Implements pure, idempotent, case-insensitive tool prefix transformations
 * ("none" | "add" | "remove") to support testing MCP servers registered
 * behind group gateway prefixes without hardcoding prefixes into test cases.
 *
 * See docs/verification.md and docs/verification-group-and-prefix-plan.md.
 */

export type ToolPrefixMode = "none" | "add" | "remove";

export interface ToolPrefixRule {
  mode: ToolPrefixMode;
  prefix: string;
}

/**
 * Resolves the effective tool name to dispatch to the downstream MCP server
 * based on the suite's configured ToolPrefixRule.
 *
 * Guarantees:
 * 1. Pure function with zero side effects.
 * 2. Case-insensitive prefix matching.
 * 3. Idempotent: `add` will not duplicate an existing prefix; `remove` only
 *    strips when the prefix actually matches.
 * 4. Robust handling of whitespace, nullish rules, and empty names.
 */
export function resolveEffectiveToolName(
  toolName: string,
  rule?: ToolPrefixRule | null,
): string {
  if (!toolName) return "";
  if (!rule || rule.mode === "none" || !rule.prefix) {
    return toolName;
  }
  const prefix = rule.prefix.trim();
  if (!prefix) return toolName;

  const prefixLen = prefix.length;
  // Case-insensitive prefix comparison
  const isMatch =
    toolName.slice(0, prefixLen).toLowerCase() === prefix.toLowerCase();

  if (rule.mode === "add") {
    // Idempotent protection: do not prepend if already present (case-insensitive)
    return isMatch ? toolName : `${prefix}${toolName}`;
  }

  if (rule.mode === "remove") {
    // Idempotent protection: strip prefix characters if matched; otherwise return as-is
    return isMatch ? toolName.slice(prefixLen) : toolName;
  }

  return toolName;
}
