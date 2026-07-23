/**
 * GET   /api/admin/guardrails — read security posture, effective tool risks, safety policies, and interception logs.
 * PATCH /api/admin/guardrails — update global guardrail configs, tool risk overrides, or safety policy rules.
 */

import "server-only";

import { NextResponse } from "next/server";
import { desc, eq, and, sql } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/lib/db";
import {
  SafetyInterceptionLogTable,
  SafetyPolicyTable,
  ToolRiskOverrideTable,
  ConfigTable,
} from "@/lib/db/schema";
import { withAdmin, ApiError } from "@/lib/http/route-handlers";
import { parseBody } from "@/lib/http/validation";
import {
  getGuardrailConfigCache,
  invalidateGuardrailCache,
  loadAllGuardrailConfigs,
  generateCustomRuleName,
  DEFAULT_SAFETY_POLICIES,
} from "@/lib/agent-pipeline/guardrail-service";
import { BUILTIN_TOOL_RISK_MAP, evaluateToolRisk } from "@/lib/agent-pipeline/risk-registry";
import { invalidateConfigCache } from "@/lib/config";

const ROUTE = "/api/admin/guardrails";

// GET handler — load posture, rules, overrides, and logs with robust fallback.
export const GET = withAdmin(ROUTE, async () => {
  try {
    await loadAllGuardrailConfigs();
  } catch (err) {
    console.warn("[guardrails] loadAllGuardrailConfigs error:", err);
  }

  const cache = getGuardrailConfigCache();

  // Load guardrail.* config keys directly from DB
  const configsMap: Record<string, string> = {};
  try {
    const rows = await db
      .select({ key: ConfigTable.key, value: ConfigTable.value })
      .from(ConfigTable);
    for (const row of rows) {
      if (row.key.startsWith("guardrail.")) {
        configsMap[row.key] = row.value;
      }
    }
  } catch (err) {
    console.warn("[guardrails] configs query error:", err);
  }

  // Robust query for recent audit interception logs
  let interceptionEvents: unknown[] = [];
  try {
    interceptionEvents = await db
      .select()
      .from(SafetyInterceptionLogTable)
      .orderBy(desc(SafetyInterceptionLogTable.createdAt))
      .limit(50);
  } catch (err) {
    console.warn("[guardrails] SafetyInterceptionLogTable query fallback:", err);
  }

  // Format built-in tools list with effective risks
  const builtinTools = Array.from(BUILTIN_TOOL_RISK_MAP.entries()).map(([toolName, meta]) => {
    const evaluation = evaluateToolRisk(toolName, undefined, meta);
    return {
      toolName,
      source: "builtin",
      meta,
      evaluation,
    };
  });

  // Fallback to default baseline policies if DB policies are empty/uninitialized
  const effectivePolicies =
    cache.safetyPolicies.length > 0
      ? cache.safetyPolicies
      : DEFAULT_SAFETY_POLICIES.map((p, index) => ({
          id: index + 1,
          ...p,
          description: p.description ?? null,
          createdBy: null,
          createdAt: new Date(),
          updatedBy: null,
          updatedAt: new Date(),
        }));

  return NextResponse.json({
    configs: configsMap,
    toolOverrides: Array.from(cache.toolOverrides.values()),
    safetyPolicies: effectivePolicies,
    builtinTools,
    interceptionLogs: interceptionEvents,
  });
});

// PATCH schema validation
const patchSchema = z
  .object({
    configs: z
      .array(
        z.object({
          key: z.string().min(1),
          value: z.string(),
        }),
      )
      .optional(),

    toolOverride: z
      .object({
        source: z.enum(["builtin", "mcp"]),
        mcpServerId: z.string().uuid().nullable().optional(),
        toolName: z.string().min(1),
        riskLevel: z.enum(["low", "medium", "high", "critical"]).nullable().optional(),
        requireApproval: z.enum(["inherit", "always", "never"]).default("inherit"),
        headlessAllowed: z.boolean().nullable().optional(),
        enabled: z.boolean().default(true),
      })
      .optional(),

    safetyPolicy: z
      .object({
        id: z.number().optional(),
        name: z.string().nullable().optional(),
        displayName: z.string().min(1),
        description: z.string().nullable().optional(),
        category: z.enum([
          "input_injection",
          "output_redaction",
          "secret_leak",
          "topic_guard",
          "model_eval",
          "input_blacklist",
          "output_blacklist",
        ]),
        policyType: z.enum(["regex", "model_eval", "keyword_list"]).default("regex"),
        action: z.enum(["redact", "block", "warn"]).default("redact"),
        severity: z.enum(["low", "medium", "high", "critical"]).default("medium"),
        scope: z.enum(["global", "input", "output"]).default("global"),
        enabled: z.boolean().default(true),
        policyConfig: z.record(z.string(), z.unknown()).default({}),
      })
      .optional(),

    deletePolicyId: z.number().optional(),
    deleteOverrideId: z.number().optional(),
  })
  .strict();

export const PATCH = withAdmin(ROUTE, async ({ req, session }) => {
  const body = await parseBody(req, patchSchema);
  const userId = session.user.id;

  try {
    // 1. Update global config key-values if provided (upsert — key may not exist yet for guardrail.* keys)
    if (body.configs && body.configs.length > 0) {
      for (const item of body.configs) {
        const [existing] = await db
          .select({ id: ConfigTable.id })
          .from(ConfigTable)
          .where(eq(ConfigTable.key, item.key))
          .limit(1);
        if (existing) {
          await db
            .update(ConfigTable)
            .set({ value: item.value, updatedBy: userId, updatedAt: new Date() })
            .where(eq(ConfigTable.key, item.key));
        } else {
          // Insert new guardrail config key on first toggle
          await db.insert(ConfigTable).values({
            key: item.key,
            value: item.value,
            valueType: "boolean",
            description: `Guardrail toggle: ${item.key}`,
            updatedBy: userId,
          });
        }
      }
      // Refresh the in-process config cache after writes
      invalidateConfigCache();
    }

    // 2. Upsert Tool Risk Override if provided
    if (body.toolOverride) {
      const { source, mcpServerId, toolName, riskLevel, requireApproval, headlessAllowed, enabled } =
        body.toolOverride;

      const existing = await db
        .select({ id: ToolRiskOverrideTable.id })
        .from(ToolRiskOverrideTable)
        .where(
          and(
            eq(ToolRiskOverrideTable.source, source),
            mcpServerId
              ? eq(ToolRiskOverrideTable.mcpServerId, mcpServerId)
              : sql`${ToolRiskOverrideTable.mcpServerId} IS NULL`,
            eq(ToolRiskOverrideTable.toolName, toolName),
          ),
        )
        .limit(1);

      if (existing.length > 0) {
        await db
          .update(ToolRiskOverrideTable)
          .set({
            riskLevel,
            requireApproval,
            headlessAllowed,
            enabled,
            updatedBy: userId,
            updatedAt: new Date(),
          })
          .where(eq(ToolRiskOverrideTable.id, existing[0].id));
      } else {
        await db.insert(ToolRiskOverrideTable).values({
          source,
          mcpServerId: mcpServerId ?? null,
          toolName,
          riskLevel,
          requireApproval,
          headlessAllowed,
          enabled,
          createdBy: userId,
          updatedBy: userId,
        });
      }
    }

    // 3. Upsert Safety Policy if provided
    if (body.safetyPolicy) {
      const p = body.safetyPolicy;
      if (p.id) {
        await db
          .update(SafetyPolicyTable)
          .set({
            displayName: p.displayName,
            description: p.description,
            category: p.category,
            policyType: p.policyType,
            action: p.action,
            severity: p.severity,
            scope: p.scope,
            enabled: p.enabled,
            policyConfig: p.policyConfig,
            updatedBy: userId,
            updatedAt: new Date(),
          })
          .where(eq(SafetyPolicyTable.id, p.id));
      } else {
        const rawName = p.name?.trim();
        const name = (rawName && rawName.length > 0) ? rawName : generateCustomRuleName(p.displayName);
        await db.insert(SafetyPolicyTable).values({
          name,
          displayName: p.displayName,
          description: p.description,
          category: p.category,
          policyType: p.policyType,
          action: p.action,
          severity: p.severity,
          scope: p.scope,
          enabled: p.enabled,
          policyConfig: p.policyConfig,
          createdBy: userId,
          updatedBy: userId,
        });
      }
    }

    // 4. Delete policy if requested
    if (body.deletePolicyId) {
      await db.delete(SafetyPolicyTable).where(eq(SafetyPolicyTable.id, body.deletePolicyId));
    }

    // 5. Delete override if requested
    if (body.deleteOverrideId) {
      await db
        .delete(ToolRiskOverrideTable)
        .where(eq(ToolRiskOverrideTable.id, body.deleteOverrideId));
    }

    // Invalidate in-process cache so all workers pick up changes immediately
    invalidateGuardrailCache();
    await loadAllGuardrailConfigs();

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error("[guardrails] PATCH error:", err);
    throw new ApiError(
      "INTERNAL",
      500,
      `Failed to save guardrail updates: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
});
