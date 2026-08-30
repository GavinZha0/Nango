"use client";

/**
 * EvalCaseInspector — middle + right columns of the evaluation main panel.
 *
 * Middle: multi-turn conversation editor (user messages + UniversalAssertionsEditor + collapsed agent response).
 * Right: evaluation result (overall score, per-dimension score bars, checklist, feedback).
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
  running: boolean;
  hasRun: boolean;
  turnIndex: number;
  error?: string | null;
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

function ResponseViewer({ messages, isLoading, running, hasRun, turnIndex: _turnIndex }: ResponseViewerProps): ReactNode {
  if (running || isLoading) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-xs text-muted-foreground font-sans">
        <Loader2 className="h-4 w-4 animate-spin text-primary" />
        Executing case & evaluating assertions...
      </div>
    );
  }

  if (!hasRun) {
    return (
      <div className="flex items-center justify-center h-full p-3 text-xs text-muted-foreground">
        Run a case to see the output.
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
  error?: unknown;
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
    if (Array.isArray(evalCase.assertions)) {
      return evalCase.assertions as AssertionSpec[];
    }
    return [];
  });

  const [assertionsHasError, setAssertionsHasError] = useState(false);
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

  const canSave = isDirty && !assertionsHasError && !saving;

  const activeDimensions = suite.dimensionIds;

  function updateTurn(index: number, updated: EvalTurn): void {
    setTurns((prev) => prev.map((t, i) => (i === index ? { ...updated, _key: t._key } : t)));
  }

  const [runOutcome, setRunOutcome] = useState<RunEvalCaseResult | null>(null);
  const [running, setRunning] = useState<boolean>(false);
  const [runError, setRunError] = useState<string | null>(null);

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
  const displayAssertionScore = pinnedOutcome
    ? pinnedOutcome.criteriaScore
    : (runOutcome ? (runOutcome.criteriaScore ?? null) : (liveCaseResult?.criteriaScore ?? (historicalResult?.criteriaScore ?? null)));
  const displayFeedback = pinnedOutcome
    ? pinnedOutcome.feedback
    : (runOutcome ? (runOutcome.feedback ?? null) : (liveCaseResult?.feedback ?? (historicalResult?.feedback ?? null)));
  const displayAssertionResults = pinnedOutcome
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
    : (running
        ? "running"
        : (runError
            ? "errored"
            : (runOutcome
                ? runOutcome.status
                : (liveRun.phase === "idle"
                    ? (historicalResult?.status ?? "idle")
                    : (liveCaseResult?.status ?? "running")))));

  const displayError = runError ?? runOutcome?.error ?? (pinnedOutcome ? (typeof pinnedOutcome.error === "string" ? pinnedOutcome.error : (pinnedOutcome.error as { message?: string } | undefined)?.message) : null);

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
        assertions,
        isDirty: Boolean(isDirty),
      },
      outcome: (displayScore !== null || resolvedStatus !== "idle")
        ? {
            source: pinnedOutcome ? "history" : "live",
            ...(pinnedOutcome && selectedRunSeq !== null ? { historySeq: selectedRunSeq } : {}),
            status: resolvedStatus,
            score: displayScore,
            dimensionScores: displayDimensionScores,
            criteriaScore: displayAssertionScore,
            criteriaResults: displayAssertionResults ?? [],
            feedback: displayFeedback || null,
          }
        : null,
    } as Record<string, unknown>;
  }, [
    suite,
    evalCase,
    turns,
    assertions,
    isDirty,
    displayScore,
    resolvedStatus,
    pinnedOutcome,
    selectedRunSeq,
    displayDimensionScores,
    displayAssertionScore,
    displayAssertionResults,
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
        signal: AbortSignal.timeout(600_000),
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
        setRunError("Evaluation timed out on client side after 600s. Consider reducing turns or testing with shorter prompts.");
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
              onClick={handleSave}
              disabled={!canSave || saving || selectedRunSeq !== null}
              title="Save changes"
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
              disabled={running || liveRun.phase === "running"}
              title={
                running || liveRun.phase === "running"
                  ? "A run is in progress"
                  : "Run case"
              }
              onClick={() => void handleRunSingleCase()}
            >
              {running || liveRun.phase === "running" ? (
                <Loader2 className="mr-1 h-3 w-3 animate-spin" />
              ) : (
                <Play className="mr-1 h-3 w-3 fill-green-500 text-green-500" />
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
              onErrorChange={(err) => setAssertionsHasError(Boolean(err))}
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
                running={running || liveRun.phase === "running"}
                hasRun={!!resolvedRunId}
                turnIndex={responseTurnIdx}
                error={displayError}
              />
            </ScrollArea>
          </div>

          {/* Bottom: Verdicts (Scores, Checklist, and Feedback) */}
          <div className="flex min-h-0 flex-col overflow-hidden border-t">
            <EvaluationPanel
              activeDimensions={activeDimensions}
              overallScore={displayScore}
              baselineScore={displayBaselineScore}
              dimensionScores={displayDimensionScores}
              assertionScore={displayAssertionScore}
              assertionResults={displayAssertionResults}
              feedback={displayFeedback}
              durationMs={displayDurationMs}
              outputTokens={displayOutputTokens}
              selectedRunSeq={selectedRunSeq}
              startedAt={pinnedOutcome?.startedAt}
              status={resolvedStatus}
              error={displayError}
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
  overallScore: number | null;
  baselineScore: number | null;
  dimensionScores: Record<string, number>;
  assertionScore: number | null;
  assertionResults: unknown[] | null;
  feedback: string | null;
  durationMs: number | null;
  outputTokens: number | null;
  selectedRunSeq?: number | null;
  startedAt?: Date | string | null;
  status?: string | null;
  error?: string | null;
}

function EvaluationPanel({
  activeDimensions,
  overallScore,
  baselineScore,
  dimensionScores,
  assertionScore,
  assertionResults,
  feedback,
  durationMs,
  outputTokens,
  selectedRunSeq = null,
  startedAt = null,
  status = null,
  error = null,
}: EvaluationPanelProps): ReactNode {
  const [assertionsExpanded, setAssertionsExpanded] = useState(true);
  const tz = useDisplayTimezone();

  const resultsList = Array.isArray(assertionResults) && assertionResults.length > 0
    ? (assertionResults as CriteriaCheckResult[]).filter((r) => r.kind !== "expectation")
    : null;
  const hasAssertionResults = resultsList !== null && resultsList.length > 0;

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
          {overallScore !== null ? (
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
          ) : status === "errored" ? (
            <span className="rounded px-1.5 py-0.5 text-[10px] font-semibold text-red-400 bg-red-500/15">
              Error
            </span>
          ) : null}
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

            {/* Deterministic Assertions — collapsible, shown only when evaluation results are available */}
            {hasAssertionResults && (
              <div className="pt-1">
                <button
                  type="button"
                  onClick={() => setAssertionsExpanded((v) => !v)}
                  className="flex w-full items-center gap-2 group"
                >
                  <span className="w-28 shrink-0 truncate text-xs text-muted-foreground text-left font-medium">Deterministic</span>
                  <div className="flex-1 h-1.5 rounded-full bg-muted overflow-hidden">
                    {assertionScore !== null && (
                      <div
                        className={cn("h-full rounded-full transition-all", barColorForScore(assertionScore))}
                        style={{ width: `${Math.min(100, assertionScore)}%` }}
                      />
                    )}
                  </div>
                  <span className="w-8 shrink-0 text-right text-xs font-mono tabular-nums">
                    {assertionScore !== null ? `${assertionScore}` : "—"}
                  </span>
                  <ChevronDown className={cn(
                    "h-3 w-3 shrink-0 text-muted-foreground transition-transform",
                    assertionsExpanded && "rotate-180",
                  )} />
                </button>

                {assertionsExpanded && (
                  <div className="mt-2 ml-1 space-y-1 border-l-2 border-muted pl-3">
                    <ul className="space-y-1">
                      {resultsList.map((item, i) => (
                        <li
                          key={i}
                          className="flex items-start gap-2 rounded border border-border/60 bg-background/40 px-2 py-1 font-mono text-[11px]"
                        >
                          <span
                            className={cn(
                              "shrink-0 font-semibold",
                              item.passed
                                ? "text-emerald-600 dark:text-emerald-400"
                                : "text-red-600 dark:text-red-400",
                            )}
                          >
                            {item.passed ? "✓" : "✗"}
                          </span>
                          <div className="min-w-0 flex-1">
                            <div className="flex items-start justify-between gap-2">
                              <span className="text-muted-foreground break-all">
                                #{i + 1} · {item.label}
                              </span>
                              {item.passed === false && item.actual !== undefined && (
                                <span className="shrink-0 text-red-500/80 dark:text-red-400/80 font-mono text-[10px]">
                                  ({item.actual})
                                </span>
                              )}
                            </div>
                          </div>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Feedback section inside Verdicts */}
          <div className="space-y-1.5 pt-2 border-t border-muted">
            <span className="text-[11px] font-semibold text-muted-foreground">Feedback</span>
            <div className={cn(
              "text-xs rounded-md border p-2.5 leading-relaxed whitespace-pre-wrap",
              error
                ? "bg-red-500/10 border-red-500/30 text-red-500 dark:text-red-400 font-medium"
                : hasResult
                  ? "bg-muted/10 border-border text-muted-foreground"
                  : "bg-muted/20 border-dashed text-muted-foreground",
            )}>
              {error ?? feedback ?? "No verdict yet."}
            </div>
          </div>
        </div>
      </ScrollArea>
    </div>
  );
}
