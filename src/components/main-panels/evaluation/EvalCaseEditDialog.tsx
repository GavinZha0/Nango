"use client";

/**
 * EvalCaseEditDialog — edit and create dialog for evaluation cases.
 *
 * Fields:
 * 1. Suite Name (parent suite selector, displays sibling suites under same agent)
 * 2. Case Name (input with auto-computed 3-digit serial prefix)
 */

import { useState, useMemo, useEffect, type ReactNode } from "react";
import useSWR from "swr";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { EvalSuiteRow, EvalCaseRow } from "@/store/evaluation";
import { useEvalCasesStore, evalCaseActions } from "@/store/evaluation-cases";
import { computeNextCasePrefix } from "@/lib/testing/case-prefix";

const fetcher = async (url: string) => {
  const res = await fetch(url);
  if (!res.ok) throw new Error("Failed to fetch suites");
  return res.json();
};

interface EvalCaseEditDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  evalCase?: EvalCaseRow;
  defaultSuiteId?: string;
  agentId?: string;
  suites?: EvalSuiteRow[];
  cases?: Array<{ name: string }>;
  onSave: (updated: { name: string; suiteId: string }) => void;
}

export function EvalCaseEditDialog({
  open,
  onOpenChange,
  evalCase,
  defaultSuiteId,
  agentId,
  suites,
  cases,
  onSave,
}: EvalCaseEditDialogProps): ReactNode {
  const { data: fetchedSuites = [] } = useSWR<EvalSuiteRow[]>(
    open ? (agentId ? `/api/eval-suites?agentId=${agentId}` : "/api/eval-suites") : null,
    fetcher
  );

  const availableSuites = useMemo(() => {
    if (fetchedSuites.length > 0) return fetchedSuites;
    if (suites && suites.length > 0) return suites;
    return [];
  }, [fetchedSuites, suites]);

  const initialSuiteId =
    evalCase?.suiteId ?? defaultSuiteId ?? (suites?.[0]?.id ?? "");

  const [selectedSuiteId, setSelectedSuiteId] = useState(initialSuiteId);

  const [name, setName] = useState<string>(() => {
    if (evalCase) return evalCase.name;
    const existing =
      cases ??
      (initialSuiteId ? useEvalCasesStore.getState().bySuite[initialSuiteId] : undefined) ??
      [];
    return computeNextCasePrefix(existing);
  });

  // Track props transition for controlled open changes without unmounting
  const [prevOpen, setPrevOpen] = useState(open);
  const [prevEvalCase, setPrevEvalCase] = useState(evalCase);

  if (open && !prevOpen) {
    setPrevOpen(true);
    setPrevEvalCase(evalCase);
    const targetId = evalCase?.suiteId ?? defaultSuiteId ?? (suites?.[0]?.id ?? "");
    setSelectedSuiteId(targetId);
    if (evalCase) {
      setName(evalCase.name);
    } else {
      const existing =
        (targetId === defaultSuiteId ? cases : undefined) ??
        (targetId ? useEvalCasesStore.getState().bySuite[targetId] : undefined) ??
        [];
      setName(computeNextCasePrefix(existing));
    }
  } else if (!open && prevOpen) {
    setPrevOpen(false);
  } else if (evalCase !== prevEvalCase) {
    setPrevEvalCase(evalCase);
    if (evalCase) {
      setSelectedSuiteId(evalCase.suiteId);
      setName(evalCase.name);
    }
  }


  // Asynchronously resolve prefix on cache miss for selected suite
  useEffect(() => {
    if (evalCase || !selectedSuiteId) return;
    const existing =
      (selectedSuiteId === defaultSuiteId ? cases : undefined) ??
      useEvalCasesStore.getState().bySuite[selectedSuiteId];
    if (existing === undefined) {
      void evalCaseActions.refresh(selectedSuiteId).then(() => {
        const fresh = useEvalCasesStore.getState().bySuite[selectedSuiteId] ?? [];
        const freshPrefix = computeNextCasePrefix(fresh);
        setName((prev) =>
          /^\d+_?$/.test(prev.trim()) || prev.trim() === "" ? freshPrefix : prev
        );
      });
    }
  }, [evalCase, selectedSuiteId, defaultSuiteId, cases]);

  function handleSave(): void {
    const trimmed = name.trim();
    if (!trimmed || !selectedSuiteId) return;
    onSave({
      name: trimmed,
      suiteId: selectedSuiteId,
    });
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{evalCase ? "Edit Case" : "Add Case"}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-3">
          {/* 1. Suite Name */}
          <div className="grid grid-cols-[100px_1fr] items-center gap-2">
            <Label htmlFor="case-suite" className="text-xs">
              Suite Name <span className="text-destructive">*</span>
            </Label>
            <div className="flex-1 text-xs">
              <Select
                value={selectedSuiteId}
                onValueChange={(val) => {
                  const nextSuiteId = val ?? "";
                  setSelectedSuiteId(nextSuiteId);
                  if (!evalCase) {
                    const existing =
                      (nextSuiteId === defaultSuiteId ? cases : undefined) ??
                      (nextSuiteId ? useEvalCasesStore.getState().bySuite[nextSuiteId] : undefined);
                    setName((prev) => {
                      if (/^\d+_?$/.test(prev.trim()) || prev.trim() === "") {
                        return computeNextCasePrefix(existing ?? []);
                      }
                      return prev;
                    });

                    if (nextSuiteId && existing === undefined) {
                      void evalCaseActions.refresh(nextSuiteId).then(() => {
                        const fresh = useEvalCasesStore.getState().bySuite[nextSuiteId] ?? [];
                        const freshPrefix = computeNextCasePrefix(fresh);
                        setName((prev) =>
                          /^\d+_?$/.test(prev.trim()) || prev.trim() === "" ? freshPrefix : prev
                        );
                      });
                    }
                  }
                }}
              >
                <SelectTrigger id="case-suite" data-testid="eval-case-suite-select" className="w-full text-xs">
                  <SelectValue placeholder="Select a suite...">
                    {selectedSuiteId ? (
                      availableSuites.find((s) => s.id === selectedSuiteId)?.name ?? "Unknown suite"
                    ) : null}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {availableSuites.map((s) => (
                    <SelectItem key={s.id} value={s.id} label={s.name} className="text-xs">
                      {s.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* 2. Case Name */}
          <div className="grid grid-cols-[100px_1fr] items-start gap-2">
            <Label htmlFor="case-name" className="text-xs pt-2.5">
              Case Name <span className="text-destructive">*</span>
            </Label>
            <div className="space-y-1 flex-1">
              <Input
                id="case-name"
                data-testid="eval-case-name-input"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="text-xs"
                autoFocus
              />
              <p className="text-[11px] text-muted-foreground">
                Use 3-digit prefix (e.g. <code>010_greeting</code>) for ordered serial execution.
              </p>
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            className="text-xs"
            data-testid="cancel-eval-case-button"
          >
            Cancel
          </Button>
          <Button
            onClick={handleSave}
            disabled={!name.trim() || !selectedSuiteId}
            className="text-xs"
            data-testid="save-eval-case-dialog-button"
          >
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
