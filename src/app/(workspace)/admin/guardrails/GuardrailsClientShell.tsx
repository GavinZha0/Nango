"use client";

/**
 * GuardrailsClientShell — Main single-page interactive client workspace.
 *
 * Manages URL query param `?tab=config` (default) vs `?tab=logs`,
 * global emergency bypass toggle, SWR data fetching, and PATCH updates.
 * Uses sonner `toast` for clean notification messages.
 */

import { useState, useEffect, useCallback } from "react";
import { useSearchParams, useRouter, usePathname } from "next/navigation";
import {
  ShieldCheck,
  ShieldAlert,
  Clock,
  RefreshCw,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { GuardrailDashboard } from "./GuardrailDashboard";
import { InterceptionLogsTable, type InterceptionLogItem } from "./InterceptionLogsTable";
import type { ToolRiskItem } from "./ToolRiskTable";
import type { SafetyPolicyItem } from "./ContentSafetyTable";

export function GuardrailsClientShell() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  const currentTab = searchParams.get("tab") === "logs" ? "logs" : "config";

  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<{
    configs: Record<string, string>;
    toolOverrides: ToolRiskItem[];
    safetyPolicies: SafetyPolicyItem[];
    builtinTools: unknown[];
    interceptionLogs: InterceptionLogItem[];
  }>({
    configs: {},
    toolOverrides: [],
    safetyPolicies: [],
    builtinTools: [],
    interceptionLogs: [],
  });

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/admin/guardrails");
      if (!res.ok) {
        throw new Error(`Failed to load guardrails state (${res.status})`);
      }
      const json = await res.json();
      setData({
        configs: json.configs ?? {},
        toolOverrides: json.toolOverrides ?? [],
        safetyPolicies: json.safetyPolicies ?? [],
        builtinTools: json.builtinTools ?? [],
        interceptionLogs: json.interceptionLogs ?? [],
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(msg);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let ignore = false;
    async function load() {
      setLoading(true);
      try {
        const res = await fetch("/api/admin/guardrails");
        if (!res.ok) {
          throw new Error(`Failed to load guardrails state (${res.status})`);
        }
        const json = await res.json();
        if (!ignore) {
          setData({
            configs: json.configs ?? {},
            toolOverrides: json.toolOverrides ?? [],
            safetyPolicies: json.safetyPolicies ?? [],
            builtinTools: json.builtinTools ?? [],
            interceptionLogs: json.interceptionLogs ?? [],
          });
        }
      } catch (err) {
        if (!ignore) {
          const msg = err instanceof Error ? err.message : String(err);
          toast.error(msg);
        }
      } finally {
        if (!ignore) {
          setLoading(false);
        }
      }
    }
    void load();
    return () => {
      ignore = true;
    };
  }, []);

  const handleTabChange = (val: string) => {
    const params = new URLSearchParams(searchParams.toString());
    if (val === "logs") {
      params.set("tab", "logs");
    } else {
      params.delete("tab"); // Default is config
    }
    router.push(`${pathname}?${params.toString()}`);
  };

  const handleSaveOverride = async (item: ToolRiskItem) => {
    try {
      const res = await fetch("/api/admin/guardrails", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          toolOverride: {
            source: item.source,
            mcpServerId: item.mcpServerId,
            toolName: item.toolName,
            riskLevel: item.riskLevel,
            requireApproval: item.requireApproval,
            headlessAllowed: item.headlessAllowed,
            enabled: item.enabled,
          },
        }),
      });
      if (!res.ok) {
        throw new Error(`Failed to save tool override (${res.status})`);
      }
      toast.success(`Updated risk override for ${item.toolName}`);
      await fetchData();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  };

  const handleDeleteOverride = async (item: ToolRiskItem) => {
    if (!item.id) return;
    try {
      const res = await fetch("/api/admin/guardrails", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deleteOverrideId: item.id }),
      });
      if (!res.ok) {
        throw new Error(`Failed to delete tool override (${res.status})`);
      }
      toast.success(`Deleted risk override for ${item.toolName}`);
      await fetchData();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  };

  const handleSavePolicy = async (policy: SafetyPolicyItem) => {
    try {
      const res = await fetch("/api/admin/guardrails", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          safetyPolicy: policy,
        }),
      });
      if (!res.ok) {
        throw new Error(`Failed to save policy (${res.status})`);
      }
      toast.success(`Saved safety policy: ${policy.displayName}`);
      await fetchData();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  };

  const handleDeletePolicy = async (policyId: number) => {
    try {
      const res = await fetch("/api/admin/guardrails", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          deletePolicyId: policyId,
        }),
      });
      if (!res.ok) {
        throw new Error(`Failed to delete policy (${res.status})`);
      }
      toast.success("Deleted safety policy");
      await fetchData();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  };

  const handleToggleConfig = async (key: string, enabled: boolean) => {
    try {
      const res = await fetch("/api/admin/guardrails", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          configs: [{ key, value: String(enabled) }],
        }),
      });
      if (!res.ok) {
        throw new Error(`Failed to update config (${res.status})`);
      }
      toast.success(`Updated node configuration`);
      await fetchData();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="flex h-[calc(100vh-3.5rem)] w-full flex-col overflow-hidden bg-background p-4 gap-3">
      {/* Integrated Top Header Bar */}
      <div className="flex items-center justify-between gap-4 border-b pb-2.5">
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <ShieldAlert className="h-4.5 w-4.5" />
            </div>
            <h1 className="text-base font-bold tracking-tight text-foreground">
              Guardrails
            </h1>
          </div>

          {/* Embedded Header Buttons Switcher */}
          <div className="flex items-center gap-2">
            <Button
              variant={currentTab === "config" ? "secondary" : "outline"}
              size="sm"
              className={cn(
                "h-7.5 text-xs gap-1.5 font-semibold",
                currentTab === "config" && "bg-muted font-bold text-foreground shadow-xs",
              )}
              onClick={() => handleTabChange("config")}
            >
              <ShieldCheck className="h-3.5 w-3.5 text-primary" />
              <span>Config</span>
            </Button>

            <Button
              variant={currentTab === "logs" ? "secondary" : "outline"}
              size="sm"
              className={cn(
                "h-7.5 text-xs gap-1.5 font-semibold",
                currentTab === "logs" && "bg-muted font-bold text-foreground shadow-xs",
              )}
              onClick={() => handleTabChange("logs")}
            >
              <Clock className="h-3.5 w-3.5 text-primary" />
              <span>Audit</span>
            </Button>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <Button
            variant="outline"
            size="sm"
            className="h-7.5 text-xs gap-1.5"
            onClick={() => void fetchData()}
            disabled={loading}
          >
            <RefreshCw className={`h-3 w-3 ${loading ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        </div>
      </div>

      {/* Main Body View */}
      <div className="flex-1 overflow-hidden">
        {currentTab === "config" ? (
          <GuardrailDashboard
            configs={data.configs}
            toolOverrides={data.toolOverrides}
            safetyPolicies={data.safetyPolicies}
            interceptionLogs={data.interceptionLogs}
            onSaveOverride={handleSaveOverride}
            onDeleteOverride={handleDeleteOverride}
            onSavePolicy={handleSavePolicy}
            onDeletePolicy={handleDeletePolicy}
            onToggleConfig={handleToggleConfig}
          />
        ) : (
          <InterceptionLogsTable
            logs={data.interceptionLogs}
            onRefresh={() => void fetchData()}
          />
        )}
      </div>
    </div>
  );
}
