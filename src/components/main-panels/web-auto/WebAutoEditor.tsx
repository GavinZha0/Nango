"use client";

import { useState, useEffect, useMemo, useCallback } from "react";
import { Play, X, ArrowLeft, Loader2, Save, Trash2, Copy, Check, ZoomIn, ZoomOut } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useWebAutoStore, WebAutoCaseRow, WebAutoSuiteRow } from "@/store/web-auto-store";
import { useWebAutoRunStream } from "@/hooks/useWebAutoRunStream";
import { useCopilotDraft } from "@/hooks/useCopilotDraft";
import { RecentRunsBanner } from "@/components/main-panels/RecentRunsBanner";
import {
  extractWebAutoImages,
  formatWebAutoOutputForDisplay,
  sanitizeWebAutoOutput,
  type WebAutoExtractedImage,
} from "@/lib/web-auto/image-extractor";
import { useRouter } from "next/navigation";
import useSWR, { mutate } from "swr";
import { toast } from "sonner";
import { NewWebAutoCaseDialog } from "./NewWebAutoCaseDialog";
import { WebAutoCaseList, type CaseVerdict } from "./WebAutoCaseList";
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
import { cn } from "@/lib/utils";
import { extractTargetCase } from "@/components/main-panels/common";
import { UniversalAssertionsEditor } from "@/components/main-panels/common/UniversalAssertionsEditor";
import type { AssertionSpec } from "@/lib/assertions";
import { AssertionVerdictList } from "@/components/main-panels/common/verdicts";

const fetcher = async (url: string) => {
  const res = await fetch(url);
  if (!res.ok) throw new Error("An error occurred while fetching the data.");
  return res.json();
};

export interface SingleCaseRunOutcome {
  status: "passed" | "failed" | "errored";
  executionOutput: unknown;
  assertionResults?: import("@/lib/assertions").AssertionResult[];
  score?: number;
  feedback?: string;
  verdict?: {
    deterministic: { passed: boolean; results: Array<{ index: number; ok: boolean; type: string; message?: string; expected?: unknown; actual?: unknown }> };
    llm?: { passed: boolean; score?: number; feedback?: string; expectationResults: Array<{ expectation: string; score: number; feedback: string }> };
    overall: { passed: boolean; reason: string };
  };
  error: { source: string; message: string; details?: unknown } | null;
  durationMs: number;
}

export function WebAutoEditor({ suiteId }: { suiteId: string }) {
  const router = useRouter();
  const { selectedCaseId, setSelectedCaseId, suites } = useWebAutoStore();
  const [caseDialogOpen, setCaseDialogOpen] = useState(false);
  const [caseToEdit, setCaseToEdit] = useState<{ id: number; name: string } | null>(null);
  const [caseToDelete, setCaseToDelete] = useState<{ id: number; name: string } | null>(null);

  // History Banner & Run Selection State
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [selectedRunSeq, setSelectedRunSeq] = useState<number | null>(null);
  const [bannerRefreshKey, setBannerRefreshKey] = useState<number>(0);
  const inHistoryView = selectedRunId !== null;

  // Lookup suite (from store or fallback SWR)
  const suiteFromStore = suites.find((s) => s.id === suiteId);
  const { data: fetchedSuite, isLoading: suiteLoading } = useSWR<WebAutoSuiteRow>(
    suiteFromStore ? null : `/api/web-auto-suites/${suiteId}`,
    fetcher,
  );
  const selectedSuite = suiteFromStore || fetchedSuite;

  // Fetch cases for this suite
  const { data: cases, isLoading, error, mutate: mutateCases } = useSWR<WebAutoCaseRow[]>(
    `/api/web-auto-suites/${suiteId}/cases`,
    fetcher
  );

  const selectedCase = cases?.find(c => c.id === selectedCaseId);

  // Editor Draft State
  const [draftScript, setDraftScript] = useState<string>("");
  const [draftSteps, setDraftSteps] = useState<string>("");
  const [inputTab, setInputTab] = useState<"script" | "steps">("script");
  const [draftAssertions, setDraftAssertions] = useState<Record<string, unknown>[]>([]);
  const [jsonError, setJsonError] = useState<string | null>(null);

  const activeSuiteRunId_state = useState<string | null>(null);
  const [activeSuiteRunId, setActiveSuiteRunId] = activeSuiteRunId_state;
  const liveRun = useWebAutoRunStream(activeSuiteRunId);

  // Terminal run effect to refresh banner when a suite run finishes
  const [lastSeenPhase, setLastSeenPhase] = useState<string>("idle");
  if (liveRun.phase !== lastSeenPhase) {
    setLastSeenPhase(liveRun.phase);
    if (liveRun.phase !== "idle" && liveRun.phase !== "running") {
      setBannerRefreshKey((k) => k + 1);
    }
  }

  // Fetch historical run snapshot if in history view
  const { data: runSnapshot } = useSWR<{
    run: { id: string; startedAt: string; status: string };
    results: Array<{
      caseId: number;
      status: "passed" | "failed" | "errored";
      executionOutput: unknown;
      verdict: {
        deterministic: { passed: boolean; results: Array<{ index: number; ok: boolean; type: string; message?: string; expected?: unknown; actual?: unknown }> };
        llm?: { passed: boolean; score?: number; feedback?: string; expectationResults: Array<{ expectation: string; score: number; feedback: string }> };
        overall: { passed: boolean; reason: string };
      };
      error: { source: string; message: string; details?: unknown } | null;
      durationMs: number;
    }>;
  }>(selectedRunId ? `/api/web-auto-runs/${selectedRunId}` : null, fetcher);

  const [outputTab, setOutputTab] = useState<"output" | "images">("output");
  const [copiedImageId, setCopiedImageId] = useState<string | null>(null);
  const [previewImage, setPreviewImage] = useState<WebAutoExtractedImage | null>(null);
  const [zoomLevel, setZoomLevel] = useState<number>(1);

  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [runOutcome, setRunOutcome] = useState<SingleCaseRunOutcome | null>(null);

  // Compute effective outcome (prioritizes historical snapshot when in history view)
  const displayOutcome = useMemo<SingleCaseRunOutcome | null>(() => {
    if (inHistoryView) {
      if (!runSnapshot || !selectedCaseId) return null;
      const historyCaseResult = runSnapshot.results.find((r) => r.caseId === selectedCaseId) as unknown as {
        status: "passed" | "failed" | "errored";
        executionOutput: unknown;
        assertionResults?: import("@/lib/assertions").AssertionResult[];
        score?: number | null;
        feedback?: string | null;
        verdict?: SingleCaseRunOutcome["verdict"];
        error: { source: string; message: string; details?: unknown } | null;
        durationMs: number;
      } | undefined;
      if (!historyCaseResult) return null;
      return {
        status: historyCaseResult.status,
        executionOutput: historyCaseResult.executionOutput,
        assertionResults: historyCaseResult.assertionResults,
        score: historyCaseResult.score ?? undefined,
        feedback: historyCaseResult.feedback ?? undefined,
        verdict: historyCaseResult.verdict,
        error: historyCaseResult.error,
        durationMs: historyCaseResult.durationMs,
      };
    }
    return runOutcome;
  }, [inHistoryView, runSnapshot, selectedCaseId, runOutcome]);

  const verdictByCaseId = useMemo<ReadonlyMap<number, CaseVerdict>>(() => {
    const map = new Map<number, CaseVerdict>();
    if (inHistoryView && runSnapshot) {
      for (const hr of runSnapshot.results) {
        map.set(hr.caseId, {
          status: hr.status,
          durationMs: hr.durationMs,
        });
      }
    } else {
      for (const [caseId, liveCase] of liveRun.caseResults) {
        map.set(Number(caseId), {
          status: liveCase.status,
          durationMs: liveCase.durationMs,
        });
      }
    }
    return map;
  }, [inHistoryView, runSnapshot, liveRun.caseResults]);

  const handleToggleCaseEnabled = async (caseId: number, nextEnabled: boolean): Promise<void> => {
    try {
      const res = await fetch(`/api/web-auto-cases/${caseId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: nextEnabled }),
      });
      if (!res.ok) throw new Error("Failed to update case enabled status");
      await mutateCases();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to toggle case");
    }
  };

  const extractedImages = useMemo(() => {
    return extractWebAutoImages(displayOutcome?.executionOutput);
  }, [displayOutcome?.executionOutput]);

  const formattedOutputText = useMemo(() => {
    return formatWebAutoOutputForDisplay(displayOutcome?.executionOutput);
  }, [displayOutcome?.executionOutput]);

  // Auto-select first case if history snapshot arrives and no valid case is active
  useEffect(() => {
    if (inHistoryView && runSnapshot && runSnapshot.results.length > 0) {
      if (!selectedCaseId || !runSnapshot.results.some((r) => r.caseId === selectedCaseId)) {
        setSelectedCaseId(runSnapshot.results[0].caseId);
      }
    }
  }, [inHistoryView, runSnapshot, selectedCaseId, setSelectedCaseId]);

  const handleCopyBase64 = async (e: React.MouseEvent, img: WebAutoExtractedImage) => {
    e.stopPropagation();
    try {
      const textToCopy = img.rawBase64 || img.src;
      await navigator.clipboard.writeText(textToCopy);
      setCopiedImageId(img.id);
      toast.success(img.rawBase64 ? "Base64 copied to clipboard" : "Image URL copied to clipboard");
      setTimeout(() => {
        setCopiedImageId((prev) => (prev === img.id ? null : prev));
      }, 2000);
    } catch {
      toast.error("Failed to copy image");
    }
  };

  const handleOpenPreview = (img: WebAutoExtractedImage) => {
    setZoomLevel(1);
    setPreviewImage(img);
  };

  useEffect(() => {
    if (selectedCase) {
      const caseInput = (selectedCase.input ?? {}) as Record<string, unknown>;
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setDraftScript(typeof caseInput.script === "string" ? caseInput.script : "");
      setDraftSteps(typeof caseInput.steps === "string" ? caseInput.steps : "");
      setDraftAssertions(
        Array.isArray(selectedCase.assertions) ? selectedCase.assertions : []
      );
      setJsonError(null);
    } else {
      setDraftScript("");
      setDraftSteps("");
      setDraftAssertions([]);
      setJsonError(null);
    }
  }, [selectedCase]);

  const currentCaseInput = (selectedCase?.input ?? {}) as Record<string, unknown>;
  const isDirty = selectedCase && (
    draftScript !== ((currentCaseInput.script as string) || "") ||
    draftSteps !== ((currentCaseInput.steps as string) || "") ||
    JSON.stringify(draftAssertions) !== JSON.stringify(Array.isArray(selectedCase.assertions) ? selectedCase.assertions : [])
  );
  const canSave = Boolean(isDirty) && !jsonError && !saving;

  // Copilot ambient context & draft integration
  const getCurrentData = useCallback(() => {
    return {
      suite: {
        id: selectedSuite?.id ?? suiteId,
        name: selectedSuite?.name ?? "",
        description: selectedSuite?.description ?? null,
        timeoutSec: selectedSuite?.timeoutSec ?? 300,
        caseCount: cases?.length ?? 0,
      },
      selectedCase: selectedCase
        ? {
            id: selectedCase.id,
            name: selectedCase.name,
            input: {
              script: draftScript,
              steps: draftSteps,
            },
            assertions: draftAssertions,
            isDirty: Boolean(isDirty),
          }
        : null,
      outcome: displayOutcome
        ? {
            source: inHistoryView ? "history" : "live",
            ...(inHistoryView && selectedRunSeq !== null ? { historySeq: selectedRunSeq } : {}),
            status: displayOutcome.status,
            error: displayOutcome.error || null,
            verdict: displayOutcome.verdict || null,
            output: sanitizeWebAutoOutput(displayOutcome.executionOutput),
          }
        : null,
    } as Record<string, unknown>;
  }, [
    selectedSuite,
    suiteId,
    cases,
    selectedCase,
    draftSteps,
    draftScript,
    draftAssertions,
    isDirty,
    displayOutcome,
    inHistoryView,
    selectedRunSeq,
  ]);

  const applyDraft = useCallback((draft: Record<string, unknown>) => {
    const applied: string[] = [];
    const sc = extractTargetCase(draft, selectedCase?.id);
    const inputObj = (sc.input && typeof sc.input === "object" ? sc.input : {}) as Record<string, unknown>;
    
    const script = typeof inputObj.script === "string" 
      ? inputObj.script 
      : (typeof sc.script === "string" ? sc.script : (typeof sc.scriptContent === "string" ? sc.scriptContent : null));
    if (script !== null) {
      setDraftScript(script);
      applied.push("input.script");
    }

    const steps = typeof inputObj.steps === "string"
      ? inputObj.steps
      : (typeof sc.steps === "string" ? sc.steps : (typeof sc.description === "string" ? sc.description : null));
    if (steps !== null) {
      setDraftSteps(steps);
      applied.push("input.steps");
    }

    if (Array.isArray(sc.assertions)) {
      setDraftAssertions(sc.assertions);
      applied.push("assertions");
    }
    if (draft.selectedCase) applied.push("selectedCase");
    return applied;
  }, [selectedCase?.id, setDraftScript, setDraftSteps, setDraftAssertions]);

  const { clearDraftState } = useCopilotDraft({
    resourceType: "web-auto",
    resourceId: suiteId ?? null,
    isReadOnly: false,
    getCurrentData,
    applyDraft,
  });

  const handleSave = async () => {
    if (!selectedCase) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/web-auto-cases/${selectedCase.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          input: {
            script: draftScript,
            steps: draftSteps,
          },
          assertions: draftAssertions,
        }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.message || "Failed to save case");
      }
      
      // Trigger SWR revalidation
      await mutate(`/api/web-auto-suites/${suiteId}/cases`);
      clearDraftState();
      toast.success("Saved successfully");
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const handleRunCase = async (caseIdToRun?: string) => {
    const targetId = caseIdToRun || selectedCaseId;
    if (!targetId) return;

    // Exit history view to view live execution
    setSelectedRunId(null);
    setSelectedRunSeq(null);

    // If dirty and targeting current selected case, save first
    if (isDirty && targetId === selectedCaseId) {
      await handleSave();
    }

    setRunning(true);
    try {
      const res = await fetch(`/api/web-auto-cases/${targetId}/run`, {
        method: "POST",
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.message || "Execution failed");
      }
      setRunOutcome(data);
      const imgs = extractWebAutoImages(data.executionOutput);
      if (imgs.length > 0) {
        setOutputTab("images");
      }
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  };

  const handleRunSuite = async () => {
    if (liveRun.phase === "running") return;
    // Exit history view to view live suite execution
    setSelectedRunId(null);
    setSelectedRunSeq(null);
    try {
      const res = await fetch("/api/web-auto-runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ suiteId }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.message || "Failed to start suite run");
      }
      setActiveSuiteRunId(data.runId);
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  };

  if (suiteLoading) {
    return (
      <div className="flex h-full w-full items-center justify-center gap-2 text-muted-foreground text-sm">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading suite...
      </div>
    );
  }

  if (!selectedSuite) {
    return (
      <div className="flex h-full w-full items-center justify-center text-muted-foreground text-sm">
        Select a suite from the left panel.
      </div>
    );
  }

  return (
    <div className="flex h-full w-full flex-col overflow-hidden">
      <header className="flex h-9 shrink-0 items-center justify-between border-b px-4">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6 p-0 shrink-0"
            onClick={() => router.push("/web-auto")}
            aria-label="Back to suite list"
          >
            <ArrowLeft className="h-3 w-3" />
          </Button>
          <h1 className="min-w-0 truncate text-sm font-semibold pr-1">
            {selectedSuite.name}
          </h1>
        </div>
        <div className="shrink-0 flex items-center gap-2">
          <RecentRunsBanner
            apiPrefix="web-auto-suites"
            suiteId={selectedSuite.id}
            refreshKey={bannerRefreshKey}
            selectedRunId={selectedRunId}
            onSelectRun={(id, seq) => {
              setSelectedRunId(id);
              setSelectedRunSeq(seq);
            }}
          />
        </div>
      </header>

      <div className="flex-1 grid h-full grid-cols-[20%_1fr] min-h-0 overflow-hidden">
        <WebAutoCaseList
          cases={cases ?? []}
          verdictByCaseId={verdictByCaseId}
          selectedCaseId={selectedCaseId}
          onSelectCase={setSelectedCaseId}
          onNewCase={() => {
            setCaseToEdit(null);
            setCaseDialogOpen(true);
          }}
          onRunSuite={() => void handleRunSuite()}
          isSuiteRunning={liveRun.phase === "running"}
          mcpServerId={selectedSuite?.mcpServerId}
          onToggleCaseEnabled={handleToggleCaseEnabled}
          onRequestEditCase={(c) => {
            setCaseToEdit({ id: c.id, name: c.name });
            setCaseDialogOpen(true);
          }}
          onRequestDeleteCase={(c) => {
            setCaseToDelete({ id: c.id, name: c.name });
          }}
          loading={isLoading}
          error={error ? "Error loading cases" : null}
          readOnly={false}
        />

        <div className="grid h-full grid-cols-2 min-w-0 overflow-hidden">
            <div className="flex min-h-0 flex-col min-w-0 border-r border-border/60">
              <div className="flex items-stretch border-b bg-muted/40 pr-1.5 h-8 shrink-0">
                <button
                  type="button"
                  onClick={() => setInputTab("script")}
                  className={`px-3 py-1.5 text-xs font-medium border-b-2 transition-colors ${
                    inputTab === "script"
                      ? "border-primary text-foreground"
                      : "border-transparent text-muted-foreground hover:text-foreground"
                  }`}
                >
                  Script
                </button>
                <button
                  type="button"
                  onClick={() => setInputTab("steps")}
                  className={`px-3 py-1.5 text-xs font-medium border-b-2 transition-colors ${
                    inputTab === "steps"
                      ? "border-primary text-foreground"
                      : "border-transparent text-muted-foreground hover:text-foreground"
                  }`}
                >
                  Steps
                </button>
                <div className="ml-auto flex shrink-0 items-center gap-2">
                  <Button 
                    size="sm"
                    variant="ghost" 
                    className={`h-6 w-6 p-0 hover:bg-transparent hover:text-foreground ${isDirty ? "text-amber-500" : "text-muted-foreground"}`}
                    disabled={!canSave}
                    onClick={handleSave}
                    title="Save"
                  >
                    {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Save className="h-3 w-3" />}
                  </Button>
                  <Button
                    size="sm"
                    className="h-6 px-2 text-xs"
                    disabled={!selectedCase || running || !selectedSuite?.mcpServerId}
                    onClick={() => void handleRunCase()}
                    title={!selectedSuite?.mcpServerId ? "Playwright not configured" : "Run case"}
                  >
                    {running ? (
                      <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />
                    ) : (
                      <Play
                        className={cn(
                          "mr-1.5 h-3 w-3",
                          selectedSuite?.mcpServerId
                            ? "fill-green-500 text-green-500"
                            : "fill-muted-foreground text-muted-foreground"
                        )}
                      />
                    )}
                    Run
                  </Button>
                </div>
              </div>

              <div className="grid h-full grid-rows-[calc(50%-1rem)_calc(50%+1rem)] min-w-0 flex-1 overflow-hidden bg-background/50">
                <div className="flex flex-col min-h-0 overflow-hidden">
                  <div className="flex min-h-0 flex-1 flex-col px-3 pb-2 pt-2">
                    <div className="relative min-h-0 flex-1">
                      {inputTab === "script" ? (
                        <Textarea
                          className="h-full w-full resize-none font-mono text-xs leading-relaxed focus-visible:ring-0 focus-visible:ring-offset-0 border-0 p-0 shadow-none bg-transparent"
                          spellCheck={false}
                          value={draftScript}
                          onChange={(e) => setDraftScript(e.target.value)}
                          placeholder={`// playwright script\nasync (page) => {\n  await page.goto('https://www.example.com/');\n  return { success: true };\n}`}
                        />
                      ) : (
                        <Textarea
                          className="h-full w-full resize-none text-xs leading-relaxed focus-visible:ring-0 focus-visible:ring-offset-0 border-0 p-0 shadow-none bg-transparent"
                          value={draftSteps}
                          onChange={(e) => setDraftSteps(e.target.value)}
                          placeholder={"1. Navigate to target page\n2. Perform interaction steps\n3. Check expected outcomes..."}
                        />
                      )}
                    </div>
                  </div>
                </div>

                <div className="flex flex-col min-h-0 overflow-hidden">
                  <UniversalAssertionsEditor
                    key={selectedCase?.id ?? "none"}
                    mode="web-auto"
                    assertions={draftAssertions as AssertionSpec[]}
                    onChange={(updated) => setDraftAssertions(updated as Record<string, unknown>[])}
                    onErrorChange={setJsonError}
                    readOnly={!selectedCase}
                    saving={saving}
                  />
                </div>
              </div>
            </div>

            <div className="flex min-h-0 flex-col min-w-0">
              <div className="flex h-8 shrink-0 items-center justify-between border-b bg-muted/40 px-3 min-w-0">
                <div className="flex items-center">
                  <button
                    type="button"
                    onClick={() => setOutputTab("output")}
                    className={`flex h-8 items-center border-b-2 px-3 text-xs font-medium transition-colors ${
                      outputTab === "output"
                        ? "border-primary text-foreground"
                        : "border-transparent text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    Output
                  </button>
                  <button
                    type="button"
                    onClick={() => setOutputTab("images")}
                    className={`flex h-8 items-center border-b-2 px-3 text-xs font-medium transition-colors gap-1.5 ${
                      outputTab === "images"
                        ? "border-primary text-foreground"
                        : "border-transparent text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    Images
                    {extractedImages.length > 0 && (
                      <span className="rounded-full bg-primary/10 px-1.5 py-0.2 text-[10px] font-semibold text-primary">
                        {extractedImages.length}
                      </span>
                    )}
                  </button>
                </div>
                {displayOutcome && (
                  <div className="flex items-center gap-2">
                    {inHistoryView && selectedRunSeq !== null && (
                      <span className="text-xs font-semibold text-amber-500 dark:text-amber-400">
                        (#{selectedRunSeq} - {runSnapshot?.run?.startedAt ? formatHistoricalTimestamp(runSnapshot.run.startedAt) : ""})
                      </span>
                    )}
                    {typeof displayOutcome.durationMs === "number" && !isNaN(displayOutcome.durationMs) && displayOutcome.durationMs > 0 && (
                      <span className="text-[10px] text-muted-foreground font-mono">
                        {displayOutcome.durationMs >= 1000
                          ? `${(displayOutcome.durationMs / 1000).toFixed(1)}s`
                          : `${displayOutcome.durationMs}ms`}
                      </span>
                    )}
                    <span
                      className={`text-[10px] font-semibold px-1.5 py-0.5 rounded ${
                        displayOutcome.status === "passed"
                          ? "bg-green-500/10 text-green-500 border border-green-500/20"
                          : displayOutcome.status === "failed"
                          ? "bg-destructive/10 text-destructive border border-destructive/20"
                          : "bg-amber-500/10 text-amber-500 border border-amber-500/20"
                      }`}
                    >
                      {displayOutcome.status.toUpperCase()}
                    </span>
                  </div>
                )}
              </div>
              
              <div className="grid h-full grid-rows-[calc(50%-1rem)_calc(50%+1rem)] min-w-0 flex-1 overflow-hidden">
                <div className="flex flex-col min-h-0 overflow-hidden">
                  <div className="flex-1 min-h-0 px-3 pb-2 pt-2">
                    {outputTab === "output" ? (
                      <div className="h-full w-full overflow-auto rounded-md border bg-background/50 p-2 flex flex-col font-mono text-xs">
                        {running ? (
                          <div className="flex h-full items-center justify-center gap-2 text-xs text-muted-foreground font-sans">
                            <Loader2 className="h-4 w-4 animate-spin text-primary" />
                            Executing case & evaluating assertions...
                          </div>
                        ) : displayOutcome ? (
                          <pre className="text-xs text-foreground whitespace-pre-wrap break-all leading-relaxed font-mono">
                            {formattedOutputText}
                          </pre>
                        ) : (
                          <div className="flex h-full items-center justify-center p-3 text-xs text-muted-foreground font-sans">
                            Run a case to see the output.
                          </div>
                        )}
                      </div>
                    ) : (
                      <div className="h-full w-full overflow-hidden rounded-md border bg-background/50 flex flex-col">
                        {extractedImages.length === 0 ? (
                          <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
                            No image
                          </div>
                        ) : extractedImages.length === 1 ? (
                          <div className="flex h-full w-full flex-col items-center justify-center p-2 relative group overflow-hidden">
                            <div className="absolute top-2 right-2 z-10">
                              <Button
                                size="icon"
                                variant="ghost"
                                className="h-6 w-6 p-0 bg-background/80 hover:bg-background border text-muted-foreground hover:text-foreground rounded shadow-xs"
                                onClick={(e) => handleCopyBase64(e, extractedImages[0])}
                                title={extractedImages[0].rawBase64 ? "Copy Base64 string" : "Copy image URL"}
                              >
                                {copiedImageId === extractedImages[0].id ? (
                                  <Check className="h-3 w-3 text-emerald-500" />
                                ) : (
                                  <Copy className="h-3 w-3" />
                                )}
                              </Button>
                            </div>
                            <div
                              className="relative flex h-full w-full items-center justify-center cursor-pointer overflow-hidden rounded bg-[radial-gradient(#e5e7eb_1px,transparent_1px)] dark:bg-[radial-gradient(#1f2937_1px,transparent_1px)] [background-size:12px_12px]"
                              onClick={() => handleOpenPreview(extractedImages[0])}
                            >
                              {/* eslint-disable-next-line @next/next/no-img-element */}
                              <img
                                src={extractedImages[0].src}
                                alt={extractedImages[0].name}
                                className="max-h-full max-w-full object-contain rounded transition-transform hover:scale-[1.01]"
                              />
                            </div>
                          </div>
                        ) : (
                          <div className="grid grid-cols-2 gap-2 p-2 overflow-y-auto h-full">
                            {extractedImages.map((img) => (
                              <div
                                key={img.id}
                                className="group relative flex flex-col rounded-md border bg-background/80 overflow-hidden hover:border-primary/50 transition-all cursor-pointer"
                                onClick={() => handleOpenPreview(img)}
                              >
                                <div className="flex items-center justify-between px-2 py-1 bg-muted/40 border-b text-[10px] text-muted-foreground font-mono">
                                  <span className="truncate max-w-[130px]" title={img.name}>{img.name}</span>
                                  <Button
                                    size="icon"
                                    variant="ghost"
                                    className="h-5 w-5 p-0 text-muted-foreground hover:text-foreground"
                                    onClick={(e) => handleCopyBase64(e, img)}
                                    title={img.rawBase64 ? "Copy Base64 string" : "Copy image URL"}
                                  >
                                    {copiedImageId === img.id ? (
                                      <Check className="h-2.5 w-2.5 text-emerald-500" />
                                    ) : (
                                      <Copy className="h-2.5 w-2.5" />
                                    )}
                                  </Button>
                                </div>
                                <div className="relative aspect-video w-full flex items-center justify-center p-1 bg-[radial-gradient(#e5e7eb_1px,transparent_1px)] dark:bg-[radial-gradient(#1f2937_1px,transparent_1px)] [background-size:8px_8px] overflow-hidden">
                                  {/* eslint-disable-next-line @next/next/no-img-element */}
                                  <img
                                    src={img.src}
                                    alt={img.name}
                                    className="max-h-full max-w-full object-contain"
                                  />
                                </div>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </div>
                <div className="flex flex-col min-h-0 overflow-hidden">
                  <AssertionVerdictList
                    verdicts={
                      displayOutcome?.assertionResults ??
                      displayOutcome?.verdict?.deterministic?.results
                    }
                    assertions={draftAssertions as unknown as readonly import("@/lib/assertions").AssertionSpec[]}
                    error={displayOutcome?.error as import("@/lib/assertions").ErrorEnvelope | null}
                    feedback={displayOutcome?.feedback}
                    title="Verdicts"
                  />
                </div>
              </div>
            </div>
          </div>
        </div>
      <NewWebAutoCaseDialog
        open={caseDialogOpen}
        onOpenChange={(open) => { setCaseDialogOpen(open); if(!open) setCaseToEdit(null); }}
        suiteId={suiteId}
        caseToEdit={caseToEdit}
      />
      <AlertDialog
        open={caseToDelete !== null}
        onOpenChange={(open) => {
          if (!open && !saving) setCaseToDelete(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete case</AlertDialogTitle>
            <AlertDialogDescription>
              Permanently delete <strong>{caseToDelete?.name}</strong>? All recorded
              run results for this case will be removed. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={saving}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={async (e) => {
                e.preventDefault();
                if (!caseToDelete) return;
                setSaving(true);
                try {
                  const res = await fetch(`/api/web-auto-cases/${caseToDelete.id}`, { method: "DELETE" });
                  if (!res.ok) throw new Error("Failed to delete case");
                  await mutate(`/api/web-auto-suites/${suiteId}/cases`);
                  setCaseToDelete(null);
                  toast.success("Case deleted");
                  if (selectedCaseId === caseToDelete.id) setSelectedCaseId(null);
                } catch (err: unknown) {
                  toast.error(err instanceof Error ? err.message : String(err));
                } finally {
                  setSaving(false);
                }
              }}
              disabled={saving}
              className="bg-destructive hover:bg-destructive/90"
            >
              {saving ? (
                <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
              ) : (
                <Trash2 className="mr-1 h-3.5 w-3.5" />
              )}
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Image Preview Lightbox Modal */}
      {previewImage && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-xs p-4 animate-in fade-in duration-150"
          onClick={() => setPreviewImage(null)}
        >
          <div
            className="relative flex flex-col max-h-[90vh] max-w-[90vw] rounded-lg border bg-background shadow-2xl overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-4 py-2 border-b bg-muted/40 text-xs">
              <span className="font-mono font-semibold text-foreground truncate max-w-[200px]" title={previewImage.name}>
                {previewImage.name}
              </span>
              <div className="flex items-center gap-1">
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-6 w-6 p-0 text-muted-foreground hover:text-foreground"
                  disabled={zoomLevel <= 0.25}
                  onClick={() => setZoomLevel((z) => Math.max(0.25, Math.round((z - 0.25) * 100) / 100))}
                  title="Zoom Out"
                >
                  <ZoomOut className="h-3.5 w-3.5" />
                </Button>
                <button
                  type="button"
                  className="px-1.5 py-0.5 text-[10px] font-mono text-muted-foreground hover:text-foreground rounded hover:bg-muted transition-colors cursor-pointer"
                  onClick={() => setZoomLevel(1)}
                  title="Reset Zoom (100%)"
                >
                  {Math.round(zoomLevel * 100)}%
                </button>
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-6 w-6 p-0 text-muted-foreground hover:text-foreground"
                  disabled={zoomLevel >= 4}
                  onClick={() => setZoomLevel((z) => Math.min(4, Math.round((z + 0.25) * 100) / 100))}
                  title="Zoom In"
                >
                  <ZoomIn className="h-3.5 w-3.5" />
                </Button>
                <div className="h-3.5 w-[1px] bg-border mx-1" />
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-6 w-6 p-0 text-muted-foreground hover:text-foreground"
                  onClick={() => {
                    setPreviewImage(null);
                    setZoomLevel(1);
                  }}
                  title="Close"
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>
            </div>
            <div className="flex-1 overflow-auto p-4 flex items-start justify-center min-h-[350px] max-h-[calc(90vh-45px)] min-w-[350px] max-w-[90vw] bg-[radial-gradient(#e5e7eb_1px,transparent_1px)] dark:bg-[radial-gradient(#1f2937_1px,transparent_1px)] [background-size:12px_12px]">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={previewImage.src}
                alt={previewImage.name}
                style={{
                  width: zoomLevel === 1 ? "auto" : `${zoomLevel * 100}%`,
                  maxWidth: zoomLevel === 1 ? "100%" : "none",
                  maxHeight: zoomLevel === 1 ? "calc(90vh - 80px)" : "none",
                }}
                className="rounded object-contain select-none shadow-xs transition-all duration-150"
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function formatHistoricalTimestamp(dateStr: string): string {
  try {
    const d = new Date(dateStr);
    const month = d.getMonth() + 1;
    const day = d.getDate();
    let hours = d.getHours();
    const minutes = d.getMinutes().toString().padStart(2, "0");
    const ampm = hours >= 12 ? "PM" : "AM";
    hours = hours % 12 || 12;
    return `${month}/${day}, ${hours}:${minutes} ${ampm}`;
  } catch {
    return dateStr;
  }
}
