"use client";

import { useState, useEffect, useMemo, useCallback } from "react";
import { Play, Plus, X, ArrowLeft, Loader2, AlertCircle, Save, SquarePen, Trash2, CircleCheck, CircleX, CircleSlash, Copy, Check, ZoomIn, ZoomOut } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
import { WEB_AUTO_ACTIVE_RESOURCE_SCHEMA } from "@/lib/web-auto/schema-spec";
import { useRouter } from "next/navigation";
import useSWR, { mutate } from "swr";
import { toast } from "sonner";
import { NewWebAutoCaseDialog } from "./NewWebAutoCaseDialog";
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

const fetcher = async (url: string) => {
  const res = await fetch(url);
  if (!res.ok) throw new Error("An error occurred while fetching the data.");
  return res.json();
};

function extractWebAutoTargetCase(
  draft: Record<string, unknown>,
  currentCaseId?: string | null,
): Record<string, unknown> {
  if (draft.selectedCase && typeof draft.selectedCase === "object" && !Array.isArray(draft.selectedCase)) {
    return draft.selectedCase as Record<string, unknown>;
  }
  if (draft.case && typeof draft.case === "object" && !Array.isArray(draft.case)) {
    return draft.case as Record<string, unknown>;
  }
  const searchInCases = (casesList: unknown[]): Record<string, unknown> | null => {
    if (!Array.isArray(casesList) || casesList.length === 0) return null;
    if (currentCaseId) {
      const match = casesList.find((c) => (c as Record<string, unknown>)?.id === currentCaseId);
      if (match && typeof match === "object") return match as Record<string, unknown>;
    }
    const first = casesList[0];
    if (first && typeof first === "object") return first as Record<string, unknown>;
    return null;
  };
  if (Array.isArray(draft.cases)) {
    const found = searchInCases(draft.cases);
    if (found) return found;
  }
  if (Array.isArray(draft.suites)) {
    for (const s of draft.suites) {
      if (s && typeof s === "object" && Array.isArray((s as Record<string, unknown>).cases)) {
        const found = searchInCases((s as Record<string, unknown>).cases as unknown[]);
        if (found) return found;
      }
    }
  }
  if (draft.suite && typeof draft.suite === "object" && !Array.isArray(draft.suite)) {
    const s = draft.suite as Record<string, unknown>;
    if (Array.isArray(s.cases)) {
      const found = searchInCases(s.cases);
      if (found) return found;
    }
  }
  return draft;
}

export function WebAutoEditor({ suiteId }: { suiteId: string }) {
  const router = useRouter();
  const { selectedCaseId, setSelectedCaseId, suites } = useWebAutoStore();
  const [activeTab, setActiveTab] = useState<"js" | "llm" | "json">("js");
  const [caseDialogOpen, setCaseDialogOpen] = useState(false);
  const [caseToEdit, setCaseToEdit] = useState<{id: string, name: string} | null>(null);
  const [caseToDelete, setCaseToDelete] = useState<{id: string, name: string} | null>(null);

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
  const { data: cases, isLoading, error } = useSWR<WebAutoCaseRow[]>(
    `/api/web-auto-cases?suiteId=${suiteId}`,
    fetcher
  );

  const selectedCase = cases?.find(c => c.id === selectedCaseId);

  // Editor Draft State
  const [draftScript, setDraftScript] = useState<string>("");
  const [draftDescription, setDraftDescription] = useState<string>("");
  const [inputTab, setInputTab] = useState<"script" | "description">("script");
  const [draftAssertions, setDraftAssertions] = useState<Record<string, unknown>[]>([]);
  const [jsonError, setJsonError] = useState<string | null>(null);
  const [activeSuiteRunId, setActiveSuiteRunId] = useState<string | null>(null);
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
      caseId: string;
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
  const [runOutcome, setRunOutcome] = useState<{
    status: "passed" | "failed" | "errored";
    executionOutput: unknown;
    verdict: {
      deterministic: { passed: boolean; results: Array<{ index: number; ok: boolean; type: string; message?: string; expected?: unknown; actual?: unknown }> };
      llm?: { passed: boolean; score?: number; feedback?: string; expectationResults: Array<{ expectation: string; score: number; feedback: string }> };
      overall: { passed: boolean; reason: string };
    };
    error: { source: string; message: string; details?: unknown } | null;
    durationMs: number;
  } | null>(null);

  // Compute effective outcome (prioritizes historical snapshot when in history view)
  const displayOutcome = useMemo(() => {
    if (inHistoryView) {
      if (!runSnapshot || !selectedCaseId) return null;
      const historyCaseResult = runSnapshot.results.find((r) => r.caseId === selectedCaseId);
      if (!historyCaseResult) return null;
      return {
        status: historyCaseResult.status,
        executionOutput: historyCaseResult.executionOutput,
        verdict: historyCaseResult.verdict,
        error: historyCaseResult.error,
        durationMs: historyCaseResult.durationMs,
      };
    }
    return runOutcome;
  }, [inHistoryView, runSnapshot, selectedCaseId, runOutcome]);

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
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setDraftScript(selectedCase.scriptContent || "");
      setDraftDescription(selectedCase.description || "");
      setDraftAssertions(
        Array.isArray(selectedCase.assertions) ? selectedCase.assertions : []
      );
      setJsonError(null);
    } else {
      setDraftScript("");
      setDraftDescription("");
      setDraftAssertions([]);
      setJsonError(null);
    }
  }, [selectedCase]);

  // Derived state for the specific tabs
  const jsExpressions = useMemo(() => {
    return draftAssertions.filter(a => a.type === "js_expression");
  }, [draftAssertions]);

  const deterministicSpecs = useMemo(() => {
    return draftAssertions.filter(
      (a) => a.type !== "expectation" && a.type !== "llm_expectation",
    );
  }, [draftAssertions]);

  const jsonText = useMemo(() => {
    return JSON.stringify(draftAssertions, null, 2);
  }, [draftAssertions]);

  const handleJsonChange = (val: string) => {
    try {
      const parsed = JSON.parse(val);
      if (Array.isArray(parsed)) {
        setDraftAssertions(parsed);
        setJsonError(null);
      } else {
        setJsonError("Assertions must be a JSON array.");
      }
    } catch (e: unknown) {
      setJsonError(e instanceof Error ? e.message : String(e));
    }
  };

  const updateAssertion = (originalArray: Record<string, unknown>[], idxToUpdate: number, newVal: Record<string, unknown>) => {
    const next = [...originalArray];
    next[idxToUpdate] = newVal;
    setDraftAssertions(next);
  };

  const removeAssertion = (type: string, localIdx: number) => {
    let typeCount = -1;
    const next = draftAssertions.filter(a => {
      if (a.type === type) {
        typeCount++;
        return typeCount !== localIdx;
      }
      return true;
    });
    setDraftAssertions(next);
  };

  const addAssertion = (type: string, baseObj: Record<string, unknown>) => {
    setDraftAssertions([...draftAssertions, { type, ...baseObj }]);
  };

  const isDirty = selectedCase && (
    draftScript !== (selectedCase.scriptContent || "") ||
    draftDescription !== (selectedCase.description || "") ||
    JSON.stringify(draftAssertions) !== JSON.stringify(Array.isArray(selectedCase.assertions) ? selectedCase.assertions : [])
  );

  // Copilot ambient context & draft integration
  const getCurrentData = useCallback(() => {
    return {
      _schema: WEB_AUTO_ACTIVE_RESOURCE_SCHEMA,
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
            description: draftDescription || null,
            scriptContent: draftScript || null,
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
    draftDescription,
    draftScript,
    draftAssertions,
    isDirty,
    displayOutcome,
    inHistoryView,
    selectedRunSeq,
  ]);

  const applyDraft = useCallback((draft: Record<string, unknown>) => {
    const sc = extractWebAutoTargetCase(draft, selectedCase?.id);
    const script = (typeof sc.scriptContent === "string" ? sc.scriptContent : (typeof sc.script === "string" ? sc.script : null));
    if (script !== null) setDraftScript(script);
    if (typeof sc.description === "string") setDraftDescription(sc.description);
    if (Array.isArray(sc.assertions)) setDraftAssertions(sc.assertions);
  }, [selectedCase?.id, setDraftScript, setDraftDescription, setDraftAssertions]);

  const { clearDraftState } = useCopilotDraft({
    resourceType: "web-auto",
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
          scriptContent: draftScript,
          description: draftDescription || null,
          assertions: draftAssertions,
        }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.message || "Failed to save case");
      }
      
      // Trigger SWR revalidation
      await mutate(`/api/web-auto-cases?suiteId=${suiteId}`);
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
        <div className="flex h-full flex-col border-r border-border/60 bg-background overflow-hidden">
          <div className="flex h-8 shrink-0 items-center gap-2 border-b bg-muted/40 px-3">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Test suite
            </h2>
            {cases && cases.length > 0 && (
              <span className="text-[10px] text-muted-foreground">
                ({cases.length})
              </span>
            )}
            <div className="ml-auto flex items-center gap-1">
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6 p-0"
                title="New Case"
                onClick={() => {
                  setCaseToEdit(null);
                  setCaseDialogOpen(true);
                }}
              >
                <Plus className="h-3 w-3" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6 p-0 text-emerald-600 hover:text-emerald-500 hover:bg-emerald-500/10"
                title="Run suite"
                disabled={liveRun.phase === "running" || !cases || cases.length === 0}
                onClick={() => void handleRunSuite()}
              >
                {liveRun.phase === "running" ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <Play className="h-3 w-3 fill-current" />
                )}
              </Button>
            </div>
          </div>
          <div className="flex-1 overflow-y-auto py-1 px-1">
            {isLoading && (
               <div className="p-4 text-center text-xs text-muted-foreground flex justify-center items-center gap-2">
                 <Loader2 className="h-3 w-3 animate-spin" /> Loading cases...
               </div>
            )}
            {error && (
               <div className="p-4 text-center text-xs text-destructive flex justify-center items-center gap-2">
                 <AlertCircle className="h-3 w-3" /> Error loading
               </div>
            )}
            {cases?.map((c) => {
              const liveCase = liveRun.caseResults.get(c.id);
              const isSelected = selectedCaseId === c.id;

              let caseStatus: "passed" | "failed" | "errored" | "running" | null = null;
              let caseDurationMs: number | null = null;

              if (inHistoryView && runSnapshot) {
                const hr = runSnapshot.results.find((r) => r.caseId === c.id);
                if (hr) {
                  caseStatus = hr.status;
                  caseDurationMs = hr.durationMs;
                }
              } else if (liveCase) {
                caseStatus = liveCase.status;
                caseDurationMs = liveCase.durationMs;
              } else if (liveRun.phase === "running") {
                caseStatus = "running";
              }

              return (
                <div 
                  key={c.id}
                  className={`group px-2 py-1.5 text-xs cursor-pointer rounded transition-colors mb-0.5 flex items-center justify-between ${isSelected ? 'bg-accent text-foreground' : 'hover:bg-muted/30 text-muted-foreground'}`}
                  onClick={() => setSelectedCaseId(c.id)}
                >
                  <div className="flex items-center gap-1.5 min-w-0 flex-1 pr-1">
                    {caseStatus === "passed" ? (
                      <CircleCheck className="h-3.5 w-3.5 text-emerald-600 shrink-0" />
                    ) : caseStatus === "failed" ? (
                      <CircleX className="h-3.5 w-3.5 text-destructive shrink-0" />
                    ) : caseStatus === "errored" ? (
                      <AlertCircle className="h-3.5 w-3.5 text-amber-500 shrink-0" />
                    ) : caseStatus === "running" ? (
                      <CircleSlash className="h-3.5 w-3.5 text-muted-foreground/40 shrink-0" />
                    ) : null}
                    <span className="truncate flex-1">{c.name}</span>
                    {caseDurationMs !== null && caseDurationMs > 0 && (
                      <span className="text-[10px] text-muted-foreground font-mono shrink-0">
                        {(caseDurationMs / 1000).toFixed(1)}s
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-0.5 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
                    <button type="button" className="shrink-0 cursor-pointer rounded p-0.5 text-muted-foreground hover:text-foreground transition-colors" title="Edit this case" onClick={(e) => { e.stopPropagation(); setCaseToEdit({ id: c.id, name: c.name }); setCaseDialogOpen(true); }}>
                      <SquarePen className="h-3 w-3" />
                    </button>
                    <button type="button" className="shrink-0 cursor-pointer rounded p-0.5 text-muted-foreground hover:text-destructive transition-colors" title="Delete this case" onClick={(e) => { e.stopPropagation(); setCaseToDelete({ id: c.id, name: c.name }); }}>
                      <Trash2 className="h-3 w-3" />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

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
                  onClick={() => setInputTab("description")}
                  className={`px-3 py-1.5 text-xs font-medium border-b-2 transition-colors ${
                    inputTab === "description"
                      ? "border-primary text-foreground"
                      : "border-transparent text-muted-foreground hover:text-foreground"
                  }`}
                >
                  Description
                </button>
                <div className="ml-auto flex shrink-0 items-center gap-2">
                  <Button 
                    size="sm"
                    variant="ghost" 
                    className={`h-6 w-6 p-0 hover:bg-transparent hover:text-foreground ${isDirty ? "text-amber-500" : "text-muted-foreground"}`}
                    disabled={!isDirty || saving}
                    onClick={handleSave}
                    title="Save"
                  >
                    {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Save className="h-3 w-3" />}
                  </Button>
                  <Button
                    size="sm"
                    className="h-6 px-2 text-xs"
                    disabled={!selectedCase || running}
                    onClick={() => void handleRunCase()}
                  >
                    {running ? (
                      <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />
                    ) : (
                      <Play className="mr-1.5 h-3 w-3 fill-green-500 text-green-500" />
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
                          placeholder="// Write Playwright script (e.g. await page.goto(...))"
                        />
                      ) : (
                        <Textarea
                          className="h-full w-full resize-none text-xs leading-relaxed focus-visible:ring-0 focus-visible:ring-offset-0 border-0 p-0 shadow-none bg-transparent"
                          value={draftDescription}
                          onChange={(e) => setDraftDescription(e.target.value)}
                          placeholder="Describe the test purpose or details..."
                        />
                      )}
                    </div>
                  </div>
                </div>

                <div className="flex flex-col min-h-0 overflow-hidden">
                  <div className="flex h-8 shrink-0 items-center justify-between border-y border-border/60 bg-muted/40 min-w-0">
                    <div className="flex items-center">
                      <button onClick={() => setActiveTab("js")} className={`flex h-8 items-center border-b-2 px-3 text-xs font-medium transition-colors ${activeTab === "js" ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"}`}>JS Expression</button>
                      <button onClick={() => setActiveTab("llm")} className={`flex h-8 items-center border-b-2 px-3 text-xs font-medium transition-colors ${activeTab === "llm" ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"}`}>Expectations</button>
                      <button onClick={() => setActiveTab("json")} className={`flex h-8 items-center border-b-2 px-3 text-xs font-medium transition-colors ${activeTab === "json" ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"}`}>JSON</button>
                    </div>
                  </div>
                  <div className="flex-1 min-h-0 p-3 overflow-y-auto">
                    {!selectedCase ? (
                      <div className="flex h-full items-center justify-center text-xs text-muted-foreground">Select a case to edit assertions</div>
                    ) : activeTab === "js" ? (
                      <div className="space-y-3">
                        <div className="flex items-center justify-between">
                          <Label className="text-[10px] font-semibold text-muted-foreground">
                            • Bindings: <code className="font-semibold text-amber-500">result</code> (script return), <code className="font-semibold text-blue-500">root</code> (full JSON).
                          </Label>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="h-5 px-1.5 text-[9px] gap-1 hover:bg-muted font-semibold"
                            onClick={() => addAssertion("js_expression", { expression: "" })}
                          >
                            <Plus className="h-2.5 w-2.5" /> Add
                          </Button>
                        </div>
                        {jsExpressions.length > 0 && (
                          <div className="space-y-2">
                            {jsExpressions.map((expr, localIdx) => {
                              const globalIdx = draftAssertions.indexOf(expr);
                              return (
                                <div key={globalIdx} className="flex items-center gap-1.5">
                                  <Input
                                    value={(expr.expression as string) || ""}
                                    onChange={(e) => updateAssertion(draftAssertions, globalIdx, { ...expr, expression: e.target.value })}
                                    placeholder="result.success === true"
                                    className="h-7 text-xs flex-1 bg-muted/20 border-muted-foreground/20 focus:border-amber-500/30"
                                  />
                                  <Button
                                    type="button"
                                    variant="ghost"
                                    size="sm"
                                    className="h-7 w-7 p-0 text-muted-foreground/50 hover:text-destructive hover:bg-destructive/10"
                                    onClick={() => removeAssertion("js_expression", localIdx)}
                                  >
                                    <X className="h-3 w-3" />
                                  </Button>
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    ) : activeTab === "llm" ? (
                      <div className="h-full w-full">
                        <textarea
                          className="h-full w-full resize-none rounded-md border bg-background p-2 text-sm leading-relaxed focus:outline-none focus:ring-1 focus:ring-ring"
                          spellCheck={false}
                          value={draftAssertions.find(a => a.type === "llm_expectation")?.expectation as string || ""}
                          onChange={(e) => {
                            const val = e.target.value;
                            const idx = draftAssertions.findIndex(a => a.type === "llm_expectation");
                            if (idx !== -1) {
                              const newAssertions = [...draftAssertions];
                              newAssertions[idx] = { ...newAssertions[idx], expectation: val };
                              setDraftAssertions(newAssertions);
                            } else {
                              setDraftAssertions([...draftAssertions, { type: "llm_expectation", expectation: val }]);
                            }
                          }}
                          placeholder="e.g. The output should contain a login success message..."
                        />
                      </div>
                    ) : (
                      <div className="space-y-3 h-full flex flex-col">
                        <Textarea 
                          className={`flex-1 min-h-[120px] resize-none font-mono text-xs ${jsonError ? 'border-destructive' : 'border-border/60'}`} 
                          value={jsonText}
                          onChange={(e) => handleJsonChange(e.target.value)}
                        />
                        {jsonError && (
                          <p className="text-[10px] text-destructive font-medium">{jsonError}</p>
                        )}
                      </div>
                    )}
                  </div>
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
                          <div className="flex h-full items-center justify-center gap-2 text-xs text-muted-foreground">
                            <Loader2 className="h-4 w-4 animate-spin text-primary" />
                            Executing script & evaluating assertions...
                          </div>
                        ) : displayOutcome ? (
                          <div className="space-y-2">
                            {displayOutcome.error && (
                              <div className="rounded border border-destructive/30 bg-destructive/10 p-2 text-xs text-destructive">
                                <span className="font-semibold">[{displayOutcome.error.source}]</span> {displayOutcome.error.message}
                              </div>
                            )}
                            <pre className="text-xs text-foreground whitespace-pre-wrap break-all leading-relaxed font-mono">
                              {formattedOutputText}
                            </pre>
                          </div>
                        ) : (
                          <pre className="flex-1 text-xs font-mono text-muted-foreground overflow-auto">
                            {`// Run the case to see output...`}
                          </pre>
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
                  <div className="flex h-8 shrink-0 items-center gap-2 border-t border-border/60 bg-muted/40 px-3">
                    <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                      Verdicts
                    </span>
                    {displayOutcome?.verdict && (
                      <span className="text-[10px] text-muted-foreground font-mono">
                        ({displayOutcome.verdict.deterministic.results.length + (displayOutcome.verdict.llm?.expectationResults.length || 0)})
                      </span>
                    )}
                  </div>
                  <div className="min-h-0 flex-1 px-3 pb-2 pt-1 overflow-y-auto">
                    {displayOutcome?.verdict ? (
                      <div className="space-y-2">
                        {/* Deterministic Assertions */}
                        {displayOutcome.verdict.deterministic.results.length === 0 && !displayOutcome.verdict.llm ? (
                          <div className="text-[11px] text-muted-foreground italic pl-1">
                            No assertions — smoke test (passes iff script executes without error).
                          </div>
                        ) : (
                          <ul className="space-y-1">
                            {displayOutcome.verdict.deterministic.results.map((res) => {
                              const spec = deterministicSpecs[res.index] as Record<string, unknown> | undefined;
                              return (
                                <li
                                  key={res.index}
                                  className="flex items-start gap-2 rounded border border-border/60 bg-background/40 px-2 py-1 font-mono text-[11px]"
                                >
                                  <span
                                    className={`shrink-0 font-semibold ${
                                      res.ok
                                        ? "text-emerald-600 dark:text-emerald-400"
                                        : "text-red-600 dark:text-red-400"
                                    }`}
                                  >
                                    {res.ok ? "✓" : "✗"}
                                  </span>
                                  <div className="min-w-0 flex-1">
                                    <div className="flex items-start justify-between gap-2">
                                      <span className="text-muted-foreground break-all">
                                        #{res.index + 1} · {getConditionDescription(res, spec)}
                                      </span>
                                      {!res.ok && res.actual !== undefined && (
                                        <span className="shrink-0 text-red-500/80 dark:text-red-400/80">
                                          ({renderActualValue(res.actual)})
                                        </span>
                                      )}
                                    </div>
                                    {res.message && res.message !== "value mismatch" && (
                                      <p className="break-words text-[10px] text-destructive/80 mt-0.5">{res.message}</p>
                                    )}
                                  </div>
                                </li>
                              );
                            })}
                          </ul>
                        )}

                        {/* LLM Expectations (AI Evaluator) */}
                        {displayOutcome.verdict.llm && displayOutcome.verdict.llm.expectationResults.length > 0 && (
                          <div className="space-y-1 pt-1">
                            {displayOutcome.verdict.llm.feedback && (
                              <div className="rounded border bg-muted/20 p-2 text-xs text-muted-foreground leading-relaxed mb-1.5">
                                <span className="font-semibold text-foreground">AI Feedback: </span>
                                {displayOutcome.verdict.llm.feedback}
                              </div>
                            )}
                            <ul className="space-y-1">
                              {displayOutcome.verdict.llm.expectationResults.map((exp, idx) => {
                                const passed = (exp.score ?? 0) >= 60;
                                return (
                                  <li
                                    key={idx}
                                    className="flex items-start gap-2 rounded border border-border/60 bg-background/40 px-2 py-1 text-[11px]"
                                  >
                                    <span
                                      className={`shrink-0 font-semibold ${
                                        passed
                                          ? "text-emerald-600 dark:text-emerald-400"
                                          : "text-red-600 dark:text-red-400"
                                      }`}
                                    >
                                      {passed ? "✓" : "✗"}
                                    </span>
                                    <div className="min-w-0 flex-1">
                                      <div className="flex items-start justify-between gap-2">
                                        <span className="text-muted-foreground break-all">
                                          Expectation #{idx + 1}: {exp.expectation}
                                        </span>
                                        <span className={`shrink-0 font-mono text-[10px] font-semibold ${passed ? "text-emerald-600" : "text-red-600"}`}>
                                          Score: {exp.score ?? 0}/100
                                        </span>
                                      </div>
                                      {exp.feedback && (
                                        <p className="break-words text-[10px] text-muted-foreground mt-0.5 leading-normal">
                                          {exp.feedback}
                                        </p>
                                      )}
                                    </div>
                                  </li>
                                );
                              })}
                            </ul>
                          </div>
                        )}
                      </div>
                    ) : (
                      <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
                        No verdict
                      </div>
                    )}
                  </div>
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
                  await mutate((key: string) => typeof key === "string" && key.startsWith(`/api/web-auto-cases?suiteId=${suiteId}`));
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

function getConditionDescription(
  verdict: { type: string; path?: string; expected?: unknown },
  spec?: Record<string, unknown>,
): string {
  if (verdict.type === "jsonpath_equals") {
    const path = verdict.path ?? (spec?.path as string) ?? "";
    const expected =
      verdict.expected !== undefined ? verdict.expected : spec?.expected;
    return `${path || "path"} === ${JSON.stringify(expected)}`;
  }

  if (verdict.type === "js_expression") {
    if (spec?.expression && typeof spec.expression === "string") {
      return spec.expression;
    }
    return "js_expression";
  }

  if (verdict.type === "json_schema") {
    if (spec?.schema && typeof spec.schema === "object") {
      const s = spec.schema as {
        type?: string;
        properties?: Record<string, unknown>;
      };
      const typeStr = s.type ? String(s.type) : "object";
      const props =
        s.properties && typeof s.properties === "object"
          ? Object.keys(s.properties)
          : [];
      if (props.length > 0) {
        return `JSON Schema (properties: ${props.join(", ")})`;
      }
      return `JSON Schema (type: ${typeStr})`;
    }
    return "json_schema";
  }

  return verdict.type;
}

function renderActualValue(val: unknown): string {
  if (val === undefined) return "";
  try {
    return JSON.stringify(val);
  } catch {
    return String(val);
  }
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
