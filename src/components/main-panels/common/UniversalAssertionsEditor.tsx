"use client";

/**
 * Universal Assertions Editor component.
 *
 * Single source of truth for editing test assertions across:
 * 1. Verification (MCP / Workflows)
 * 2. Web Auto (Browser automation)
 * 3. Evaluation (Agent multi-turn LLM benchmark)
 *
 * Tab ordering strictly adheres to:
 * Deterministic Assertions FIRST -> Stochastic (LLM Judge) Assertions NEXT -> Raw JSON LAST.
 *
 * See docs/verification.md and docs/evaluation.md.
 */

import { useState, useMemo, type ReactNode } from "react";
import { Plus, X, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import type {
  AssertionSpec,
  JsonPathOperator,
  MetricName,
  MetricOperator,
} from "@/lib/assertions";

export type UniversalEditorMode = "verification" | "web-auto" | "evaluation";

export interface UniversalAssertionsEditorProps {
  mode: UniversalEditorMode;
  /** Array form — used when the parent manages an AssertionSpec[] state directly */
  assertions?: AssertionSpec[];
  onChange?: (updated: AssertionSpec[]) => void;
  /** Draft text form — used when the parent manages raw JSON draft text (e.g. Verification useJsonDraft) */
  draft?: {
    text: string;
    setText: (next: string) => void;
    parseError: string | null;
    saving?: boolean;
    isDirty?: boolean;
  };
  onErrorChange?: (error: string | null) => void;
  readOnly?: boolean;
  saving?: boolean;
  overrideText?: string | null;
}

type TabType =
  | "path_match"
  | "expression"
  | "schema"
  | "tool_call"
  | "metric"
  | "llm_judge"
  | "json";

const SCHEMA_TEMPLATES = [
  {
    label: "Object with id",
    schema: {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "string", minLength: 8 },
        age: { type: "number", minimum: 18 },
      },
    },
  },
  {
    label: "Array of strings",
    schema: {
      type: "array",
      items: { type: "string" },
      minItems: 1,
    },
  },
  {
    label: "Success response",
    schema: {
      type: "object",
      required: ["success"],
      properties: {
        success: { type: "boolean" },
        data: { type: "object" },
      },
    },
  },
];

function computeDefaultTab(assertions: AssertionSpec[], mode: UniversalEditorMode): TabType {
  const hasExpressions = assertions.some((a) => a.type === "js_expression");
  if (hasExpressions) return "expression";

  const hasPathMatches = assertions.some((a) => a.type === "jsonpath");
  if (hasPathMatches) return "path_match";

  if (mode === "verification") {
    const hasSchema = assertions.some((a) => a.type === "json_schema");
    if (hasSchema) return "schema";
  }

  if (mode === "evaluation") {
    const hasToolCalls = assertions.some((a) => a.type === "tool_call");
    if (hasToolCalls) return "tool_call";

    const hasMetrics = assertions.some((a) => a.type === "metric");
    if (hasMetrics) return "metric";
  }

  if (mode === "web-auto" || mode === "evaluation") {
    const hasLlmJudges = assertions.some(
      (a) => a.type === "llm_judge" || a.type === "expectation" || a.type === "llm_expectation",
    );
    if (hasLlmJudges) return "llm_judge";
  }

  return "expression";
}

export function UniversalAssertionsEditor({
  mode,
  assertions: propAssertions,
  onChange: propOnChange,
  draft,
  onErrorChange,
  readOnly = false,
  saving = false,
  overrideText = null,
}: UniversalAssertionsEditorProps): ReactNode {
  // Parse assertions either from draft.text or from propAssertions
  const currentAssertions: AssertionSpec[] = useMemo(() => {
    if (draft) {
      if (!draft.text || draft.text.trim() === "") return [];
      try {
        const parsed = JSON.parse(draft.text);
        return Array.isArray(parsed) ? (parsed as AssertionSpec[]) : [];
      } catch {
        return [];
      }
    }
    return propAssertions ?? [];
  }, [draft, propAssertions]);

  const [subTab, setSubTab] = useState<TabType>(() =>
    computeDefaultTab(currentAssertions, mode),
  );

  const canonicalJson = useMemo(() => {
    if (draft) return draft.text;
    return JSON.stringify(currentAssertions, null, 2);
  }, [draft, currentAssertions]);

  const [rawJsonState, setRawJsonState] = useState<{ text: string; prevCanonical: string }>({
    text: canonicalJson,
    prevCanonical: canonicalJson,
  });
  const [rawJsonError, setRawJsonError] = useState<string | null>(draft?.parseError ?? null);

  if (canonicalJson !== rawJsonState.prevCanonical) {
    setRawJsonState({
      text: canonicalJson,
      prevCanonical: canonicalJson,
    });
    setRawJsonError(draft?.parseError ?? null);
    setSubTab(computeDefaultTab(currentAssertions, mode));
  }

  const rawJsonText = rawJsonState.text;
  const setRawJsonText = (val: string) => setRawJsonState((prev) => ({ ...prev, text: val }));

  const commitAssertions = (nextList: AssertionSpec[]) => {
    if (readOnly) return;
    if (draft) {
      const nextStr = nextList.length === 0 ? "" : JSON.stringify(nextList, null, 2);
      draft.setText(nextStr);
      setRawJsonState({ text: nextStr, prevCanonical: nextStr });
      setRawJsonError(null);
      onErrorChange?.(null);
    } else if (propOnChange) {
      propOnChange(nextList);
      const nextStr = JSON.stringify(nextList, null, 2);
      setRawJsonState({ text: nextStr, prevCanonical: nextStr });
      setRawJsonError(null);
      onErrorChange?.(null);
    }
  };

  // Grouped assertions indicators
  const hasExpressions = useMemo(
    () => currentAssertions.some((a) => a.type === "js_expression"),
    [currentAssertions],
  );
  const hasPathMatches = useMemo(
    () => currentAssertions.some((a) => a.type === "jsonpath"),
    [currentAssertions],
  );
  const hasSchema = useMemo(
    () => currentAssertions.some((a) => a.type === "json_schema"),
    [currentAssertions],
  );
  const hasToolCalls = useMemo(
    () => currentAssertions.some((a) => a.type === "tool_call"),
    [currentAssertions],
  );
  const hasMetrics = useMemo(
    () => currentAssertions.some((a) => a.type === "metric"),
    [currentAssertions],
  );
  const hasLlmJudges = useMemo(
    () =>
      currentAssertions.some(
        (a) => a.type === "llm_judge" || a.type === "expectation" || a.type === "llm_expectation",
      ),
    [currentAssertions],
  );

  const schemaAssertion = useMemo(
    () => currentAssertions.find((a) => a.type === "json_schema"),
    [currentAssertions],
  );

  const canonicalSchemaText = useMemo(() => {
    return schemaAssertion && "schema" in schemaAssertion
      ? JSON.stringify(schemaAssertion.schema, null, 2)
      : "";
  }, [schemaAssertion]);

  const [schemaTextState, setSchemaTextState] = useState<{ text: string; prevCanonical: string }>({
    text: canonicalSchemaText,
    prevCanonical: canonicalSchemaText,
  });

  if (canonicalSchemaText !== schemaTextState.prevCanonical) {
    setSchemaTextState({
      text: canonicalSchemaText,
      prevCanonical: canonicalSchemaText,
    });
  }

  const schemaRawText = schemaTextState.text;
  const setSchemaRawText = (val: string) => setSchemaTextState((prev) => ({ ...prev, text: val }));
  const [schemaError, setSchemaError] = useState<string | null>(null);

  // Tab definitions: JS Expression FIRST -> JSONPath NEXT -> Domain-specific -> LLM Judge -> JSON Last
  const TABS = useMemo(() => {
    const list: Array<{ id: TabType; label: string; hasDot: boolean }> = [];

    // 1. All modes have JS Expression and JSONPath first
    list.push({ id: "expression", label: "JS Expression", hasDot: hasExpressions });
    list.push({ id: "path_match", label: "JSONPath", hasDot: hasPathMatches });

    // 2. Only Verification has Schema
    if (mode === "verification") {
      list.push({ id: "schema", label: "Schema", hasDot: hasSchema });
    }

    // 3. Evaluation has Tool Calls & Metrics
    if (mode === "evaluation") {
      list.push({ id: "tool_call", label: "Tool Calls", hasDot: hasToolCalls });
      list.push({ id: "metric", label: "Metrics", hasDot: hasMetrics });
    }

    // 4. Web Auto and Evaluation have LLM Judge (Stochastic)
    if (mode === "web-auto" || mode === "evaluation") {
      list.push({ id: "llm_judge", label: "LLM Judge", hasDot: hasLlmJudges });
    }

    // 5. All modes end with JSON
    list.push({ id: "json", label: "JSON", hasDot: false });
    return list;
  }, [mode, hasExpressions, hasPathMatches, hasSchema, hasToolCalls, hasMetrics, hasLlmJudges]);

  const isHistoryView = overrideText !== null;
  const activeTab = isHistoryView ? "json" : subTab;
  const isSaving = saving || Boolean(draft?.saving);

  const handleRawJsonChange = (val: string) => {
    setRawJsonText(val);
    if (!val.trim()) {
      commitAssertions([]);
      return;
    }
    try {
      const parsed = JSON.parse(val);
      if (Array.isArray(parsed)) {
        commitAssertions(parsed as AssertionSpec[]);
      } else {
        const err = "Assertions must be a JSON array.";
        setRawJsonError(err);
        onErrorChange?.(err);
      }
    } catch (e: unknown) {
      const err = e instanceof Error ? e.message : String(e);
      setRawJsonError(err);
      onErrorChange?.(err);
    }
  };

  const removeAssertion = (targetIndex: number) => {
    const next = currentAssertions.filter((_, idx) => idx !== targetIndex);
    commitAssertions(next);
  };

  const addAssertion = (spec: AssertionSpec) => {
    const next = [...currentAssertions, spec];
    commitAssertions(next);
  };

  const updateAssertionAt = (targetIndex: number, updated: AssertionSpec) => {
    const next = [...currentAssertions];
    next[targetIndex] = updated;
    commitAssertions(next);
  };

  function handleSchemaTextChange(val: string) {
    setSchemaRawText(val);
    if (val.trim() === "") {
      setSchemaError(null);
      const next: AssertionSpec[] = currentAssertions.filter((a) => a.type !== "json_schema");
      commitAssertions(next);
      return;
    }
    try {
      const parsed = JSON.parse(val) as unknown;
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        setSchemaError("Schema must be a JSON object.");
        return;
      }
      setSchemaError(null);
      const next: AssertionSpec[] = currentAssertions.filter((a) => a.type !== "json_schema");
      next.unshift({ type: "json_schema", schema: parsed as Record<string, unknown> });
      commitAssertions(next);
    } catch (err) {
      setSchemaError(err instanceof Error ? err.message : String(err));
    }
  }

  function applySchemaTemplate(schemaObj: Record<string, unknown>) {
    const str = JSON.stringify(schemaObj, null, 2);
    setSchemaRawText(str);
    setSchemaError(null);
    const next: AssertionSpec[] = currentAssertions.filter((a) => a.type !== "json_schema");
    next.unshift({ type: "json_schema", schema: schemaObj });
    commitAssertions(next);
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-muted/5 border-l border-t">
      {/* Sub-tabs header with capsule tabs and emerald indicator dots */}
      <div className="flex h-8 shrink-0 items-center justify-between border-b bg-muted/20 px-3 py-1">
        <div className="flex items-center gap-1">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setSubTab(t.id)}
              disabled={isHistoryView || (activeTab === "json" && rawJsonError !== null && t.id !== "json")}
              className={cn(
                "flex items-center gap-1.5 px-2 py-0.5 text-[11px] font-medium rounded transition-colors border",
                activeTab === t.id
                  ? "bg-muted text-foreground border-muted-foreground/10 font-semibold"
                  : "text-muted-foreground hover:bg-muted/30 hover:text-foreground border-transparent",
                !isHistoryView && activeTab === "json" && rawJsonError !== null && t.id !== "json"
                  ? "opacity-50 cursor-not-allowed"
                  : "",
                isHistoryView && t.id !== "json" ? "opacity-50 cursor-not-allowed" : "",
              )}
            >
              <span>{t.label}</span>
              {t.hasDot && (
                <span className="w-1 h-1 rounded-full bg-emerald-500 shrink-0 animate-pulse-subtle" />
              )}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1.5">
          {isSaving && (
            <Loader2 className="h-2.5 w-2.5 animate-spin text-muted-foreground" />
          )}
        </div>
      </div>

      {/* Tab content area */}
      <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-3">
        {/* 1. JSONPath Tab (Universal: Path + Operator + Expected) */}
        {activeTab === "path_match" && (
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-4">
              <div className="space-y-0.5">
                <Label className="text-[10px] font-semibold text-muted-foreground block">
                  • Paths with <code className="text-amber-500 font-semibold">$</code> query root (e.g. $.isError). Paths without query <code className="text-amber-500 font-semibold">structuredContent</code>.<br />
                  • Expected value supports literal values or <code className="text-amber-500 font-semibold">{"{{ input.path }}"}</code> variable templates.
                </Label>
              </div>
              {!readOnly && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-5 px-1.5 text-[9px] gap-1 hover:bg-muted font-semibold shrink-0"
                  onClick={() => addAssertion({ type: "jsonpath", path: "", operator: "==", expected: "" })}
                >
                  <Plus className="h-2.5 w-2.5" /> Add
                </Button>
              )}
            </div>

            <div className="space-y-2">
              {currentAssertions.map((spec, idx) => {
                if (spec.type !== "jsonpath") return null;
                const path = spec.path;
                const operator = spec.operator || "==";
                const expectedVal = spec.expected ?? "";
                return (
                  <div key={idx} className="flex items-center gap-1.5">
                    <Input
                      value={path}
                      onChange={(e) =>
                        updateAssertionAt(idx, {
                          type: "jsonpath",
                          path: e.target.value,
                          operator,
                          expected: expectedVal,
                        })
                      }
                      placeholder="$.data.user.role or isError"
                      disabled={readOnly}
                      className="h-7 text-xs flex-1 bg-muted/20 border-muted-foreground/20 focus:border-amber-500/30"
                    />
                    <Select
                      value={operator}
                      disabled={readOnly}
                      onValueChange={(val: string | null) => {
                        if (val)
                          updateAssertionAt(idx, {
                            type: "jsonpath",
                            path,
                            operator: val as JsonPathOperator,
                            expected: expectedVal,
                          });
                      }}
                    >
                      <SelectTrigger className="w-24 h-7 text-xs bg-muted/20 border-muted-foreground/20">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="==">==</SelectItem>
                        <SelectItem value="!=">!=</SelectItem>
                        <SelectItem value=">">&gt;</SelectItem>
                        <SelectItem value=">=">&gt;=</SelectItem>
                        <SelectItem value="<">&lt;</SelectItem>
                        <SelectItem value="<=">&lt;=</SelectItem>
                        <SelectItem value="contains">contains</SelectItem>
                        <SelectItem value="matches">matches</SelectItem>
                        <SelectItem value="exists">exists</SelectItem>
                      </SelectContent>
                    </Select>
                    {operator !== "exists" && (
                      <Input
                        value={
                          typeof expectedVal === "object"
                            ? JSON.stringify(expectedVal)
                            : String(expectedVal ?? "")
                        }
                        onChange={(e) => {
                          let parsed: unknown = e.target.value;
                          try {
                            parsed = JSON.parse(e.target.value);
                          } catch {
                            // keep as string
                          }
                          updateAssertionAt(idx, {
                            type: "jsonpath",
                            path,
                            operator,
                            expected: parsed,
                          });
                        }}
                        placeholder="expected value"
                        disabled={readOnly}
                        className="h-7 text-xs flex-1 bg-muted/20 border-muted-foreground/20 focus:border-amber-500/30"
                      />
                    )}
                    {!readOnly && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-7 w-7 p-0 text-muted-foreground/50 hover:text-destructive hover:bg-destructive/10 shrink-0"
                        onClick={() => removeAssertion(idx)}
                      >
                        <X className="h-3 w-3" />
                      </Button>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* 2. JS Expression Tab */}
        {activeTab === "expression" && (
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <div className="space-y-0.5">
                <Label className="text-[10px] font-semibold text-muted-foreground">
                  • Bindings: <code className="font-semibold text-amber-500">result</code> (structured output), <code className="font-semibold text-amber-500">root</code> (full payload), <code className="font-semibold text-amber-500">input</code>.
                </Label>
              </div>
              {!readOnly && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-5 px-1.5 text-[9px] gap-1 hover:bg-muted font-semibold"
                  onClick={() => addAssertion({ type: "js_expression", expression: "" })}
                >
                  <Plus className="h-2.5 w-2.5" /> Add
                </Button>
              )}
            </div>

            <div className="space-y-2">
              {currentAssertions.map((spec, idx) => {
                if (spec.type !== "js_expression") return null;
                return (
                  <div key={idx} className="flex items-center gap-1.5">
                    <Input
                      value={spec.expression}
                      onChange={(e) => updateAssertionAt(idx, { ...spec, expression: e.target.value })}
                      placeholder="result.status === 'success' || root.total > 0"
                      disabled={readOnly}
                      className="h-7 text-xs flex-1 bg-muted/20 border-muted-foreground/20 focus:border-amber-500/30"
                    />
                    {!readOnly && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-7 w-7 p-0 text-muted-foreground/50 hover:text-destructive hover:bg-destructive/10 shrink-0"
                        onClick={() => removeAssertion(idx)}
                      >
                        <X className="h-3 w-3" />
                      </Button>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* 3. JSON Schema Tab */}
        {activeTab === "schema" && (
          <div className="space-y-3 h-full flex flex-col">
            <div className="flex items-center justify-between">
              <Label className="text-[10px] font-semibold text-muted-foreground">
                JSON Schema Draft 2020-12 of <code className="text-amber-500 font-semibold">structuredContent</code>
              </Label>
              {!readOnly && (
                <div className="flex gap-1">
                  {SCHEMA_TEMPLATES.map((tmpl) => (
                    <Button
                      key={tmpl.label}
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-5 px-1.5 text-[9px] hover:bg-muted font-semibold"
                      onClick={() => applySchemaTemplate(tmpl.schema)}
                    >
                      {tmpl.label}
                    </Button>
                  ))}
                </div>
              )}
            </div>
            <div className="relative flex-1 min-h-[120px]">
              <textarea
                value={schemaRawText}
                onChange={(e) => handleSchemaTextChange(e.target.value)}
                disabled={readOnly}
                spellCheck={false}
                placeholder={`{\n  "type": "object",\n  "required": ["id"],\n  "properties": {\n    "id": { "type": "string" }\n  }\n}`}
                className={cn(
                  "h-full w-full resize-none rounded-md border bg-background p-2 font-mono text-xs leading-relaxed",
                  schemaError && "border-destructive",
                )}
              />
            </div>
            {schemaError && (
              <p className="text-[10px] text-destructive">{schemaError}</p>
            )}
          </div>
        )}

        {/* 4. Tool Calls Tab */}
        {activeTab === "tool_call" && (
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <div className="space-y-0.5">
                <Label className="text-[10px] font-semibold text-muted-foreground">
                  • Verifies Agent tool call trajectory and required invocation count.
                </Label>
              </div>
              {!readOnly && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-5 px-1.5 text-[9px] gap-1 hover:bg-muted font-semibold"
                  onClick={() => addAssertion({ type: "tool_call", toolName: "", expectedCalls: 1 })}
                >
                  <Plus className="h-2.5 w-2.5" /> Add
                </Button>
              )}
            </div>

            <div className="space-y-2">
              {currentAssertions.map((spec, idx) => {
                if (spec.type !== "tool_call") return null;
                return (
                  <div key={idx} className="flex items-center gap-1.5">
                    <Input
                      value={spec.toolName}
                      onChange={(e) => updateAssertionAt(idx, { ...spec, toolName: e.target.value })}
                      placeholder="tool_name (e.g. search_knowledge_base)"
                      disabled={readOnly}
                      className="h-7 text-xs flex-1 bg-muted/20 border-muted-foreground/20 focus:border-amber-500/30"
                    />
                    <Input
                      type="number"
                      min={0}
                      value={spec.expectedCalls ?? 1}
                      onChange={(e) =>
                        updateAssertionAt(idx, {
                          ...spec,
                          expectedCalls: parseInt(e.target.value, 10) || 0,
                        })
                      }
                      placeholder=">= 1 calls"
                      disabled={readOnly}
                      className="h-7 text-xs w-24 bg-muted/20 border-muted-foreground/20 focus:border-amber-500/30"
                    />
                    {!readOnly && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-7 w-7 p-0 text-muted-foreground/50 hover:text-destructive hover:bg-destructive/10 shrink-0"
                        onClick={() => removeAssertion(idx)}
                      >
                        <X className="h-3 w-3" />
                      </Button>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* 5. Metrics Tab */}
        {activeTab === "metric" && (
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <div className="space-y-0.5">
                <Label className="text-[10px] font-semibold text-muted-foreground">
                  • Execution performance limits: duration, token consumption, and tool call count.
                </Label>
              </div>
              {!readOnly && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-5 px-1.5 text-[9px] gap-1 hover:bg-muted font-semibold"
                  onClick={() =>
                    addAssertion({
                      type: "metric",
                      metric: "duration_s",
                      operator: "<=",
                      threshold: 10,
                    })
                  }
                >
                  <Plus className="h-2.5 w-2.5" /> Add
                </Button>
              )}
            </div>

            <div className="space-y-2">
              {currentAssertions.map((spec, idx) => {
                if (spec.type !== "metric") return null;
                return (
                  <div key={idx} className="flex items-center gap-1.5">
                    <Select
                      value={spec.metric}
                      disabled={readOnly}
                      onValueChange={(val: string | null) => {
                        if (val) updateAssertionAt(idx, { ...spec, metric: val as MetricName });
                      }}
                    >
                      <SelectTrigger className="w-36 h-7 text-xs bg-muted/20 border-muted-foreground/20 font-mono">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="duration_s">duration_s</SelectItem>
                        <SelectItem value="output_tokens">output_tokens</SelectItem>
                        <SelectItem value="total_tool_calls">total_tool_calls</SelectItem>
                      </SelectContent>
                    </Select>

                    <Select
                      value={spec.operator}
                      disabled={readOnly}
                      onValueChange={(val: string | null) => {
                        if (val) updateAssertionAt(idx, { ...spec, operator: val as MetricOperator });
                      }}
                    >
                      <SelectTrigger className="w-20 h-7 text-xs bg-muted/20 border-muted-foreground/20 font-mono">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="<=">&lt;=</SelectItem>
                        <SelectItem value="<">&lt;</SelectItem>
                        <SelectItem value="==">==</SelectItem>
                        <SelectItem value=">">&gt;</SelectItem>
                        <SelectItem value=">=">&gt;=</SelectItem>
                      </SelectContent>
                    </Select>

                    <Input
                      type="number"
                      value={spec.threshold}
                      onChange={(e) =>
                        updateAssertionAt(idx, {
                          ...spec,
                          threshold: parseFloat(e.target.value) || 0,
                        })
                      }
                      placeholder="threshold limit"
                      disabled={readOnly}
                      className="h-7 text-xs flex-1 bg-muted/20 border-muted-foreground/20 focus:border-amber-500/30 font-mono"
                    />

                    {!readOnly && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-7 w-7 p-0 text-muted-foreground/50 hover:text-destructive hover:bg-destructive/10 shrink-0"
                        onClick={() => removeAssertion(idx)}
                      >
                        <X className="h-3 w-3" />
                      </Button>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* 6. LLM Judge Tab (Atomic: expectation, unexpectation, or reference) */}
        {activeTab === "llm_judge" && (
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-4">
              <div className="space-y-0.5">
                <Label className="text-[10px] font-semibold text-muted-foreground block">
                  • Evaluated by LLM Judge: Atomic checks for expected outcomes, forbidden constraints, or reference facts.
                </Label>
              </div>
              {!readOnly && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-5 px-1.5 text-[9px] gap-1 hover:bg-muted font-semibold shrink-0"
                  onClick={() => addAssertion({ type: "llm_judge", expectation: "" })}
                >
                  <Plus className="h-2.5 w-2.5" /> Add
                </Button>
              )}
            </div>

            <div className="space-y-2">
              {currentAssertions.map((spec, idx) => {
                if (
                  spec.type !== "llm_judge" &&
                  spec.type !== "expectation" &&
                  spec.type !== "llm_expectation"
                )
                  return null;

                const kind =
                  "unexpectation" in spec && spec.unexpectation !== undefined
                    ? "unexpectation"
                    : "reference" in spec && spec.reference !== undefined && !("expectation" in spec && spec.expectation)
                      ? "reference"
                      : "expectation";

                const currentValue =
                  kind === "unexpectation"
                    ? (spec as { unexpectation?: string }).unexpectation ?? ""
                    : kind === "reference"
                      ? (spec as { reference?: string }).reference ?? ""
                      : (spec as { expectation?: string }).expectation ?? "";

                return (
                  <div
                    key={idx}
                    className="flex items-center gap-1.5 rounded-md border border-border/40 bg-muted/10 p-1.5"
                  >
                    {/* Compact mode dropdown selector with 3-color ball indicators */}
                    <Select
                      value={kind}
                      disabled={readOnly}
                      onValueChange={(val: string | null) => {
                        if (!val) return;
                        const { expectation: _e, unexpectation: _u, reference: _r, ...rest } =
                          spec as Record<string, unknown>;
                        updateAssertionAt(idx, {
                          ...rest,
                          type: "llm_judge",
                          [val]: currentValue,
                        } as AssertionSpec);
                      }}
                    >
                      <SelectTrigger className="w-36 h-7 text-xs bg-muted/20 border-muted-foreground/20 shrink-0 font-medium">
                        <SelectValue>
                          <span
                            className={cn(
                              "h-2 w-2 rounded-full shrink-0 shadow-xs",
                              kind === "unexpectation"
                                ? "bg-rose-500"
                                : kind === "reference"
                                  ? "bg-sky-500"
                                  : "bg-emerald-500"
                            )}
                          />
                          <span>
                            {kind === "unexpectation"
                              ? "Unexpectation"
                              : kind === "reference"
                                ? "Reference"
                                : "Expectation"}
                          </span>
                        </SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="expectation">
                          <span className="h-2 w-2 rounded-full bg-emerald-500 shrink-0 shadow-xs" />
                          <span>Expectation</span>
                        </SelectItem>
                        <SelectItem value="unexpectation">
                          <span className="h-2 w-2 rounded-full bg-rose-500 shrink-0 shadow-xs" />
                          <span>Unexpectation</span>
                        </SelectItem>
                        <SelectItem value="reference">
                          <span className="h-2 w-2 rounded-full bg-sky-500 shrink-0 shadow-xs" />
                          <span>Reference</span>
                        </SelectItem>
                      </SelectContent>
                    </Select>

                    {/* Single atomic input box */}
                    <Input
                      value={currentValue}
                      onChange={(e) => {
                        const val = e.target.value;
                        const { expectation: _e, unexpectation: _u, reference: _r, ...rest } =
                          spec as Record<string, unknown>;
                        updateAssertionAt(idx, {
                          ...rest,
                          type: "llm_judge",
                          [kind]: val,
                        } as AssertionSpec);
                      }}
                      placeholder={
                        kind === "unexpectation"
                          ? "Prohibited behavior (e.g. Must not mention competitors or leak secrets)"
                          : kind === "reference"
                            ? "Ground truth context (e.g. Standard turnaround is 1-3 business days)"
                            : "Expected outcome (e.g. Output should explain refund steps clearly)"
                      }
                      disabled={readOnly}
                      className="h-7 text-xs flex-1 bg-muted/20 border-muted-foreground/20 focus:border-amber-500/30"
                    />

                    {!readOnly && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-7 w-7 p-0 text-muted-foreground/50 hover:text-destructive hover:bg-destructive/10 shrink-0"
                        onClick={() => removeAssertion(idx)}
                      >
                        <X className="h-3 w-3" />
                      </Button>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* 7. Raw JSON Tab */}
        {activeTab === "json" && (
          <div className="space-y-2 h-full flex flex-col">
            <Textarea
              className="flex-1 min-h-[160px] font-mono text-xs leading-relaxed bg-background"
              value={overrideText ?? rawJsonText}
              disabled={readOnly || isHistoryView}
              onChange={(e) => handleRawJsonChange(e.target.value)}
              placeholder="[]"
            />
            {rawJsonError && !isHistoryView && (
              <span className="text-[10px] text-destructive">{rawJsonError}</span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
