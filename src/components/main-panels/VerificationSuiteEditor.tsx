"use client";

/**
 * VerificationSuiteEditor — host for the `/verification/[id]` page.
 *
 * Layout (top-down):
 *   ┌── Header: [Back] name
 *   │   (Enable toggle + Delete live on the left panel's suite row,
 *   │    next to the status check. Run suite lives on the CaseTree
 *   │    header, adjacent to the + New case button, so all per-suite
 *   │    actions cluster around the case list they operate on.)
 *   │   (RecentRunsBanner — chip strip with prev/next pagination —
 *   │    sits inline on the right of this header, next to the suite
 *   │    name, so the run history shares the row with the actions.)
 *   ├── History-mode notice (only when a chip is selected)
 *   └── Body:
 *           Workflow: "coming soon" placeholder.
 *           MCP: 3-pane split — CaseTree | CaseInspector (input + run).
 *
 * Verdict / outcome resolution:
 *
 *   CaseTree badges (status only, lightweight):
 *     1. when a chip is selected      → snapshot.results.status
 *     2. else if a live stream exists  → liveRun.caseResults (SSE)
 *     3. else                          → empty
 *
 *   CaseInspector `pinnedOutcome` (full payload + assertions + error):
 *     - sourced from the SAME run snapshot used for badges, when one
 *       is loaded (just-completed live run OR explicit history-view
 *       chip). The snapshot runId is `selectedRunId ?? liveRunId`
 *       once the live phase is terminal; while a run is in flight
 *       no snapshot is fetched (results aren't persisted yet) and
 *       the inspector falls back to its own single-case rerun state.
 *
 * The live SSE channel carries only lightweight per-case status +
 * duration frames; full payloads ride the snapshot fetch.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { ArrowLeft, Loader2, Play, Trash2 } from "lucide-react";

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
import { cn } from "@/lib/utils";
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
import { RecentRunsBanner } from "@/components/main-panels/verification/RecentRunsBanner";
import { type VerificationSuiteRow } from "@/store/verification";
import {
  caseActions,
  useCasesStore,
  type VerificationCaseRow,
} from "@/store/verification-cases";

// --- Props -------------------------------------------------------------------

export interface VerificationSuiteEditorProps {
  /** Live suite row from the store. Parent guarantees `row.id === suiteId`. */
  row: VerificationSuiteRow;
  onBack: () => void;
}

// --- Component ---------------------------------------------------------------

export function VerificationSuiteEditor({
  row,
  onBack,
}: VerificationSuiteEditorProps): ReactNode {
  // Run lifecycle: holding the runId of the most-recent run started
  // FROM THIS EDITOR. Older runs reachable through the banner are
  // viewed as snapshots, not "live" — they don't drive this state.
  const [liveRunId, setLiveRunId] = useState<string | null>(null);
  const [starting, setStarting] = useState<boolean>(false);
  const [startError, setStartError] = useState<string | null>(null);
  const liveRun = useVerificationRunStream(liveRunId);

  // History-view: which past run is the user inspecting? Null = live
  // editor mode. We co-track the absolute sequence number (#N) so the
  // CaseInspector toolbar can prefix the outcome line with it — the
  // banner is the only place that knows the seq, so it pushes it in
  // via `onSelectRun` rather than the editor recomputing.
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [selectedRunSeq, setSelectedRunSeq] = useState<number | null>(null);

  /** Centralised "exit history view" — clear both pieces of state
   *  together so they can never drift. Invoked by the chip toggle
   *  AND by any in-place run action (Run suite / Run case), since
   *  the user clearly wants to focus on a fresh execution. */
  const exitHistoryView = useCallback((): void => {
    setSelectedRunId(null);
    setSelectedRunSeq(null);
  }, []);

  // Banner refresh signal — bump whenever the persisted run set
  // changes (currently: when a live run transitions to a terminal
  // state, so the chip becomes a real row).
  const [bannerRefreshKey, setBannerRefreshKey] = useState<number>(0);

  // Case list — lazily loaded from /api/verification-suites/[id]/cases.
  const cases = useCasesStore((s) => s.bySuite[row.id] ?? EMPTY_CASES);
  const casesLoading = useCasesStore((s) => s.loadingFor.has(row.id));
  const casesError = useCasesStore((s) => s.errorFor[row.id] ?? null);
  const isWorkflow = row.category === "workflow";
  useEffect(() => {
    if (!isWorkflow) void caseActions.refresh(row.id);
  }, [row.id, isWorkflow]);

  // Selected case — reset to null whenever the case set changes in a
  // way that invalidates the selection (e.g. delete).
  const [selectedCaseId, setSelectedCaseId] = useState<number | null>(null);
  const selectedCase = useMemo(
    () => cases.find((c) => c.id === selectedCaseId) ?? null,
    [cases, selectedCaseId],
  );
  // Same caveat as in RecentRunsBanner: the lint flags this canonical
  // "drop a stale selection when the underlying row disappears" pattern
  // because setSelectedCaseId is reachable from the effect body. The
  // call IS conditional and idempotent (it only fires after a row was
  // deleted, exactly once); suppress at the callsite.
  useEffect(() => {
    if (selectedCaseId !== null && !selectedCase) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setSelectedCaseId(null);
    }
  }, [selectedCaseId, selectedCase]);

  // MCP server catalog — needed to translate `mcpServerId` to a
  // human-readable label in the case tree. Single fetch on mount; the
  // tree gracefully degrades to "(unknown server)" if the catalog
  // hasn't loaded yet.
  const [serverNameById, setServerNameById] = useState<ReadonlyMap<string, string>>(
    EMPTY_NAME_MAP,
  );
  useEffect(() => {
    if (isWorkflow) return;
    let cancelled = false;
    fetchMcpServerNameMap()
      .then((map) => {
        if (!cancelled) setServerNameById(map);
      })
      .catch(() => {
        // Silent — server catalog is a nice-to-have for labelling;
        // the tree falls back to "(unknown server)".
      });
    return () => {
      cancelled = true;
    };
  }, [isWorkflow]);

  // New-case dialog.
  const [newCaseOpen, setNewCaseOpen] = useState<boolean>(false);

  // Per-case edit (rename) + delete dialogs. State holds the target
  // row so the dialog body can quote `name` even while the underlying
  // store row is changing.
  const [editingCase, setEditingCase] = useState<VerificationCaseRow | null>(
    null,
  );
  const [deletingCase, setDeletingCase] =
    useState<VerificationCaseRow | null>(null);

  // Snapshot source for badges + inspector outcomes. A history-view
  // chip wins outright; otherwise we lazy-fetch the just-completed
  // live run once SSE reaches a terminal phase. While a run is in
  // flight we deliberately DON'T fetch — results aren't persisted yet
  // and the live SSE stream owns the display.
  const isLiveTerminal: boolean =
    liveRun.phase !== "idle" && liveRun.phase !== "running";
  const snapshotRunId: string | null =
    selectedRunId ?? (isLiveTerminal ? liveRunId : null);
  const { snapshot: runSnapshot } = useRunSnapshot(snapshotRunId);

  // CaseTree badges — status-only. Snapshot wins when present (covers
  // history-view AND just-completed live runs); falls back to the
  // live SSE accumulator during an in-flight run.
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

  // CaseInspector full-outcome — only meaningful when the user has a
  // case selected AND we have a snapshot row for it. Mapped 1:1 from
  // the DB row (the orchestrator persists `CaseExecutionOutcome`
  // verbatim, so the reverse cast below is safe).
  const pinnedOutcome = useMemo<CaseExecutionOutcome | undefined>(() => {
    if (!runSnapshot || selectedCaseId === null) return undefined;
    const row = runSnapshot.results.find((r) => r.caseId === selectedCaseId);
    if (!row) return undefined;
    return {
      status: row.status as VerificationCaseResultStatus,
      resultPayload: row.resultPayload,
      resultTruncated: row.resultTruncated,
      assertionResults: row.assertionResults as AssertionResult[],
      error: row.error as ErrorEnvelope | null,
      // `startedAt` on the wire is a JSON-serialised ISO string (the
      // Drizzle Date column gets stringified by NextResponse.json).
      // `new Date(value).getTime()` accepts both string and Date, so
      // this stays type-safe across the network boundary.
      startedAt: new Date(row.startedAt).getTime(),
      durationMs: row.durationMs ?? 0,
    };
  }, [runSnapshot, selectedCaseId]);

  // When a live run finishes, refresh the banner so the transient
  // chip is replaced by the persisted row. We deliberately KEEP
  // `liveRunId` set so the snapshot fetch above can target it and
  // the inspector keeps showing the just-completed outcomes until
  // the user starts another run or navigates away.
  useTerminalRunEffect(
    liveRun.phase,
    useCallback(() => {
      setBannerRefreshKey((k) => k + 1);
    }, []),
  );

  // --- Handlers -------------------------------------------------------------

  const handleStartRun = async (): Promise<void> => {
    setStartError(null);
    setStarting(true);
    try {
      const res = await fetch("/api/verification-runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ suiteId: row.id }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as
          | { message?: string }
          | null;
        throw new Error(body?.message ?? `${res.status} ${res.statusText}`);
      }
      const { runId } = (await res.json()) as { runId: string };
      setLiveRunId(runId);
      // Clear any history snapshot the user was viewing — they
      // probably want to see the new run land.
      exitHistoryView();
    } catch (err) {
      setStartError(err instanceof Error ? err.message : String(err));
    } finally {
      setStarting(false);
    }
  };

  // --- Render ---------------------------------------------------------------

  const inHistoryView: boolean = selectedRunId !== null;

  // History meta passed to CaseInspector — surfaces #N + startedAt
  // in the outcome toolbar (amber tint) AND carries the per-case
  // `inputSnapshot` so the Input pane can render the exact JSON
  // that was sent at run time (the live `caseRow.input` may have
  // been edited since). Assertions are NOT snapshotted in the DB
  // (only their evaluated `assertion_results` rows are), so the
  // inspector shows a "spec not recoverable" notice for that pane
  // — the historical truth lives in the Verdicts panel.
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
          // `null` when this case wasn't part of the selected run
          // (e.g. added after the run completed) — the inspector
          // falls back to an empty snapshot view.
          inputSnapshot: selectedCaseResult?.inputSnapshot ?? null,
        }
      : null;

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Header — suite name on the left, recent-runs banner pinned
          right so both share a single row instead of two stacked
          strips. The banner sizes to its content; the title gets the
          rest via `flex-1 min-w-0 truncate`. */}
      <header className="flex items-center gap-3 border-b px-4 py-2">
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 shrink-0"
          onClick={onBack}
          aria-label="Back to suite list"
        >
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <h1 className="min-w-0 flex-1 truncate text-base font-semibold">
          {row.name}
        </h1>
        <div className="shrink-0">
          <RecentRunsBanner
            suiteId={row.id}
            refreshKey={bannerRefreshKey}
            liveRunId={liveRunId}
            livePhase={liveRun.phase === "idle" ? null : liveRun.phase}
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

      {/* The dedicated history notice row has been removed — the
          history indicator now rides inside the CaseInspector toolbar
          (amber `#N …` prefix). Any Run-button click in the editor or
          inspector calls `exitHistoryView()` to drop the selection. */}

      {/* Body */}
      <div
        className={cn(
          "flex-1 min-h-0",
          isWorkflow && "grid place-items-center px-8 text-center",
        )}
      >
        {isWorkflow ? (
          <p className="max-w-md text-sm text-muted-foreground">
            Workflow verification cases are coming in a later release.
          </p>
        ) : (
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
              loading={casesLoading}
              error={casesError}
              readOnly={false}
              headerExtra={
                !isWorkflow ? (
                  <Button
                    size="sm"
                    className="h-6 w-6 p-0"
                    variant="ghost"
                    onClick={handleStartRun}
                    disabled={
                      starting || !row.enabled || liveRun.phase === "running"
                    }
                    title={
                      !row.enabled
                        ? "Enable the suite to run it."
                        : liveRun.phase === "running"
                          ? "A run is already in progress."
                          : "Run suite"
                    }
                  >
                    {starting || liveRun.phase === "running" ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Play className="h-3.5 w-3.5 fill-green-500 text-green-500" />
                    )}
                  </Button>
                ) : null
              }
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
        )}
      </div>

      <NewCaseDialog
        suiteId={row.id}
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
          // If the deleted case was selected, clear the inspector.
          if (selectedCaseId === deletedId) setSelectedCaseId(null);
        }}
      />
    </div>
  );
}

// --- Case dialogs ----------------------------------------------------------

/**
 * Rename a verification case. Single-field form; we don't expose other
 * editable fields here because input/assertions live in the inspector
 * (a textarea-based JSON editor far richer than what fits in a modal).
 */
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

  // Re-seed inputs whenever a new case is targeted. Same render-time
  // detect pattern used elsewhere to avoid effect-setState lint.
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

/** Confirm + delete a verification case. */
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

// --- Helpers ----------------------------------------------------------------

/**
 * Fire `onTerminal` exactly once each time the live-run phase
 * transitions from `running` → terminal. Idle phase is treated as
 * "no run", not as a terminal transition.
 */
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
      // Schedule the callback for after render to avoid mid-render setState chains.
      queueMicrotask(onTerminal);
    }
  }
}

// --- Module-level helpers (hoisted to stay lint-clean re: effect setState) -

/** Shared stable reference for "no cases yet" to avoid re-renders. */
const EMPTY_CASES: ReadonlyArray<
  import("@/store/verification-cases").VerificationCaseRow
> = [];

/** Shared stable empty map. */
const EMPTY_NAME_MAP: ReadonlyMap<string, string> = new Map();

/**
 * Fetch the MCP server catalog as a (id → displayName) map. We pull
 * `serverTitle` first (preferred display) and fall back to `name`.
 */
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
