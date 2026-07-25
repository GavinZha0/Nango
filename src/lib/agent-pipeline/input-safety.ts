/**
 * Agent pipeline — Incoming Prompt Safety Guard.
 *
 * Intercepts incoming user messages before they reach the CopilotRuntime / LLM.
 * Scans for input_injection, topic_guard, and secret_leak violations using
 * both regex and keyword_list policies.
 */

import "server-only";
import vm from "node:vm";
import { getGuardrailConfigCache, recordInterceptionLog } from "./guardrail-service";
import type { SafetyPolicyRule } from "./tool-safety";

export interface ScanResult {
  action: "pass" | "block" | "redact";
  result?: string;
  message?: string;
}

/**
 * Apply a single regex safety policy rule to text.
 */
function applyRegexRule(text: string, rule: SafetyPolicyRule): { matched: boolean; result: string } {
  const pattern = rule.policyConfig.pattern as string;
  if (!pattern) return { matched: false, result: text };

  try {
    const safeText = text.length > 50000 ? text.slice(0, 50000) : text;
    const replacement = (rule.policyConfig.replacement as string) || "[REDACTED]";
    
    const context = vm.createContext({ text: safeText, replacement });
    let scriptContent = "";

    if (rule.action === "redact") {
      scriptContent = `text.replace(new RegExp(${JSON.stringify(pattern)}, 'gi'), replacement)`;
    } else {
      scriptContent = `new RegExp(${JSON.stringify(pattern)}, 'gi').test(text)`;
    }

    const script = new vm.Script(scriptContent);
    const result = script.runInContext(context, { timeout: 50 });

    if (rule.action === "redact") {
      return { matched: result !== safeText, result: result as string };
    } else {
      return { matched: result as boolean, result: text };
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes('timeout')) {
      console.error(`[prompt-safety] RE-DOS DETECTED! Regex timeout for rule ${rule.name}`);
      return { matched: true, result: text }; 
    }
    console.warn(`[prompt-safety] Invalid regex pattern in rule ${rule.name}:`, err);
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
    const lowerText = result.toLowerCase();
    const lowerKw = kw.toLowerCase();
    
    if (lowerText.includes(lowerKw)) {
      matched = true;
      if (rule.action === "redact") {
        const escapedKw = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        result = result.replace(new RegExp(escapedKw, 'gi'), replacement);
      } else {
        break;
      }
    }
  }

  return { matched, result };
}

/**
 * Scan an incoming user prompt string against active DB rules.
 */
export async function scanIncomingPrompt(
  text: string,
  userId?: string,
  runId?: string
): Promise<ScanResult> {
  const cache = getGuardrailConfigCache();
  const activeRules = cache.safetyPolicies.filter(
    (p) => p.enabled && (p.scope === "input" || p.scope === "global")
  ) as SafetyPolicyRule[];

  if (activeRules.length === 0) {
    return { action: "pass" };
  }

  let modifiedText = text;
  let blocked = false;
  let blockingRule: SafetyPolicyRule | null = null;
  let wasRedacted = false;

  for (const rule of activeRules) {
    let matched = false;
    let result = modifiedText;

    if (rule.policyType === "regex") {
      const res = applyRegexRule(modifiedText, rule);
      matched = res.matched;
      result = res.result;
    } else if (rule.policyType === "keyword_list") {
      const res = applyKeywordRule(modifiedText, rule);
      matched = res.matched;
      result = res.result;
    } else {
      continue; // Skip model_eval for real-time path
    }

    if (matched) {
      if (rule.action === "block") {
        blocked = true;
        blockingRule = rule;
        break; // Stop on first block
      } else if (rule.action === "redact") {
        modifiedText = result;
        wasRedacted = true;
      }
      
      if (rule.action === "warn") {
        await recordInterceptionLog({
          runId: runId ?? null,
          userId: userId ?? null,
          stage: "input",
          category: rule.category as "input_injection" | "secret_leak" | "topic_guard",
          policyId: rule.id,
          policyName: rule.displayName,
          policyType: rule.policyType,
          action: "warn",
          severity: rule.severity,
          payload: { snippet: text.slice(0, 100) },
        });
      }
    }
  }

  if (blocked && blockingRule) {
    await recordInterceptionLog({
      runId: runId ?? null,
      userId: userId ?? null,
      stage: "input",
      category: blockingRule.category as "input_injection" | "secret_leak" | "topic_guard",
      policyId: blockingRule.id,
      policyName: blockingRule.displayName,
      policyType: blockingRule.policyType,
      action: "block",
      severity: blockingRule.severity,
      payload: { snippet: text.slice(0, 100) },
    });

    return {
      action: "block",
      message: `It's blocked by safety policy "${blockingRule.displayName}"`,
    };
  }

  if (wasRedacted) {
    return { action: "redact", result: modifiedText };
  }

  return { action: "pass" };
}
