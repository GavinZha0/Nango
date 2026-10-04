"use client";

/**
 * EvalCaseInspector — middle + right columns of the evaluation main panel.
 *
 * Middle: multi-turn conversation editor (user messages + UniversalAssertionsEditor + collapsed agent response).
 * Right: evaluation result (overall score, per-dimension score bars, checklist, feedback).
 *
 * Header hosts Add Turn and Evaluate buttons.
 */

import { useState, useMemo, useCallback, useEffect, useRef, type ReactNode } from "react";
import { readNdjson } from "@/lib/http/read-ndjson";
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
  Hammer,
} from "lucide-react";
import useSWR from "swr";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn, isDeepEqual, formatCharCount } from "@/lib/utils";
import {
  type EvalTurn,
  type ToolCallSummary,
  type ExecutionStats,
} from "@/lib/evaluation/types";
import { UniversalAssertionsEditor } from "@/components/main-panels/common/UniversalAssertionsEditor";
import { sanitizeAssertions, type AssertionSpec } from "@/lib/assertions/types";
import type { RunEvalCaseResult } from "@/lib/evaluation/eval-runner";
import type { EvaluationRunLiveState } from "@/hooks/useEvaluationRunStream";
import { useDisplayTimezone } from "@/hooks/useDisplayTimezone";
import { formatTimestamp } from "@/components/admin/format";
import { AssertionVerdictList } from "@/components/main-panels/common/verdicts";
import { extractTargetCase } from "@/components/main-panels/common";
import type { EvalSuiteRow, EvalCaseRow } from "@/store/evaluation";
import { evalCaseActions } from "@/store/evaluation-cases";

/** EvalTurn with a stable React key (runtime-only, not persisted). */
interface KeyedTurn extends EvalTurn {
  _key: number;
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
        data-testid="eval-turn-textarea"
      />
    </div>
  );
}

// Response viewer — fetches conversation from eval run, caches in state.

export interface ResponseMessage {
  role: "user" | "assistant" | "tool";
  content: string;
  toolName?: string;
  durationMs?: number;
}

interface ResponseViewerProps {
  messages: ResponseMessage[] | null;
  isLoading: boolean;
  running: boolean;
  runningText?: string;
  hasRun: boolean;
  turnIndex: number;
  error?: string | null;
}

function formatToolDuration(durationMs?: number | null): string | null {
  if (typeof durationMs !== "number" || isNaN(durationMs) || durationMs < 0) return null;
  if (durationMs < 1000) {
    return `${durationMs}ms`;
  }
  const s = durationMs / 1000;
  const sStr = s >= 10 ? `${Math.round(s)}s` : `${s.toFixed(1).replace(/\.0$/, "")}s`;
  return sStr;
}

function formatJsonContent(content: string): string {
  if (!content || !content.trim()) return "(empty tool output)";
  try {
    const parsed = JSON.parse(content);
    return JSON.stringify(parsed, null, 2);
  } catch {
    return content;
  }
}

function ToolMessageRow({ msg }: { msg: ResponseMessage }): ReactNode {
  const [expanded, setExpanded] = useState(false);
  const durationStr = formatToolDuration(msg.durationMs);

  return (
    <div className="rounded-md border border-amber-500/20 bg-amber-500/5 overflow-hidden">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center justify-between px-2.5 py-1 text-left text-xs hover:bg-amber-500/10 transition-colors"
      >
        <div className="flex items-center gap-1.5 min-w-0">
          <Hammer className="h-3 w-3 text-amber-500 shrink-0" />
          <span className="font-mono text-[11px] font-semibold text-amber-500 truncate">
            {msg.toolName || "tool"}
          </span>
        </div>
        <div className="flex items-center gap-1 text-[10px] text-muted-foreground shrink-0">
          {durationStr && (
            <span className="font-mono text-[10px] text-muted-foreground/80">({durationStr})</span>
          )}
          <ChevronDown
            className={cn(
              "h-3 w-3 transition-transform text-amber-500/70",
              expanded && "rotate-180",
            )}
          />
        </div>
      </button>
      {expanded && (
        <div className="border-t border-amber-500/15 bg-background/60 p-2.5 text-xs font-mono text-muted-foreground whitespace-pre-wrap break-all leading-relaxed max-h-72 overflow-y-auto">
          {formatJsonContent(msg.content)}
        </div>
      )}
    </div>
  );
}

function formatElapsedSec(sec: number): string {
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}m ${s}s`;
}

function RunningTimer({ runningText }: { runningText: string }): ReactNode {
  const [elapsedSec, setElapsedSec] = useState<number>(0);

  useEffect(() => {
    const start = Date.now();
    const interval = setInterval(() => {
      setElapsedSec(Math.floor((Date.now() - start) / 1000));
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="flex h-full items-center justify-center gap-2 text-xs text-muted-foreground font-sans">
      <Loader2 className="h-4 w-4 animate-spin text-primary" />
      <span>{runningText}</span>
      <span className="font-mono tabular-nums text-muted-foreground/80">({formatElapsedSec(elapsedSec)})</span>
    </div>
  );
}

function ResponseViewer({
  messages,
  isLoading,
  running,
  runningText = "Running target agent...",
  hasRun,
  turnIndex: _turnIndex,
  error,
}: ResponseViewerProps): ReactNode {
  if (running) {
    return <RunningTimer runningText={runningText} />;
  }

  if (isLoading && (!messages || messages.length === 0)) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-xs text-muted-foreground font-sans">
        <Loader2 className="h-4 w-4 animate-spin text-primary" />
        Loading response...
      </div>
    );
  }

  if (error && (!messages || messages.length === 0)) {
    return (
      <div className="flex items-center justify-center h-full p-3 text-xs text-rose-500 font-sans">
        Execution error: {error}
      </div>
    );
  }

  if (!hasRun) {
    return (
      <div className="flex items-center justify-center h-full p-3 text-xs text-muted-foreground font-sans">
        Run a case to see the output.
      </div>
    );
  }

  if (!messages || messages.length === 0) {
    return (
      <div className="flex items-center justify-center h-full p-3 text-xs text-muted-foreground font-sans">
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

// Main component

export interface PinnedOutcome {
  status: "passed" | "failed" | "errored";
  assertionResults?: unknown[];
  feedback: string | null;
  durationMs: number | null;
  outputChars: number | null;
  executionStats?: import("@/lib/evaluation/types").ExecutionStats | null;
  startedAt: Date | string | null;
  error?: unknown;
  toolCallSummary?: ToolCallSummary | null;
}

export interface EvalCaseInspectorDraftHandle {
  getCurrentDraft: () => {
    turns: EvalTurn[];
    assertions: AssertionSpec[];
    isDirty: boolean;
  };
  getDisplayedOutcome: () => {
    source: "live" | "history";
    historySeq?: number;
    status: string;
    assertionResults: unknown[];
    feedback: string | null;
  } | null;
  applyDraft: (draft: Record<string, unknown>) => string[];
}

export interface EvalCaseInspectorProps {
  evalCase: EvalCaseRow;
  suite: EvalSuiteRow;
  liveRun: EvaluationRunLiveState;
  onRunCase: (caseId: number) => Promise<void>;
  pinnedOutcome?: PinnedOutcome;
  pinnedRunId?: string | null;
  selectedRunSeq?: number | null;
  onExitHistoryView?: () => void;
  onBindDraftHandle?: (handle: EvalCaseInspectorDraftHandle | null) => void;
  onSaveSuccess?: () => void;
  onDataChange?: () => void;
}

// CONTRACT: parent renders <EvalCaseInspector key={evalCase.id} />,
// so the counter resets on case switch via remount.
let nextTurnKey = 0;
function mintKey(): number { return nextTurnKey++; }



export function EvalCaseInspector({
  evalCase,
  liveRun,
  onRunCase: _onRunCase,
  pinnedOutcome,
  pinnedRunId,
  selectedRunSeq = null,
  onExitHistoryView,
  onBindDraftHandle,
  onSaveSuccess,
  onDataChange,
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
      return sanitizeAssertions(evalCase.assertions as AssertionSpec[]);
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

  // Extract original baseline values for semantic dirty comparison
  const origTurns = useMemo(() => {
    const caseInput = (evalCase.input ?? {}) as Record<string, unknown>;
    return Array.isArray(caseInput.turns)
      ? (caseInput.turns as EvalTurn[])
      : (Array.isArray(evalCase.turns) ? (evalCase.turns as EvalTurn[]) : []);
  }, [evalCase.input, evalCase.turns]);

  const origAssertions = useMemo(() => {
    return Array.isArray(evalCase.assertions) ? sanitizeAssertions(evalCase.assertions as AssertionSpec[]) : [];
  }, [evalCase.assertions]);

  const strippedCurrentTurns = useMemo(() => stripKeys(turns), [turns]);

  const isDirty = useMemo(() => {
    return (
      !isDeepEqual(strippedCurrentTurns, origTurns) ||
      !isDeepEqual(assertions, origAssertions)
    );
  }, [strippedCurrentTurns, origTurns, assertions, origAssertions]);

  const canSave = isDirty && !assertionsHasError && !saving;

  function updateTurn(index: number, updated: EvalTurn): void {
    setTurns((prev) => prev.map((t, i) => (i === index ? { ...updated, _key: t._key } : t)));
  }

  const [runOutcome, setRunOutcome] = useState<RunEvalCaseResult | null>(null);
  const [running, setRunning] = useState<boolean>(false);
  const [runPhase, setRunPhase] = useState<"idle" | "running_target" | "evaluating_verdicts">("idle");
  const [playgroundThreadId, setPlaygroundThreadId] = useState<string | null>(null);
  const [playgroundStats, setPlaygroundStats] = useState<ExecutionStats | null>(null);
  const [playgroundToolCallSummary, setPlaygroundToolCallSummary] = useState<ToolCallSummary | null>(null);
  const [runError, setRunError] = useState<string | null>(null);

  // CONTRACT: at most one in-flight single-case run; only the run whose
  // controller is current may write component state.
  const runAbortRef = useRef<AbortController | null>(null);
  useEffect(() => () => runAbortRef.current?.abort(), []);

  // Derive display results: prefer pinnedOutcome (history snapshot), then runOutcome (local run), then liveRun, then latest-result SWR
  const liveCaseResult = liveRun.caseResults.get(evalCase.id);
  
  const displayFeedback = pinnedOutcome
    ? pinnedOutcome.feedback
    : (runOutcome
        ? (runOutcome.feedback ?? null)
        : (running
            ? null
            : (liveCaseResult?.feedback ?? (historicalResult?.feedback ?? null))));

  const displayAssertionResults = useMemo(() => {
    if (pinnedOutcome) return pinnedOutcome.assertionResults ?? null;
    if (runOutcome) return runOutcome.assertionResults ?? null;
    if (running) return null;
    return liveCaseResult?.assertionResults ?? (historicalResult?.assertionResults ?? null);
  }, [pinnedOutcome, runOutcome, running, liveCaseResult?.assertionResults, historicalResult?.assertionResults]);

  const displayDurationMs = pinnedOutcome
    ? pinnedOutcome.durationMs
    : (runOutcome
        ? (runOutcome.executionStats?.durationMs ?? null)
        : (playgroundStats
            ? (playgroundStats.durationMs ?? null)
            : (liveCaseResult?.durationMs ?? (historicalResult?.executionStats?.durationMs ?? null))));

  const displayOutputChars = pinnedOutcome
    ? pinnedOutcome.outputChars
    : (runOutcome
        ? (runOutcome.executionStats?.outputChars ?? null)
        : (playgroundStats
            ? (playgroundStats.outputChars ?? null)
            : (liveCaseResult?.outputChars ?? (historicalResult?.executionStats?.outputChars ?? null))));

  const durationMs = displayDurationMs;
  const outputDurationStr = useMemo(() => {
    if (typeof durationMs !== "number" || isNaN(durationMs) || durationMs <= 0) return null;
    return durationMs >= 1000 ? `${(durationMs / 1000).toFixed(1)}s` : `${durationMs}ms`;
  }, [durationMs]);

  const displayToolCallSummary = pinnedOutcome
    ? (pinnedOutcome.toolCallSummary ?? null)
    : (runOutcome
        ? (runOutcome.toolCallSummary ?? null)
        : (playgroundToolCallSummary
            ? playgroundToolCallSummary
            : ((liveCaseResult?.toolCallSummary as ToolCallSummary | undefined) ?? (historicalResult?.toolCallSummary ?? null))));

  const resolvedRunId = pinnedOutcome
    ? pinnedRunId
    : (runOutcome || playgroundThreadId ? "playground" : (liveRun.phase === "idle" ? (historicalResult?.runId ?? null) : liveRun.runId));
  const resolvedThreadId = playgroundThreadId ?? runOutcome?.threadId ?? null;
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

  // Copilot ambient context & draft integration (bound to parent suite synchronization)
  const getCurrentDraft = useCallback(() => {
    const cleaned = sanitizeAssertions(assertions);
    return {
      turns: stripKeys(turns),
      assertions: cleaned,
      isDirty: Boolean(isDirty),
    };
  }, [turns, assertions, isDirty]);

  const getDisplayedOutcome = useCallback(() => {
    if (resolvedStatus === "idle") return null;
    return {
      source: (pinnedOutcome ? "history" : "live") as "live" | "history",
      ...(pinnedOutcome && selectedRunSeq !== null ? { historySeq: selectedRunSeq } : {}),
      status: resolvedStatus,
      assertionResults: (displayAssertionResults ?? []) as unknown[],
      feedback: displayFeedback || null,
    };
  }, [
    resolvedStatus,
    pinnedOutcome,
    selectedRunSeq,
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
    if (sc.assertions !== undefined) {
      let targetAssertions: unknown = sc.assertions;
      if (typeof targetAssertions === "string") {
        try {
          targetAssertions = JSON.parse(targetAssertions);
        } catch {
          targetAssertions = undefined;
        }
      }
      if (Array.isArray(targetAssertions)) {
        setAssertions(targetAssertions as AssertionSpec[]);
        applied.push("assertions");
      }
    }
    if (draft.selectedCase) applied.push("selectedCase");
    return applied;
  }, [evalCase.id]);

  useEffect(() => {
    if (!onBindDraftHandle) return;
    onBindDraftHandle({
      getCurrentDraft,
      getDisplayedOutcome,
      applyDraft,
    });
    return () => {
      onBindDraftHandle(null);
    };
  }, [onBindDraftHandle, getCurrentDraft, getDisplayedOutcome, applyDraft]);

  // Notify parent suite of any internal edits, dirty toggles, or outcome changes
  useEffect(() => {
    onDataChange?.();
  }, [
    onDataChange,
    turns,
    assertions,
    isDirty,
    resolvedStatus,
    displayAssertionResults,
    displayFeedback,
  ]);

  const handleSave = useCallback(async (): Promise<void> => {
    if (!canSave) return;
    setSaving(true);
    try {
      const stripped = stripKeys(turns);
      const cleanedAssertions = sanitizeAssertions(assertions);
      if (cleanedAssertions.length !== assertions.length) {
        setAssertions(cleanedAssertions);
      }
      const savedRow = await evalCaseActions.patch(
        { id: evalCase.id, suiteId: evalCase.suiteId },
        {
          input: { turns: stripped },
          assertions: cleanedAssertions,
        },
      );
      if (savedRow) {
        if (Array.isArray(savedRow.assertions)) {
          setAssertions(sanitizeAssertions(savedRow.assertions as AssertionSpec[]));
        }
        const savedInput = (savedRow.input ?? {}) as Record<string, unknown>;
        const rawTurns = Array.isArray(savedInput.turns)
          ? (savedInput.turns as EvalTurn[])
          : (Array.isArray(savedRow.turns) ? (savedRow.turns as EvalTurn[]) : []);
        setTurns(rawTurns.map((t) => ({ ...t, _key: mintKey() })));
      }
      onSaveSuccess?.();
    } finally {
      setSaving(false);
    }
  }, [canSave, evalCase.id, evalCase.suiteId, turns, assertions, onSaveSuccess]);

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
    setPlaygroundThreadId(null);
    setPlaygroundStats(null);
    setPlaygroundToolCallSummary(null);
    setRunPhase("running_target");
    setRunning(true);
    runAbortRef.current?.abort();
    const controller = new AbortController();
    runAbortRef.current = controller;
    const isCurrent = (): boolean => runAbortRef.current === controller;
    try {
      if (canSave) {
        await handleSave();
      }
      const res = await fetch(`/api/eval-cases/${evalCase.id}/run?stream=true`, {
        method: "POST",
        headers: {
          Accept: "application/x-ndjson",
        },
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(600_000)]),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { message?: string } | null;
        throw new Error(body?.message ?? `${res.status} ${res.statusText}`);
      }

      const contentType = res.headers.get("content-type") ?? "";
      if (contentType.includes("application/x-ndjson") && res.body) {
        type Frame =
          | {
              type: "target_complete";
              threadId: string;
              executionStats: ExecutionStats;
              toolCallSummary: ToolCallSummary;
            }
          | { type: "verdict_complete"; outcome: RunEvalCaseResult };
        const outcome = await readNdjson<Frame, RunEvalCaseResult>(res.body, (frame) => {
          if (!isCurrent()) return;
          if (frame.type === "target_complete") {
            setPlaygroundThreadId(frame.threadId);
            setPlaygroundStats(frame.executionStats);
            setPlaygroundToolCallSummary(frame.toolCallSummary);
            setRunPhase("evaluating_verdicts");
            setResponseTurnIdx(Math.max(0, turns.length - 1));
          }
        });
        if (isCurrent()) {
          setRunOutcome(outcome);
          if (outcome.threadId) {
            setPlaygroundThreadId(outcome.threadId);
          }
        }
      } else {
        const outcome = (await res.json()) as RunEvalCaseResult;
        if (!isCurrent()) return;
        setRunOutcome(outcome);
        if (outcome.threadId) {
          setPlaygroundThreadId(outcome.threadId);
        }
        setResponseTurnIdx(Math.max(0, turns.length - 1));
      }
    } catch (err) {
      if (!isCurrent() || controller.signal.aborted) return;
      if (err instanceof Error && err.name === "TimeoutError") {
        setRunError("Evaluation timed out on client side after 600s. Consider reducing turns or testing with shorter prompts.");
      } else {
        setRunError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      if (isCurrent()) {
        runAbortRef.current = null;
        setRunning(false);
        setRunPhase("idle");
      }
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
          <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide shrink-0">
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
              data-testid="add-turn-button"
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
              data-testid="save-case-button"
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
              data-testid="run-case-button"
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
          {Boolean(hasResponse || outputDurationStr || displayOutputChars !== null) && (
            <div className="flex items-center gap-1.5 font-mono text-[10px] text-muted-foreground shrink-0">
              {(outputDurationStr || displayOutputChars !== null) && (
                <span>
                  {outputDurationStr ? `${outputDurationStr} / ` : ""}{formatCharCount(displayOutputChars ?? 0)}
                </span>
              )}
              {hasResponse && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 w-6 p-0 text-muted-foreground hover:text-foreground"
                  onClick={handleCopyResponse}
                  title="Copy response"
                >
                  {copied ? (
                    <Check className="h-3.5 w-3.5 text-green-500" />
                  ) : (
                    <Copy className="h-3.5 w-3.5" />
                  )}
                </Button>
              )}
            </div>
          )}
        </div>

        {/* Output & Verdicts split — strictly 50%/50% matching Left Column */}
        <div className="grid h-full grid-rows-[calc(50%-1rem)_calc(50%+1rem)] min-w-0 flex-1 overflow-hidden bg-background">
          {/* Top: Output (Agent Response) */}
          <div className="flex min-h-0 flex-col overflow-hidden">
            <ScrollArea className="h-full">
              <ResponseViewer
                messages={filteredMessages}
                isLoading={messagesLoading}
                running={runPhase === "running_target" || liveRun.phase === "running"}
                runningText="Running target agent..."
                hasRun={Boolean(resolvedRunId || playgroundThreadId)}
                turnIndex={responseTurnIdx}
                error={displayError}
              />
            </ScrollArea>
          </div>

          {/* Bottom: Verdicts (Scores, Checklist, and Feedback) */}
          <div className="flex h-full min-h-0 flex-col overflow-hidden border-t">
            <EvaluationPanel
              assertions={assertions}
              assertionResults={displayAssertionResults}
              feedback={displayFeedback}
              toolCallSummary={displayToolCallSummary}
              selectedRunSeq={selectedRunSeq}
              startedAt={pinnedOutcome?.startedAt}
              status={resolvedStatus}
              error={displayError}
              evaluating={runPhase === "evaluating_verdicts"}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Verdicts & Evaluation result panel ─────────────────────────────

interface EvaluationPanelProps {
  assertions?: AssertionSpec[];
  assertionResults: unknown[] | null;
  feedback: string | null;
  toolCallSummary?: ToolCallSummary | null;
  selectedRunSeq?: number | null;
  startedAt?: Date | string | null;
  status?: string | null;
  error?: string | null;
  evaluating?: boolean;
}

function EvaluationPanel({
  assertions = [],
  assertionResults,
  feedback,
  toolCallSummary = null,
  selectedRunSeq = null,
  startedAt = null,
  status = null,
  error = null,
  evaluating = false,
}: EvaluationPanelProps): ReactNode {
  const tz = useDisplayTimezone();
  const formattedTime = startedAt ? formatTimestamp(startedAt, tz) : null;
  const subtitle = selectedRunSeq !== null ? (
    <span className="text-xs font-semibold text-amber-500 dark:text-amber-400 shrink-0">
      (#{selectedRunSeq}{formattedTime ? ` - ${formattedTime}` : ""})
    </span>
  ) : null;

  return (
    <AssertionVerdictList
      className="h-full"
      verdicts={assertionResults as import("@/lib/assertions").AssertionResult[] | null}
      assertions={assertions}
      error={error ? { source: "evaluator", message: error } : null}
      feedback={feedback}
      status={status}
      subtitle={subtitle}
      toolCallSummary={toolCallSummary}
      emptyText={
        evaluating ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground font-sans">
            <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
            Evaluating assertions...
          </div>
        ) : "No verdict yet."
      }
      title="Verdicts"
    />
  );
}
