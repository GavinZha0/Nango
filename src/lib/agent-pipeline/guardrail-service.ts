/**
 * Guardrail Service — process-wide safety guardrail policy & override management.
 *
 * Provides:
 * 1. Automatic database seeding for baseline safety policies (seedSafetyPolicies)
 * 2. In-memory caching for effective tool risk overrides & dynamic safety policies
 * 3. Cache invalidation on admin write operations
 *
 * Resolution: Code Defaults -> Global Config DB -> ToolRiskOverride DB -> SafetyPolicy DB
 */

import { db } from "@/lib/db";
import {
  SafetyInterceptionLogTable,
  SafetyPolicyTable,
  ToolRiskOverrideTable,
  type SafetyPolicyEntity,
  type ToolRiskOverrideEntity,
} from "@/lib/db/schema";
import { eq } from "drizzle-orm";

/** Seed baseline safety policies (8 predefined standard rules). */
export const DEFAULT_SAFETY_POLICIES = [
  {
    name: "llm_api_key_redact",
    displayName: "LLM API Key Secret Redaction",
    description: "Automatically detects and redacts OpenAI, Anthropic, DeepSeek, and Moonshot API keys.",
    category: "secret_leak",
    policyType: "regex",
    action: "redact",
    severity: "critical",
    scope: "global",
    enabled: true,
    policyConfig: {
      pattern: "\\b(sk-[a-zA-Z0-9_-]{20,}|sk-ant-[a-zA-Z0-9_-]{20,}|key-[a-zA-Z0-9]{30,})\\b",
      replacement: "[REDACTED_API_KEY]",
    },
  },
  {
    name: "cloud_credential_redact",
    displayName: "Cloud Credential & Private Key Redaction",
    description: "Automatically detects and redacts AWS, GCP, Azure access keys and SSH private keys.",
    category: "secret_leak",
    policyType: "regex",
    action: "redact",
    severity: "critical",
    scope: "global",
    enabled: true,
    policyConfig: {
      pattern: "\\b(AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z-_]{35}|-----\\s*BEGIN[A-Z\\s]*PRIVATE\\s+KEY\\s*-----)\\b",
      replacement: "[REDACTED_CLOUD_CREDENTIAL]",
    },
  },
  {
    name: "bearer_token_redact",
    displayName: "Auth Bearer Token Redaction",
    description: "Automatically detects and redacts HTTP Bearer authentication tokens in headers and text.",
    category: "secret_leak",
    policyType: "regex",
    action: "redact",
    severity: "high",
    scope: "global",
    enabled: true,
    policyConfig: {
      pattern: "Bearer\\s+[a-zA-Z0-9._~+/-]{20,}=*",
      replacement: "Bearer [REDACTED_TOKEN]",
    },
  },
  {
    name: "chinese_phone_redact",
    displayName: "Mobile Phone Number PII Masking",
    description: "Automatically masks 11-digit mobile phone numbers with asterisks.",
    category: "output_redaction",
    policyType: "regex",
    action: "redact",
    severity: "medium",
    scope: "output",
    enabled: true,
    policyConfig: {
      pattern: "\\b(1[3-9]\\d)(\\d{4})(\\d{4})\\b",
      replacement: "$1****$3",
    },
  },
  {
    name: "id_card_redact",
    displayName: "National Identity Number Masking",
    description: "Automatically masks 18-digit identity numbers and passport identifiers.",
    category: "output_redaction",
    policyType: "regex",
    action: "redact",
    severity: "high",
    scope: "output",
    enabled: true,
    policyConfig: {
      pattern: "\\b(\\d{6})\\d{8}(\\d{3}[\\dXx])\\b",
      replacement: "$1********$2",
    },
  },
  {
    name: "email_redact",
    displayName: "Email Address PII Redaction",
    description: "Automatically masks email username prefixes before output rendering.",
    category: "output_redaction",
    policyType: "regex",
    action: "redact",
    severity: "low",
    scope: "output",
    enabled: true,
    policyConfig: {
      pattern: "\\b([A-Za-z0-9._%+-]{1,3})[A-Za-z0-9._%+-]*@([A-Za-z0-9.-]+\\.[A-Za-z]{2,})\\b",
      replacement: "$1***@$2",
    },
  },
  {
    name: "system_tag_injection_block",
    displayName: "System Control Tag Injection Guard",
    description: "Blocks and escapes malicious control tags mimicking framework system prompts.",
    category: "input_injection",
    policyType: "regex",
    action: "block",
    severity: "high",
    scope: "input",
    enabled: true,
    policyConfig: {
      pattern: "<system-reminder>|<\\|im_start\\|>|<\\|im_end\\|>|<assistant>",
    },
  },
  {
    name: "default_prohibited_terms",
    displayName: "Destructive System Command Guard",
    description: "Blocks destructive OS commands like 'rm -rf /' and disk format commands.",
    category: "topic_guard",
    policyType: "regex",
    action: "block",
    severity: "critical",
    scope: "global",
    enabled: true,
    policyConfig: {
      pattern: "(sudo\\s+rm\\s+-rf\\s+/|format\\s+[c-z]:)",
    },
  },
] as const;

/**
 * Global cache pinned to `globalThis` so Turbopack & Next.js worker realms share state.
 */
interface GuardrailCacheState {
  toolOverrides: Map<string, ToolRiskOverrideEntity>; // Key: "source:mcpServerId:toolName"
  safetyPolicies: SafetyPolicyEntity[];
  loaded: boolean;
}

const G = globalThis as { __nango_guardrail_state?: GuardrailCacheState };
G.__nango_guardrail_state ??= {
  toolOverrides: new Map(),
  safetyPolicies: [],
  loaded: false,
};
const cacheState = G.__nango_guardrail_state;

/**
 * Seed baseline policies if they do not exist in DB yet.
 */
export async function seedSafetyPolicies(): Promise<void> {
  try {
    for (const policy of DEFAULT_SAFETY_POLICIES) {
      const existing = await db
        .select({ id: SafetyPolicyTable.id })
        .from(SafetyPolicyTable)
        .where(eq(SafetyPolicyTable.name, policy.name))
        .limit(1);

      if (existing.length === 0) {
        await db.insert(SafetyPolicyTable).values({
          name: policy.name,
          displayName: policy.displayName,
          description: policy.description,
          category: policy.category,
          policyType: policy.policyType,
          action: policy.action,
          severity: policy.severity,
          scope: policy.scope,
          enabled: policy.enabled,
          policyConfig: policy.policyConfig,
        });
      }
    }
  } catch (err) {
    console.warn(`[guardrails] seedSafetyPolicies error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Load all guardrail policy rows and overrides from DB into memory.
 */
export async function loadAllGuardrailConfigs(): Promise<void> {
  try {
    // Ensure seeds exist
    await seedSafetyPolicies();

    const [overrides, policies] = await Promise.all([
      db.select().from(ToolRiskOverrideTable),
      db.select().from(SafetyPolicyTable),
    ]);

    cacheState.toolOverrides.clear();
    for (const row of overrides) {
      const key = `${row.source}:${row.mcpServerId ?? ""}:${row.toolName}`;
      cacheState.toolOverrides.set(key, row);
    }

    cacheState.safetyPolicies = policies;
    cacheState.loaded = true;
  } catch (err) {
    console.warn(
      `[guardrails] failed to load configs from DB: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Invalidate guardrail policy cache so next read reloads.
 */
export function invalidateGuardrailCache(): void {
  cacheState.toolOverrides.clear();
  cacheState.safetyPolicies = [];
  cacheState.loaded = false;
}

/**
 * Get active guardrail cache state.
 */
export function getGuardrailConfigCache(): GuardrailCacheState {
  return cacheState;
}

/**
 * Helper to find effective tool risk override.
 */
export function getToolRiskOverride(
  source: string,
  mcpServerId: string | null | undefined,
  toolName: string,
): ToolRiskOverrideEntity | undefined {
  const key = `${source}:${mcpServerId ?? ""}:${toolName}`;
  return cacheState.toolOverrides.get(key);
}

/**
 * Generate a unique slug name for custom safety rules.
 */
export function generateCustomRuleName(displayName: string): string {
  let slug = displayName
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");

  if (!slug) {
    slug = "rule";
  }

  const shortHash = Math.random().toString(36).substring(2, 6);
  return `custom_${slug.slice(0, 20)}_${shortHash}`;
}

export interface InterceptionLogInput {
  runId?: string | null;
  userId?: string | null;
  stage: "input" | "llm_call" | "tool_call" | "tool_result" | "output";
  category:
    | "input_injection"
    | "secret_leak"
    | "loop_detection"
    | "tool_risk"
    | "output_redaction"
    | "model_eval";
  policyId?: number | null;
  policyName?: string | null;
  policyType?: "regex" | "model_eval" | "keyword_list" | "builtin_rule" | null;
  toolName?: string | null;
  action: "block" | "redact" | "warn" | "require_approval";
  severity: "low" | "medium" | "high" | "critical";
  payload?: Record<string, unknown>;
}

/**
 * Record a security interception audit log entry asynchronously.
 */
export async function recordInterceptionLog(input: InterceptionLogInput): Promise<void> {
  try {
    await db.insert(SafetyInterceptionLogTable).values({
      runId: input.runId ?? null,
      userId: input.userId ?? null,
      stage: input.stage,
      category: input.category,
      policyId: input.policyId ?? null,
      policyName: input.policyName ?? null,
      policyType: input.policyType ?? null,
      toolName: input.toolName ?? null,
      action: input.action,
      severity: input.severity,
      payload: input.payload ?? {},
    });
  } catch (err) {
    console.warn(`[guardrails] recordInterceptionLog error: ${err instanceof Error ? err.message : String(err)}`);
  }
}
