"use client";

/**
 * EvalCaseInspector — middle + right columns of the evaluation main panel.
 *
 * Middle: multi-turn conversation editor (user messages + JSON criteria + collapsed agent response).
 * Right: evaluation result (overall score, per-dimension score bars, feedback).
 *
 * Header hosts Add Turn and Evaluate buttons.
 */

import { useState, useMemo, useCallback, type ReactNode } from "react";
import {
  Play,
  Loader2,
  SquarePlus,
  Save,
  Trash2,
  ChevronDown,
  Check,
  X,
  MessageSquare,
  Plus,
} from "lucide-react";
import useSWR from "swr";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import {
  BUILTIN_DIMENSIONS,
  evalCriteriaSchema,
  type EvalCriteria,
  type EvalTurn,
  type CriteriaCheckResult,
} from "@/lib/evaluation/types";
import type { EvaluationRunLiveState } from "@/hooks/useEvaluationRunStream";
import {
  LEVEL_META,
  scoreToLevel,
  barColorForScore,
} from "@/lib/evaluation/config";
import type { EvalSuiteRow, EvalCaseRow } from "@/store/evaluation";
import { evalCaseActions } from "@/store/evaluation-cases";

/** EvalTurn with a stable React key (runtime-only, not persisted). */
interface KeyedTurn extends EvalTurn {
  _key: number;
}

function dimensionName(id: string): string {
  return BUILTIN_DIMENSIONS.find((d) => d.id === id)?.name ?? id;
}

// Turn row — flat layout: "User (n)" label + delete button, then textarea

interface TurnRowProps {
  turn: EvalTurn;
  index: number;
  canDelete: boolean;
  selected: boolean;
  hasResponse: boolean;
  onChange: (updated: EvalTurn) => void;
  onDelete: () => void;
  onViewResponse: () => void;
}

function TurnRow({ turn, index, canDelete, selected, hasResponse, onChange, onDelete, onViewResponse }: TurnRowProps): ReactNode {
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-1.5">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-blue-400">
          User ({index + 1})
        </span>
        <div className="flex-1" />
        <button
          type="button"
          onClick={onViewResponse}
          className={cn(
            "rounded p-0.5 transition-colors",
            hasResponse
              ? selected
                ? "bg-emerald-500/15 text-emerald-400"
                : "text-muted-foreground hover:bg-muted hover:text-foreground"
              : "text-muted-foreground/30 cursor-default",
          )}
          title={hasResponse ? "View response" : "Not yet executed"}
          disabled={!hasResponse}
        >
          <MessageSquare className="h-3 w-3" />
        </button>
        {canDelete && (
          <button
            type="button"
            onClick={onDelete}
            className="rounded p-0.5 text-muted-foreground/50 hover:text-destructive"
            title="Remove turn"
          >
            <Trash2 className="h-3 w-3" />
          </button>
        )}
      </div>
      <Textarea
        value={turn.userMessage}
        onChange={(e) => onChange({ ...turn, userMessage: e.target.value })}
        placeholder="User message..."
        className="h-20 text-xs resize-none field-sizing-fixed"
      />
    </div>
  );
}

// Response viewer — fetches conversation from eval run, caches in state.

export interface ResponseMessage {
  role: "user" | "assistant" | "tool";
  content: string;
  toolName?: string;
}

interface ResponseViewerProps {
  messages: ResponseMessage[] | null;
  isLoading: boolean;
  hasRun: boolean;
  turnIndex: number;
}

function ResponseViewer({ messages, isLoading, hasRun, turnIndex: _turnIndex }: ResponseViewerProps): ReactNode {
  if (!hasRun) {
    return (
      <div className="flex items-center justify-center h-full p-3 text-xs text-muted-foreground">
        Run the case to see the agent&apos;s response.
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full p-3 text-xs text-muted-foreground">
        <Loader2 className="mr-2 h-3 w-3 animate-spin" /> Loading response...
      </div>
    );
  }

  if (!messages || messages.length === 0) {
    return (
      <div className="flex items-center justify-center h-full p-3 text-xs text-muted-foreground">
        No response data available for this turn.
      </div>
    );
  }

  return (
    <ScrollArea className="h-full">
      <div className="space-y-2 p-3">
        {messages.map((msg, i) => (
          <div key={i} className="space-y-0.5">
            <span className={cn(
              "text-[10px] font-semibold uppercase tracking-wider",
              msg.role === "user" ? "text-blue-400"
                : msg.role === "tool" ? "text-amber-400"
                : "text-emerald-400",
            )}>
              {msg.role === "tool" ? `Tool: ${msg.toolName ?? "unknown"}` : msg.role}
            </span>
            <div className="rounded border bg-muted/20 px-2.5 py-1.5 text-xs leading-relaxed text-muted-foreground whitespace-pre-wrap">
              {msg.content || "(empty)"}
            </div>
          </div>
        ))}
      </div>
    </ScrollArea>
  );
}

// Criteria JSON editor — case-level

interface CriteriaEditorProps {
  criteria: EvalCriteria;
  onChange: (updated: EvalCriteria) => void;
  onErrorChange: (hasError: boolean) => void;
}

interface DynamicInputListProps {
  label: string;
  items: string[];
  placeholder?: string;
  onChange: (items: string[]) => void;
}

function DynamicInputList({ label, items, placeholder, onChange }: DynamicInputListProps): ReactNode {
  function handleItemChange(idx: number, val: string): void {
    const next = [...items];
    next[idx] = val;
    onChange(next);
  }

  function addItem(): void {
    onChange([...items, ""]);
  }

  function removeItem(idx: number): void {
    onChange(items.filter((_, i) => i !== idx));
  }

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <Label className="text-[10px] font-semibold text-muted-foreground">{label}</Label>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-5 px-1.5 text-[9px] gap-1 hover:bg-muted font-semibold"
          onClick={addItem}
        >
          <Plus className="h-2.5 w-2.5" /> Add
        </Button>
      </div>
      {items.length > 0 && (
        <div className="space-y-1">
          {items.map((item, idx) => (
            <div key={idx} className="flex items-center gap-1">
              <Input
                value={item}
                onChange={(e) => handleItemChange(idx, e.target.value)}
                placeholder={placeholder ?? "Enter value..."}
                className="h-7 text-xs flex-1 bg-muted/20 border-muted-foreground/20 focus:border-amber-500/30"
              />
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 w-7 p-0 text-muted-foreground/50 hover:text-destructive hover:bg-destructive/10"
                onClick={() => removeItem(idx)}
              >
                <X className="h-3 w-3" />
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

interface CommaSeparatedInputProps {
  label: string;
  value: string[];
  placeholder?: string;
  onChange: (value: string[]) => void;
}

function CommaSeparatedInput({ label, value, placeholder, onChange }: CommaSeparatedInputProps): ReactNode {
  const canonical = value.join(", ");
  const [state, setState] = useState({
    text: canonical,
    prevCanonical: canonical,
  });

  if (canonical !== state.prevCanonical) {
    setState({
      text: canonical,
      prevCanonical: canonical,
    });
  }

  function handleChange(val: string): void {
    setState((prev) => ({ ...prev, text: val }));
    const parsed = val
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    onChange(parsed);
  }

  return (
    <div className="space-y-1">
      <Label className="text-[10px] font-semibold text-muted-foreground block">{label}</Label>
      <Input
        value={state.text}
        onChange={(e) => handleChange(e.target.value)}
        placeholder={placeholder ?? "e.g. term1, term2, term3"}
        className="h-7 text-xs bg-muted/20 border-muted-foreground/20 focus:border-amber-500/30"
      />
    </div>
  );
}

function CriteriaEditor({ criteria, onChange, onErrorChange }: CriteriaEditorProps): ReactNode {
  type CriteriaSubTab = "expectations" | "checklist" | "limits" | "json";
  const [subTab, setSubTab] = useState<CriteriaSubTab>("expectations");

  const [jsonText, setJsonText] = useState(() => {
    return Object.keys(criteria).length === 0 ? "" : JSON.stringify(criteria, null, 2);
  });
  const [jsonError, setJsonError] = useState<string | null>(null);

  const hasExpectations = useMemo(() => {
    return !!(
      criteria.expectation ||
      criteria.issue ||
      criteria.reference ||
      (criteria.context && criteria.context.length > 0)
    );
  }, [criteria]);

  const hasChecklist = useMemo(() => {
    return !!(
      (criteria.assertions && criteria.assertions.length > 0) ||
      (criteria.expected_keywords && criteria.expected_keywords.length > 0) ||
      (criteria.unexpected_keywords && criteria.unexpected_keywords.length > 0) ||
      (criteria.tool_calls && criteria.tool_calls.length > 0)
    );
  }, [criteria]);

  const hasLimits = useMemo(() => {
    return !!(
      criteria.max_duration_s !== undefined ||
      criteria.max_output_tokens !== undefined ||
      criteria.max_tool_calls !== undefined
    );
  }, [criteria]);

  const hasJson = useMemo(() => {
    return Object.keys(criteria).length > 0;
  }, [criteria]);

  function updateField<K extends keyof EvalCriteria>(key: K, value: EvalCriteria[K]): void {
    const updated = { ...criteria, [key]: value };
    if (value === undefined || value === "" || (Array.isArray(value) && value.length === 0)) {
      delete updated[key];
    }
    onChange(updated);
    onErrorChange(false);
  }

  function handleJsonChange(v: string): void {
    setJsonText(v);
    if (!v.trim() || v.trim() === "{}") {
      setJsonError(null);
      onErrorChange(false);
      onChange({});
      return;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(v);
    } catch {
      setJsonError("Invalid JSON");
      onErrorChange(true);
      return;
    }
    const result = evalCriteriaSchema.safeParse(raw);
    if (!result.success) {
      const first = result.error.issues[0];
      setJsonError(first?.message ?? "Invalid criteria");
      onErrorChange(true);
      return;
    }
    setJsonError(null);
    onErrorChange(false);
    onChange(result.data as EvalCriteria);
  }

  function switchTab(newTab: CriteriaSubTab): void {
    if (subTab === "json" && newTab !== "json") {
      if (jsonError) return;
    }
    if (newTab === "json") {
      setJsonText(Object.keys(criteria).length === 0 ? "" : JSON.stringify(criteria, null, 2));
      setJsonError(null);
      onErrorChange(false);
    }
    setSubTab(newTab);
  }

  return (
    <div className="flex flex-col h-full min-h-0 bg-muted/5">
      {/* Sub-tabs header */}
      <div className="flex items-center gap-1 border-b bg-muted/20 px-3 py-1.5 shrink-0">
        {(
          [
            { id: "expectations", label: "Expectations", hasDot: hasExpectations },
            { id: "checklist", label: "Checklist", hasDot: hasChecklist },
            { id: "limits", label: "Limits", hasDot: hasLimits },
            { id: "json", label: "JSON", hasDot: hasJson },
          ] as const
        ).map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => switchTab(t.id)}
            disabled={subTab === "json" && !!jsonError && t.id !== "json"}
            className={cn(
              "flex items-center gap-1.5 px-2 py-0.5 text-[10px] font-medium rounded transition-colors border",
              subTab === t.id
                ? "bg-muted text-foreground border-muted-foreground/10 font-semibold"
                : "text-muted-foreground hover:bg-muted/30 hover:text-foreground border-transparent",
              subTab === "json" && jsonError && t.id !== "json" ? "opacity-50 cursor-not-allowed" : ""
            )}
          >
            <span>{t.label}</span>
            {t.hasDot && (
              <span className="w-1 h-1 rounded-full bg-emerald-500 shrink-0 animate-pulse-subtle" />
            )}
          </button>
        ))}
      </div>

      {/* Tab content area */}
      <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-3">
        {subTab === "expectations" && (
          <div className="space-y-3">
            {/* Expectation */}
            <div className="space-y-1">
              <Label className="text-[10px] font-semibold text-muted-foreground">Expectation</Label>
              <Textarea
                value={criteria.expectation ?? ""}
                onChange={(e) => updateField("expectation", e.target.value)}
                placeholder="Natural language description of the expected outcome..."
                className="h-16 text-xs resize-none bg-muted/20 border-muted-foreground/20 focus:border-amber-500/30"
              />
            </div>

            {/* Reference */}
            <div className="space-y-1">
              <Label className="text-[10px] font-semibold text-muted-foreground">Reference answer</Label>
              <Textarea
                value={criteria.reference ?? ""}
                onChange={(e) => updateField("reference", e.target.value)}
                placeholder="A good example of an agent response or ground truth..."
                className="h-16 text-xs font-mono resize-none bg-muted/20 border-muted-foreground/20 focus:border-amber-500/30"
              />
            </div>
            
            {/* Issue */}
            <div className="space-y-1">
              <Label className="text-[10px] font-semibold text-muted-foreground">Reported issue</Label>
              <Input
                value={criteria.issue ?? ""}
                onChange={(e) => updateField("issue", e.target.value)}
                placeholder="Describe the previous issue or bug you observed..."
                className="h-7 text-xs bg-muted/20 border-muted-foreground/20 focus:border-amber-500/30"
              />
            </div>

            {/* Context */}
            <DynamicInputList
              label="Context (supplementary knowledge)"
              items={criteria.context ?? []}
              placeholder="e.g. Business rules, documentation snippet..."
              onChange={(next) => updateField("context", next)}
            />
          </div>
        )}

        {subTab === "checklist" && (
          <div className="space-y-3">
            {/* Expected Keywords */}
            <CommaSeparatedInput
              label="Expected keywords (must contain)"
              value={criteria.expected_keywords ?? []}
              placeholder="e.g. success, approved"
              onChange={(next) => updateField("expected_keywords", next)}
            />

            {/* Unexpected Keywords */}
            <CommaSeparatedInput
              label="Unexpected keywords (must not contain)"
              value={criteria.unexpected_keywords ?? []}
              placeholder="e.g. failure, error, exception"
              onChange={(next) => updateField("unexpected_keywords", next)}
            />

            {/* Tool Calls */}
            <CommaSeparatedInput
              label="Expected tool calls"
              value={criteria.tool_calls ?? []}
              placeholder="e.g. search_database, send_email"
              onChange={(next) => updateField("tool_calls", next)}
            />

            {/* Assertions */}
            <DynamicInputList
              label="Assertions (LLM checks)"
              items={criteria.assertions ?? []}
              placeholder="e.g. The response does not contain code formatting errors..."
              onChange={(next) => updateField("assertions", next)}
            />
          </div>
        )}

        {subTab === "limits" && (
          <div className="space-y-3">
            <div className="grid grid-cols-3 gap-2">
              {/* Max Duration */}
              <div className="space-y-1">
                <Label className="text-[10px] font-semibold text-muted-foreground block">Max duration</Label>
                <div className="relative flex items-center">
                  <Input
                    type="number"
                    min={1}
                    value={criteria.max_duration_s ?? ""}
                    onChange={(e) => {
                      const val = e.target.value === "" ? undefined : parseFloat(e.target.value);
                      updateField("max_duration_s", val);
                    }}
                    placeholder="None"
                    className="h-7 text-xs pr-4 bg-muted/20 border-muted-foreground/20 focus:border-amber-500/30"
                  />
                  <span className="absolute right-1.5 text-[9px] text-muted-foreground font-medium pointer-events-none">s</span>
                </div>
              </div>

              {/* Max Output Tokens */}
              <div className="space-y-1">
                <Label className="text-[10px] font-semibold text-muted-foreground block">Max tokens</Label>
                <div className="relative flex items-center">
                  <Input
                    type="number"
                    min={1}
                    value={criteria.max_output_tokens ?? ""}
                    onChange={(e) => {
                      const val = e.target.value === "" ? undefined : parseInt(e.target.value, 10);
                      updateField("max_output_tokens", val);
                    }}
                    placeholder="None"
                    className="h-7 text-xs bg-muted/20 border-muted-foreground/20 focus:border-amber-500/30"
                  />
                </div>
              </div>

              {/* Max Tool Calls */}
              <div className="space-y-1">
                <Label className="text-[10px] font-semibold text-muted-foreground block">Max tool calls</Label>
                <div className="relative flex items-center">
                  <Input
                    type="number"
                    min={0}
                    value={criteria.max_tool_calls ?? ""}
                    onChange={(e) => {
                      const val = e.target.value === "" ? undefined : parseInt(e.target.value, 10);
                      updateField("max_tool_calls", val);
                    }}
                    placeholder="None"
                    className="h-7 text-xs bg-muted/20 border-muted-foreground/20 focus:border-amber-500/30"
                  />
                </div>
              </div>
            </div>
            <p className="text-[9px] text-muted-foreground/70 italic leading-relaxed">
              These are hard limits measured by the runner. If exceeded, the deterministic checks fail and degrade the score.
            </p>
          </div>
        )}

        {subTab === "json" && (
          <div className="flex flex-col gap-1.5 h-full min-h-0">
            <Textarea
              value={jsonText}
              onChange={(e) => handleJsonChange(e.target.value)}
              placeholder="{}"
              className={cn("flex-1 font-mono text-xs resize-none field-sizing-fixed bg-muted/20 border-muted-foreground/20 focus:border-amber-500/30")}
            />
            {jsonError && <p className="text-[10px] text-destructive shrink-0">{jsonError}</p>}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Score bar ──────────────────────────────────────────────────────

function ScoreBar({ name, score }: { name: string; score: number | null }): ReactNode {
  return (
    <div className="flex items-center gap-2">
      <span className="w-28 shrink-0 truncate text-xs text-muted-foreground">{name}</span>
      <div className="flex-1 h-1.5 rounded-full bg-muted overflow-hidden">
        {score !== null && (
          <div
            className={cn("h-full rounded-full transition-all", barColorForScore(score))}
            style={{ width: `${Math.min(100, score)}%` }}
          />
        )}
      </div>
      <span className="w-8 shrink-0 text-right text-xs font-mono tabular-nums">
        {score !== null ? `${score}` : "—"}
      </span>
      <div className="w-3 shrink-0" />
    </div>
  );
}

// ─── Criteria detail (collapsible) ──────────────────────────────────

/** Build UI-side checklist from criteria definition. `passed` is null
 *  (not yet evaluated) until the runner populates real results. */
function buildCriteriaChecklist(criteria: EvalCriteria, results?: unknown[]): CriteriaCheckResult[] {
  if (results && results.length > 0) return results as CriteriaCheckResult[];
  const items: CriteriaCheckResult[] = [];

  // LLM-evaluated
  if (criteria.expectation) {
    items.push({ label: criteria.expectation, kind: "expectation", passed: null, score: null });
  }
  for (const a of criteria.assertions ?? []) {
    items.push({ label: a, kind: "assertion", passed: null });
  }

  // Deterministic
  for (const kw of criteria.expected_keywords ?? []) {
    items.push({ label: `keyword: "${kw}"`, kind: "keyword", passed: null });
  }
  for (const kw of criteria.unexpected_keywords ?? []) {
    items.push({ label: `not: "${kw}"`, kind: "keyword", passed: null });
  }
  for (const tc of criteria.tool_calls ?? []) {
    items.push({ label: `tool: ${tc}`, kind: "tool_call", passed: null });
  }

  // Execution metrics
  if (criteria.max_duration_s !== undefined) {
    items.push({ label: `duration ≤ ${criteria.max_duration_s}s`, kind: "metric", passed: null });
  }
  if (criteria.max_output_tokens !== undefined) {
    items.push({ label: `output tokens ≤ ${criteria.max_output_tokens}`, kind: "metric", passed: null });
  }
  if (criteria.max_tool_calls !== undefined) {
    items.push({ label: `tool calls ≤ ${criteria.max_tool_calls}`, kind: "metric", passed: null });
  }

  return items;
}

function CriteriaCheckIcon({ passed }: { passed: boolean | null }): ReactNode {
  if (passed === null) return <span className="h-3.5 w-3.5 rounded-full border border-dashed border-muted-foreground/30" />;
  if (passed) return <Check className="h-3.5 w-3.5 text-emerald-400" />;
  return <X className="h-3.5 w-3.5 text-red-400" />;
}

// Main component

interface EvalCaseInspectorProps {
  evalCase: EvalCaseRow;
  suite: EvalSuiteRow;
  liveRun: EvaluationRunLiveState;
  onRunCase: (caseId: number) => Promise<void>;
}

// CONTRACT: parent renders <EvalCaseInspector key={evalCase.id} />,
// so the counter resets on case switch via remount.
let nextTurnKey = 0;
function mintKey(): number { return nextTurnKey++; }

export function EvalCaseInspector({ evalCase, suite, liveRun, onRunCase }: EvalCaseInspectorProps): ReactNode {
  const [turns, setTurns] = useState<KeyedTurn[]>(() =>
    (evalCase.turns as EvalTurn[]).map((t) => ({ ...t, _key: mintKey() })),
  );
  const [criteria, setCriteria] = useState<EvalCriteria>((evalCase.criteria ?? {}) as EvalCriteria);
  const [criteriaHasError, setCriteriaHasError] = useState(false);
  const [saving, setSaving] = useState(false);

  type BottomTab = "criteria" | "response";
  const [bottomTab, setBottomTab] = useState<BottomTab>("criteria");
  const [responseTurnIdx, setResponseTurnIdx] = useState(0);

  // Fetch historical result for this case (Disabled for now to show initial empty state)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: historicalResult } = useSWR<any>(
    null, // `/api/eval-cases/${evalCase.id}/latest-result`,
    (url: string) => fetch(url).then((res) => {
      if (!res.ok && res.status === 404) return null;
      if (!res.ok) throw new Error("Failed to fetch");
      return res.json();
    })
  );

  // Strip runtime-only `_key` for persistence and comparison.
  function stripKeys(kt: KeyedTurn[]): EvalTurn[] {
    return kt.map(({ _key: _, ...rest }) => rest);
  }

  // Snapshot original values for dirty comparison (stable across renders).
  const origTurnsJson = useMemo(() => JSON.stringify(evalCase.turns), [evalCase.turns]);
  const origCriteriaJson = useMemo(() => JSON.stringify(evalCase.criteria ?? {}), [evalCase.criteria]);

  const isDirty =
    JSON.stringify(stripKeys(turns)) !== origTurnsJson ||
    JSON.stringify(criteria) !== origCriteriaJson;

  const canSave = isDirty && !criteriaHasError && !saving;

  const handleSave = useCallback(async (): Promise<void> => {
    if (!canSave) return;
    setSaving(true);
    await evalCaseActions.patch(
      { id: evalCase.id, suiteId: evalCase.suiteId },
      {
        turns: stripKeys(turns) as Array<{ userMessage: string }>,
        criteria: criteria as Record<string, unknown>,
      },
    );
    setSaving(false);
  }, [canSave, evalCase.id, evalCase.suiteId, turns, criteria]);

  const activeDimensions = suite.dimensionIds;

  function updateTurn(index: number, updated: EvalTurn): void {
    setTurns((prev) => prev.map((t, i) => (i === index ? { ...updated, _key: t._key } : t)));
  }

  // Derive display scores: prefer liveRun if it has a caseResult for this case, else historical
  const liveCaseResult = liveRun.caseResults.get(evalCase.id);
  
  const displayScore = liveCaseResult?.score ?? historicalResult?.score ?? null;
  const displayDimensionScores = liveCaseResult?.dimensionScores ?? historicalResult?.dimensionScores ?? {};
  const displayBaselineScore = displayDimensionScores?.baseline ?? null;
  const displayCriteriaScore = liveCaseResult?.criteriaScore ?? historicalResult?.criteriaScore ?? null;
  const displayFeedback = liveCaseResult?.feedback ?? historicalResult?.feedback ?? null;
  const displayCriteriaResults = liveCaseResult?.criteriaResults ?? historicalResult?.criteriaResults ?? null;
  const displayDurationMs = liveCaseResult?.durationMs ?? historicalResult?.durationMs ?? null;
  const displayOutputTokens = liveCaseResult?.outputTokens ?? historicalResult?.outputTokens ?? null;

  const resolvedRunId = liveRun.phase === "idle" ? historicalResult?.runId ?? null : liveRun.runId;
  const resolvedStatus = liveRun.phase === "idle" ? historicalResult?.status ?? "idle" : (liveCaseResult?.status ?? "running");

  const { data: messagesData, isLoading: messagesLoading } = useSWR<{ messages: ResponseMessage[] }>(
    resolvedRunId ? `/api/eval-runs/${resolvedRunId}/messages?caseId=${evalCase.id}&status=${resolvedStatus}` : null,
    (url: string) => fetch(url).then(res => res.json())
  );

  const fullMessages = messagesData?.messages;
  const hasResponse = !!fullMessages && fullMessages.length > 0;

  const filteredMessages = useMemo(() => {
    if (!fullMessages || fullMessages.length === 0) return null;
    
    const totalUserMsgs = fullMessages.filter(m => m.role === "user").length;
    const result: ResponseMessage[] = [];
    let userCount = 0;
    
    for (const msg of fullMessages) {
      if (msg.role === "user") {
        userCount++;
      } else {
        // If there are no user messages, or if we matched the turn exactly,
        // or if this is the last available user message block but the user requested 
        // a later turn (backend squashed turns fallback), we include the message.
        if (
          totalUserMsgs === 0 || 
          userCount - 1 === responseTurnIdx || 
          (userCount === totalUserMsgs && responseTurnIdx >= totalUserMsgs)
        ) {
          result.push(msg);
        }
      }
    }
    return result;
  }, [fullMessages, responseTurnIdx]);

  function deleteTurn(index: number): void {
    setTurns((prev) => prev.filter((_, i) => i !== index));
  }

  function addTurn(): void {
    setTurns((prev) => [...prev, { userMessage: "", _key: mintKey() }]);
  }

  return (
    <div className="flex flex-[7] min-h-0">
      {/* Middle: conversation (top) + criteria/response tabs (bottom) */}
      <div className="flex flex-[4] flex-col border-r min-w-0">
        {/* Top: conversation turns */}
        <div className="flex h-10 shrink-0 items-center border-b bg-muted/40 px-3">
          <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
            Conversation
          </span>
          <div className="ml-auto flex items-center gap-1">
            <Button
              size="sm"
              variant="ghost"
              className="h-6 w-6 p-0"
              onClick={addTurn}
              title="Add turn"
            >
              <SquarePlus className="h-3 w-3" />
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-6 w-6 p-0"
              disabled={!canSave}
              onClick={handleSave}
            >
              {saving ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <Save className="h-3 w-3" />
              )}
            </Button>
            <Button
              size="sm"
              className="h-6 px-2 text-xs"
              disabled={!suite.evaluatorAgentId || liveRun.phase === "running"}
              title={
                !suite.evaluatorAgentId
                  ? "Evaluator Agent is required to run"
                  : liveRun.phase === "running"
                    ? "A run is in progress"
                    : "Run case"
              }
              onClick={() => void onRunCase(evalCase.id)}
            >
              {liveRun.phase === "running" ? (
                <Loader2 className="mr-1 h-3 w-3 animate-spin" />
              ) : (
                <Play className={cn("mr-1 h-3 w-3", suite.evaluatorAgentId ? "fill-green-500 text-green-500" : "fill-muted-foreground text-muted-foreground")} />
              )}
              Run
            </Button>
          </div>
        </div>
        <ScrollArea className="basis-1/2 min-h-0">
          <div className="space-y-3 p-3">
            {turns.map((turn, i) => (
              <TurnRow
                key={turn._key}
                turn={turn}
                index={i}
                canDelete={turns.length > 1}
                selected={responseTurnIdx === i}
                hasResponse={hasResponse}
                onChange={(updated) => updateTurn(i, updated)}
                onDelete={() => deleteTurn(i)}
                onViewResponse={() => {
                  setResponseTurnIdx(i);
                  setBottomTab("response");
                }}
              />
            ))}
          </div>
        </ScrollArea>

        {/* Bottom: Criteria / Response tabs */}
        <div className="flex items-stretch border-y bg-muted/40">
          <button
            type="button"
            onClick={() => setBottomTab("criteria")}
            className={cn(
              "px-3 py-1.5 text-xs font-medium transition-colors",
              bottomTab === "criteria"
                ? "text-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            Criteria
          </button>
          <button
            type="button"
            onClick={() => setBottomTab("response")}
            className={cn(
              "px-3 py-1.5 text-xs font-medium transition-colors",
              bottomTab === "response"
                ? "text-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            Response
          </button>
        </div>
        <ScrollArea className="basis-1/2 min-h-0">
          {bottomTab === "criteria" ? (
            <CriteriaEditor criteria={criteria} onChange={setCriteria} onErrorChange={setCriteriaHasError} />
          ) : (
            <ResponseViewer 
              messages={filteredMessages}
              isLoading={messagesLoading}
              hasRun={!!resolvedRunId}
              turnIndex={responseTurnIdx}
            />
          )}
        </ScrollArea>
      </div>

        {/* Right: evaluation result */}
        <EvaluationPanel
          activeDimensions={activeDimensions}
          criteria={criteria}
          running={liveRun.phase === "running"}
          overallScore={displayScore}
          baselineScore={displayBaselineScore}
          dimensionScores={displayDimensionScores}
          criteriaScore={displayCriteriaScore}
          criteriaResults={displayCriteriaResults}
          feedback={displayFeedback}
          durationMs={displayDurationMs}
          outputTokens={displayOutputTokens}
        />
    </div>
  );
}

// ─── Evaluation result panel (right column) ─────────────────────────

interface EvaluationPanelProps {
  activeDimensions: string[];
  criteria: EvalCriteria;
  running: boolean;
  overallScore: number | null;
  baselineScore: number | null;
  dimensionScores: Record<string, number>;
  criteriaScore: number | null;
  criteriaResults: unknown[] | null;
  feedback: string | null;
  durationMs: number | null;
  outputTokens: number | null;
}

function EvaluationPanel({
  activeDimensions,
  criteria,
  running,
  overallScore,
  baselineScore,
  dimensionScores,
  criteriaScore,
  criteriaResults,
  feedback,
  durationMs,
  outputTokens,
}: EvaluationPanelProps): ReactNode {
  const [criteriaExpanded, setCriteriaExpanded] = useState(true);

  const criteriaChecklist = useMemo(
    () => buildCriteriaChecklist(criteria, criteriaResults ?? undefined),
    [criteria, criteriaResults],
  );
  const hasCriteria = criteriaChecklist.length > 0;

  // Level badge for the header.
  const levelMeta = overallScore !== null
    ? LEVEL_META[scoreToLevel(overallScore)]
    : null;

  const hasResult = overallScore !== null;

  return (
    <div className="flex flex-[3] flex-col min-w-0 bg-muted/10">
      {/* Header: "Evaluation" + level badge */}
      <div className="flex h-10 shrink-0 items-center border-b bg-muted/40 px-3">
        <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          Evaluation
        </span>
        <div className="ml-auto flex items-center gap-1.5">
          {running && (
            <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
          )}
          {levelMeta && overallScore !== null && (
            <>
              <span className={cn("rounded px-1.5 py-0.5 text-[10px] font-semibold", levelMeta.color, levelMeta.bgColor)}>
                {levelMeta.label}
              </span>
              <span className="text-xs font-mono tabular-nums font-semibold">
                {overallScore}
              </span>
            </>
          )}
        </div>
      </div>

      {/* Top Half: Scores and Criteria */}
      <ScrollArea className="basis-1/2 min-h-0 bg-background">
        <div className="p-3 space-y-1.5">
          {/* Metrics */}
          {hasResult && (durationMs !== null || outputTokens !== null) && (
            <div className="flex items-center gap-4 text-[11px] text-muted-foreground mb-3 pb-2 border-b border-muted">
              {durationMs !== null && (
                <div className="flex gap-1.5 items-center">
                  <span className="font-semibold text-foreground/80">Duration:</span>
                  <span>{(durationMs / 1000).toFixed(1)}s</span>
                </div>
              )}
              {outputTokens !== null && (
                <div className="flex gap-1.5 items-center">
                  <span className="font-semibold text-foreground/80">Output token:</span>
                  <span>{outputTokens}</span>
                </div>
              )}
            </div>
          )}

          {/* Baseline — always present */}
          <ScoreBar name="Baseline" score={baselineScore} />

          {/* Suite dimensions */}
          {activeDimensions.length > 0 && activeDimensions.map((dimId) => (
            <ScoreBar
              key={dimId}
              name={dimensionName(dimId)}
              score={dimensionScores[dimId] ?? null}
            />
          ))}

          {/* Criteria — collapsible */}
          {hasCriteria && (
              <div>
                {/* Criteria header row — click to expand */}
                <button
                  type="button"
                  onClick={() => setCriteriaExpanded((v) => !v)}
                  className="flex w-full items-center gap-2 group"
                >
                  <span className="w-28 shrink-0 truncate text-xs text-muted-foreground text-left">Criteria</span>
                  <div className="flex-1 h-1.5 rounded-full bg-muted overflow-hidden">
                    {criteriaScore !== null && (
                      <div
                        className={cn("h-full rounded-full transition-all", barColorForScore(criteriaScore))}
                        style={{ width: `${Math.min(100, criteriaScore)}%` }}
                      />
                    )}
                  </div>
                  <span className="w-8 shrink-0 text-right text-xs font-mono tabular-nums">
                    {criteriaScore !== null ? `${criteriaScore}` : "—"}
                  </span>
                  <ChevronDown className={cn(
                    "h-3 w-3 shrink-0 text-muted-foreground transition-transform",
                    criteriaExpanded && "rotate-180",
                  )} />
                </button>

                {/* Criteria detail items */}
                {criteriaExpanded && (
                  <div className="mt-2 ml-1 space-y-1 border-l-2 border-muted pl-3">
                    {criteriaChecklist.map((item, i) => (
                      <div key={i} className="flex items-start gap-1.5">
                        <div className="mt-0.5 shrink-0">
                          <CriteriaCheckIcon passed={item.passed} />
                        </div>
                        <div className="min-w-0 flex-1">
                          <span className={cn(
                            "text-[11px] break-words",
                            item.passed === false ? "text-red-400" : "text-muted-foreground",
                          )}>
                            {item.label}
                          </span>
                          {item.kind === "expectation" && item.score !== null && (
                            <span className="ml-1.5 text-[10px] font-mono tabular-nums text-muted-foreground">
                              {item.score}/100
                            </span>
                          )}
                          {item.actual !== undefined && (
                            <p className="text-[10px] text-muted-foreground/70">
                              actual: {item.actual}
                            </p>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
          )}
        </div>
      </ScrollArea>

      {/* Bottom Half: Feedback */}
      <div className="flex items-center border-y bg-muted/40 px-3 py-1.5">
        <span className="text-xs font-medium text-foreground">Feedback</span>
      </div>
      <ScrollArea className="basis-1/2 min-h-0 bg-background">
        <div className="p-3 h-full">
          <div className={cn(
            "text-xs text-muted-foreground rounded border p-3 min-h-full",
            hasResult ? "bg-muted/10 border-border" : "bg-muted/20 border-dashed",
          )}>
            {feedback ?? "No evaluation result yet. Click Run to evaluate."}
          </div>
        </div>
      </ScrollArea>
    </div>
  );
}
