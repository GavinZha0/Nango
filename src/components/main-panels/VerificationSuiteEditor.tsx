"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { ArrowLeft, Loader2, Trash2 } from "lucide-react";

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
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useRunSnapshot } from "@/hooks/useRunSnapshot";
import { useVerificationRunStream } from "@/hooks/useVerificationRunStream";
import { CaseInspector } from "@/components/main-panels/verification/CaseInspector";
import type {
  AssertionResult,
  CaseExecutionOutcome,
  ErrorEnvelope,
} from "@/lib/verification/types";
import type { VerificationCaseResultStatus } from "@/lib/db/schema";
import {
  CaseTree,
  type CaseVerdict,
} from "@/components/main-panels/verification/CaseTree";
import { NewCaseDialog } from "@/components/main-panels/verification/NewCaseDialog";
import { RecentRunsBanner } from "@/components/main-panels/RecentRunsBanner";
import { type VerificationServerRow } from "@/store/verification";
import {
  caseActions,
  useCasesStore,
  type VerificationCaseRow,
} from "@/store/verification-cases";

export interface VerificationSuiteEditorProps {
  /** The active MCP Server being verification-managed. */
  row: VerificationServerRow;
  onBack: () => void;
}

export function VerificationSuiteEditor({
  row,
  onBack,
}: VerificationSuiteEditorProps): ReactNode {
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

  // Subscribe to all cases in the store, then filter for this server.
  const bySuite = useCasesStore((s) => s.bySuite);
  const cases = useMemo(() => {
    return Object.values(bySuite).flat().filter((c) => c.mcpServerId === row.id);
  }, [bySuite, row.id]);

  const [casesLoading, setCasesLoading] = useState<boolean>(false);
  const [casesError, setCasesError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setCasesLoading(true);
    setCasesError(null);
    caseActions.refreshForServer(row.id)
      .catch((err) => {
        if (active) setCasesError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (active) setCasesLoading(false);
      });
    return () => {
      active = false;
    };
  }, [row.id]);

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

  const [serverNameById, setServerNameById] = useState<ReadonlyMap<string, string>>(
    EMPTY_NAME_MAP,
  );
  useEffect(() => {
    let cancelled = false;
    fetchMcpServerNameMap()
      .then((map) => {
        if (!cancelled) setServerNameById(map);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const [newCaseOpen, setNewCaseOpen] = useState<boolean>(false);

  const [editingCase, setEditingCase] = useState<VerificationCaseRow | null>(
    null,
  );
  const [deletingCase, setDeletingCase] =
    useState<VerificationCaseRow | null>(null);

  const isLiveTerminal: boolean =
    liveRun.phase !== "idle" && liveRun.phase !== "running";
  const snapshotRunId: string | null =
    selectedRunId ?? (isLiveTerminal ? liveRunId : null);
  const { snapshot: runSnapshot } = useRunSnapshot(snapshotRunId);

  const verdictByCaseId = useMemo<ReadonlyMap<number, CaseVerdict>>(() => {
    const map = new Map<number, CaseVerdict>();
    if (runSnapshot) {
      for (const r of runSnapshot.results) {
        map.set(r.caseId, {
          status: r.status as VerificationCaseResultStatus,
        });
      }
      return map;
    }
    for (const [caseId, v] of liveRun.caseResults) {
      map.set(caseId, { status: v.status });
    }
    return map;
  }, [runSnapshot, liveRun.caseResults]);

  const pinnedOutcome = useMemo<CaseExecutionOutcome | undefined>(() => {
    if (!runSnapshot || selectedCaseId === null) return undefined;
    const row = runSnapshot.results.find((r) => r.caseId === selectedCaseId);
    if (!row) return undefined;
    return {
      status: row.status as VerificationCaseResultStatus,
      resolvedInput: (row.inputSnapshot ?? {}) as Record<string, unknown>,
      resultPayload: row.resultPayload,
      resultTruncated: row.resultTruncated,
      assertionResults: row.assertionResults as AssertionResult[],
      error: row.error as ErrorEnvelope | null,
      startedAt: new Date(row.startedAt).getTime(),
      durationMs: row.durationMs ?? 0,
    };
  }, [runSnapshot, selectedCaseId]);

  useEffect(() => {
    if (runSnapshot && selectedCaseId === null && runSnapshot.results.length > 0) {
      const first = runSnapshot.results[0]?.caseId;
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (first !== undefined) setSelectedCaseId(first);
    }
  }, [runSnapshot, selectedCaseId]);

  useTerminalRunEffect(
    liveRun.phase,
    useCallback(() => {
      setBannerRefreshKey((k) => k + 1);
    }, []),
  );

  const handleRunTool = async (suiteId: string): Promise<void> => {
    setStartError(null);
    try {
      const res = await fetch("/api/verification-runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ suiteId }),
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
    } catch (err) {
      setStartError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleToggleSuiteVisibility = async (suiteId: string, next: "public" | "private"): Promise<void> => {
    try {
      const res = await fetch(`/api/verification-suites/${suiteId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ visibility: next }),
      });
      if (!res.ok) {
        void caseActions.refreshForServer(row.id);
      }
    }
    catch (err) {
      console.error("Failed to toggle suite visibility:", err);
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

  const displayName = row.serverTitle || row.name;

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Header aligned with left panel height and layout */}
      <header className="flex h-9 shrink-0 items-center justify-between border-b px-4">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <Button
            variant="ghost"
            size="icon-xs"
            className="h-6 w-6 shrink-0"
            onClick={onBack}
            aria-label="Back to server list"
          >
            <ArrowLeft className="h-3 w-3" />
          </Button>
          <h1 className="min-w-0 truncate text-sm font-semibold pr-1">
            {displayName}
          </h1>
        </div>
        <div className="shrink-0 flex items-center gap-2">
          <RecentRunsBanner
            suiteId={row.id}
            apiPrefix="verification-servers"
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

      <div className="flex-1 min-h-0">
        <div className="grid h-full grid-cols-[20%_1fr] overflow-hidden">
          <CaseTree
            cases={cases}
            serverNameById={serverNameById}
            verdictByCaseId={verdictByCaseId}
            selectedCaseId={selectedCaseId}
            onSelectCase={setSelectedCaseId}
            onNewCase={() => setNewCaseOpen(true)}
            onRequestEditCase={setEditingCase}
            onRequestDeleteCase={setDeletingCase}
            onRunTool={handleRunTool}
            onToggleSuiteVisibility={handleToggleSuiteVisibility}
            loading={casesLoading}
            error={casesError}
            readOnly={false}
          />
          <div className="min-w-0 overflow-hidden">
            {selectedCase ? (
              <CaseInspector
                key={selectedCase.id}
                caseRow={selectedCase}
                pinnedOutcome={pinnedOutcome}
                historyMeta={historyMeta}
                onExitHistoryView={exitHistoryView}
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
        serverId={row.id}
        open={newCaseOpen}
        onOpenChange={setNewCaseOpen}
        onCreated={(created) => setSelectedCaseId(created.id)}
      />

      <RenameCaseDialog
        caseRow={editingCase}
        onClose={() => setEditingCase(null)}
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

function RenameCaseDialog({
  caseRow,
  onClose,
}: {
  caseRow: VerificationCaseRow | null;
  onClose: () => void;
}): ReactNode {
  const open = caseRow !== null;
  const [name, setName] = useState<string>("");
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [error, setError] = useState<string>("");

  const seedKey = `${open ? 1 : 0}:${caseRow?.id ?? ""}`;
  const [lastSeedKey, setLastSeedKey] = useState<string>(seedKey);
  if (seedKey !== lastSeedKey) {
    setLastSeedKey(seedKey);
    if (open) {
      setName(caseRow.name);
      setError("");
      setSubmitting(false);
    }
  }

  async function handleSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (!caseRow) return;
    const trimmed = name.trim();
    if (!trimmed) {
      setError("Name is required.");
      return;
    }
    if (trimmed === caseRow.name) {
      onClose();
      return;
    }
    setSubmitting(true);
    const updated = await caseActions.patch(caseRow, { name: trimmed });
    setSubmitting(false);
    if (!updated) {
      setError("Failed to save case.");
      return;
    }
    onClose();
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o && !submitting) onClose();
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Rename case</DialogTitle>
        </DialogHeader>
        <form onSubmit={(e) => void handleSubmit(e)} className="space-y-3 py-2">
          <div className="grid grid-cols-[80px_1fr] items-center gap-2">
            <Label htmlFor="case-name">
              Name <span className="text-destructive">*</span>
            </Label>
            <Input
              id="case-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              autoFocus
            />
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={onClose}
              disabled={submitting}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={submitting}>
              {submitting && (
                <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
              )}
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
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
    await caseActions.remove(caseRow);
    setDeleting(false);
    onDeleted(caseRow.id);
    onClose();
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

const EMPTY_NAME_MAP: ReadonlyMap<string, string> = new Map();

async function fetchMcpServerNameMap(): Promise<ReadonlyMap<string, string>> {
  const res = await fetch("/api/mcp-servers");
  if (!res.ok) throw new Error(`${res.status}`);
  const rows = (await res.json()) as Array<{
    id: string;
    name: string;
    serverTitle?: string | null;
  }>;
  const map = new Map<string, string>();
  for (const r of rows) {
    map.set(r.id, r.serverTitle ?? r.name);
  }
  return map;
}
