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
  Copy,
  Terminal,
} from "lucide-react";
import useSWR from "swr";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import {
  BUILTIN_DIMENSIONS,
  type EvalCriteria,
  type EvalTurn,
  type CriteriaCheckResult,
} from "@/lib/evaluation/types";
import { UniversalAssertionsEditor } from "@/components/main-panels/common/UniversalAssertionsEditor";
import type { AssertionSpec } from "@/lib/assertions";
import type { RunEvalCaseResult } from "@/lib/evaluation/eval-runner";
import type { EvaluationRunLiveState } from "@/hooks/useEvaluationRunStream";
import { useDisplayTimezone } from "@/hooks/useDisplayTimezone";
import { formatTimestamp } from "@/components/admin/format";
import {
  LEVEL_META,
  scoreToLevel,
  barColorForScore,
} from "@/lib/evaluation/config";
import { extractTargetCase } from "@/components/main-panels/common";
import type { EvalSuiteRow, EvalCaseRow } from "@/store/evaluation";
import { evalCaseActions } from "@/store/evaluation-cases";
import { useCopilotDraft } from "@/hooks/useCopilotDraft";

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
  readOnly?: boolean;
}

function TurnRow({
  turn,
  index,
  canDelete,
  selected,
  hasResponse,
  onChange,
  onDelete,
  onViewResponse,
  readOnly = false,
}: TurnRowProps): ReactNode {
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
        {canDelete && !readOnly && (
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
        placeholder={readOnly ? "No message content" : "User message..."}
        className={cn("h-20 text-xs resize-none field-sizing-fixed leading-relaxed", readOnly && "bg-transparent cursor-default")}
        readOnly={readOnly}
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

function ToolMessageRow({ msg }: { msg: ResponseMessage }): ReactNode {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="rounded-md border border-amber-500/20 bg-amber-500/5 overflow-hidden">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center justify-between px-2.5 py-1 text-left text-xs hover:bg-amber-500/10 transition-colors"
      >
        <div className="flex items-center gap-1.5 min-w-0">
          <Terminal className="h-3 w-3 text-amber-500 shrink-0" />
          <span className="font-mono text-[11px] font-semibold text-amber-500 truncate">
            {msg.toolName ? `Tool: ${msg.toolName}` : "Tool Execution"}
          </span>
        </div>
        <div className="flex items-center gap-1 text-[10px] text-muted-foreground shrink-0">
          <span className="text-[9px] uppercase tracking-wider font-mono">{expanded ? "Hide" : "Show"}</span>
          <ChevronDown
            className={cn(
              "h-3 w-3 transition-transform text-amber-500/70",
              expanded && "rotate-180",
            )}
          />
        </div>
      </button>
      {expanded && (
        <div className="border-t border-amber-500/15 bg-background/60 p-2 text-xs font-mono text-muted-foreground whitespace-pre-wrap break-all leading-relaxed">
          {msg.content || "(empty tool output)"}
        </div>
      )}
    </div>
  );
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
        {messages.map((msg, i) => {
          if (msg.role === "tool") {
            return <ToolMessageRow key={i} msg={msg} />;
          }

          return (
            <div key={i} className="space-y-0.5">
              <span
                className={cn(
                  "text-[10px] font-semibold uppercase tracking-wider",
                  msg.role === "user" ? "text-blue-400" : "text-emerald-400",
                )}
              >
                {msg.role}
              </span>
              <div className="rounded border bg-muted/20 px-2.5 py-1.5 text-xs leading-relaxed text-muted-foreground whitespace-pre-wrap">
                {msg.content || "(empty)"}
              </div>
            </div>
          );
        })}
      </div>
    </ScrollArea>
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

export interface PinnedOutcome {
  status: "passed" | "failed" | "errored";
  score: number | null;
  dimensionScores: Record<string, number>;
  criteriaScore: number | null;
  criteriaResults: unknown[];
  feedback: string | null;
  durationMs: number | null;
  outputTokens: number | null;
  startedAt: Date | string | null;
}

interface EvalCaseInspectorProps {
  evalCase: EvalCaseRow;
  suite: EvalSuiteRow;
  liveRun: EvaluationRunLiveState;
  onRunCase: (caseId: number) => Promise<void>;
  pinnedOutcome?: PinnedOutcome;
  pinnedRunId?: string | null;
  selectedRunSeq?: number | null;
  onExitHistoryView?: () => void;
}

// CONTRACT: parent renders <EvalCaseInspector key={evalCase.id} />,
// so the counter resets on case switch via remount.
let nextTurnKey = 0;
function mintKey(): number { return nextTurnKey++; }

export function EvalCaseInspector({
  evalCase,
  suite,
  liveRun,
  onRunCase: _onRunCase,
  pinnedOutcome,
  pinnedRunId,
  selectedRunSeq = null,
  onExitHistoryView,
}: EvalCaseInspectorProps): ReactNode {
  const [turns, setTurns] = useState<KeyedTurn[]>(() => {
    const caseInput = (evalCase.input ?? {}) as Record<string, unknown>;
    const rawTurns = Array.isArray(caseInput.turns)
      ? (caseInput.turns as EvalTurn[])
      : (Array.isArray(evalCase.turns) ? (evalCase.turns as EvalTurn[]) : []);
    return rawTurns.map((t) => ({ ...t, _key: mintKey() }));
  });

  const [assertions, setAssertions] = useState<AssertionSpec[]>(() => {
    if (Array.isArray(evalCase.assertions) && evalCase.assertions.length > 0) {
      return evalCase.assertions as AssertionSpec[];
    }
    const legacy: AssertionSpec[] = [];
    const c = (evalCase.criteria ?? {}) as EvalCriteria;
    if (c.expectation) legacy.push({ type: "llm_judge", expectation: c.expectation, reference: c.reference });
    for (const kw of c.expected_keywords ?? []) legacy.push({ type: "jsonpath", path: "$.text", operator: "contains", expected: kw });
    for (const tc of c.tool_calls ?? []) legacy.push({ type: "tool_call", toolName: tc, expectedCalls: 1 });
    if (c.max_duration_s) legacy.push({ type: "metric", metric: "duration_ms", operator: "<=", threshold: c.max_duration_s * 1000 });
    if (c.max_output_tokens) legacy.push({ type: "metric", metric: "output_tokens", operator: "<=", threshold: c.max_output_tokens });
    if (c.max_tool_calls) legacy.push({ type: "metric", metric: "total_tool_calls", operator: "<=", threshold: c.max_tool_calls });
    return legacy;
  });

  const [criteria, _setCriteria] = useState<EvalCriteria>((evalCase.criteria ?? {}) as EvalCriteria);
  const [criteriaHasError, setCriteriaHasError] = useState(false);
  const [saving, setSaving] = useState(false);
  const [responseTurnIdx, setResponseTurnIdx] = useState<number>(() => Math.max(0, turns.length - 1));

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
  const origTurnsJson = useMemo(() => {
    const caseInput = (evalCase.input ?? {}) as Record<string, unknown>;
    const rawTurns = Array.isArray(caseInput.turns)
      ? caseInput.turns
      : (Array.isArray(evalCase.turns) ? evalCase.turns : []);
    return JSON.stringify(rawTurns);
  }, [evalCase.input, evalCase.turns]);

  const origAssertionsJson = useMemo(() => {
    if (Array.isArray(evalCase.assertions)) return JSON.stringify(evalCase.assertions);
    return JSON.stringify([]);
  }, [evalCase.assertions]);

  const isDirty =
    JSON.stringify(stripKeys(turns)) !== origTurnsJson ||
    JSON.stringify(assertions) !== origAssertionsJson;

  const canSave = isDirty && !criteriaHasError && !saving;

  const activeDimensions = suite.dimensionIds;

  function updateTurn(index: number, updated: EvalTurn): void {
    setTurns((prev) => prev.map((t, i) => (i === index ? { ...updated, _key: t._key } : t)));
  }

  const [runOutcome, setRunOutcome] = useState<RunEvalCaseResult | null>(null);
  const [running, setRunning] = useState<boolean>(false);
  const [_runError, setRunError] = useState<string | null>(null);

  // Derive display scores: prefer pinnedOutcome (history snapshot), then runOutcome (local run), then liveRun, then latest-result SWR
  const liveCaseResult = liveRun.caseResults.get(evalCase.id);
  
  const displayScore = pinnedOutcome
    ? pinnedOutcome.score
    : (runOutcome ? runOutcome.score : (liveCaseResult?.score ?? (historicalResult?.score ?? null)));
  const displayDimensionScores = useMemo(() => {
    return pinnedOutcome
      ? pinnedOutcome.dimensionScores
      : (runOutcome?.dimensionScores ?? (liveCaseResult?.dimensionScores ?? (historicalResult?.dimensionScores ?? {})));
  }, [pinnedOutcome, runOutcome?.dimensionScores, liveCaseResult?.dimensionScores, historicalResult?.dimensionScores]);
  const displayBaselineScore = displayDimensionScores?.baseline ?? null;
  const displayCriteriaScore = pinnedOutcome
    ? pinnedOutcome.criteriaScore
    : (runOutcome ? (runOutcome.criteriaScore ?? null) : (liveCaseResult?.criteriaScore ?? (historicalResult?.criteriaScore ?? null)));
  const displayFeedback = pinnedOutcome
    ? pinnedOutcome.feedback
    : (runOutcome ? (runOutcome.feedback ?? null) : (liveCaseResult?.feedback ?? (historicalResult?.feedback ?? null)));
  const displayCriteriaResults = pinnedOutcome
    ? pinnedOutcome.criteriaResults
    : (runOutcome ? (runOutcome.criteriaResults ?? null) : (liveCaseResult?.criteriaResults ?? (historicalResult?.criteriaResults ?? null)));
  const displayDurationMs = pinnedOutcome
    ? pinnedOutcome.durationMs
    : (runOutcome ? (runOutcome.durationMs ?? null) : (liveCaseResult?.durationMs ?? (historicalResult?.durationMs ?? null)));
  const displayOutputTokens = pinnedOutcome
    ? pinnedOutcome.outputTokens
    : (runOutcome ? (runOutcome.outputTokens ?? null) : (liveCaseResult?.outputTokens ?? (historicalResult?.outputTokens ?? null)));

  const resolvedRunId = pinnedOutcome
    ? pinnedRunId
    : (runOutcome ? "playground" : (liveRun.phase === "idle" ? (historicalResult?.runId ?? null) : liveRun.runId));
  const resolvedThreadId = runOutcome?.threadId ?? null;
  const resolvedStatus = pinnedOutcome
    ? pinnedOutcome.status
    : (running ? "running" : (runOutcome ? runOutcome.status : (liveRun.phase === "idle" ? (historicalResult?.status ?? "idle") : (liveCaseResult?.status ?? "running"))));

  // Copilot ambient context & draft integration
  const getCurrentData = useCallback(() => {
    return {
      suite: {
        id: suite.id,
        name: suite.name,
        description: suite.description ?? null,
        agentId: suite.agentId,
        agentSource: suite.agentSource,
        evaluatorAgentId: suite.evaluatorAgentId,
        dimensionIds: suite.dimensionIds,
        caseCount: 0,
      },
      selectedCase: {
        id: evalCase.id,
        suiteId: evalCase.suiteId,
        suiteName: suite.name,
        name: evalCase.name,
        turns: stripKeys(turns),
        criteria,
        isDirty: Boolean(isDirty),
      },
      outcome: (displayScore !== null || resolvedStatus !== "idle")
        ? {
            source: pinnedOutcome ? "history" : "live",
            ...(pinnedOutcome && selectedRunSeq !== null ? { historySeq: selectedRunSeq } : {}),
            status: resolvedStatus,
            score: displayScore,
            dimensionScores: displayDimensionScores,
            criteriaScore: displayCriteriaScore,
            criteriaResults: displayCriteriaResults ?? [],
            feedback: displayFeedback || null,
          }
        : null,
    } as Record<string, unknown>;
  }, [
    suite,
    evalCase,
    turns,
    criteria,
    isDirty,
    displayScore,
    resolvedStatus,
    pinnedOutcome,
    selectedRunSeq,
    displayDimensionScores,
    displayCriteriaScore,
    displayCriteriaResults,
    displayFeedback,
  ]);

  const applyDraft = useCallback((draft: Record<string, unknown>) => {
    const applied: string[] = [];
    const sc = extractTargetCase(draft, evalCase.id);
    if (Array.isArray(sc.turns)) {
      const newTurns: KeyedTurn[] = [];
      for (const item of sc.turns) {
        if (typeof item === "string") {
          newTurns.push({ userMessage: item, _key: mintKey() });
        } else if (item && typeof item === "object" && typeof (item as Record<string, unknown>).userMessage === "string") {
          newTurns.push({ userMessage: (item as Record<string, unknown>).userMessage as string, _key: mintKey() });
        }
      }
      if (newTurns.length > 0) {
        setTurns(newTurns);
        applied.push("turns");
      }
    }
    if (sc.assertions !== undefined && Array.isArray(sc.assertions)) {
      setAssertions(sc.assertions as AssertionSpec[]);
      applied.push("assertions");
    }
    if (draft.selectedCase) applied.push("selectedCase");
    return applied;
  }, [evalCase.id]);

  const { clearDraftState } = useCopilotDraft({
    resourceType: "evaluation",
    resourceId: String(evalCase.id),
    isReadOnly: false,
    getCurrentData,
    applyDraft,
  });

  const handleSave = useCallback(async (): Promise<void> => {
    if (!canSave) return;
    setSaving(true);
    await evalCaseActions.patch(
      { id: evalCase.id, suiteId: evalCase.suiteId },
      {
        input: { turns: stripKeys(turns) },
        assertions: assertions,
      },
    );
    setSaving(false);
    clearDraftState();
  }, [canSave, evalCase.id, evalCase.suiteId, turns, assertions, clearDraftState]);

  const messagesUrl = resolvedRunId === "playground" && resolvedThreadId
    ? `/api/eval-runs/playground/messages?caseId=${evalCase.id}&threadId=${resolvedThreadId}`
    : resolvedRunId
      ? `/api/eval-runs/${resolvedRunId}/messages?caseId=${evalCase.id}&status=${resolvedStatus}`
      : null;

  const { data: messagesData, isLoading: messagesLoading } = useSWR<{ messages: ResponseMessage[] }>(
    messagesUrl,
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

  const handleRunSingleCase = async (): Promise<void> => {
    onExitHistoryView?.();
    setRunError(null);
    setRunOutcome(null);
    setRunning(true);
    try {
      if (canSave) {
        await handleSave();
      }
      const res = await fetch(`/api/eval-cases/${evalCase.id}/run`, {
        method: "POST",
        signal: AbortSignal.timeout(290_000),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { message?: string } | null;
        throw new Error(body?.message ?? `${res.status} ${res.statusText}`);
      }
      const outcome = (await res.json()) as RunEvalCaseResult;
      setRunOutcome(outcome);
      setResponseTurnIdx(Math.max(0, turns.length - 1));
    } catch (err) {
      if (err instanceof Error && err.name === "TimeoutError") {
        setRunError("Evaluation timed out on client side after 290s. Consider reducing turns or testing with shorter prompts.");
      } else {
        setRunError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setRunning(false);
    }
  };

  function deleteTurn(index: number): void {
    setTurns((prev) => prev.filter((_, i) => i !== index));
  }

  function addTurn(): void {
    setTurns((prev) => [...prev, { userMessage: "", _key: mintKey() }]);
  }

  const [copied, setCopied] = useState(false);

  const handleCopyResponse = () => {
    if (!filteredMessages || filteredMessages.length === 0) return;
    const text = filteredMessages.map((m) => m.content).join("\n\n");
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="grid h-full grid-cols-2 overflow-hidden">
      {/* ── Middle Column: Input (Turns, Top) + Assertions (UniversalAssertionsEditor, Bottom) ── */}
      <div className="flex h-full min-h-0 flex-col border-r min-w-0">
        {/* Top Header: Input */}
        <div className="flex h-8 shrink-0 items-center border-b bg-muted/40 px-3">
          <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
            Input
          </span>
          <div className="ml-auto flex items-center gap-1">
            <Button
              size="sm"
              variant="ghost"
              className="h-6 w-6 p-0"
              onClick={addTurn}
              title="Add turn"
              disabled={selectedRunSeq !== null}
            >
              <SquarePlus className="h-3 w-3" />
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className={`h-6 w-6 p-0 hover:bg-transparent hover:text-foreground ${isDirty ? "text-amber-500" : "text-muted-foreground"}`}
              disabled={!canSave || selectedRunSeq !== null}
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
              disabled={!suite.evaluatorAgentId || running || liveRun.phase === "running"}
              title={
                !suite.evaluatorAgentId
                  ? "Evaluator not configured"
                  : running || liveRun.phase === "running"
                    ? "A run is in progress"
                    : "Run case"
              }
              onClick={() => void handleRunSingleCase()}
            >
              {running || liveRun.phase === "running" ? (
                <Loader2 className="mr-1 h-3 w-3 animate-spin" />
              ) : (
                <Play className={cn("mr-1 h-3 w-3", suite.evaluatorAgentId ? "fill-green-500 text-green-500" : "fill-muted-foreground text-muted-foreground")} />
              )}
              Run
            </Button>
          </div>
        </div>

        {/* Input & Assertions split */}
        <div className="grid min-h-0 flex-1 grid-rows-[calc(50%-1rem)_calc(50%+1rem)] overflow-hidden">
          {/* Top: conversation turns input */}
          <div className="flex min-h-0 flex-col overflow-hidden bg-background">
            <ScrollArea className="h-full">
              <div className="space-y-2 p-3">
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
                    onViewResponse={() => setResponseTurnIdx(i)}
                    readOnly={selectedRunSeq !== null}
                  />
                ))}
              </div>
            </ScrollArea>
          </div>

          {/* Bottom: Universal Assertions Editor */}
          <div className="flex min-h-0 flex-col overflow-hidden">
            <UniversalAssertionsEditor
              mode="evaluation"
              assertions={assertions}
              onChange={setAssertions}
              onErrorChange={(err) => setCriteriaHasError(Boolean(err))}
              readOnly={selectedRunSeq !== null}
              saving={saving}
            />
          </div>
        </div>
      </div>

      {/* ── Right Column: Output (Response, Top) + Verdicts (Scores & Feedback, Bottom) ── */}
      <div className="flex h-full min-h-0 flex-col min-w-0">
        {/* Top Header: Output (aligned with Left Column Input Header) */}
        <div className="flex h-8 shrink-0 items-center justify-between border-b bg-muted/40 px-3">
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
              Output
            </span>
          </div>
          <Button
            size="sm"
            variant="ghost"
            className="h-6 w-6 p-0 text-muted-foreground hover:text-foreground"
            onClick={handleCopyResponse}
            disabled={!hasResponse}
            title="Copy response"
          >
            {copied ? (
              <Check className="h-3.5 w-3.5 text-green-500" />
            ) : (
              <Copy className="h-3.5 w-3.5" />
            )}
          </Button>
        </div>

        {/* Output & Verdicts split — strictly 50%/50% matching Left Column */}
        <div className="grid h-full grid-rows-[calc(50%-1rem)_calc(50%+1rem)] min-w-0 flex-1 overflow-hidden bg-background">
          {/* Top: Output (Agent Response) */}
          <div className="flex min-h-0 flex-col overflow-hidden">
            <ScrollArea className="h-full">
              <ResponseViewer
                messages={filteredMessages}
                isLoading={messagesLoading}
                hasRun={!!resolvedRunId}
                turnIndex={responseTurnIdx}
              />
            </ScrollArea>
          </div>

          {/* Bottom: Verdicts (Scores, Checklist, and Feedback) */}
          <div className="flex min-h-0 flex-col overflow-hidden border-t">
            <EvaluationPanel
              activeDimensions={activeDimensions}
              criteria={criteria}
              overallScore={displayScore}
              baselineScore={displayBaselineScore}
              dimensionScores={displayDimensionScores}
              criteriaScore={displayCriteriaScore}
              criteriaResults={displayCriteriaResults}
              feedback={displayFeedback}
              durationMs={displayDurationMs}
              outputTokens={displayOutputTokens}
              selectedRunSeq={selectedRunSeq}
              startedAt={pinnedOutcome?.startedAt}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Verdicts & Evaluation result panel ─────────────────────────────

interface EvaluationPanelProps {
  activeDimensions: string[];
  criteria: EvalCriteria;
  overallScore: number | null;
  baselineScore: number | null;
  dimensionScores: Record<string, number>;
  criteriaScore: number | null;
  criteriaResults: unknown[] | null;
  feedback: string | null;
  durationMs: number | null;
  outputTokens: number | null;
  selectedRunSeq?: number | null;
  startedAt?: Date | string | null;
}

function EvaluationPanel({
  activeDimensions,
  criteria,
  overallScore,
  baselineScore,
  dimensionScores,
  criteriaScore,
  criteriaResults,
  feedback,
  durationMs,
  outputTokens,
  selectedRunSeq = null,
  startedAt = null,
}: EvaluationPanelProps): ReactNode {
  const [criteriaExpanded, setCriteriaExpanded] = useState(true);
  const tz = useDisplayTimezone();

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
  const formattedTime = startedAt ? formatTimestamp(startedAt, tz) : null;

  return (
    <div className="flex h-full min-h-0 flex-col min-w-0 bg-background">
      {/* Header: "Verdicts" + time, score, result badge */}
      <div className="flex h-8 shrink-0 items-center border-b bg-muted/20 px-3">
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            Verdicts
          </span>
        </div>
        <div className="ml-auto flex items-center gap-2">
          {/* 1. 执行时间 */}
          {selectedRunSeq !== null && (
            <span className="text-xs font-semibold text-amber-500 dark:text-amber-400 shrink-0">
              (#{selectedRunSeq}{formattedTime ? ` - ${formattedTime}` : ""})
            </span>
          )}
          {typeof durationMs === "number" && !isNaN(durationMs) && durationMs > 0 && (
            <span className="text-[10px] text-muted-foreground font-mono shrink-0">
              {durationMs >= 1000
                ? `${(durationMs / 1000).toFixed(1)}s`
                : `${durationMs}ms`}
            </span>
          )}
          {/* 2. 打分 + 3. 结果字符串 */}
          {overallScore !== null && (
            <div className="flex items-center gap-1.5 shrink-0">
              <span className="text-xs font-mono tabular-nums font-semibold">
                {overallScore}
              </span>
              {levelMeta && (
                <span className={cn("rounded px-1.5 py-0.5 text-[10px] font-semibold", levelMeta.color, levelMeta.bgColor)}>
                  {levelMeta.label}
                </span>
              )}
            </div>
          )}
        </div>
      </div>

      <ScrollArea className="flex-1 min-h-0">
        <div className="p-3 space-y-3">
          {/* Metrics header */}
          {hasResult && (durationMs !== null || outputTokens !== null) && (
            <div className="flex items-center gap-4 text-[11px] text-muted-foreground pb-2 border-b border-muted">
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

          {/* Scores Section */}
          <div className="space-y-1.5">
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

            {/* Criteria Checklist — collapsible */}
            {hasCriteria && (
              <div className="pt-1">
                <button
                  type="button"
                  onClick={() => setCriteriaExpanded((v) => !v)}
                  className="flex w-full items-center gap-2 group"
                >
                  <span className="w-28 shrink-0 truncate text-xs text-muted-foreground text-left font-medium">Checklist</span>
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
                            {item.actual !== undefined && (
                              <span className="text-[10px] text-muted-foreground/60 italic ml-1.5">
                                (actual: {item.actual})
                              </span>
                            )}
                          </span>
                          {item.kind === "expectation" && item.score !== null && (
                            <span className="ml-1.5 text-[10px] font-mono tabular-nums text-muted-foreground">
                              {item.score}/100
                            </span>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Feedback section inside Verdicts */}
          <div className="space-y-1.5 pt-2 border-t border-muted">
            <span className="text-[11px] font-semibold text-muted-foreground">Feedback</span>
            <div className={cn(
              "text-xs text-muted-foreground rounded-md border p-2.5 leading-relaxed",
              hasResult ? "bg-muted/10 border-border" : "bg-muted/20 border-dashed",
            )}>
              {feedback ?? "No verdict yet."}
            </div>
          </div>
        </div>
      </ScrollArea>
    </div>
  );
}
