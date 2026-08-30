"use client";

import {
  useState,
  useEffect,
  useCallback,
  useMemo,
  useRef,
  type ReactNode,
} from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, Loader2 } from "lucide-react";
import { toast } from "sonner";
import useSWR from "swr";

import { Button } from "@/components/ui/button";
import { DeleteConfirmDialog } from "@/components/ui/delete-confirm-dialog";
import { EvalCaseList } from "@/components/main-panels/evaluation/EvalCaseList";
import { EvalCaseEditDialog } from "@/components/main-panels/evaluation/EvalCaseEditDialog";
import { EvalCaseInspector } from "@/components/main-panels/evaluation/EvalCaseInspector";
import { useEvaluationRunStream } from "@/hooks/useEvaluationRunStream";
import { useEvalRunSnapshot } from "@/hooks/useEvalRunSnapshot";
import { RecentRunsBanner } from "@/components/main-panels/RecentRunsBanner";
import type { EvalSuiteRow } from "@/store/evaluation";
import {
  useEvalCasesStore,
  evalCaseActions,
  type EvalCaseRow,
} from "@/store/evaluation-cases";
import { useWorkspaceStore } from "@/store/workspace";
import { useShallow } from "zustand/react/shallow";
import type { EntityDescriptor } from "@/lib/backends/types";
import { useCopilotDraft } from "@/hooks/useCopilotDraft";

const fetcher = async (url: string) => {
  const res = await fetch(url);
  if (!res.ok) throw new Error("Failed to fetch data");
  return res.json();
};

export interface EvaluationSuiteEditorProps {
  /** The active evaluation suite ID. */
  suiteId: string;
  onBack?: () => void;
}

function EmptyEvaluationCopilotSync({
  suite,
}: {
  suite: EvalSuiteRow | null;
}) {
  const getCurrentData = useCallback(
    () => ({
      suite: suite
        ? {
            id: suite.id,
            name: suite.name,
            description: suite.description ?? null,
            agentId: suite.agentId,
            agentSource: suite.agentSource,
            evaluatorAgentId: suite.evaluatorAgentId,
            dimensionIds: suite.dimensionIds,
            caseCount: 0,
          }
        : null,
      selectedCase: null,
      outcome: null,
    }),
    [suite],
  );

  useCopilotDraft({
    resourceType: "evaluation",
    resourceId: suite?.id ?? null,
    isReadOnly: false,
    getCurrentData,
    applyDraft: () => {},
  });

  return null;
}

export function EvaluationSuiteEditor({
  suiteId,
  onBack,
}: EvaluationSuiteEditorProps): ReactNode {
  const router = useRouter();

  // 1. Fetch Suite details
  const { data: suiteData, error: suiteError, isLoading: suiteLoading } = useSWR<EvalSuiteRow>(
    suiteId ? `/api/eval-suites/${suiteId}` : null,
    fetcher,
  );

  const [selectedCaseId, setSelectedCaseId] = useState<number | null>(null);

  // Run state
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [isSuiteRunning, setIsSuiteRunning] = useState<boolean>(false);
  const liveRun = useEvaluationRunStream(activeRunId);

  // History runs selection state
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [selectedRunSeq, setSelectedRunSeq] = useState<number | null>(null);
  const [bannerRefreshKey, setBannerRefreshKey] = useState(0);

  // Auto refresh history banner when live eval completes
  const prevPhaseRef = useRef(liveRun.phase);
  useEffect(() => {
    if (prevPhaseRef.current !== "idle" && liveRun.phase === "idle") {
      setBannerRefreshKey((prev) => prev + 1);
      setIsSuiteRunning(false);
    }
    prevPhaseRef.current = liveRun.phase;
  }, [liveRun.phase]);

  const exitHistoryView = useCallback(() => {
    setSelectedRunId(null);
    setSelectedRunSeq(null);
  }, []);

  const isLiveTerminal = liveRun.phase !== "idle" && liveRun.phase !== "running";
  const snapshotRunId = selectedRunId ?? (isLiveTerminal ? activeRunId : null);
  const { snapshot: runSnapshot } = useEvalRunSnapshot(snapshotRunId);

  // Derived verdict map
  const verdictByCaseId = useMemo<ReadonlyMap<number, { status: "running" | "passed" | "failed" | "errored" }>>(() => {
    const map = new Map<number, { status: "running" | "passed" | "failed" | "errored" }>();
    if (runSnapshot) {
      for (const r of runSnapshot.results) {
        map.set(r.caseId, {
          status: r.status as "passed" | "failed" | "errored",
        });
      }
      return map;
    }
    for (const [caseId, v] of liveRun.caseResults) {
      map.set(caseId, { status: v.status });
    }
    return map;
  }, [runSnapshot, liveRun.caseResults]);

  // Derived historical outcome of the currently selected case
  const pinnedOutcome = useMemo(() => {
    if (!runSnapshot || selectedCaseId === null) return undefined;
    const row = runSnapshot.results.find((r) => r.caseId === selectedCaseId);
    if (!row) return undefined;
    const resultsList = (row.assertionResults ?? (row as unknown as { criteriaResults?: unknown[] }).criteriaResults ?? []) as unknown[];
    return {
      status: row.status as "passed" | "failed" | "errored",
      score: row.score,
      dimensionScores: row.dimensionScores as Record<string, number>,
      criteriaScore: row.criteriaScore,
      assertionResults: resultsList,
      criteriaResults: resultsList,
      feedback: row.feedback,
      durationMs: row.durationMs,
      outputTokens: row.outputTokens,
      startedAt: row.startedAt,
    };
  }, [runSnapshot, selectedCaseId]);

  // 2. Cases subscription
  const casesBySuite = useEvalCasesStore((s) => s.bySuite);
  const cases = useMemo(() => {
    return casesBySuite[suiteId] ?? [];
  }, [casesBySuite, suiteId]);

  const [casesLoading, setCasesLoading] = useState<boolean>(false);
  const [casesError, setCasesError] = useState<string | null>(null);

  useEffect(() => {
    if (!suiteId) return;
    let active = true;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setCasesLoading(true);
    setCasesError(null);
    evalCaseActions.refresh(suiteId)
      .catch((err) => {
        if (active) setCasesError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (active) setCasesLoading(false);
      });
    return () => {
      active = false;
    };
  }, [suiteId]);

  const selectedCase = useMemo(
    () => cases.find((c) => c.id === selectedCaseId) ?? null,
    [cases, selectedCaseId],
  );

  useEffect(() => {
    if (selectedCaseId !== null && !selectedCase) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setSelectedCaseId(null);
    }
  }, [selectedCaseId, selectedCase]);

  // Auto-select first case if none selected
  useEffect(() => {
    if (selectedCaseId === null && cases.length > 0) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setSelectedCaseId(cases[0].id);
    }
  }, [selectedCaseId, cases]);

  const handleRunSuite = useCallback(async (): Promise<void> => {
    if (!suiteId) return;
    try {
      setIsSuiteRunning(true);
      const res = await fetch("/api/eval-runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ suiteId }),
      });
      if (!res.ok) {
        setIsSuiteRunning(false);
        toast.error("Failed to run evaluation suite");
        return;
      }
      const { runId } = (await res.json()) as { runId: string };
      setSelectedRunId(null);
      setSelectedRunSeq(null);
      setActiveRunId(runId);
      toast.success("Started evaluation suite run");
    } catch {
      setIsSuiteRunning(false);
      toast.error("Failed to run evaluation suite");
    }
  }, [suiteId]);

  const handleRunCase = useCallback(async (caseId: number): Promise<void> => {
    try {
      const res = await fetch(`/api/eval-cases/${caseId}/run`, { method: "POST" });
      if (!res.ok) {
        toast.error("Failed to run evaluation case");
        return;
      }
      const { runId } = (await res.json()) as { runId: string };
      setSelectedRunId(null);
      setSelectedRunSeq(null);
      setActiveRunId(runId);
      toast.success("Started case evaluation");
    } catch {
      toast.error("Failed to run evaluation case");
    }
  }, []);

  const handleToggleCaseEnabled = async (caseId: number, nextEnabled: boolean): Promise<void> => {
    try {
      await evalCaseActions.patch({ id: caseId, suiteId }, { enabled: nextEnabled });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to update case enabled state");
    }
  };

  // Case dialogs
  const [editingCase, setEditingCase] = useState<EvalCaseRow | null>(null);
  const [isCreatingCase, setIsCreatingCase] = useState<boolean>(false);
  const [deletingCase, setDeletingCase] = useState<EvalCaseRow | null>(null);

  // Agent display name resolution
  const builtinAgents = useWorkspaceStore((s) => s.builtinAgents);
  const backendEntities = useWorkspaceStore(useShallow((s) => [...s.agents, ...s.teams, ...s.workflows]));
  const agentDisplay = useMemo<{ name: string; icon: string | null }>(() => {
    if (!suiteData) return { name: "Agent", icon: null };
    if (suiteData.agentSource === "builtin") {
      const found = builtinAgents.find((a) => a.id === suiteData.agentId);
      return found ? { name: found.name, icon: found.icon ?? null } : { name: suiteData.agentId, icon: null };
    }
    const foundEntity: EntityDescriptor | undefined = backendEntities.find(
      (e) => e.id === suiteData.agentId,
    );
    if (foundEntity) return { name: foundEntity.name ?? foundEntity.id, icon: null };
    return { name: suiteData.agentId, icon: null };
  }, [suiteData, builtinAgents, backendEntities]);

  async function handleCaseCreate(input: { name: string; suiteId: string }): Promise<void> {
    const newCase = await evalCaseActions.create(input.suiteId, {
      name: input.name,
      turns: [],
      criteria: {},
    });
    if (newCase) {
      toast.success("Case created");
      if (input.suiteId !== suiteId) {
        router.push(`/evaluation/${input.suiteId}`);
      } else {
        setSelectedCaseId(newCase.id);
      }
    }
    setIsCreatingCase(false);
  }

  async function handleCaseSave(updated: { name: string; suiteId: string }): Promise<void> {
    if (!editingCase) return;
    await evalCaseActions.patch(
      { id: editingCase.id, suiteId: editingCase.suiteId },
      { name: updated.name, suiteId: updated.suiteId },
    );
    setEditingCase(null);
    toast.success("Case updated");
  }

  async function handleDeleteCaseConfirm(): Promise<void> {
    if (!deletingCase) return;
    try {
      await evalCaseActions.remove({ id: deletingCase.id, suiteId: deletingCase.suiteId });
      if (selectedCaseId === deletingCase.id) setSelectedCaseId(null);
      toast.success("Case deleted");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to delete case");
    } finally {
      setDeletingCase(null);
    }
  }

  if (suiteLoading && !suiteData) {
    return (
      <div className="flex h-full w-full items-center justify-center gap-2 text-muted-foreground text-sm">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading evaluation suite…
      </div>
    );
  }

  if (suiteError || !suiteData) {
    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-2 text-muted-foreground text-sm">
        <p>Evaluation suite not found or inaccessible.</p>
        {onBack && (
          <Button variant="outline" size="sm" onClick={onBack}>
            Back to evaluation
          </Button>
        )}
      </div>
    );
  }

  const suiteDisplayName = suiteData.name;

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {!selectedCase && <EmptyEvaluationCopilotSync suite={suiteData} />}

      {/* Header */}
      <header className="flex h-9 shrink-0 items-center justify-between border-b px-4">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          {onBack && (
            <Button
              variant="ghost"
              size="icon-xs"
              className="h-6 w-6 shrink-0"
              onClick={onBack}
              aria-label="Back"
            >
              <ArrowLeft className="h-3 w-3" />
            </Button>
          )}
          <div className="flex items-center gap-1.5 min-w-0 truncate">
            {agentDisplay.icon && <span className="text-xs">{agentDisplay.icon}</span>}
            <span className="text-xs text-muted-foreground truncate">
              {agentDisplay.name} /
            </span>
            <h1 className="min-w-0 truncate text-sm font-semibold pr-1">
              {suiteDisplayName}
            </h1>
          </div>
        </div>

        <div className="shrink-0 flex items-center gap-2">
          <RecentRunsBanner
            suiteId={suiteId}
            apiPrefix="eval-suites"
            refreshKey={bannerRefreshKey}
            selectedRunId={selectedRunId}
            onSelectRun={(id, seq) => {
              setSelectedRunId(id);
              setSelectedRunSeq(seq);
            }}
          />
        </div>
      </header>

      {/* Main Grid: Left 20% Case List + Right Inspector */}
      <div className="flex-1 min-h-0">
        <div className="grid h-full grid-cols-[20%_1fr] overflow-hidden">
          <EvalCaseList
            suiteName={suiteDisplayName}
            cases={cases}
            verdictByCaseId={verdictByCaseId}
            selectedCaseId={selectedCaseId}
            onSelectCase={setSelectedCaseId}
            onNewCase={() => setIsCreatingCase(true)}
            onRunSuite={handleRunSuite}
            isSuiteRunning={isSuiteRunning || liveRun.phase === "running"}
            onToggleCaseEnabled={handleToggleCaseEnabled}
            onRequestEditCase={setEditingCase}
            onRequestDeleteCase={setDeletingCase}
            loading={casesLoading}
            error={casesError}
            readOnly={false}
          />

          <div className="min-w-0 overflow-hidden">
            {selectedCase ? (
              <EvalCaseInspector
                key={selectedCase.id}
                evalCase={selectedCase}
                suite={suiteData}
                liveRun={liveRun}
                onRunCase={handleRunCase}
                pinnedOutcome={pinnedOutcome}
                pinnedRunId={selectedRunId ?? (isLiveTerminal ? activeRunId : null)}
                selectedRunSeq={selectedRunSeq}
                onExitHistoryView={exitHistoryView}
              />
            ) : (
              <div className="grid h-full place-items-center px-8 text-center text-xs text-muted-foreground">
                <p>Select an evaluation case on the left, or create a new one.</p>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Case create dialog */}
      {isCreatingCase && (
        <EvalCaseEditDialog
          open
          onOpenChange={setIsCreatingCase}
          agentId={suiteData?.agentId}
          defaultSuiteId={suiteId}
          onSave={handleCaseCreate}
        />
      )}

      {/* Case edit dialog */}
      {editingCase && (
        <EvalCaseEditDialog
          open
          onOpenChange={(open) => { if (!open) setEditingCase(null); }}
          evalCase={editingCase}
          agentId={suiteData?.agentId}
          onSave={handleCaseSave}
        />
      )}

      {/* Delete confirmation */}
      <DeleteConfirmDialog
        title="Delete evaluation case"
        description={
          deletingCase ? (
            <>
              Permanently delete <strong>{deletingCase.name}</strong>? All recorded
              eval results for this case will be removed. This cannot be undone.
            </>
          ) : (
            ""
          )
        }
        open={deletingCase !== null}
        onOpenChange={(open) => { if (!open) setDeletingCase(null); }}
        onConfirm={handleDeleteCaseConfirm}
        deleting={false}
      />
    </div>
  );
}
