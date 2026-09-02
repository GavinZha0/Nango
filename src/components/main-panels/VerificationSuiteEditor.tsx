"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { ArrowLeft, Loader2, Trash2 } from "lucide-react";
import { toast } from "sonner";
import useSWR from "swr";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { useRunSnapshot } from "@/hooks/useRunSnapshot";
import { useVerificationRunStream } from "@/hooks/useVerificationRunStream";
import { useCopilotDraft } from "@/hooks/useCopilotDraft";
import { CaseInspector, type CaseInspectorDraftHandle } from "@/components/main-panels/verification/CaseInspector";
import type {
  AssertionResult,
  CaseExecutionOutcome,
  ErrorEnvelope,
} from "@/lib/verification/types";
import type { VerificationCaseResultStatus } from "@/lib/db/schema";
import { VerificationCaseList } from "@/components/main-panels/verification/VerificationCaseList";
import { NewCaseDialog } from "@/components/main-panels/verification/NewCaseDialog";
import { RecentRunsBanner } from "@/components/main-panels/RecentRunsBanner";
import {
  caseActions,
  useCasesStore,
  type VerificationCaseRow,
} from "@/store/verification-cases";
import type { VerificationSuiteRow } from "@/store/verification";

const fetcher = async (url: string) => {
  const res = await fetch(url);
  if (!res.ok) throw new Error("Failed to fetch data");
  return res.json();
};

export interface VerificationSuiteEditorProps {
  /** The active verification suite ID. */
  suiteId?: string;
  /** Legacy prop support for server-level row if routed from old page. */
  row?: { id: string; name: string; serverTitle?: string | null };
  onBack?: () => void;
}

export function VerificationSuiteEditor({
  suiteId: propSuiteId,
  row: legacyRow,
  onBack,
}: VerificationSuiteEditorProps): ReactNode {
  const effectiveSuiteId = propSuiteId ?? legacyRow?.id;

  // 1. Fetch Suite details if suiteId is present
  const { data: suiteData, error: suiteError, isLoading: suiteLoading } = useSWR<VerificationSuiteRow & { mcpServerId?: string; serverTitle?: string; serverName?: string }>(
    effectiveSuiteId ? `/api/verification-suites/${effectiveSuiteId}` : null,
    fetcher,
  );

  const [liveRunId, setLiveRunId] = useState<string | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  const liveRun = useVerificationRunStream(liveRunId);

  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [selectedRunSeq, setSelectedRunSeq] = useState<number | null>(null);

  const exitHistoryView = useCallback((): void => {
    setSelectedRunId(null);
    setSelectedRunSeq(null);
  }, []);

  const [bannerRefreshKey, setBannerRefreshKey] = useState<number>(0);

  // 2. Cases subscription
  const bySuite = useCasesStore((s) => s.bySuite);
  const cases = useMemo(() => {
    if (!effectiveSuiteId) return [];
    return bySuite[effectiveSuiteId] ?? [];
  }, [bySuite, effectiveSuiteId]);

  const [casesLoading, setCasesLoading] = useState<boolean>(false);
  const [casesError, setCasesError] = useState<string | null>(null);

  useEffect(() => {
    if (!effectiveSuiteId) return;
    let active = true;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setCasesLoading(true);
    setCasesError(null);
    caseActions.refresh(effectiveSuiteId)
      .catch((err) => {
        if (active) setCasesError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (active) setCasesLoading(false);
      });
    return () => {
      active = false;
    };
  }, [effectiveSuiteId]);

  const [selectedCaseId, setSelectedCaseId] = useState<number | null>(null);
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

  const [newCaseOpen, setNewCaseOpen] = useState<boolean>(false);
  const [editingCase, setEditingCase] = useState<VerificationCaseRow | null>(null);
  const [deletingCase, setDeletingCase] = useState<VerificationCaseRow | null>(null);

  const isLiveTerminal: boolean =
    liveRun.phase !== "idle" && liveRun.phase !== "running";
  const snapshotRunId: string | null =
    selectedRunId ?? (isLiveTerminal ? liveRunId : null);
  const { snapshot: runSnapshot } = useRunSnapshot(snapshotRunId);

  const verdictByCaseId = useMemo<ReadonlyMap<number, { status: VerificationCaseResultStatus }>>(() => {
    const map = new Map<number, { status: VerificationCaseResultStatus }>();
    if (runSnapshot) {
      for (const r of runSnapshot.results) {
        map.set(r.caseId, {
          status: r.status as VerificationCaseResultStatus,
        });
      }
      return map;
    }
    for (const [caseId, res] of liveRun.caseResults) {
      map.set(caseId, {
        status: res.status,
      });
    }
    return map;
  }, [runSnapshot, liveRun.caseResults]);

  const pinnedOutcome = useMemo<CaseExecutionOutcome | undefined>(() => {
    if (!runSnapshot || selectedCaseId === null) return undefined;
    const r = runSnapshot.results.find((row) => row.caseId === selectedCaseId);
    if (!r) return undefined;
    return {
      status: r.status as VerificationCaseResultStatus,
      resolvedInput: (r.inputSnapshot ?? {}) as Record<string, unknown>,
      resultPayload: r.resultPayload,
      resultTruncated: r.resultTruncated,
      assertionResults: r.assertionResults as AssertionResult[],
      error: r.error as ErrorEnvelope | null,
      startedAt: new Date(r.startedAt).getTime(),
      durationMs: r.durationMs ?? 0,
    };
  }, [runSnapshot, selectedCaseId]);

  useTerminalRunEffect(
    liveRun.phase,
    useCallback(() => {
      setBannerRefreshKey((k) => k + 1);
    }, [setBannerRefreshKey]),
  );

  const handleRunSuite = async (): Promise<void> => {
    if (!effectiveSuiteId) return;
    setStartError(null);
    try {
      const res = await fetch("/api/verification-runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ suiteId: effectiveSuiteId }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as
          | { message?: string }
          | null;
        throw new Error(body?.message ?? `${res.status} ${res.statusText}`);
      }
      const { runId } = (await res.json()) as { runId: string };
      setLiveRunId(runId);
      exitHistoryView();
      toast.success("Started verification suite run");
    } catch (err) {
      setStartError(err instanceof Error ? err.message : String(err));
      toast.error(err instanceof Error ? err.message : "Failed to run suite");
    }
  };

  const handleToggleCaseEnabled = async (caseId: number, nextEnabled: boolean): Promise<void> => {
    if (!effectiveSuiteId) return;
    try {
      await caseActions.patch({ id: caseId, suiteId: effectiveSuiteId }, { enabled: nextEnabled });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to update case enabled state");
    }
  };

  const inHistoryView: boolean = selectedRunId !== null;

  const selectedCaseResult = useMemo(
    () =>
      runSnapshot && selectedCaseId !== null
        ? runSnapshot.results.find((r) => r.caseId === selectedCaseId) ?? null
        : null,
    [runSnapshot, selectedCaseId],
  );
  const historyMeta =
    inHistoryView && selectedRunSeq !== null && runSnapshot
      ? {
          seq: selectedRunSeq,
          startedAt: runSnapshot.run.startedAt,
          inputSnapshot: selectedCaseResult?.inputSnapshot ?? null,
        }
      : null;

  const suiteDisplayName = suiteData?.name || legacyRow?.name || "Verification Suite";
  const serverDisplayName = suiteData?.serverTitle || suiteData?.serverName || legacyRow?.serverTitle || null;

  const caseInspectorHandleRef = useRef<CaseInspectorDraftHandle | null>(null);
  const [inspectorVersion, setInspectorVersion] = useState(0);
  const notifyInspectorChange = useCallback(() => {
    setInspectorVersion((v) => v + 1);
  }, []);

  const casesSitemap = useMemo(() => {
    return cases.map((c) => ({
      id: c.id,
      name: c.name,
      toolName: c.toolName ?? null,
      enabled: c.enabled,
    }));
  }, [cases]);

  const getCurrentData = useCallback(() => {
    void inspectorVersion;
    const handle = caseInspectorHandleRef.current;
    let selectedCasePayload = null;
    let outcomePayload = null;

    if (selectedCase) {
      const draft = handle?.getCurrentDraft();
      selectedCasePayload = {
        id: selectedCase.id,
        suiteId: selectedCase.suiteId,
        name: selectedCase.name,
        toolName: selectedCase.toolName ?? null,
        input: draft?.input ?? selectedCase.input ?? {},
        assertions: draft?.assertions ?? selectedCase.assertions ?? [],
        isDirty: Boolean(draft?.isDirty),
      };
      outcomePayload = handle ? handle.getDisplayedOutcome() : null;
    }

    return {
      suite: {
        id: effectiveSuiteId ?? "",
        name: suiteDisplayName,
        serverId: suiteData?.mcpServerId ?? null,
        serverName: serverDisplayName ?? null,
        caseCount: cases.length,
      },
      cases: casesSitemap,
      selectedCase: selectedCasePayload,
      outcome: outcomePayload,
    };
  }, [
    effectiveSuiteId,
    suiteDisplayName,
    suiteData?.mcpServerId,
    serverDisplayName,
    cases.length,
    casesSitemap,
    selectedCase,
    inspectorVersion,
  ]);

  const applyDraft = useCallback((draft: Record<string, unknown>) => {
    if (!caseInspectorHandleRef.current) return [];
    return caseInspectorHandleRef.current.applyDraft(draft);
  }, []);

  const { clearDraftState } = useCopilotDraft({
    resourceType: "verification",
    resourceId: effectiveSuiteId ?? null,
    isReadOnly: inHistoryView,
    getCurrentData,
    applyDraft,
  });

  if (suiteLoading && !suiteData) {
    return (
      <div className="flex h-full w-full items-center justify-center gap-2 text-muted-foreground text-sm">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading suite…
      </div>
    );
  }

  if (suiteError || !effectiveSuiteId) {
    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-2 text-muted-foreground text-sm">
        <p>Verification suite not found or inaccessible.</p>
        {onBack && (
          <Button variant="outline" size="sm" onClick={onBack}>
            Back to verification
          </Button>
        )}
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">

      {/* Top Header */}
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
            {serverDisplayName && (
              <span className="text-xs text-muted-foreground truncate">
                {serverDisplayName} /
              </span>
            )}
            {selectedCase ? (
              <>
                <span className="text-xs text-muted-foreground truncate">
                  {suiteDisplayName} /
                </span>
                <h1
                  className="min-w-0 truncate text-sm font-semibold pr-1"
                  title={selectedCase.name}
                >
                  {selectedCase.name}
                </h1>
              </>
            ) : (
              <h1 className="min-w-0 truncate text-sm font-semibold pr-1">
                {suiteDisplayName}
              </h1>
            )}
          </div>
        </div>

        <div className="shrink-0 flex items-center gap-2">
          <RecentRunsBanner
            suiteId={effectiveSuiteId}
            apiPrefix="verification-suites"
            refreshKey={bannerRefreshKey}
            selectedRunId={selectedRunId}
            onSelectRun={(id, seq) => {
              setSelectedRunId(id);
              setSelectedRunSeq(seq);
            }}
          />
        </div>
      </header>

      {startError && (
        <p className="border-b border-destructive/40 bg-destructive/10 px-4 py-1.5 text-[11px] text-destructive">
          {startError}
        </p>
      )}

      {/* Main Grid: Left 20% Case List + Right Inspector */}
      <div className="flex-1 min-h-0">
        <div className="grid h-full grid-cols-[20%_1fr] overflow-hidden">
          <VerificationCaseList
            suiteName={suiteDisplayName}
            cases={cases}
            verdictByCaseId={verdictByCaseId}
            selectedCaseId={selectedCaseId}
            onSelectCase={setSelectedCaseId}
            onNewCase={() => setNewCaseOpen(true)}
            onRunSuite={handleRunSuite}
            onToggleCaseEnabled={handleToggleCaseEnabled}
            onRequestEditCase={setEditingCase}
            onRequestDeleteCase={setDeletingCase}
            loading={casesLoading}
            error={casesError}
            readOnly={false}
          />

          <div className="min-w-0 overflow-hidden">
            {selectedCase ? (
              <CaseInspector
                key={selectedCase.id}
                caseRow={selectedCase}
                serverMeta={{ id: suiteData?.mcpServerId ?? "", name: serverDisplayName ?? "", caseCount: cases.length }}
                pinnedOutcome={pinnedOutcome}
                historyMeta={historyMeta}
                onExitHistoryView={exitHistoryView}
                onBindDraftHandle={(h) => {
                  caseInspectorHandleRef.current = h;
                }}
                onSaveSuccess={clearDraftState}
                onDataChange={notifyInspectorChange}
              />
            ) : (
              <div className="grid h-full place-items-center px-8 text-center text-xs text-muted-foreground">
                <p>Select a case on the left, or create a new one.</p>
              </div>
            )}
          </div>
        </div>
      </div>

      <NewCaseDialog
        suiteId={effectiveSuiteId}
        serverId={suiteData?.mcpServerId}
        open={newCaseOpen}
        onOpenChange={setNewCaseOpen}
        onCreated={(created) => setSelectedCaseId(created.id)}
      />

      <NewCaseDialog
        suiteId={effectiveSuiteId}
        serverId={suiteData?.mcpServerId}
        open={editingCase !== null}
        onOpenChange={(o) => { if (!o) setEditingCase(null); }}
        caseRow={editingCase}
        onCreated={(updated) => {
          if (updated.suiteId !== effectiveSuiteId) {
            if (selectedCaseId === updated.id) {
              setSelectedCaseId(null);
            }
          } else if (selectedCaseId === updated.id) {
            setSelectedCaseId(null);
            queueMicrotask(() => setSelectedCaseId(updated.id));
          }
        }}
      />

      <DeleteCaseDialog
        caseRow={deletingCase}
        onClose={() => setDeletingCase(null)}
        onDeleted={(deletedId) => {
          if (selectedCaseId === deletedId) setSelectedCaseId(null);
        }}
      />
    </div>
  );
}

function DeleteCaseDialog({
  caseRow,
  onClose,
  onDeleted,
}: {
  caseRow: VerificationCaseRow | null;
  onClose: () => void;
  onDeleted: (deletedId: number) => void;
}): ReactNode {
  const [deleting, setDeleting] = useState<boolean>(false);
  const open = caseRow !== null;

  async function handleConfirm(): Promise<void> {
    if (!caseRow) return;
    setDeleting(true);
    try {
      await caseActions.remove(caseRow);
      onDeleted(caseRow.id);
      onClose();
      toast.success("Case deleted");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to delete case");
    } finally {
      setDeleting(false);
    }
  }

  return (
    <AlertDialog
      open={open}
      onOpenChange={(o) => {
        if (!o && !deleting) onClose();
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete case</AlertDialogTitle>
          <AlertDialogDescription>
            Permanently delete <strong>{caseRow?.name}</strong>? All recorded
            run results for this case will be removed. This cannot be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={(e) => {
              e.preventDefault();
              void handleConfirm();
            }}
            disabled={deleting}
            className="bg-destructive hover:bg-destructive/90"
          >
            {deleting ? (
              <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
            ) : (
              <Trash2 className="mr-1 h-3.5 w-3.5" />
            )}
            Delete
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function useTerminalRunEffect(
  phase: ReturnType<typeof useVerificationRunStream>["phase"],
  onTerminal: () => void,
): void {
  const [lastSeen, setLastSeen] = useState<typeof phase>("idle");
  if (phase !== lastSeen) {
    setLastSeen(phase);
    if (
      phase !== "idle" &&
      phase !== "running"
    ) {
      queueMicrotask(onTerminal);
    }
  }
}
