"use client";

/**
 * GuardrailPipelineVisualizer — Dynamic Rescriptive 14-Node Serpentine Security Stream.
 *
 * Uses container-level ResizeObserver to dynamically adapt nodes-per-row (4 -> 3 -> 2)
 * when the right Chatbot panel or screen width changes, ensuring no nodes ever overflow.
 */

import { useState, useRef, useEffect, useMemo } from "react";
import {
  ShieldCheck,
  ShieldX,
  Lock,
  ArrowRight,
  ArrowLeft,
  ArrowDown,
  Sliders,
  AlertTriangle,
  FileCode2,
  Eye,
  Bot,
  ShieldAlert,
  MessageCircleMore,
  MessageSquareText,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import type { SafetyPolicyItem } from "./ContentSafetyTable";

export interface PipelineNode {
  id: string;
  num: number;
  name: string;
  shortName: string;
  stage: "input" | "tool_call" | "tool_result" | "output";
  category?: string;
  isInvariant?: boolean;
  isBoundary?: boolean;
  enabled: boolean;
  interceptionCount: number;
  description: string;
  icon: typeof ShieldCheck;
  configKey?: string;
}

interface CredentialItem {
  id: string;
  name: string;
  provider: string;
  type: string;
}

interface SecurityAgentItem {
  id: string;
  name: string;
  role: string | null;
  source: string;
}

function AiModerationConfigPanel({
  scope,
  existingPolicy,
  onSavePolicy,
}: {
  nodeId?: string;
  scope: "input" | "output";
  existingPolicy?: SafetyPolicyItem;
  onSavePolicy?: (policy: SafetyPolicyItem) => Promise<void>;
}) {
  const [credentials, setCredentials] = useState<CredentialItem[]>([]);
  const [securityAgents, setSecurityAgents] = useState<SecurityAgentItem[]>([]);
  const [loadingData, setLoadingData] = useState(false);

  // Initial State derived from existingPolicy
  const cfg = (existingPolicy?.policyConfig as Record<string, string>) ?? {};
  const [mode, setMode] = useState<"api" | "security_agent">(
    cfg.mode === "security_agent" ? "security_agent" : "api"
  );
  const [credentialId, setCredentialId] = useState<string>(cfg.credentialId ?? "");
  const [modelId, setModelId] = useState<string>(cfg.modelId ?? "omni-moderation-latest");
  const [agentId, setAgentId] = useState<string>(cfg.agentId ?? "");
  const [action, setAction] = useState<"block" | "warn" | "redact">(existingPolicy?.action ?? "block");
  const [saving, setSaving] = useState(false);

  // Fetch options on mount
  useEffect(() => {
    let ignore = false;
    async function loadOptions() {
      setLoadingData(true);
      try {
        const [credRes, agentRes] = await Promise.all([
          fetch("/api/admin/credentials").then((r) => (r.ok ? r.json() : [])).catch(() => []),
          fetch("/api/admin/agents").then((r) => (r.ok ? r.json() : [])).catch(() => []),
        ]);
        if (!ignore) {
          const rawCreds = Array.isArray(credRes) ? credRes : (credRes.items ?? credRes.credentials ?? []);
          const rawAgents = Array.isArray(agentRes) ? agentRes : (agentRes.items ?? agentRes.agents ?? []);

          // Filter LLM / OpenAI Credentials
          const filteredCreds = rawCreds.filter(
            (c: CredentialItem) =>
              c.type === "llm" || c.type === "openai" || c.provider === "openai" || c.provider === "anthropic" || true
          );

          // Filter Builtin Agents with role === 'security'
          const filteredAgents = rawAgents.filter(
            (a: SecurityAgentItem) => a.role === "security" || a.source === "builtin"
          );

          setCredentials(filteredCreds);
          setSecurityAgents(filteredAgents);
        }
      } finally {
        if (!ignore) setLoadingData(false);
      }
    }
    loadOptions();
    return () => {
      ignore = true;
    };
  }, []);

  const handleReset = () => {
    setAction(existingPolicy?.action ?? "block");
    if (existingPolicy?.policyConfig) {
      const cfg = existingPolicy.policyConfig as Record<string, string>;
      if (cfg.mode === "security_agent") {
        setMode("security_agent");
        setAgentId(cfg.agentId ?? "");
      } else {
        setMode("api");
        setCredentialId(cfg.credentialId ?? "");
        setModelId(cfg.modelId ?? "omni-moderation-latest");
      }
    } else {
      setMode("api");
      setCredentialId("");
      setModelId("omni-moderation-latest");
      setAgentId("");
    }
  };

  const handleSave = async () => {
    if (!onSavePolicy) return;
    setSaving(true);
    try {
      const policyConfig =
        mode === "api"
          ? { mode: "api", credentialId, modelId }
          : { mode: "security_agent", agentId };

      await onSavePolicy({
        id: existingPolicy?.id,
        name: existingPolicy?.name ?? `ai_moderation_${scope}`,
        displayName: existingPolicy?.displayName ?? `AI Moderation Guard (${scope})`,
        description: `AI Model Moderation Guard for ${scope} stream`,
        category: "model_eval",
        policyType: "model_eval",
        action: action,
        severity: "high",
        scope,
        enabled: true,
        policyConfig,
      });
      toast.success(`AI Moderation Guard (${scope}) saved successfully!`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-3 font-sans text-left pt-1">
      {/* Mode Selection */}
      <div className="space-y-1">
        <Label className="text-[11px] font-medium text-muted-foreground">Execution Mode</Label>
        <div className="grid grid-cols-2 gap-1 bg-muted/60 p-1 rounded-md">
          <button
            type="button"
            onClick={() => setMode("api")}
            className={cn(
              "py-1 px-2 text-xs font-semibold rounded transition-all",
              mode === "api" ? "bg-background text-foreground shadow-xs" : "text-muted-foreground hover:text-foreground"
            )}
          >
            1. Moderation API
          </button>
          <button
            type="button"
            onClick={() => setMode("security_agent")}
            className={cn(
              "py-1 px-2 text-xs font-semibold rounded transition-all",
              mode === "security_agent" ? "bg-background text-foreground shadow-xs" : "text-muted-foreground hover:text-foreground"
            )}
          >
            2. Security Agent
          </button>
        </div>
      </div>

      {/* Mode 1: Moderation API */}
      {mode === "api" && (
        <div className="space-y-2.5 pt-1">
          <div className="space-y-1">
            <Label className="text-[11px] font-medium text-foreground">API Credential (LLM / Provider)</Label>
            <Select
              value={credentialId}
              items={credentials.map((cred) => ({
                value: cred.id,
                label: `${cred.name} (${cred.provider})`,
              }))}
              onValueChange={(val) => setCredentialId(val ?? "")}
            >
              <SelectTrigger className="w-full h-8 text-xs">
                <SelectValue placeholder={loadingData ? "Loading credentials..." : "Select LLM Credential..."} />
              </SelectTrigger>
              <SelectContent>
                {credentials.length === 0 ? (
                  <SelectItem value="_empty" disabled>
                    No LLM Credentials configured
                  </SelectItem>
                ) : (
                  credentials.map((cred) => (
                    <SelectItem key={cred.id} value={cred.id}>
                      {cred.name} ({cred.provider})
                    </SelectItem>
                  ))
                )}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1">
            <Label className="text-[11px] font-medium text-foreground">Moderation Model ID</Label>
            <Input
              value={modelId}
              onChange={(e) => setModelId(e.target.value)}
              placeholder="e.g. omni-moderation-latest, gpt-4o-mini"
              className="h-8 text-xs font-mono"
            />
          </div>
        </div>
      )}

      {/* Mode 2: Security Agent */}
      {mode === "security_agent" && (
        <div className="space-y-2 pt-1">
          <Label className="text-[11px] font-medium text-foreground">Security Role Builtin Agent</Label>
          <Select
            value={agentId}
            items={securityAgents.map((agent) => ({
              value: agent.id,
              label: `${agent.name} (Role: ${agent.role ?? "security"})`,
            }))}
            onValueChange={(val) => setAgentId(val ?? "")}
          >
            <SelectTrigger className="w-full h-8 text-xs">
              <SelectValue placeholder={loadingData ? "Loading security agents..." : "Select Security Agent..."} />
            </SelectTrigger>
            <SelectContent>
              {securityAgents.length === 0 ? (
                <SelectItem value="_empty" disabled>
                  No Security Agents found (role = &apos;security&apos;)
                </SelectItem>
              ) : (
                securityAgents.map((agent) => (
                  <SelectItem key={agent.id} value={agent.id}>
                    {agent.name} (Role: {agent.role ?? "security"})
                  </SelectItem>
                ))
              )}
            </SelectContent>
          </Select>
        </div>
      )}

      {/* Interception Action Selection */}
      <div className="space-y-1 pt-2 border-t">
        <Label className="text-[11px] font-medium text-foreground">Interception Action</Label>
        <Select
          value={action}
          items={[
            { value: "block", label: "Block (Stop & Reject Execution)" },
            { value: "warn", label: "Warn (Audit Log & Continue)" },
            { value: "redact", label: "Redact (Mask & Sanitize Sensitive Tokens)" },
          ]}
          onValueChange={(val) => setAction((val as "block" | "warn" | "redact") ?? "block")}
        >
          <SelectTrigger className="w-full h-8 text-xs">
            <SelectValue placeholder="Select Action..." />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="block">Block (Stop & Reject Execution)</SelectItem>
            <SelectItem value="warn">Warn (Audit Log & Continue)</SelectItem>
            <SelectItem value="redact">Redact (Mask & Sanitize Sensitive Tokens)</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Action Bar: Save & Cancel Buttons */}
      <div className="flex items-center justify-end gap-2 pt-3 border-t mt-3">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={handleReset}
          className="h-7 text-xs px-2.5 gap-1"
        >
          Cancel
        </Button>
        <Button
          type="button"
          size="sm"
          disabled={saving}
          onClick={handleSave}
          className="h-7 text-xs px-3 gap-1 bg-primary text-primary-foreground hover:bg-primary/90"
        >
          {saving ? "Saving..." : "Save"}
        </Button>
      </div>
    </div>
  );
}

interface GuardrailPipelineVisualizerProps {
  configs?: Record<string, string>;
  interceptionLogs?: Array<{
    stage: string;
    category: string;
    action: string;
  }>;
  safetyPolicies?: SafetyPolicyItem[];
  onSavePolicy?: (policy: SafetyPolicyItem) => Promise<void>;
  onToggleConfig?: (key: string, enabled: boolean) => Promise<void>;
}

export function GuardrailPipelineVisualizer({
  configs = {},
  interceptionLogs = [],
  safetyPolicies = [],
  onSavePolicy,
  onToggleConfig,
}: GuardrailPipelineVisualizerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [selectedNode, setSelectedNode] = useState<PipelineNode | null>(null);
  const [nodesPerRow, setNodesPerRow] = useState<number>(4);

  // ResizeObserver listens to actual Left Column container width changes (e.g. Chatbot panel open/close)
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const width = entry.contentRect.width;
        if (width < 360) {
          setNodesPerRow(2);
        } else if (width < 500) {
          setNodesPerRow(3);
        } else {
          setNodesPerRow(4);
        }
      }
    });

    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Compute 24h counts per node category
  const countForCategory = (category?: string, stage?: string) => {
    if (!category && !stage) return 0;
    return interceptionLogs.filter((log) => {
      if (category && log.category === category) return true;
      if (stage && log.stage === stage) return true;
      return false;
    }).length;
  };

  // Helper: resolve node enabled state from configs (falls back to true for nodes without configKey)
  const isNodeEnabled = (configKey?: string): boolean => {
    if (!configKey) return true;
    const val = configs[configKey];
    // Stored as string "true" / "false"; absent key defaults to enabled
    return val === undefined || val === "true";
  };

  const NODES: PipelineNode[] = useMemo(
    () => [
      {
        id: "node-1",
        num: 1,
        name: "1. User input & context",
        shortName: "1. User input & context",
        stage: "input",
        isBoundary: true,
        isInvariant: true,
        enabled: true,
        interceptionCount: 0,
        description: "Receives User Prompt / WebSocket requests and injects full execution context tracking metadata.",
        icon: MessageCircleMore,
      },
      {
        id: "node-2",
        num: 2,
        name: "2. Identity & Access Guard",
        shortName: "2. Identity & Access Guard",
        stage: "input",
        isInvariant: true,
        enabled: true,
        interceptionCount: countForCategory(undefined, "input"),
        description: "Verifies user RBAC role privileges, entity visibility (isAgentVisibleTo), parent run ownership, and credential enablement.",
        icon: Lock,
      },
      {
        id: "node-3",
        num: 3,
        name: "3. Injection Pattern Guard",
        shortName: "3. Injection Pattern Guard",
        stage: "input",
        category: "input_injection",
        enabled: isNodeEnabled("guardrail.input_injection.enabled"),
        interceptionCount: countForCategory("input_injection"),
        description: "Matches safety_policy regex rules against system tag injection, jailbreak prompts, and malicious commands. (Fast Fail)",
        icon: ShieldAlert,
        configKey: "guardrail.input_injection.enabled",
      },
      {
        id: "node-4",
        num: 4,
        name: "4. AI Moderation Guard",
        shortName: "4. AI Moderation Guard",
        stage: "input",
        category: "model_eval",
        enabled: isNodeEnabled("guardrail.model_eval.input.enabled"),
        interceptionCount: countForCategory("model_eval", "input"),
        description: "Evaluates input prompt safety using OpenAI Moderation API or dedicated Security Role Agent after passing regex checks.",
        icon: Bot,
        configKey: "guardrail.model_eval.input.enabled",
      },
      {
        id: "node-5",
        num: 5,
        name: "5. Credential Confinement (AES-256)",
        shortName: "5. Credential Isolation",
        stage: "input",
        isInvariant: true,
        enabled: true,
        interceptionCount: 0,
        description: "Ensures credentials are never exposed to client bundles or model messages. Decryption keys remain strictly server-side.",
        icon: Lock,
      },
      {
        id: "node-6",
        num: 6,
        name: "6. Tool Loop Guard",
        shortName: "6. Tool Loop Guard",
        stage: "tool_call",
        category: "loop_detection",
        enabled: isNodeEnabled("guardrail.loop_detection.enabled"),
        interceptionCount: countForCategory("loop_detection"),
        description: "Prevents token explosion. Automatically blocks and sends self-correction prompts after 3 consecutive identical tool calls.",
        icon: AlertTriangle,
        configKey: "guardrail.loop_detection.enabled",
      },
      {
        id: "node-7",
        num: 7,
        name: "7. Tool Risk Guard",
        shortName: "7. Tool Risk Guard",
        stage: "tool_call",
        category: "tool_risk",
        enabled: isNodeEnabled("guardrail.tool_risk.enabled"),
        interceptionCount: countForCategory("tool_risk"),
        description: "Evaluates static risk levels (low/medium/high/critical), MCP annotations, and dynamic SQL/SSH argument policies.",
        icon: Sliders,
        configKey: "guardrail.tool_risk.enabled",
      },
      {
        id: "node-8",
        num: 8,
        name: "8. HITL Approval",
        shortName: "8. HITL Approval",
        stage: "tool_call",
        category: "tool_approval",
        enabled: isNodeEnabled("guardrail.approval.enabled"),
        interceptionCount: countForCategory("tool_approval"),
        description: "Gates high-risk tool calls behind Human-In-The-Loop approval cards, pausing execution until explicit admin authorization.",
        icon: ShieldCheck,
        configKey: "guardrail.approval.enabled",
      },
      {
        id: "node-9",
        num: 9,
        name: "9. Static Security Scan",
        shortName: "9. Static Security Scan",
        stage: "tool_call",
        isInvariant: true,
        enabled: true,
        interceptionCount: 0,
        description: "Performs AST code syntax scanning, node-sql-parser SELECT-only parsing, and SSH command regex checks before execution.",
        icon: Lock,
      },
      {
        id: "node-10",
        num: 10,
        name: "10. Sandbox & Physical Isolation",
        shortName: "10. Sandbox & Isolation",
        stage: "tool_call",
        isInvariant: true,
        enabled: true,
        interceptionCount: 0,
        description: "Enforces Docker container isolation for code/scripts and read-only DB transaction mounting.",
        icon: Lock,
      },
      {
        id: "node-11",
        num: 11,
        name: "11. Tool Result Sanitization",
        shortName: "11. Tool Result Sanitization",
        stage: "tool_result",
        category: "result_sanitization",
        enabled: isNodeEnabled("guardrail.result_sanitization.enabled"),
        interceptionCount: countForCategory("result_sanitization"),
        description: "Strips system control tags from external web/MCP outputs and wraps data inside <<<UNTRUSTED_SOURCE_DATA>>> tags.",
        icon: FileCode2,
        configKey: "guardrail.result_sanitization.enabled",
      },
      {
        id: "node-12",
        num: 12,
        name: "12. Token Budget & Run Cap",
        shortName: "12. Token Budget Cap",
        stage: "output",
        category: "token_budget",
        enabled: isNodeEnabled("guardrail.token_budget.enabled"),
        interceptionCount: countForCategory("token_budget"),
        description: "Caps maximum token consumption and execution steps per run to prevent infinite recursion and resource exhaustion.",
        icon: Sliders,
        configKey: "guardrail.token_budget.enabled",
      },
      {
        id: "node-13",
        num: 13,
        name: "13. Output Sanitization",
        shortName: "13. Output Sanitization",
        stage: "output",
        category: "output_redaction",
        enabled: isNodeEnabled("guardrail.output_redaction.enabled"),
        interceptionCount: countForCategory("output_redaction"),
        description: "Uses a 60-character SlidingWindowRedactor for real-time PII Masking and Secret Redaction on streamed responses.",
        icon: Eye,
        configKey: "guardrail.output_redaction.enabled",
      },
      {
        id: "node-14",
        num: 14,
        name: "14. AI Moderation Guard",
        shortName: "14. AI Moderation Guard",
        stage: "output",
        category: "model_eval",
        enabled: isNodeEnabled("guardrail.model_eval.output.enabled"),
        interceptionCount: countForCategory("model_eval", "output"),
        description: "Performs final AI moderation verification on output responses before delivering messages to the user.",
        icon: Bot,
        configKey: "guardrail.model_eval.output.enabled",
      },
      {
        id: "node-15",
        num: 15,
        name: "15. Terminal Output & Audit Persistence",
        shortName: "15. Output & Audit",
        stage: "output",
        isBoundary: true,
        isInvariant: true,
        enabled: true,
        interceptionCount: 0,
        description: "Dispatches sanitized messages to the client typewriter renderer and asynchronously persists logs to safety_interception_log.",
        icon: MessageSquareText,
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [interceptionLogs, configs],
  );

  // Dynamic Serpentine Chunking based on nodesPerRow
  const rows = useMemo(() => {
    const result: Array<{ items: PipelineNode[]; direction: "ltr" | "rtl" }> = [];
    let i = 0;
    let lineIdx = 0;
    while (i < NODES.length) {
      const chunk = NODES.slice(i, i + nodesPerRow);
      const direction = lineIdx % 2 === 0 ? "ltr" : "rtl";
      result.push({
        items: direction === "rtl" ? [...chunk].reverse() : chunk,
        direction,
      });
      i += nodesPerRow;
      lineIdx++;
    }
    return result;
  }, [NODES, nodesPerRow]);

  return (
    <div
      ref={containerRef}
      className="flex h-full flex-col gap-3 rounded-lg border bg-card/40 p-3 shadow-xs overflow-y-auto"
    >
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-xs font-semibold text-foreground flex items-center gap-1.5">
            <ShieldCheck className="h-3.5 w-3.5 text-emerald-500" />
            Security Pipeline
          </h3>
          <p className="text-[11px] text-muted-foreground">
            Click a node to configure. Amber nodes are immutable security invariants, gray nodes are ingress/egress boundaries.
          </p>
        </div>
      </div>

      {/* Dynamic Serpentine Flow */}
      <div className="flex flex-col gap-2">
        {rows.map((row, rowIndex) => (
          <div key={rowIndex} className="flex flex-col gap-2">
            <div
              className={cn(
                "relative flex items-center gap-1",
                row.direction === "rtl" && row.items.length < nodesPerRow
                  ? "justify-end"
                  : "justify-between",
              )}
            >
              {row.items.map((node, index) => (
                <div
                  key={node.id}
                  className="flex flex-none items-center gap-1 min-w-0"
                  style={{
                    width: `calc((100% - ${(nodesPerRow - 1) * 0.25}rem) / ${nodesPerRow})`,
                  }}
                >
                  <NodeCard node={node} onClick={() => setSelectedNode(node)} />
                  {index < row.items.length - 1 &&
                    (row.direction === "ltr" ? (
                      <ArrowRight className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground/40" />
                    ) : (
                      <ArrowLeft className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground/40" />
                    ))}
                </div>
              ))}
            </div>

            {/* Turn Downward Arrow */}
            {rowIndex < rows.length - 1 && (
              <div
                className={cn(
                  "flex py-0.5",
                  row.direction === "ltr" ? "justify-end pr-5" : "justify-start pl-5",
                )}
              >
                <ArrowDown className="h-3.5 w-3.5 text-muted-foreground/70" />
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Node Interactive Drawer */}
      <Sheet open={!!selectedNode} onOpenChange={(open) => !open && setSelectedNode(null)}>
        <SheetContent side="right" className="w-[420px] sm:w-[480px] flex flex-col">
          {selectedNode && (() => {
            const DrawerHeaderIcon = !selectedNode.isBoundary && !selectedNode.isInvariant
              ? selectedNode.enabled
                ? ShieldCheck
                : ShieldX
              : selectedNode.icon;
            return (
              <div className="flex flex-col h-full gap-4 pt-2 pb-4 overflow-y-auto">
                <SheetHeader>
                  <div className="flex items-center gap-2">
                    <DrawerHeaderIcon
                      className={cn(
                        "h-5 w-5 flex-shrink-0",
                        selectedNode.isBoundary
                          ? "text-muted-foreground"
                          : selectedNode.isInvariant
                          ? "text-amber-500"
                          : selectedNode.enabled
                          ? "text-emerald-500"
                          : "text-muted-foreground",
                      )}
                    />
                    <SheetTitle className="text-base">{selectedNode.name}</SheetTitle>
                  </div>
                  <SheetDescription className="text-xs text-muted-foreground">
                    {selectedNode.description}
                  </SheetDescription>
                </SheetHeader>

              {/* Card 1: Guardrail State */}
              <div className="space-y-2">
                <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                  Guardrail state
                </h4>
                <div className="space-y-4 rounded-lg border bg-muted/40 p-4">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium">Guardrail status</span>
                    {selectedNode.isInvariant ? (
                      <Badge
                        variant="outline"
                        className="bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20 font-semibold"
                      >
                        Always on
                      </Badge>
                    ) : (
                      <div className="flex items-center gap-2">
                        <Label htmlFor="node-toggle" className="text-xs text-muted-foreground">
                          {selectedNode.enabled ? "Enabled" : "Disabled"}
                        </Label>
                        <Switch
                          id="node-toggle"
                          checked={selectedNode.enabled}
                          onCheckedChange={async (checked) => {
                            if (selectedNode.configKey && onToggleConfig) {
                              try {
                                await onToggleConfig(selectedNode.configKey, checked);
                                setSelectedNode({ ...selectedNode, enabled: checked });
                              } catch {
                                // Keep original state, toast already shown in handler
                              }
                            }
                          }}
                        />
                      </div>
                    )}
                  </div>

                  <div className="grid grid-cols-2 gap-2 pt-2 border-t text-xs">
                    <div>
                      <span className="text-muted-foreground">Pipeline Stage:</span>
                      <p className="font-semibold uppercase text-foreground">{selectedNode.stage}</p>
                    </div>
                    <div>
                      <span className="text-muted-foreground">24h Interceptions:</span>
                      <p className="font-semibold text-muted-foreground">
                        {selectedNode.interceptionCount} events
                      </p>
                    </div>
                  </div>
                </div>
              </div>

              {/* Card 2: Configuration (Rendered only when interactive config exists) */}
              {(selectedNode.id === "node-4" || selectedNode.id === "node-14") && (
                <div className="space-y-2">
                  <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                    Configuration
                  </h4>
                  <div className="text-xs space-y-2 rounded-md border p-3 bg-card shadow-xs">
                    <AiModerationConfigPanel
                      key={selectedNode.id}
                      scope={selectedNode.id === "node-4" ? "input" : "output"}
                      existingPolicy={safetyPolicies.find(
                        (p) =>
                          p.policyType === "model_eval" &&
                          p.scope === (selectedNode.id === "node-4" ? "input" : "output")
                      )}
                      onSavePolicy={onSavePolicy}
                    />
                  </div>
                </div>
              )}

              {/* Card 3: Description & Specs (Pushed to Drawer Bottom with Gap) */}
              <div className="space-y-2 mt-auto pt-2 pb-2">
                <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                  Description & Specs
                </h4>
                <div className="text-xs space-y-2 rounded-md border p-3 bg-muted/20">
                  {selectedNode.id === "node-2" && (
                    <ul className="list-disc pl-4 space-y-1.5 text-muted-foreground text-[11px]">
                      <li>
                        <strong className="text-foreground">1. User Role & Privileges:</strong> Queries RBAC role (<code className="text-[10px] bg-muted px-1 rounded">admin</code> vs <code className="text-[10px] bg-muted px-1 rounded">user</code>). Admins bypass visibility limits, while regular users are strictly isolated.
                      </li>
                      <li>
                        <strong className="text-foreground">2. Entity Visibility:</strong> Asserts the target Agent or Workflow is public or owned by caller (<code className="text-[10px] bg-muted px-1 rounded">isAgentVisibleTo</code>), preventing unauthorized execution.
                      </li>
                      <li>
                        <strong className="text-foreground">3. Parent Run Ownership:</strong> Verifies delegated sub-runs attach to a parent run owned by the same principal, preventing cross-tenant hijacking.
                      </li>
                      <li>
                        <strong className="text-foreground">4. Credential Status:</strong> Confirms bound credentials exist, are enabled, and match valid backend types.
                      </li>
                    </ul>
                  )}
                  {selectedNode.id === "node-3" && (
                    <ul className="list-disc pl-4 space-y-2 text-muted-foreground text-[11px]">
                      <li>
                        <strong className="text-foreground">1. input_injection (Prompt Injection Guard):</strong> Detects system control tags (<code className="text-[10px] bg-muted px-1 rounded">&lt;system-reminder&gt;</code>, <code className="text-[10px] bg-muted px-1 rounded">&lt;|im_start|&gt;</code>) and jailbreak prompt templates. <em className="text-foreground font-semibold">Action: Block</em>.
                      </li>
                      <li>
                        <strong className="text-foreground">2. topic_guard (Destructive Command Guard):</strong> Detects dangerous OS commands (<code className="text-[10px] bg-muted px-1 rounded">sudo rm -rf /</code>, <code className="text-[10px] bg-muted px-1 rounded">format c:</code>) and malicious shell scripts. <em className="text-foreground font-semibold">Action: Block</em>.
                      </li>
                      <li>
                        <strong className="text-foreground">3. secret_leak (Input Secret Pre-Scan):</strong> Pre-scans incoming prompts for accidentally pasted LLM API keys (<code className="text-[10px] bg-muted px-1 rounded">sk-...</code>), AWS keys (<code className="text-[10px] bg-muted px-1 rounded">AKIA...</code>), or SSH private keys. <em className="text-foreground font-semibold">Action: Redact / Warn</em>.
                      </li>
                      <li>
                        <strong className="text-foreground">4. Policy Configuration:</strong> Rules are configured in the <em className="text-foreground font-semibold">Safety Policies</em> table on the right (categories: <code className="text-[10px] bg-muted px-1 rounded">input_injection</code>, <code className="text-[10px] bg-muted px-1 rounded">topic_guard</code>, <code className="text-[10px] bg-muted px-1 rounded">secret_leak</code>).
                      </li>
                    </ul>
                  )}
                  {selectedNode.id === "node-4" && (
                    <div className="space-y-1.5 text-[11px] text-muted-foreground leading-relaxed">
                      <p>
                        Evaluates incoming user prompts using AI moderation engines to intercept harmful, illegal, or hostile input before LLM execution:
                      </p>
                      <ul className="list-disc pl-4 space-y-1">
                        <li>
                          <strong className="text-foreground">1. Content Harm Inspection:</strong> Scans input text for toxic content categories including hate speech, harassment, sexual content, violence, self-harm, and illegal activity guides.
                        </li>
                        <li>
                          <strong className="text-foreground">2. Prompt Attack Protection:</strong> Leverages LLM security agents to intercept complex prompt injections, system tag impersonations, and jailbreak templates.
                        </li>
                      </ul>
                    </div>
                  )}
                  {selectedNode.id === "node-5" && (
                    <ul className="list-disc pl-4 space-y-1.5 text-muted-foreground text-[11px]">
                      <li>
                        <strong className="text-foreground">1. AES-256-GCM Encryption:</strong> Encrypts all API keys, DB passwords, and SSH keys in the database using versioned keyrings (<code className="text-[10px] bg-muted px-1 rounded">CREDENTIAL_ENCRYPTION_KEYRING</code>).
                      </li>
                      <li>
                        <strong className="text-foreground">2. Zero Prompt/Client Exposure:</strong> Plaintext keys are strictly blocked from being sent to client browsers or injected into LLM System Prompts / Message histories. LLMs only reference <code className="text-[10px] bg-muted px-1 rounded">credentialId</code>.
                      </li>
                      <li>
                        <strong className="text-foreground">3. Server-Memory Consumption:</strong> Decrypted plaintext secrets exist solely in Node.js server memory and are directly consumed by trusted adapters (e.g. HTTP API clients / SSH connectors) at execution time.
                      </li>
                    </ul>
                  )}
                  {selectedNode.id === "node-6" && (
                    <ul className="list-disc pl-4 space-y-1.5 text-muted-foreground text-[11px]">
                      <li>
                        <strong className="text-foreground">1. Token Explosion Prevention:</strong> Prevents LLMs from falling into infinite recursion by repeatedly executing identical tool calls with identical parameters.
                      </li>
                      <li>
                        <strong className="text-foreground">2. Consecutive Call Tracking:</strong> Tracks tool name and argument hashes. Triggers when <code className="text-[10px] bg-muted px-1 rounded">N consecutive calls</code> (default: 3) are detected.
                      </li>
                      <li>
                        <strong className="text-foreground">3. Self-Correction Interception:</strong> Blocks the repeating call and injects a system self-correction prompt to force the LLM to switch execution strategies.
                      </li>
                    </ul>
                  )}
                  {selectedNode.id === "node-7" && (
                    <ul className="list-disc pl-4 space-y-1.5 text-muted-foreground text-[11px]">
                      <li>
                        <strong className="text-foreground">1. Admin Database Overrides:</strong> Checks <code className="text-[10px] bg-muted px-1 rounded">tool_risk_override</code> table for custom row-level admin risk and approval rules.
                      </li>
                      <li>
                        <strong className="text-foreground">2. Declared Built-in Metadata:</strong> Evaluates static tool risk mapping (<code className="text-[10px] bg-muted px-1 rounded">BUILTIN_TOOL_RISK_MAP</code>) defining riskLevel (<code className="text-[10px] bg-muted px-1 rounded">low / medium / high / critical</code>) and sideEffects.
                      </li>
                      <li>
                        <strong className="text-foreground">3. MCP Standard Annotations:</strong> Parses standard MCP hints (<code className="text-[10px] bg-muted px-1 rounded">readOnlyHint</code>, <code className="text-[10px] bg-muted px-1 rounded">destructiveHint</code>). Falls back to fail-closed default policies for unannotated MCP tools.
                      </li>
                      <li>
                        <strong className="text-foreground">4. Dynamic Parameter Escalation (assessArgs):</strong> Dynamically escalates risk based on argument content (e.g. SSH <code className="text-[10px] bg-muted px-1 rounded">ls</code> remains low, while SSH <code className="text-[10px] bg-muted px-1 rounded">rm/drop</code> escalates to critical).
                      </li>
                      <li>
                        <strong className="text-foreground">5. Policy Configuration:</strong> Governed by the <em className="text-foreground font-semibold">Tool Risk Registry</em> table on the right (overriding risk levels <code className="text-[10px] bg-muted px-1 rounded">low / medium / high / critical</code>).
                      </li>
                    </ul>
                  )}
                  {selectedNode.id === "node-8" && (
                    <ul className="list-disc pl-4 space-y-1.5 text-muted-foreground text-[11px]">
                      <li>
                        <strong className="text-foreground">1. Execution Gate & State Pause:</strong> Suspends high-risk or critical tool calls (<code className="text-[10px] bg-muted px-1 rounded">waiting_approval</code> state), rendering interactive approval cards in the Chat UI.
                      </li>
                      <li>
                        <strong className="text-foreground">2. Configurable Agent Approval Modes:</strong> Governed by per-agent or global modes (<code className="text-[10px] bg-muted px-1 rounded">auto</code> based on risk, <code className="text-[10px] bg-muted px-1 rounded">always</code> require human check, or <code className="text-[10px] bg-muted px-1 rounded">never</code> bypass).
                      </li>
                      <li>
                        <strong className="text-foreground">3. Headless Automatic Deny (G20):</strong> In scheduled / async un-attended runs (<code className="text-[10px] bg-muted px-1 rounded">isHeadless = true</code>), approval-required tools are immediately denied without waiting for timeout.
                      </li>
                      <li>
                        <strong className="text-foreground">4. Policy Configuration:</strong> Governed by the <em className="text-foreground font-semibold">Tool Risk Registry</em> table on the right (<code className="text-[10px] bg-muted px-1 rounded">Require Approval</code> column per tool).
                      </li>
                    </ul>
                  )}
                  {selectedNode.id === "node-9" && (
                    <ul className="list-disc pl-4 space-y-1.5 text-muted-foreground text-[11px]">
                      <li>
                        <strong className="text-foreground">1. Python/Bash AST Code Scan (G21):</strong> Parses Python AST before execution to inspect dangerous calls (<code className="text-[10px] bg-muted px-1 rounded">os.system</code>, <code className="text-[10px] bg-muted px-1 rounded">subprocess</code>, raw sockets).
                      </li>
                      <li>
                        <strong className="text-foreground">2. SQL AST Read-Only Parsing (G2):</strong> Uses <code className="text-[10px] bg-muted px-1 rounded">node-sql-parser</code> to enforce <code className="text-[10px] bg-muted px-1 rounded">SELECT</code>-only queries, blocking data mutations before reaching DB.
                      </li>
                      <li>
                        <strong className="text-foreground">3. SSH Command Policy Matching (G3):</strong> Verifies SSH command strings against host regex allow/deny rules (empty allowlist fails-closed).
                      </li>
                    </ul>
                  )}
                  {selectedNode.id === "node-10" && (
                    <ul className="list-disc pl-4 space-y-1.5 text-muted-foreground text-[11px]">
                      <li>
                        <strong className="text-foreground">1. Docker Sandbox Container (G4):</strong> Runs code and skill scripts inside isolated, read-only mounted Docker containers. Fails-closed if unisolated execution is attempted.
                      </li>
                      <li>
                        <strong className="text-foreground">2. Database Read-Only Transaction:</strong> Enforces read-only isolation transaction wrappers on DB connections.
                      </li>
                      <li>
                        <strong className="text-foreground">3. Restricted Host Shell Connection:</strong> Connects to SSH hosts using restricted user identities and keypairs.
                      </li>
                    </ul>
                  )}
                  {selectedNode.id === "node-11" && (
                    <ul className="list-disc pl-4 space-y-1.5 text-muted-foreground text-[11px]">
                      <li>
                        <strong className="text-foreground">1. System Control Tag Stripping:</strong> Strips system tokens (<code className="text-[10px] bg-muted px-1 rounded">&lt;system-reminder&gt;</code>, <code className="text-[10px] bg-muted px-1 rounded">&lt;|im_start|&gt;</code>) from external web / MCP tool outputs.
                      </li>
                      <li>
                        <strong className="text-foreground">2. Untrusted Boundary Enclosure:</strong> Wraps external outputs in <code className="text-[10px] bg-muted px-1 rounded">&lt;&lt;&lt;UNTRUSTED_SOURCE_DATA&gt;&gt;&gt;</code> tags, instructing the LLM to treat them strictly as reference data, not control prompts.
                      </li>
                    </ul>
                  )}
                  {selectedNode.id === "node-12" && (
                    <ul className="list-disc pl-4 space-y-1.5 text-muted-foreground text-[11px]">
                      <li>
                        <strong className="text-foreground">1. Execution Step Cap:</strong> Restricts maximum tool call and reasoning iterations per run (e.g., max 20 steps) to prevent infinite recursion.
                      </li>
                      <li>
                        <strong className="text-foreground">2. Total Token Consumption Ceiling:</strong> Dynamically tracks accumulated Prompt and Completion tokens. Triggers graceful interception once budget limits are hit.
                      </li>
                      <li>
                        <strong className="text-foreground">3. Cost & Resource Protection:</strong> Guards against runaway LLM billing, infinite retry loops, and background process hanging.
                      </li>
                    </ul>
                  )}
                  {selectedNode.id === "node-13" && (
                    <ul className="list-disc pl-4 space-y-2 text-muted-foreground text-[11px]">
                      <li>
                        <strong className="text-foreground">1. PII Masking (output_redaction):</strong> Sanitizes 11-digit mobile phone numbers (<code className="text-[10px] bg-muted px-1 rounded">138****5678</code>), 18-digit identity numbers, and email prefixes before rendering. <em className="text-foreground font-semibold">Action: Redact (Masking)</em>.
                      </li>
                      <li>
                        <strong className="text-foreground">2. Secret Redaction (secret_leak):</strong> Prevents LLM outputs from echoing OpenAI/Anthropic API keys (<code className="text-[10px] bg-muted px-1 rounded">sk-...</code>), AWS AccessKeys (<code className="text-[10px] bg-muted px-1 rounded">AKIA...</code>), SSH private keys, or Bearer auth tokens. <em className="text-foreground font-semibold">Action: Redact ([REDACTED])</em>.
                      </li>
                      <li>
                        <strong className="text-foreground">3. Policy Configuration:</strong> Rules are configured in the <em className="text-foreground font-semibold">Safety Policies</em> table on the right (categories: <code className="text-[10px] bg-muted px-1 rounded">output_redaction</code>, <code className="text-[10px] bg-muted px-1 rounded">secret_leak</code>).
                      </li>
                    </ul>
                  )}
                  {selectedNode.id === "node-14" && (
                    <div className="space-y-1.5 text-[11px] text-muted-foreground leading-relaxed">
                      <p>
                        Audits generated model completions before streaming to users to ensure final outputs strictly adhere to safety and legal compliance:
                      </p>
                      <ul className="list-disc pl-4 space-y-1">
                        <li>
                          <strong className="text-foreground">1. Response Harm Inspection:</strong> Scans generated text for accidental toxic outputs, profanity, violent descriptions, or inappropriate content generated by LLMs.
                        </li>
                        <li>
                          <strong className="text-foreground">2. Egress Compliance Guarantee:</strong> Prevents harmful instruction leaks, hallucinated dangerous advice, or inappropriate system responses from reaching the user interface.
                        </li>
                      </ul>
                    </div>
                  )}
                </div>
              </div>
            </div>
          ); })()}
        </SheetContent>
      </Sheet>
    </div>
  );
}

function NodeCard({ node, onClick }: { node: PipelineNode; onClick: () => void }) {
  const Icon = !node.isBoundary && !node.isInvariant
    ? node.enabled
      ? ShieldCheck
      : ShieldX
    : node.icon;
  return (
    <button
      onClick={node.isBoundary ? undefined : onClick}
      disabled={node.isBoundary}
      className={cn(
        "group relative flex flex-1 flex-col justify-between rounded-lg border p-2 text-left transition-all min-w-0",
        node.isBoundary
          ? "border-border bg-muted/40 text-muted-foreground cursor-default opacity-90"
          : "hover:scale-[1.02] hover:shadow-xs cursor-pointer",
        !node.isBoundary &&
          (node.isInvariant
            ? "border-amber-500/30 bg-amber-500/5 hover:border-amber-500/60"
            : node.enabled
            ? "border-emerald-500/30 bg-emerald-500/5 hover:border-emerald-500/60"
            : "border-muted bg-muted/20 opacity-60 hover:opacity-100"),
      )}
    >
      <div className="flex items-center justify-between gap-1 w-full min-w-0">
        <div className="flex items-center gap-1 min-w-0">
          <Icon
            className={cn(
              "h-3 w-3 flex-shrink-0",
              node.isBoundary
                ? "text-muted-foreground"
                : node.isInvariant
                ? "text-amber-500"
                : node.enabled
                ? "text-emerald-500"
                : "text-muted-foreground",
            )}
          />
          <span className="text-[11px] font-semibold truncate text-foreground">{node.shortName}</span>
        </div>
        <span
          className={cn(
            "h-1.5 w-1.5 rounded-full flex-shrink-0",
            node.isBoundary
              ? "bg-muted-foreground/60"
              : node.isInvariant
              ? "bg-amber-500"
              : node.enabled
              ? "bg-emerald-500"
              : "bg-muted-foreground",
          )}
        />
      </div>

      <div className="mt-1.5 flex items-center justify-between text-[10px] text-muted-foreground min-w-0">
        <span className="truncate max-w-[75px]">{node.stage}</span>
        {node.interceptionCount > 0 && (
          <Badge variant="destructive" className="h-3.5 px-1 text-[9px] font-mono shrink-0">
            {node.interceptionCount}
          </Badge>
        )}
      </div>
    </button>
  );
}
