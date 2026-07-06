"use client";

/**
 * EvaluationEditor — host for evaluation editor pages.
 *
 * Serves both builtin (`/evaluation/[id]`) and backend
 * (`/evaluation/[credentialId]/[agentId]`) routes.
 *
 * Layout:
 *   Header: [Back] agent name + icon
 *   Body: 3-pane split (3:4:3)
 *     Left  — EvalSuiteTree (suite + case tree)
 *     Mid   — Conversation detail (from EvalCaseInspector)
 *     Right — Evaluation result (from EvalCaseInspector)
 *
 * Wired to evaluation + evaluation-cases Zustand stores.
 */

import { useState, useEffect, useCallback, useMemo, useRef, type ReactNode } from "react";
import { ArrowLeft, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DeleteConfirmDialog } from "@/components/ui/delete-confirm-dialog";
import { EvalSuiteTree } from "@/components/main-panels/evaluation/EvalSuiteTree";
import { EvalSuiteEditDialog } from "@/components/main-panels/evaluation/EvalSuiteEditDialog";
import { EvalCaseEditDialog } from "@/components/main-panels/evaluation/EvalCaseEditDialog";
import { EvalCaseInspector } from "@/components/main-panels/evaluation/EvalCaseInspector";
import { useEvaluationRunStream } from "@/hooks/useEvaluationRunStream";
import { useEvalRunSnapshot } from "@/hooks/useEvalRunSnapshot";
import { RecentRunsBanner } from "@/components/main-panels/RecentRunsBanner";
import {
  useEvaluationStore,
  evalActions,
  agentKey,
  type EvalSuiteRow,
} from "@/store/evaluation";
import {
  useEvalCasesStore,
  evalCaseActions,
  type EvalCaseRow,
} from "@/store/evaluation-cases";
import { useWorkspaceStore } from "@/store/workspace";
import { useShallow } from "zustand/react/shallow";
import type { EntityDescriptor } from "@/lib/backends/types";

interface EvaluationEditorProps {
  agentId: string;
  agentSource: string;
  /** Required for backend agents; ignored for builtin. */
  credentialId?: string;
  onBack: () => void;
}

export function EvaluationEditor({ agentId, agentSource, credentialId, onBack }: EvaluationEditorProps): ReactNode {
  const key = agentKey(agentId, agentSource);
  const suites = useEvaluationStore((s) => s.suitesByAgent[key] ?? []);

  const [selectedCaseId, setSelectedCaseId] = useState<number | null>(null);

  // Run state — shared across suite-level and case-level runs.
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [runningSuiteId, setRunningSuiteId] = useState<string | null>(null);
  const liveRun = useEvaluationRunStream(activeRunId);

  // History runs selection state
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [selectedRunSeq, setSelectedRunSeq] = useState<number | null>(null);
  const [bannerRefreshKey, setBannerRefreshKey] = useState(0);

  // Auto refresh the history banner when a live evaluation completes
  const prevPhaseRef = useRef(liveRun.phase);
  useEffect(() => {
    if (prevPhaseRef.current !== "idle" && liveRun.phase === "idle") {
      setBannerRefreshKey((prev) => prev + 1);
    }
    prevPhaseRef.current = liveRun.phase;
  }, [liveRun.phase]);

  const isLiveTerminal = liveRun.phase !== "idle" && liveRun.phase !== "running";
  const snapshotRunId = selectedRunId ?? (isLiveTerminal ? activeRunId : null);
  const { snapshot: runSnapshot } = useEvalRunSnapshot(snapshotRunId);

  // Per-case verdict (passed/failed/errored) — maps caseId to check statuses
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
    return {
      status: row.status as "passed" | "failed" | "errored",
      score: row.score,
      dimensionScores: row.dimensionScores as Record<string, number>,
      criteriaScore: row.criteriaScore,
      criteriaResults: row.criteriaResults as unknown[],
      feedback: row.feedback,
      durationMs: row.durationMs,
      outputTokens: row.outputTokens,
      startedAt: row.startedAt,
    };
  }, [runSnapshot, selectedCaseId]);

  const handleRunSuite = useCallback(async (suiteId: string): Promise<void> => {
    try {
      const res = await fetch(`/api/eval-suites/${suiteId}/run`, { method: "POST" });
      if (!res.ok) return;
      const { runId } = (await res.json()) as { runId: string };
      setSelectedRunId(null);
      setSelectedRunSeq(null);
      setActiveRunId(runId);
      setRunningSuiteId(suiteId);
    } catch { /* swallow */ }
  }, []);

  const handleRunCase = useCallback(async (caseId: number, suiteId: string): Promise<void> => {
    try {
      const res = await fetch(`/api/eval-cases/${caseId}/run`, { method: "POST" });
      if (!res.ok) return;
      const { runId } = (await res.json()) as { runId: string };
      setSelectedRunId(null);
      setSelectedRunSeq(null);
      setActiveRunId(runId);
      setRunningSuiteId(suiteId);
    } catch { /* swallow */ }
  }, []);

  // Suite edit dialog
  const [editingSuite, setEditingSuite] = useState<EvalSuiteRow | null>(null);
  const [isCreatingSuite, setIsCreatingSuite] = useState(false);
  const [editingCase, setEditingCase] = useState<EvalCaseRow | null>(null);
  const [creatingCaseSuiteId, setCreatingCaseSuiteId] = useState<string | null>(null);

  // Delete confirmation
  const [deleteTarget, setDeleteTarget] = useState<
    | { kind: "suite"; id: string; name: string }
    | { kind: "case"; id: number; suiteId: string; name: string }
    | null
  >(null);

  // Agent display name — builtin: read workspace store; backend: read workspace store.
  const builtinAgents = useWorkspaceStore((s) => s.builtinAgents);
  const backendEntities = useWorkspaceStore(useShallow((s) => [...s.agents, ...s.teams, ...s.workflows]));
  const agentDisplay = useMemo<{ name: string; icon: string | null }>(() => {
    if (agentSource === "builtin") {
      const found = builtinAgents.find((a) => a.id === agentId);
      return found ? { name: found.name, icon: found.icon ?? null } : { name: agentId, icon: null };
    }
    if (credentialId) {
      const entity: EntityDescriptor | undefined = backendEntities.find(
        (e) => e.credentialId === credentialId && e.id === agentId,
      );
      if (entity) return { name: entity.name ?? entity.id, icon: null };
    }
    return { name: agentId, icon: null };
  }, [agentSource, agentId, credentialId, builtinAgents, backendEntities]);

  // Load cases for all suites
  const casesBySuite = useEvalCasesStore((s) => s.bySuite);
  useEffect(() => {
    for (const suite of suites) {
      if (!casesBySuite[suite.id]) {
        void evalCaseActions.refresh(suite.id);
      }
    }
  }, [suites, casesBySuite]);

  // Find selected case and its parent suite (render-time derivation)
  let selected: { evalCase: EvalCaseRow; suite: EvalSuiteRow } | null = null;
  if (selectedCaseId !== null) {
    for (const suite of suites) {
      const cases = casesBySuite[suite.id] ?? [];
      const evalCase = cases.find((c) => c.id === selectedCaseId);
      if (evalCase) { selected = { evalCase, suite }; break; }
    }
  }

  // Suite edit handler
  function handleSuiteEdit(suiteId: string): void {
    const suite = suites.find((s) => s.id === suiteId);
    if (suite) setEditingSuite(suite);
  }

  function handleSuiteSave(updated: { name: string; evaluatorAgentId?: string | null; dimensionIds: string[] }): void {
    if (!editingSuite) return;
    void evalActions.patch(editingSuite.id, updated);
    setEditingSuite(null);
  }

  async function handleSuiteCreate(input: { name: string; evaluatorAgentId?: string | null; dimensionIds: string[] }): Promise<void> {
    await evalActions.create({
      agentId,
      agentSource,
      credentialId,
      name: input.name,
      evaluatorAgentId: input.evaluatorAgentId,
      dimensionIds: input.dimensionIds,
    });
    setIsCreatingSuite(false);
  }

  async function handleCaseCreate(updated: { name: string; suiteId: string }): Promise<void> {
    if (!creatingCaseSuiteId) return;
    const newCase = await evalCaseActions.create(updated.suiteId, {
      name: updated.name,
      turns: [],
      criteria: {},
    });
    if (newCase) {
      setSelectedCaseId(newCase.id);
    }
    setCreatingCaseSuiteId(null);
  }

  async function handleCaseSave(updated: { name: string; suiteId: string }): Promise<void> {
    if (!editingCase) return;
    await evalCaseActions.patch(
      { id: editingCase.id, suiteId: editingCase.suiteId },
      { name: updated.name, suiteId: updated.suiteId }
    );
    setEditingCase(null);
  }

  // Delete handlers
  function handleDeleteSuiteRequest(suiteId: string): void {
    const suite = suites.find((s) => s.id === suiteId);
    if (suite) setDeleteTarget({ kind: "suite", id: suiteId, name: suite.name });
  }

  function handleDeleteCaseRequest(caseId: number, suiteId: string): void {
    const cases = casesBySuite[suiteId] ?? [];
    const c = cases.find((cs) => cs.id === caseId);
    if (c) setDeleteTarget({ kind: "case", id: caseId, suiteId, name: c.name });
  }

  function handleDeleteConfirm(): void {
    if (!deleteTarget) return;
    if (deleteTarget.kind === "suite") {
      void evalActions.remove(deleteTarget.id);
      if (selectedCaseId !== null) {
        const suiteCases = casesBySuite[deleteTarget.id] ?? [];
        if (suiteCases.some((c) => c.id === selectedCaseId)) {
          setSelectedCaseId(null);
        }
      }
    } else {
      void evalCaseActions.remove({ id: deleteTarget.id, suiteId: deleteTarget.suiteId });
      if (selectedCaseId === deleteTarget.id) setSelectedCaseId(null);
    }
    setDeleteTarget(null);
  }

  const activeSuiteId = selected?.suite.id ?? (suites[0]?.id ?? null);

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex h-9 items-center gap-3 border-b px-4 shrink-0">
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 shrink-0"
          onClick={onBack}
          aria-label="Back"
        >
          <ArrowLeft className="h-4 w-4" />
        </Button>

        <div className="flex min-w-0 flex-1 items-center gap-2">
          <h2 className="truncate text-sm font-semibold">{agentDisplay.name}</h2>
          <Button
            variant="outline"
            size="sm"
            className="h-6 gap-1 px-2 text-[10px]"
            onClick={() => setIsCreatingSuite(true)}
          >
            <Plus className="h-3 w-3" />
            <span>New Suite</span>
          </Button>
        </div>

        {/* Recent runs banner in header right */}
        {activeSuiteId && (
          <div className="shrink-0">
            <RecentRunsBanner
              apiPrefix="eval-suites"
              suiteId={activeSuiteId}
              refreshKey={bannerRefreshKey}
              selectedRunId={selectedRunId}
              onSelectRun={(id, seq) => {
                setSelectedRunId(id);
                setSelectedRunSeq(seq);
              }}
            />
          </div>
        )}
      </div>

      {/* Three-column body */}
      <div className="flex flex-1 min-h-0">
        {/* Left: suite tree */}
        <div className="flex flex-[2] flex-col border-r min-w-0">
          <EvalSuiteTree
            suites={suites}
            casesBySuite={casesBySuite}
            selectedCaseId={selectedCaseId}
            liveRun={liveRun}
            runningSuiteId={runningSuiteId}
            verdictByCaseId={verdictByCaseId}
            onSelectCase={setSelectedCaseId}
            onRunSuite={(id) => void handleRunSuite(id)}
            onEditSuite={handleSuiteEdit}
            onDeleteSuite={handleDeleteSuiteRequest}
            onDeleteCase={handleDeleteCaseRequest}
            onCreateCase={setCreatingCaseSuiteId}
            onEditCase={setEditingCase}
          />
        </div>

        {/* Mid + Right: case inspector */}
        {selected ? (
          <EvalCaseInspector
            key={selected.evalCase.id}
            evalCase={selected.evalCase}
            suite={selected.suite}
            liveRun={liveRun}
            onRunCase={(id) => handleRunCase(id, selected!.suite.id)}
            pinnedOutcome={pinnedOutcome}
            pinnedRunId={selectedRunId}
            selectedRunSeq={selectedRunSeq}
          />
        ) : (
          <div className="flex flex-[8] items-center justify-center text-xs text-muted-foreground">
            Select a case from the tree to inspect.
          </div>
        )}
      </div>

      {/* Suite edit dialog */}
      {editingSuite && (
        <EvalSuiteEditDialog
          open
          onOpenChange={(open) => { if (!open) setEditingSuite(null); }}
          suite={editingSuite}
          onSave={handleSuiteSave}
        />
      )}

      {/* Suite create dialog */}
      {isCreatingSuite && (
        <EvalSuiteEditDialog
          open
          onOpenChange={setIsCreatingSuite}
          onSave={handleSuiteCreate}
        />
      )}

      {/* Case create dialog */}
      {creatingCaseSuiteId && (
        <EvalCaseEditDialog
          open
          onOpenChange={(open) => { if (!open) setCreatingCaseSuiteId(null); }}
          suites={suites}
          defaultSuiteId={creatingCaseSuiteId}
          onSave={handleCaseCreate}
        />
      )}

      {/* Case edit dialog */}
      {editingCase && (
        <EvalCaseEditDialog
          open
          onOpenChange={(open) => { if (!open) setEditingCase(null); }}
          evalCase={editingCase}
          suites={suites}
          onSave={handleCaseSave}
        />
      )}

      {/* Delete confirmation */}
      <DeleteConfirmDialog
        title={deleteTarget?.kind === "suite" ? "Delete suite" : "Delete case"}
        description={
          deleteTarget
            ? <>Permanently delete <strong>{deleteTarget.name}</strong>? This cannot be undone.</>
            : ""
        }
        open={deleteTarget !== null}
        onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}
        onConfirm={handleDeleteConfirm}
        deleting={false}
      />
    </div>
  );
}
