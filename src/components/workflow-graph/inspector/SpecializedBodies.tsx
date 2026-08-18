/**
 * Inspector Bodies for Agent, Code, SQL, and Chart nodes.
 */

import {
  type ReactElement,
  useState,
  useEffect,
  useMemo,
  useCallback,
} from "react";
import { Loader2, Sparkles } from "lucide-react";
import { format as formatSql } from "sql-formatter";
import { toast } from "sonner";

import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import type {
  CanonicalAgentNode,
  CanonicalCodeNode,
  CanonicalSqlNode,
  CanonicalChartNode,
} from "@/lib/workflows";
import { Section } from "./InspectorDrawer";

// ── AgentBody ────────────────────────────────────────────────────────

interface AgentOption {
  id: string;
  name: string;
  role: string | null;
  description?: string;
  visibility?: string;
}

export function AgentBody({
  node,
  onChange,
}: {
  node: CanonicalAgentNode;
  onChange: (updated: CanonicalAgentNode) => void;
}): ReactElement {
  const [agents, setAgents] = useState<AgentOption[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    async function loadAgents() {
      try {
        const res = await fetch("/api/builtin-agents");
        if (!res.ok) return;
        const data = (await res.json()) as AgentOption[];
        if (!cancelled && Array.isArray(data)) {
          setAgents(data);
        }
      } catch {
        // Fallback
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }
    void loadAgents();
    return () => {
      cancelled = true;
    };
  }, []);

  const { systemAgents, customAgents } = useMemo(() => {
    const sys: AgentOption[] = [];
    const cust: AgentOption[] = [];
    for (const a of agents) {
      if (a.role || a.visibility === "public") {
        sys.push(a);
      } else {
        cust.push(a);
      }
    }
    return { systemAgents: sys, customAgents: cust };
  }, [agents]);

  const taskValue = node.inputs.task ?? "";

  return (
    <>
      <Section title="Agent Selection">
        {isLoading ? (
          <div className="flex items-center gap-1.5 h-7 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Loading agents…
          </div>
        ) : (
          <select
            className="h-7 w-full rounded border border-input bg-background px-2 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
            value={node.inputs.agent_id}
            onChange={(e) => {
              const selected = agents.find((a) => a.id === e.target.value);
              if (selected) {
                onChange({
                  ...node,
                  inputs: {
                    ...node.inputs,
                    name: selected.name,
                    agent_id: selected.id,
                  },
                });
              }
            }}
          >
            {systemAgents.length > 0 && (
              <optgroup label="System & Builtin Agents">
                {systemAgents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name} {a.role ? `(${a.role})` : ""}
                  </option>
                ))}
              </optgroup>
            )}
            {customAgents.length > 0 && (
              <optgroup label="Custom Agents">
                {customAgents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </optgroup>
            )}
            {!agents.some((a) => a.id === node.inputs.agent_id) && (
              <option value={node.inputs.agent_id}>
                {node.inputs.name} (Current)
              </option>
            )}
          </select>
        )}
      </Section>

      <Section title="Task Instructions">
        <textarea
          className="w-full rounded border border-input bg-background p-2 font-mono text-[11px] leading-snug text-foreground resize-none overflow-y-auto focus:outline-none focus:ring-1 focus:ring-ring"
          rows={6}
          placeholder="Task instructions passed to this agent..."
          value={taskValue}
          onChange={(e) =>
            onChange({
              ...node,
              inputs: {
                ...node.inputs,
                task: e.target.value,
              },
            })
          }
        />
      </Section>
    </>
  );
}

// ── CodeBody ─────────────────────────────────────────────────────────

export function CodeBody({
  node,
  onChange,
}: {
  node: CanonicalCodeNode;
  onChange: (updated: CanonicalCodeNode) => void;
}): ReactElement {
  const language = node.inputs.language;
  const codeText = node.inputs.code_text ?? "";
  const datasetNames = Array.isArray(node.inputs.datasets)
    ? node.inputs.datasets.filter((d: unknown): d is string => typeof d === "string")
    : [];

  return (
    <>
      <Section title="Language">
        <select
          className="h-7 w-full rounded border border-input bg-background px-2 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
          value={language}
          onChange={(e) =>
            onChange({
              ...node,
              inputs: {
                ...node.inputs,
                language: e.target.value as "python" | "javascript",
              },
            })
          }
        >
          <option value="python">Python</option>
          <option value="javascript">JavaScript</option>
        </select>
      </Section>

      <Section title="Datasets">
        <Input
          className="h-7 text-xs font-mono"
          value={datasetNames.join(", ")}
          placeholder="e.g. dataset_1, dataset_2"
          onChange={(e) => {
            const datasets = e.target.value
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean);
            onChange({
              ...node,
              inputs: {
                ...node.inputs,
                datasets,
              },
            });
          }}
        />
      </Section>

      <Section title="Code">
        <textarea
          className="w-full rounded border border-input bg-background p-2 font-mono text-[11px] leading-snug text-foreground resize-none overflow-y-auto focus:outline-none focus:ring-1 focus:ring-ring"
          rows={30}
          value={codeText}
          onChange={(e) =>
            onChange({
              ...node,
              inputs: {
                ...node.inputs,
                code_text: e.target.value,
              },
            })
          }
        />
      </Section>
    </>
  );
}

// ── SqlBody ──────────────────────────────────────────────────────────

interface DataSourceOption {
  id: string;
  name: string;
  provider: string;
}

export function SqlBody({
  node,
  onChange,
}: {
  node: CanonicalSqlNode;
  onChange: (updated: CanonicalSqlNode) => void;
}): ReactElement {
  const [dataSources, setDataSources] = useState<DataSourceOption[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    async function loadDataSources() {
      try {
        const res = await fetch("/api/data-sources");
        if (!res.ok) return;
        const data = (await res.json()) as DataSourceOption[];
        if (!cancelled && Array.isArray(data)) {
          setDataSources(data);
        }
      } catch {
        // Fallback
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }
    void loadDataSources();
    return () => {
      cancelled = true;
    };
  }, []);

  const sqlText = node.inputs.sql_text;

  const handleFormatSql = useCallback(() => {
    try {
      const formatted = formatSql(sqlText, {
        language: "duckdb",
        tabWidth: 2,
        keywordCase: "preserve",
      });
      onChange({
        ...node,
        inputs: {
          ...node.inputs,
          sql_text: formatted,
        },
      });
      toast.success("SQL formatted");
    } catch {
      toast.error("Format SQL failed: syntax error");
    }
  }, [sqlText, node, onChange]);

  return (
    <>
      <Section title="Data source">
        {isLoading ? (
          <div className="flex items-center gap-1.5 h-7 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Loading data sources…
          </div>
        ) : (
          <select
            className="h-7 w-full rounded border border-input bg-background px-2 text-xs font-mono text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
            value={node.inputs.data_source_name}
            onChange={(e) => {
              const selected = dataSources.find((ds) => ds.name === e.target.value);
              onChange({
                ...node,
                inputs: {
                  ...node.inputs,
                  data_source_name: e.target.value,
                  data_source_id: selected?.id ?? node.inputs.data_source_id,
                },
              });
            }}
          >
            {dataSources.map((ds) => (
              <option key={ds.id} value={ds.name}>
                {ds.name} ({ds.provider})
              </option>
            ))}
            {!dataSources.some((ds) => ds.name === node.inputs.data_source_name) &&
              node.inputs.data_source_name && (
                <option value={node.inputs.data_source_name}>
                  {node.inputs.data_source_name}
                </option>
              )}
          </select>
        )}
      </Section>
      <Section title="Dataset name">
        <Input
          className="h-7 text-xs font-mono"
          value={node.inputs.dataset_name ?? ""}
          placeholder="Dataset output identifier"
          onChange={(e) =>
            onChange({
              ...node,
              inputs: {
                ...node.inputs,
                dataset_name: e.target.value || undefined,
              },
            })
          }
        />
      </Section>
      <Section title="Row limit">
        <Input
          type="number"
          className="h-7 text-xs font-mono"
          value={node.inputs.row_limit ?? 200}
          onChange={(e) => {
            const val = parseInt(e.target.value, 10);
            onChange({
              ...node,
              inputs: {
                ...node.inputs,
                row_limit: isNaN(val) ? undefined : val,
              },
            });
          }}
        />
      </Section>
      <Section
        title="Query"
        headerAction={
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-5 px-1.5 text-[10px] text-muted-foreground hover:text-foreground gap-1"
            onClick={handleFormatSql}
            title="Format SQL query"
          >
            <Sparkles className="h-3 w-3" />
            Format SQL
          </Button>
        }
      >
        <div className="flex flex-col gap-1">
          <textarea
            className="w-full rounded border border-input bg-background p-2 font-mono text-[11px] leading-snug text-foreground resize-none overflow-y-auto focus:outline-none focus:ring-1 focus:ring-ring"
            rows={30}
            value={sqlText}
            onChange={(e) =>
              onChange({
                ...node,
                inputs: {
                  ...node.inputs,
                  sql_text: e.target.value,
                },
              })
            }
          />
        </div>
      </Section>
    </>
  );
}

// ── ChartBody ────────────────────────────────────────────────────────

export function ChartBody({
  node,
  onChange,
}: {
  node: CanonicalChartNode;
  onChange: (updated: CanonicalChartNode) => void;
}): ReactElement {
  const dataset = node.inputs.dataset;
  const dataRefStr =
    dataset === undefined
      ? ""
      : Array.isArray(dataset)
      ? dataset.join(", ")
      : String(dataset);

  const [prevConfig, setPrevConfig] = useState(node.inputs.config);
  const [configText, setConfigText] = useState(() =>
    JSON.stringify(node.inputs.config ?? {}, null, 2),
  );
  const [jsonError, setJsonError] = useState<string | null>(null);

  if (prevConfig !== node.inputs.config) {
    setPrevConfig(node.inputs.config);
    setConfigText(JSON.stringify(node.inputs.config ?? {}, null, 2));
    setJsonError(null);
  }

  const handleConfigChange = (text: string) => {
    setConfigText(text);
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>;
      setJsonError(null);
      onChange({
        ...node,
        inputs: {
          ...node.inputs,
          config: parsed,
        },
      });
    } catch (err) {
      setJsonError(err instanceof Error ? err.message : "Invalid JSON");
    }
  };

  const handleFormatJson = useCallback(() => {
    try {
      const parsed = JSON.parse(configText) as Record<string, unknown>;
      const formatted = JSON.stringify(parsed, null, 2);
      setConfigText(formatted);
      setJsonError(null);
      onChange({
        ...node,
        inputs: {
          ...node.inputs,
          config: parsed,
        },
      });
      toast.success("JSON formatted");
    } catch {
      toast.error("Prettify JSON failed: invalid JSON syntax");
    }
  }, [configText, node, onChange]);

  return (
    <>
      <Section title="Renderer">
        <select
          className="h-7 w-full rounded border border-input bg-background px-2 text-xs font-mono text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
          value={node.inputs.renderer ?? "echarts"}
          onChange={(e) =>
            onChange({
              ...node,
              inputs: {
                ...node.inputs,
                renderer: e.target.value as "echarts",
              },
            })
          }
        >
          <option value="echarts">echarts</option>
        </select>
      </Section>
      <Section title="Data ref">
        <Input
          className="h-7 text-xs font-mono"
          value={dataRefStr}
          placeholder="e.g. @node_1.outputs.dataset"
          onChange={(e) => {
            const val = e.target.value.trim();
            const datasetVal = val.includes(",")
              ? val.split(",").map((s) => s.trim()).filter(Boolean)
              : val || undefined;
            onChange({
              ...node,
              inputs: {
                ...node.inputs,
                dataset: datasetVal,
              },
            });
          }}
        />
      </Section>
      <Section
        title="Config"
        headerAction={
          <div className="flex items-center gap-2">
            {jsonError && (
              <span className="text-[10px] text-destructive truncate max-w-[120px]">
                {jsonError}
              </span>
            )}
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-5 px-1.5 text-[10px] text-muted-foreground hover:text-foreground gap-1"
              onClick={handleFormatJson}
              title="Prettify JSON config"
            >
              <Sparkles className="h-3 w-3" />
              Prettify JSON
            </Button>
          </div>
        }
      >
        <div className="flex flex-col gap-1">
          <textarea
            className="w-full rounded border bg-background p-2 font-mono text-[11px] leading-snug text-foreground resize-none overflow-y-auto focus:outline-none focus:ring-1 focus:ring-ring"
            rows={30}
            value={configText}
            onChange={(e) => handleConfigChange(e.target.value)}
          />
        </div>
      </Section>
    </>
  );
}
