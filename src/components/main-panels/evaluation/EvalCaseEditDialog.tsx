"use client";

/**
 * EvalCaseEditDialog — edit and create dialog for evaluation cases.
 *
 * Fields: name, parent suite selector.
 */

import { useState, type ReactNode } from "react";
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

interface EvalCaseEditDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  evalCase?: EvalCaseRow;
  defaultSuiteId?: string;
  suites: EvalSuiteRow[];
  onSave: (updated: { name: string; suiteId: string }) => void;
}

export function EvalCaseEditDialog({
  open,
  onOpenChange,
  evalCase,
  defaultSuiteId,
  suites,
  onSave,
}: EvalCaseEditDialogProps): ReactNode {
  const [name, setName] = useState(evalCase?.name ?? "");
  const [selectedSuiteId, setSelectedSuiteId] = useState(
    evalCase?.suiteId ?? defaultSuiteId ?? (suites[0]?.id ?? "")
  );

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

        <div className="space-y-4 py-2">
          {/* Name */}
          <div className="flex items-center gap-3">
            <Label htmlFor="case-name" className="w-16 shrink-0 text-xs">Name</Label>
            <Input
              id="case-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Case name"
              className="flex-1 text-xs"
            />
          </div>

          {/* Suite */}
          <div className="flex items-center gap-3">
            <Label className="w-16 shrink-0 text-xs">Suite</Label>
            <div className="flex-1 text-xs">
              <Select value={selectedSuiteId} onValueChange={(val) => setSelectedSuiteId(val ?? "")}>
                <SelectTrigger className="w-full text-xs">
                  <SelectValue placeholder="Select a suite...">
                    {selectedSuiteId ? (
                      suites.find((s) => s.id === selectedSuiteId)?.name ?? "Unknown suite"
                    ) : null}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {suites.map((s) => (
                    <SelectItem key={s.id} value={s.id} label={s.name} className="text-xs">
                      {s.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} className="text-xs">Cancel</Button>
          <Button onClick={handleSave} disabled={!name.trim() || !selectedSuiteId} className="text-xs">Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
