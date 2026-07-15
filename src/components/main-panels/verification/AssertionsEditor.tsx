"use client";

// HEADERS: Pointer to docs/verification.md
// CONTRACT: AssertionsEditor operates as a projection of a raw JSON array.
// Any updates in Schema/Path Match/Expression tabs serialize back to assertionsDraft.text.

import { useState, useMemo, type ReactNode } from "react";
import { Plus, X, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type {
  AssertionSpec,
  JsonSchemaAssertion,
  JsonPathEqualsAssertion,
  JsExpressionAssertion,
} from "@/lib/verification/types";

// --- Form State & Helper Types ----------------------------------------------

export interface AssertionsFormState {
  schema: JsonSchemaAssertion | null;
  pathMatches: JsonPathEqualsAssertion[];
  expressions: JsExpressionAssertion[];
  extraAssertions: AssertionSpec[];
}

interface AssertionsEditorProps {
  draft: {
    text: string;
    setText: (next: string) => void;
    parseError: string | null;
    saving: boolean;
    isDirty: boolean;
  };
  readOnly: boolean;
  overrideText?: string | null;
}

type TabType = "schema" | "path_match" | "expression" | "json";

// --- Data Converters --------------------------------------------------------

export function assertionsToForm(assertions: AssertionSpec[]): AssertionsFormState {
  let schema: JsonSchemaAssertion | null = null;
  const pathMatches: JsonPathEqualsAssertion[] = [];
  const expressions: JsExpressionAssertion[] = [];
  const extraAssertions: AssertionSpec[] = [];

  for (const item of assertions) {
    if (item.type === "json_schema") {
      if (!schema) {
        schema = item;
      } else {
        extraAssertions.push(item);
      }
    } else if (item.type === "jsonpath_equals") {
      pathMatches.push(item);
    } else if (item.type === "js_expression") {
      expressions.push(item);
    } else {
      extraAssertions.push(item);
    }
  }

  return { schema, pathMatches, expressions, extraAssertions };
}

export function formToAssertions(formState: AssertionsFormState): AssertionSpec[] {
  const result: AssertionSpec[] = [];
  if (formState.schema) {
    result.push(formState.schema);
  }
  result.push(...formState.pathMatches);
  result.push(...formState.expressions);
  result.push(...formState.extraAssertions);
  return result;
}

// --- Constants & Templates --------------------------------------------------

const SCHEMA_TEMPLATES = [
  {
    label: "Object with id",
    schema: {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "string", "minLength": 8 },
        age: { type: "number", "minimum": 18 },
      },
    },
  },
  {
    label: "Array of strings",
    schema: {
      type: "array",
      items: { type: "string" },
      "minItems": 1,
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

function getExpectedInputValue(expected: unknown): string {
  if (expected === undefined || expected === null) return "";
  if (typeof expected === "string") return expected;
  return JSON.stringify(expected);
}

// --- Component --------------------------------------------------------------

export function AssertionsEditor({
  draft,
  readOnly,
  overrideText = null,
}: AssertionsEditorProps): ReactNode {
  const [subTab, setSubTab] = useState<TabType>("path_match");

  const formState = useMemo(() => {
    try {
      const parsed = draft.text.trim() === "" ? [] : (JSON.parse(draft.text) as AssertionSpec[]);
      return assertionsToForm(Array.isArray(parsed) ? parsed : []);
    } catch {
      return assertionsToForm([]);
    }
  }, [draft.text]);

  const [schemaRawText, setSchemaRawText] = useState(() => {
    return formState.schema ? JSON.stringify(formState.schema.schema, null, 2) : "";
  });
  const [schemaError, setSchemaError] = useState<string | null>(null);

  const hasSchema = formState.schema !== null;
  const hasPathMatches = formState.pathMatches.length > 0;
  const hasExpressions = formState.expressions.length > 0;

  const isHistoryView = overrideText !== null;
  const activeTab = isHistoryView ? "json" : subTab;
  const hasJsonError = !!draft.parseError;

  function updateFormState(updater: (prev: AssertionsFormState) => AssertionsFormState) {
    const next = updater(formState);
    const nextAssertions = formToAssertions(next);
    const nextText = nextAssertions.length === 0 ? "" : JSON.stringify(nextAssertions, null, 2);
    draft.setText(nextText);
  }

  function handleSchemaTextChange(val: string) {
    setSchemaRawText(val);
    if (val.trim() === "") {
      setSchemaError(null);
      updateFormState((prev) => ({ ...prev, schema: null }));
      return;
    }
    try {
      const parsed = JSON.parse(val) as unknown;
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        setSchemaError("Schema must be a JSON object.");
        return;
      }
      setSchemaError(null);
      updateFormState((prev) => ({
        ...prev,
        schema: { type: "json_schema", schema: parsed as Record<string, unknown> },
      }));
    } catch (err) {
      setSchemaError(err instanceof Error ? err.message : String(err));
    }
  }

  function applySchemaTemplate(schemaObj: Record<string, unknown>) {
    const str = JSON.stringify(schemaObj, null, 2);
    setSchemaRawText(str);
    setSchemaError(null);
    updateFormState((prev) => ({
      ...prev,
      schema: { type: "json_schema", schema: schemaObj },
    }));
  }

  function updatePathMatch(idx: number, field: "path" | "expected", val: string) {
    updateFormState((prev) => {
      const nextMatches = [...prev.pathMatches];
      const item = nextMatches[idx];
      if (!item) return prev;
      if (field === "path") {
        nextMatches[idx] = { ...item, path: val.trim() };
      } else {
        let parsed: unknown;
        try {
          parsed = JSON.parse(val);
        } catch {
          parsed = val;
        }
        nextMatches[idx] = { ...item, expected: parsed };
      }
      return { ...prev, pathMatches: nextMatches };
    });
  }

  function addPathMatch() {
    updateFormState((prev) => ({
      ...prev,
      pathMatches: [...prev.pathMatches, { type: "jsonpath_equals", path: "", expected: "" }],
    }));
  }

  function removePathMatch(idx: number) {
    updateFormState((prev) => ({
      ...prev,
      pathMatches: prev.pathMatches.filter((_, i) => i !== idx),
    }));
  }

  function updateExpression(idx: number, val: string) {
    updateFormState((prev) => {
      const nextExprs = [...prev.expressions];
      const item = nextExprs[idx];
      if (!item) return prev;
      nextExprs[idx] = { ...item, expression: val };
      return { ...prev, expressions: nextExprs };
    });
  }

  function addExpression() {
    updateFormState((prev) => ({
      ...prev,
      expressions: [...prev.expressions, { type: "js_expression", expression: "" }],
    }));
  }

  function removeExpression(idx: number) {
    updateFormState((prev) => ({
      ...prev,
      expressions: prev.expressions.filter((_, i) => i !== idx),
    }));
  }

  function switchTab(newTab: TabType): void {
    if (activeTab === "json" && newTab !== "json") {
      if (hasJsonError) return;
    }
    if (newTab === "schema") {
      setSchemaRawText(formState.schema ? JSON.stringify(formState.schema.schema, null, 2) : "");
      setSchemaError(null);
    }
    setSubTab(newTab);
  }

  const TABS = (
    [
      { id: "path_match", label: "JSONPath", hasDot: hasPathMatches },
      { id: "expression", label: "JS Expression", hasDot: hasExpressions },
      { id: "schema", label: "Schema", hasDot: hasSchema },
      { id: "json", label: "JSON", hasDot: false },
    ] as const
  );

  const displayText = overrideText ?? draft.text;

  return (
    <div className="flex h-full min-h-0 flex-col bg-muted/5 border-l border-t">
      {/* Sub-tabs header */}
      <div className="flex h-8 shrink-0 items-center justify-between border-b bg-muted/20 px-3 py-1">
        <div className="flex items-center gap-1">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => switchTab(t.id)}
              disabled={isHistoryView || (activeTab === "json" && hasJsonError && t.id !== "json")}
              className={cn(
                "flex items-center gap-1.5 px-2 py-0.5 text-[10px] font-medium rounded transition-colors border",
                activeTab === t.id
                  ? "bg-muted text-foreground border-muted-foreground/10 font-semibold"
                  : "text-muted-foreground hover:bg-muted/30 hover:text-foreground border-transparent",
                !isHistoryView && activeTab === "json" && hasJsonError && t.id !== "json"
                  ? "opacity-50 cursor-not-allowed"
                  : "",
                isHistoryView && t.id !== "json" ? "opacity-50 cursor-not-allowed" : ""
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
          {draft.saving && (
            <Loader2 className="h-2.5 w-2.5 animate-spin text-muted-foreground" />
          )}
        </div>
      </div>

      {/* Tab content area */}
      <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-3">
        {activeTab === "schema" && (
          <div className="space-y-3 h-full flex flex-col">
            <div className="flex items-center justify-between">
              <Label className="text-[10px] font-semibold text-muted-foreground">
                JSON Schema of <code className="text-amber-500 font-semibold">structuredContent (content)</code>
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
                placeholder={`{\n  "type": "object",\n  "required": ["name", "age"],\n  "properties": { \n    "name": { "type": "string", "pattern": "^user_" }, \n    "age": { "type": "number", "minimum": 18 }, \n    "status": { "type": "boolean" }\n  }\n}`}
                className={cn(
                  "h-full w-full resize-none rounded-md border bg-background p-2 font-mono text-xs leading-relaxed",
                  schemaError && "border-destructive"
                )}
              />
            </div>
            {schemaError && (
              <p className="text-[10px] text-destructive">{schemaError}</p>
            )}
          </div>
        )}

        {activeTab === "path_match" && (
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-4">
              <div className="space-y-0.5">
                <Label className="text-[10px] font-semibold text-muted-foreground block">
                  • Paths starting with <code className="text-amber-500 font-semibold">$</code> query the full tool output root (e.g. $.isError).<br />
                  • Paths without a prefix query under <code className="text-amber-500 font-semibold">structuredContent(content)</code> directly (e.g. items[0].id).<br />
                  • Expected value supports <code className="text-amber-500 font-semibold">{"{{ input.path }}"}</code> templates to reference resolved inputs.
                </Label>
              </div>
              {!readOnly && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-5 px-1.5 text-[9px] gap-1 hover:bg-muted font-semibold shrink-0"
                  onClick={addPathMatch}
                >
                  <Plus className="h-2.5 w-2.5" /> Add
                </Button>
              )}
            </div>
            {formState.pathMatches.length > 0 && (
              <div className="space-y-2">
                {formState.pathMatches.map((pm, idx) => (
                  <div key={idx} className="flex items-center gap-1.5">
                    <Input
                      value={pm.path}
                      onChange={(e) => updatePathMatch(idx, "path", e.target.value)}
                      placeholder="$.isError or items[0].id"
                      disabled={readOnly}
                      className="h-7 text-xs flex-1 bg-muted/20 border-muted-foreground/20 focus:border-amber-500/30"
                    />
                    <Input
                      value={getExpectedInputValue(pm.expected)}
                      onChange={(e) => updatePathMatch(idx, "expected", e.target.value)}
                      placeholder="expected value (JSON/text)"
                      disabled={readOnly}
                      className="h-7 text-xs flex-1 bg-muted/20 border-muted-foreground/20 focus:border-amber-500/30"
                    />
                    {!readOnly && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-7 w-7 p-0 text-muted-foreground/50 hover:text-destructive hover:bg-destructive/10"
                        onClick={() => removePathMatch(idx)}
                      >
                        <X className="h-3 w-3" />
                      </Button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {activeTab === "expression" && (
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <div className="space-y-0.5">
                <Label className="text-[10px] font-semibold text-muted-foreground">
                  • Bindings: <code className="font-semibold text-amber-500">result</code> (structuredContent or content), <code className="font-semibold text-amber-500">root</code> (full output), <code className="font-semibold text-amber-500">input</code> (resolved input).
                </Label>
              </div>
              {!readOnly && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-5 px-1.5 text-[9px] gap-1 hover:bg-muted font-semibold"
                  onClick={addExpression}
                >
                  <Plus className="h-2.5 w-2.5" /> Add
                </Button>
              )}
            </div>
            {formState.expressions.length > 0 && (
              <div className="space-y-2">
                {formState.expressions.map((expr, idx) => (
                  <div key={idx} className="flex items-center gap-1.5">
                    <Input
                      value={expr.expression}
                      onChange={(e) => updateExpression(idx, e.target.value)}
                      placeholder="result.item.length > 2 or root.isError === false"
                      disabled={readOnly}
                      className="h-7 text-xs flex-1 bg-muted/20 border-muted-foreground/20 focus:border-amber-500/30"
                    />
                    {!readOnly && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-7 w-7 p-0 text-muted-foreground/50 hover:text-destructive hover:bg-destructive/10"
                        onClick={() => removeExpression(idx)}
                      >
                        <X className="h-3 w-3" />
                      </Button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {activeTab === "json" && (
          <div className="space-y-1 h-full flex flex-col">
            <div className="relative flex-1 min-h-[120px]">
              <textarea
                value={displayText}
                onChange={(e) => {
                  if (isHistoryView) return;
                  draft.setText(e.target.value);
                }}
                disabled={readOnly}
                spellCheck={false}
                className={cn(
                  "h-full w-full resize-none rounded-md border bg-background p-2 font-mono text-xs leading-relaxed",
                  draft.parseError && !isHistoryView && "border-destructive"
                )}
              />
            </div>
            {draft.parseError && !isHistoryView && (
              <p className="text-[10px] text-destructive">{draft.parseError}</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
