/**
 * Agent pipeline — Input Safety Policy Middleware (G18).
 *
 * Executes safety_policy rules with scope='input' or 'global' on tool arguments
 * to prevent prompt injection and malicious input patterns.
 *
 * See docs/architecture-improvements.md "P1 — Safety Guardrails".
 */

import "server-only";

import vm from "node:vm";

import { defineToolMiddleware } from "./compose";
import type { ToolMiddleware } from "./types";
import { recordInterceptionLog } from "./guardrail-service";

export interface SafetyPolicyRule {
  id: number;
  name: string;
  displayName: string;
  description: string | null;
  category: string;
  policyType: "regex" | "model_eval" | "keyword_list";
  action: "redact" | "block" | "warn";
  severity: "low" | "medium" | "high" | "critical";
  scope: "global" | "input" | "output";
  enabled: boolean;
  policyConfig: Record<string, unknown>;
}

/**
 * Apply a single regex safety policy rule to text.
 */
function applyRegexRule(text: string, rule: SafetyPolicyRule): { matched: boolean; result: string } {
  const pattern = rule.policyConfig.pattern as string;
  if (!pattern) return { matched: false, result: text };

  try {
    // Limit text length to prevent extremely long strings from slowing down even simple regexes
    const safeText = text.length > 50000 ? text.slice(0, 50000) : text;
    const replacement = (rule.policyConfig.replacement as string) || "[REDACTED]";
    
    const context = vm.createContext({ text: safeText, replacement });
    let scriptContent = "";

    if (rule.action === "redact") {
      scriptContent = `text.replace(new RegExp(${JSON.stringify(pattern)}, 'gi'), replacement)`;
    } else {
      scriptContent = `new RegExp(${JSON.stringify(pattern)}, 'gi').test(text)`;
    }

    // Set 50ms timeout to abort catastrophic backtracking
    const script = new vm.Script(scriptContent);
    const result = script.runInContext(context, { timeout: 50 });

    if (rule.action === "redact") {
      // If result changed, it matched. Return full result.
      return { matched: result !== safeText, result: result as string };
    } else {
      return { matched: result as boolean, result: text };
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes('timeout')) {
      console.error(`[tool-safety] RE-DOS DETECTED! Regex timeout for rule ${rule.name}`);
      // If it times out due to backtracking, treat it as a block/match for safety
      return { matched: true, result: text }; 
    }
    console.warn(`[tool-safety] Invalid regex pattern in rule ${rule.name}:`, err);
  }

  return { matched: false, result: text };
}

/**
 * Apply a keyword list safety policy rule to text.
 */
function applyKeywordRule(text: string, rule: SafetyPolicyRule): { matched: boolean; result: string } {
  const keywords = rule.policyConfig.keywords;
  if (!Array.isArray(keywords) || keywords.length === 0) return { matched: false, result: text };

  let matched = false;
  let result = text;
  const replacement = (rule.policyConfig.replacement as string) || "[REDACTED]";

  for (const kw of keywords) {
    if (typeof kw !== "string") continue;
    // Simple case-insensitive match
    const lowerText = result.toLowerCase();
    const lowerKw = kw.toLowerCase();
    
    if (lowerText.includes(lowerKw)) {
      matched = true;
      if (rule.action === "redact") {
        // Redact all occurrences case-insensitively using regex
        // Escape special regex chars in keyword
        const escapedKw = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        result = result.replace(new RegExp(escapedKw, 'gi'), replacement);
      } else {
        // Block or Warn action doesn't modify result, just stop checking
        break;
      }
    }
  }

  return { matched, result };
}

/**
 * Order 35 — Tool safety policy middleware (before tool approval).
 * Applies regex and keyword rules to tool arguments to detect and block malicious patterns.
 */
export function toolSafetyPolicyMiddleware(rules: SafetyPolicyRule[]): ToolMiddleware {
  return defineToolMiddleware({
    name: "tool-safety-policy",
    order: 35,
    beforeToolCall: async (ctx, call) => {
      // Filter enabled rules with input or global scope
      const activeRules = rules.filter((r) => r.enabled && (r.scope === "input" || r.scope === "global"));

      if (activeRules.length === 0) {
        return { action: "pass" };
      }

      // Convert args to string for pattern matching
      const argsStr = JSON.stringify(call.args ?? {});
      let modifiedArgs = argsStr;
      let blocked = false;
      let blockingRule: SafetyPolicyRule | null = null;

      // Apply each rule
      for (const rule of activeRules) {
        let matched = false;
        let result = modifiedArgs;

        if (rule.policyType === "regex") {
          const res = applyRegexRule(modifiedArgs, rule);
          matched = res.matched;
          result = res.result;
        } else if (rule.policyType === "keyword_list") {
          const res = applyKeywordRule(modifiedArgs, rule);
          matched = res.matched;
          result = res.result;
        } else {
          continue; // Ignore model_eval
        }

        if (matched) {
          if (rule.action === "block") {
            blocked = true;
            blockingRule = rule;
            break; // Stop on first block
          } else if (rule.action === "redact") {
            modifiedArgs = result;
          }
          // warn action: log but don't block
          await recordInterceptionLog({
            runId: ctx.runId,
            userId: ctx.userId,
            stage: "input",
            category: rule.category as "input_injection" | "secret_leak" | "topic_guard",
            policyId: rule.id,
            policyName: rule.displayName,
            policyType: rule.policyType,
            toolName: call.toolName,
            action: rule.action,
            severity: rule.severity,
            payload: { argsPreview: argsStr.slice(0, 200) },
          });
        }
      }

      if (blocked && blockingRule) {
        await recordInterceptionLog({
          runId: ctx.runId,
          userId: ctx.userId,
          stage: "input",
          category: blockingRule.category as "input_injection" | "secret_leak" | "topic_guard",
          policyId: blockingRule.id,
          policyName: blockingRule.displayName,
          policyType: blockingRule.policyType,
          toolName: call.toolName,
          action: "block",
          severity: blockingRule.severity,
          payload: { argsPreview: argsStr.slice(0, 200) },
        });

        return {
          action: "block",
          result: {
            isError: true,
            message: `Input blocked by safety policy "${blockingRule.displayName}": ${blockingRule.description || "Pattern matched"}`,
          },
        };
      }

      // If args were redacted, parse back to object
      let finalModifiedArgs: unknown = undefined;
      if (modifiedArgs !== argsStr) {
        try {
          finalModifiedArgs = JSON.parse(modifiedArgs);
        } catch (err) {
          console.warn(`[tool-safety] Failed to parse redacted args:`, err);
        }
      }

      return finalModifiedArgs !== undefined 
        ? { action: "pass", modifiedArgs: finalModifiedArgs }
        : { action: "pass" };
    },
  });
}
