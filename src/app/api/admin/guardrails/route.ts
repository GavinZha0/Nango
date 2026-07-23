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
} from "@/lib/db/schema";
import { withAdmin } from "@/lib/http/route-handlers";
import { parseBody } from "@/lib/http/validation";
import {
  getGuardrailConfigCache,
  invalidateGuardrailCache,
  loadAllGuardrailConfigs,
  generateCustomRuleName,
} from "@/lib/agent-pipeline/guardrail-service";
import { BUILTIN_TOOL_RISK_MAP, evaluateToolRisk } from "@/lib/agent-pipeline/risk-registry";
import { updateConfig } from "@/lib/config";

const ROUTE = "/api/admin/guardrails";

// GET handler — load posture, rules, overrides, and logs.
export const GET = withAdmin(ROUTE, async () => {
  await loadAllGuardrailConfigs();
  const cache = getGuardrailConfigCache();

  // Load recent audit interception logs from SafetyInterceptionLogTable
  const interceptionEvents = await db
    .select()
    .from(SafetyInterceptionLogTable)
    .orderBy(desc(SafetyInterceptionLogTable.createdAt))
    .limit(50);

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

  return NextResponse.json({
    toolOverrides: Array.from(cache.toolOverrides.values()),
    safetyPolicies: cache.safetyPolicies,
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
        name: z.string().optional(),
        displayName: z.string().min(1),
        description: z.string().optional(),
        category: z.enum(["input_injection", "output_redaction", "secret_leak", "topic_guard"]),
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

  // 1. Update global config key-values if provided
  if (body.configs && body.configs.length > 0) {
    for (const item of body.configs) {
      await updateConfig({
        key: item.key,
        value: item.value,
        updatedBy: userId,
      });
    }
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
      const name = p.name ?? generateCustomRuleName(p.displayName);
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
});
