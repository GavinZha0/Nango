"use client";

/**
 * GuardrailDashboard — 4:6 Split-Screen Control Tower for tab=config.
 *
 * Left Column (40%): Top Single-Line Stat Overview Bar (4 Metrics) + 14-Node Serpentine Pipeline Visualizer
 * Vertical Divider (border-r)
 * Right Column (60%): Top 50% ToolRiskTable + Bottom 50% ContentSafetyTable
 */

import { ShieldCheck, ShieldAlert, Clock } from "lucide-react";
import {
  GuardrailPipelineVisualizer,
} from "./GuardrailPipelineVisualizer";
import { ToolRiskTable, type ToolRiskItem } from "./ToolRiskTable";
import { ContentSafetyTable, type SafetyPolicyItem } from "./ContentSafetyTable";

interface GuardrailDashboardProps {
  configs: Record<string, string>;
  toolOverrides: ToolRiskItem[];
  safetyPolicies: SafetyPolicyItem[];
  interceptionLogs: Array<{ stage: string; category: string; action: string }>;
  onSaveOverride?: (item: ToolRiskItem) => Promise<void>;
  onDeleteOverride?: (item: ToolRiskItem) => Promise<void>;
  onSavePolicy?: (policy: SafetyPolicyItem) => Promise<void>;
  onDeletePolicy?: (policyId: number) => Promise<void>;
  onToggleConfig?: (key: string, enabled: boolean) => void;
}

export function GuardrailDashboard({
  configs,
  toolOverrides,
  safetyPolicies,
  interceptionLogs,
  onSaveOverride,
  onDeleteOverride,
  onSavePolicy,
  onDeletePolicy,
  onToggleConfig,
}: GuardrailDashboardProps) {
  // Pipeline node stats: nodes 2-14 (13 total), excluding boundary node-1 and node-15.
  // Invariant nodes (2, 5, 9, 10) are always active; configurable nodes read from configs.
  const PIPELINE_INVARIANT_COUNT = 4; // node-2, node-5, node-9, node-10
  const PIPELINE_CONFIGURABLE_KEYS = [
    "guardrail.input_injection.enabled",    // node-3
    "guardrail.model_eval.input.enabled",   // node-4
    "guardrail.loop_detection.enabled",     // node-6
    "guardrail.tool_risk.enabled",          // node-7
    "guardrail.approval.enabled",           // node-8
    "guardrail.result_sanitization.enabled",// node-11
    "guardrail.token_budget.enabled",       // node-12
    "guardrail.output_redaction.enabled",   // node-13
    "guardrail.model_eval.output.enabled",  // node-14
  ] as const;
  const PIPELINE_TOTAL = PIPELINE_INVARIANT_COUNT + PIPELINE_CONFIGURABLE_KEYS.length; // 13
  const activeConfigurableCount = PIPELINE_CONFIGURABLE_KEYS.filter(
    (key) => configs[key] === undefined || configs[key] === "true"
  ).length;
  const pipelineActiveCount = PIPELINE_INVARIANT_COUNT + activeConfigurableCount;

  return (
    <div className="flex h-full w-full overflow-hidden">
      {/* LEFT COLUMN (40% width) */}
      <div className="flex w-[40%] flex-col gap-3 overflow-hidden pr-3.5 border-r border-border">
        {/* Top Single-Line Stat Overview Bar (4 Key Metrics) */}
        <div className="flex items-center justify-between rounded-md border bg-card/40 px-2.5 py-1.5 text-xs shadow-xs shrink-0 gap-1 font-sans">
          {/* 1. Protection Level */}
          <div className="flex items-center gap-1">
            <ShieldCheck className="h-3.5 w-3.5 text-primary shrink-0" />
            <span className="text-muted-foreground font-medium text-[11px]">Level:</span>
            <span className="font-bold text-foreground text-[11px]">HIGH</span>
          </div>

          <div className="h-3 w-px bg-border shrink-0" />

          {/* 2. Active Pipeline Nodes */}
          <div className="flex items-center gap-1">
            <ShieldAlert className="h-3.5 w-3.5 text-primary shrink-0" />
            <span className="text-muted-foreground font-medium text-[11px]">Active:</span>
            <span className="font-bold text-foreground text-[11px] font-mono">{pipelineActiveCount}/{PIPELINE_TOTAL}</span>
          </div>

          <div className="h-3 w-px bg-border shrink-0" />

          {/* 3. 24h Interceptions */}
          <div className="flex items-center gap-1">
            <Clock className="h-3.5 w-3.5 text-primary shrink-0" />
            <span className="text-muted-foreground font-medium text-[11px]">24h:</span>
            <span className="font-bold text-foreground text-[11px]">{interceptionLogs.length}</span>
          </div>
        </div>

        {/* 15-Node Serpentine Dynamic Pipeline Visualizer — Expands to fill remaining left column height */}
        <div className="flex-1 min-h-0">
          <GuardrailPipelineVisualizer
            configs={configs}
            interceptionLogs={interceptionLogs}
            safetyPolicies={safetyPolicies}
            onSavePolicy={onSavePolicy}
            onToggleConfig={onToggleConfig}
          />
        </div>
      </div>

      {/* RIGHT COLUMN (60% width) — Unwrapped Header Panels */}
      <div className="flex flex-1 flex-col overflow-hidden pl-3.5">
        {/* Top 50%: Tool Risk Registry Table */}
        <div className="flex h-[50%] flex-col overflow-hidden pb-2 border-b border-border">
          <ToolRiskTable items={toolOverrides} onSaveOverride={onSaveOverride} onDeleteOverride={onDeleteOverride} />
        </div>

        {/* Bottom 50%: Content & AI Model Safety Policies Table */}
        <div className="flex flex-1 flex-col overflow-hidden pt-2">
          <ContentSafetyTable
            policies={safetyPolicies}
            onSavePolicy={onSavePolicy}
            onDeletePolicy={onDeletePolicy}
          />
        </div>
      </div>
    </div>
  );
}
