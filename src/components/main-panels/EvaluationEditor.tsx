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

import { useState, useEffect, useCallback, useMemo, type ReactNode } from "react";
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DeleteConfirmDialog } from "@/components/ui/delete-confirm-dialog";
import { EvalSuiteTree } from "@/components/main-panels/evaluation/EvalSuiteTree";
import { EvalSuiteEditDialog } from "@/components/main-panels/evaluation/EvalSuiteEditDialog";
import { EvalCaseInspector } from "@/components/main-panels/evaluation/EvalCaseInspector";
import { useEvaluationRunStream } from "@/hooks/useEvaluationRunStream";
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
  const totalCases = suites.reduce((n, s) => n + s.caseCount, 0);

  const [selectedCaseId, setSelectedCaseId] = useState<number | null>(null);

  // Run state — shared across suite-level and case-level runs.
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [runningSuiteId, setRunningSuiteId] = useState<string | null>(null);
  const liveRun = useEvaluationRunStream(activeRunId);

  const handleRunSuite = useCallback(async (suiteId: string): Promise<void> => {
    try {
      const res = await fetch(`/api/eval-suites/${suiteId}/run`, { method: "POST" });
      if (!res.ok) return;
      const { runId } = (await res.json()) as { runId: string };
      setActiveRunId(runId);
      setRunningSuiteId(suiteId);
    } catch { /* swallow */ }
  }, []);

  const handleRunCase = useCallback(async (caseId: number): Promise<void> => {
    try {
      const res = await fetch(`/api/eval-cases/${caseId}/run`, { method: "POST" });
      if (!res.ok) return;
      const { runId } = (await res.json()) as { runId: string };
      setActiveRunId(runId);
    } catch { /* swallow */ }
  }, []);

  // Suite edit dialog
  const [editingSuite, setEditingSuite] = useState<EvalSuiteRow | null>(null);

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

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6 shrink-0"
          onClick={onBack}
          aria-label="Back"
        >
          <ArrowLeft className="h-4 w-4" />
        </Button>

        <h2 className="text-sm font-semibold truncate">{agentDisplay.name}</h2>
        <span className="text-xs text-muted-foreground shrink-0">
          ({totalCases})
        </span>
      </div>

      {/* Three-column body */}
      <div className="flex flex-1 min-h-0">
        {/* Left: suite tree */}
        <div className="flex flex-[3] flex-col border-r min-w-0">
          <EvalSuiteTree
            suites={suites}
            casesBySuite={casesBySuite}
            selectedCaseId={selectedCaseId}
            liveRun={liveRun}
            runningSuiteId={runningSuiteId}
            onSelectCase={setSelectedCaseId}
            onRunSuite={(id) => void handleRunSuite(id)}
            onEditSuite={handleSuiteEdit}
            onDeleteSuite={handleDeleteSuiteRequest}
            onDeleteCase={handleDeleteCaseRequest}
          />
        </div>

        {/* Mid + Right: case inspector */}
        {selected ? (
          <EvalCaseInspector
            key={selected.evalCase.id}
            evalCase={selected.evalCase}
            suite={selected.suite}
            liveRun={liveRun}
            onRunCase={handleRunCase}
          />
        ) : (
          <div className="flex flex-[7] items-center justify-center text-xs text-muted-foreground">
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
