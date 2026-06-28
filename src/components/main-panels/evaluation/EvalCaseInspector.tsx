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
  SlidersHorizontal,
  MessageSquareText,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { BUILTIN_DIMENSIONS, DIMENSION_CATEGORIES, type EvalCriteria, type EvalTurn } from "@/lib/evaluation/types";
import type { EvalSuiteRow, EvalCaseRow } from "@/store/evaluation";
import { evalCaseActions } from "@/store/evaluation-cases";

/** EvalTurn with a stable React key (runtime-only, not persisted). */
interface KeyedTurn extends EvalTurn {
  _key: number;
}

function dimensionName(id: string): string {
  return BUILTIN_DIMENSIONS.find((d) => d.id === id)?.name ?? id;
}

// Turn row — flat layout: "User (n)" label + response button + delete button, then textarea

interface TurnRowProps {
  turn: EvalTurn;
  index: number;
  canDelete: boolean;
  selected: boolean;
  onChange: (updated: EvalTurn) => void;
  onDelete: () => void;
  onViewResponse: () => void;
}

function TurnRow({ turn, index, canDelete, selected, onChange, onDelete, onViewResponse }: TurnRowProps): ReactNode {
  const hasResponse = Boolean(turn.actualResponse);

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
          disabled={!hasResponse}
          className={cn(
            "rounded p-0.5 transition-colors",
            hasResponse
              ? selected
                ? "bg-emerald-500/15 text-emerald-400"
                : "text-muted-foreground hover:bg-muted hover:text-foreground"
              : "text-muted-foreground/30 cursor-default",
          )}
          title={hasResponse ? "View response" : "Not yet executed"}
        >
          <MessageSquareText className="h-3.5 w-3.5" />
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
        placeholder="User message…"
        className="h-20 text-xs resize-none field-sizing-fixed"
      />
    </div>
  );
}

// Response viewer — shows a specific turn's agent response

function ResponseViewer({ turn, index }: { turn: EvalTurn; index: number }): ReactNode {
  if (!turn.actualResponse) {
    return (
      <div className="p-3 text-xs text-muted-foreground">
        Turn {index + 1} has not been executed yet.
      </div>
    );
  }

  return (
    <div className="flex flex-col space-y-2 p-3 h-full min-h-0">
      {turn.toolCalls && turn.toolCalls.length > 0 && (
        <div className="space-y-1">
          {turn.toolCalls.map((tc, i) => (
            <div key={i} className="rounded border bg-muted/20 px-2 py-1.5 space-y-0.5">
              <span className="text-[10px] font-mono font-medium text-blue-400">{tc.name}</span>
              <pre className="text-[9px] text-muted-foreground whitespace-pre-wrap">{tc.args}</pre>
              <pre className="text-[9px] text-muted-foreground whitespace-pre-wrap border-t pt-0.5">{tc.result}</pre>
            </div>
          ))}
        </div>
      )}
      <div className="flex-1 rounded border bg-background px-2.5 py-2 text-xs leading-relaxed text-muted-foreground overflow-y-auto">
        {turn.actualResponse}
      </div>
    </div>
  );
}

// Criteria JSON editor — case-level

interface CriteriaEditorProps {
  criteria: EvalCriteria;
  onChange: (updated: EvalCriteria) => void;
  onErrorChange: (hasError: boolean) => void;
}

function CriteriaEditor({ criteria, onChange, onErrorChange }: CriteriaEditorProps): ReactNode {
  const [text, setText] = useState(JSON.stringify(criteria, null, 2));
  const [error, setError] = useState<string | null>(null);

  function handleChange(v: string): void {
    setText(v);
    if (!v.trim() || v.trim() === "{}") {
      setError(null);
      onErrorChange(false);
      onChange({});
      return;
    }
    try {
      const parsed: EvalCriteria = JSON.parse(v);
      setError(null);
      onErrorChange(false);
      onChange(parsed);
    } catch {
      setError("Invalid JSON");
      onErrorChange(true);
    }
  }

  return (
    <div className="flex flex-col gap-1.5 p-3 h-full min-h-0">
      <Textarea
        value={text}
        onChange={(e) => handleChange(e.target.value)}
        placeholder={'{\n  "expectation": "...",\n  "tool_calls": ["..."],\n  "expected_keywords": ["..."],\n  "assertions": ["duration_ms <= 5000"]\n}'}
        className={cn("flex-1 font-mono text-xs resize-none field-sizing-fixed", error ? "border-destructive" : "border-amber-500/30")}
      />
      {error && <p className="text-[10px] text-destructive shrink-0">{error}</p>}
    </div>
  );
}

// Score bar

function ScoreBar({ dimensionId, nameOverride, score }: { dimensionId: string; nameOverride?: string; score: number | null }): ReactNode {
  return (
    <div className="flex items-center gap-2">
      <span className="w-28 shrink-0 truncate text-xs text-muted-foreground">{nameOverride ?? dimensionName(dimensionId)}</span>
      <div className="flex-1 h-1.5 rounded-full bg-muted overflow-hidden">
        {score !== null && (
          <div
            className={cn(
              "h-full rounded-full transition-all",
              score >= 80 ? "bg-emerald-500" : score >= 60 ? "bg-amber-500" : "bg-red-500",
            )}
            style={{ width: `${Math.min(100, score)}%` }}
          />
        )}
      </div>
      <span className="w-8 shrink-0 text-right text-xs font-mono tabular-nums">
        {score !== null ? `${score}` : "—"}
      </span>
    </div>
  );
}

// Main component

interface EvalCaseInspectorProps {
  evalCase: EvalCaseRow;
  suite: EvalSuiteRow;
}

// CONTRACT: parent renders <EvalCaseInspector key={evalCase.id} />,
// so the counter resets on case switch via remount.
let nextTurnKey = 0;
function mintKey(): number { return nextTurnKey++; }

export function EvalCaseInspector({ evalCase, suite }: EvalCaseInspectorProps): ReactNode {
  const [turns, setTurns] = useState<KeyedTurn[]>(() =>
    (evalCase.turns as EvalTurn[]).map((t) => ({ ...t, _key: mintKey() })),
  );
  const [criteria, setCriteria] = useState<EvalCriteria>((evalCase.criteria ?? {}) as EvalCriteria);
  const [dimOverride, setDimOverride] = useState<string[] | null>(evalCase.dimensionOverride as string[] | null);
  const [criteriaHasError, setCriteriaHasError] = useState(false);
  const [saving, setSaving] = useState(false);

  type BottomTab = "criteria" | "response";
  const [bottomTab, setBottomTab] = useState<BottomTab>("criteria");
  const [responseTurnIdx, setResponseTurnIdx] = useState<number>(0);

  // Strip runtime-only `_key` for persistence and comparison.
  function stripKeys(kt: KeyedTurn[]): EvalTurn[] {
    return kt.map(({ _key: _, ...rest }) => rest);
  }

  // Snapshot original values for dirty comparison (stable across renders).
  const origTurnsJson = useMemo(() => JSON.stringify(evalCase.turns), [evalCase.turns]);
  const origCriteriaJson = useMemo(() => JSON.stringify(evalCase.criteria ?? {}), [evalCase.criteria]);
  const origDimOverrideJson = useMemo(() => JSON.stringify(evalCase.dimensionOverride ?? null), [evalCase.dimensionOverride]);

  const isDirty =
    JSON.stringify(stripKeys(turns)) !== origTurnsJson ||
    JSON.stringify(criteria) !== origCriteriaJson ||
    JSON.stringify(dimOverride) !== origDimOverrideJson;

  const canSave = isDirty && !criteriaHasError && !saving;

  const handleSave = useCallback(async (): Promise<void> => {
    if (!canSave) return;
    setSaving(true);
    await evalCaseActions.patch(
      { id: evalCase.id, suiteId: evalCase.suiteId },
      {
        turns: stripKeys(turns) as Array<{ userMessage: string }>,
        criteria: criteria as Record<string, unknown>,
        dimensionOverride: dimOverride,
      },
    );
    setSaving(false);
  }, [canSave, evalCase.id, evalCase.suiteId, turns, criteria, dimOverride]);

  const activeDimensions = dimOverride ?? suite.dimensionIds;
  const isOverridden = dimOverride !== null;

  function toggleDimension(dimId: string): void {
    const current = dimOverride ?? [...suite.dimensionIds];
    const next = current.includes(dimId)
      ? current.filter((d) => d !== dimId)
      : [...current, dimId];
    setDimOverride(next);
  }

  function resetToSuiteDefault(): void {
    setDimOverride(null);
  }

  function updateTurn(index: number, updated: EvalTurn): void {
    setTurns((prev) => prev.map((t, i) => (i === index ? { ...updated, _key: t._key } : t)));
  }

  function deleteTurn(index: number): void {
    setTurns((prev) => prev.filter((_, i) => i !== index));
    if (responseTurnIdx >= index && responseTurnIdx > 0) {
      setResponseTurnIdx(responseTurnIdx - 1);
    }
  }

  function addTurn(): void {
    setTurns((prev) => [...prev, { userMessage: "", _key: mintKey() }]);
  }

  function viewResponse(index: number): void {
    setResponseTurnIdx(index);
    setBottomTab("response");
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
            {/* Dimension override dropdown */}
            <DropdownMenu>
              <DropdownMenuTrigger
                className={cn(
                  "inline-flex h-6 items-center gap-1 rounded-md px-2 text-[10px] transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                  isOverridden
                    ? "text-amber-500 hover:bg-amber-500/10"
                    : "text-muted-foreground hover:bg-muted hover:text-foreground",
                )}
              >
                <SlidersHorizontal className="h-3 w-3" />
                Dims ({activeDimensions.length})
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56 p-2">
                <div className="max-h-[280px] overflow-y-auto space-y-2">
                  {DIMENSION_CATEGORIES.map((cat) => {
                    const dims = BUILTIN_DIMENSIONS.filter((d) => d.category === cat);
                    return (
                      <div key={cat}>
                        <p className="text-[9px] font-semibold uppercase tracking-wider text-muted-foreground mb-1">{cat}</p>
                        {dims.map((dim) => (
                          <label key={dim.id} className="flex cursor-pointer items-center gap-1.5 rounded px-1 py-0.5 hover:bg-muted/40">
                            <Checkbox
                              checked={activeDimensions.includes(dim.id)}
                              onCheckedChange={() => toggleDimension(dim.id)}
                            />
                            <span className="text-[11px]">{dim.name}</span>
                          </label>
                        ))}
                      </div>
                    );
                  })}
                </div>
                {isOverridden && (
                  <button
                    type="button"
                    onClick={resetToSuiteDefault}
                    className="mt-2 w-full rounded border border-dashed px-2 py-1 text-[10px] text-muted-foreground hover:text-foreground"
                  >
                    Reset to suite default
                  </button>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
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
              disabled={!suite.evaluatorAgentId}
              title={suite.evaluatorAgentId ? "Run case" : "Evaluator Agent is required to run"}
            >
              {false ? (
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
                onChange={(updated) => updateTurn(i, updated)}
                onDelete={() => deleteTurn(i)}
                onViewResponse={() => viewResponse(i)}
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
          ) : turns[responseTurnIdx] ? (
            <ResponseViewer turn={turns[responseTurnIdx]} index={responseTurnIdx} />
          ) : (
            <div className="p-3 text-xs text-muted-foreground">No turn selected.</div>
          )}
        </ScrollArea>
      </div>

        {/* Right: evaluation result */}
        <div className="flex flex-[3] flex-col min-w-0">
          <div className="flex h-10 shrink-0 items-center border-b bg-muted/40 px-3">
            <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
              Evaluation
            </span>
          </div>
          <div className="flex flex-1 flex-col p-3 min-h-0 gap-4">
            <div className="shrink-0 space-y-4">
              <ScoreBar dimensionId="overall" nameOverride="Overall Score" score={null} />
              <div className="h-px bg-border w-full" />
              <div className="space-y-1.5">
                <ScoreBar dimensionId="baseline" nameOverride="Baseline" score={null} />
                {activeDimensions.map((dimId) => (
                  <ScoreBar key={dimId} dimensionId={dimId} score={null} />
                ))}
              </div>
            </div>

            <div className="flex flex-col flex-1 min-h-0 space-y-1.5">
              <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                Summary
              </span>
              <div className="flex-1 overflow-y-auto text-xs text-muted-foreground bg-muted/30 p-2 rounded border border-dashed">
                No evaluation result yet. Click Run case to evaluate.
              </div>
            </div>
          </div>
        </div>
    </div>
  );
}
