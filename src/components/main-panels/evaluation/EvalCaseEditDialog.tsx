"use client";

/**
 * EvalCaseEditDialog — edit and create dialog for evaluation cases.
 *
 * Fields:
 * 1. Suite Name (parent suite selector, displays sibling suites under same agent)
 * 2. Case Name (input)
 */

import { useState, useMemo, type ReactNode } from "react";
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
  onSave: (updated: { name: string; suiteId: string }) => void;
}

export function EvalCaseEditDialog({
  open,
  onOpenChange,
  evalCase,
  defaultSuiteId,
  agentId,
  suites,
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

  const [name, setName] = useState(evalCase?.name ?? "");
  const [selectedSuiteId, setSelectedSuiteId] = useState(
    evalCase?.suiteId ?? defaultSuiteId ?? (suites?.[0]?.id ?? "")
  );

  // Sync state when dialog opens
  const [lastOpen, setLastOpen] = useState<boolean>(open);
  if (open !== lastOpen) {
    setLastOpen(open);
    if (open) {
      setName(evalCase?.name ?? "");
      setSelectedSuiteId(
        evalCase?.suiteId ?? defaultSuiteId ?? (availableSuites[0]?.id ?? suites?.[0]?.id ?? "")
      );
    }
  }

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
              <Select value={selectedSuiteId} onValueChange={(val) => setSelectedSuiteId(val ?? "")}>
                <SelectTrigger id="case-suite" className="w-full text-xs">
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
          <div className="grid grid-cols-[100px_1fr] items-center gap-2">
            <Label htmlFor="case-name" className="text-xs">
              Case Name <span className="text-destructive">*</span>
            </Label>
            <Input
              id="case-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="flex-1 text-xs"
              autoFocus
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} className="text-xs">
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={!name.trim() || !selectedSuiteId} className="text-xs">
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
