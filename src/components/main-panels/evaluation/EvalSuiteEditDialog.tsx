"use client";

/**
 * EvalSuiteEditDialog — edit dialog for an evaluation suite.
 *
 * Fields: name, evaluator agent (Select dropdown, role=evaluator),
 * dimension multi-select grouped by category.
 */

import { useState, useMemo, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
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
import { BUILTIN_DIMENSIONS, DIMENSION_CATEGORIES } from "@/lib/evaluation/types";
import { useWorkspaceStore } from "@/store/workspace";
import type { EvalSuiteRow } from "@/store/evaluation";

interface EvalSuiteEditDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  suite?: EvalSuiteRow;
  onSave: (updated: { name: string; evaluatorAgentId?: string | null; dimensionIds: string[] }) => void;
}

export function EvalSuiteEditDialog({ open, onOpenChange, suite, onSave }: EvalSuiteEditDialogProps): ReactNode {
  const [name, setName] = useState(suite?.name ?? "");
  const builtinAgents = useWorkspaceStore((s) => s.builtinAgents);
  const evaluators = useMemo(
    () => builtinAgents.filter((a) => a.role === "evaluator"),
    [builtinAgents],
  );
  const [selectedEvalId, setSelectedEvalId] = useState(suite?.evaluatorAgentId ?? "");
  const [selectedDims, setSelectedDims] = useState<Set<string>>(new Set(suite?.dimensionIds ?? []));

  function toggleDimension(dimId: string): void {
    setSelectedDims((prev) => {
      const next = new Set(prev);
      if (next.has(dimId)) next.delete(dimId);
      else next.add(dimId);
      return next;
    });
  }

  function handleSave(): void {
    const trimmed = name.trim();
    if (!trimmed) return;
    onSave({
      name: trimmed,
      evaluatorAgentId: selectedEvalId || null,
      dimensionIds: [...selectedDims],
    });
    onOpenChange(false);
  }

  const grouped = DIMENSION_CATEGORIES.map((cat) => ({
    category: cat,
    dimensions: BUILTIN_DIMENSIONS.filter((d) => d.category === cat),
  }));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{suite ? "Edit Suite" : "Create Suite"}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {/* Name */}
          <div className="flex items-center gap-3">
            <Label htmlFor="suite-name" className="w-16 shrink-0 text-xs">Name</Label>
            <Input
              id="suite-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Suite name"
              className="flex-1 text-xs"
            />
          </div>

          {/* Evaluator agent — Select dropdown */}
          <div className="flex items-center gap-3">
            <Label className="w-16 shrink-0 text-xs">Evaluator</Label>
            <div className="flex-1 text-xs">
              <Select
                value={selectedEvalId}
                onValueChange={(v) => setSelectedEvalId(v ?? "")}
              >
              <SelectTrigger className="w-full text-xs">
                <SelectValue placeholder="Select an evaluator agent…">
                  {selectedEvalId ? (() => {
                    const ev = evaluators.find((e) => e.id === selectedEvalId);
                    return ev ? (
                      <span className="flex items-center gap-1.5 text-xs">
                        {ev.icon && <span>{ev.icon}</span>}
                        <span>{ev.name}</span>
                      </span>
                    ) : (
                      "Unknown agent"
                    );
                  })() : null}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {evaluators.map((ev) => (
                  <SelectItem key={ev.id} value={ev.id} label={ev.name} className="text-xs">
                    <span className="flex items-center gap-1.5 text-xs">
                      {ev.icon && <span>{ev.icon}</span>}
                      <span>{ev.name}</span>
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            </div>
          </div>

          {/* Dimensions — grouped by category */}
          <div className="space-y-1.5 text-xs">
            <div className="flex items-center justify-between">
              <Label className="text-xs">Evaluation Dimensions</Label>
              <span className="text-[10px] text-muted-foreground tabular-nums">
                {selectedDims.size} selected
              </span>
            </div>
            <div className="max-h-[300px] overflow-y-auto rounded-md border p-3 space-y-3">
              {grouped.map((group) => (
                <div key={group.category}>
                  <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1.5">
                    {group.category}
                  </p>
                  <div className="space-y-1">
                    {group.dimensions.map((dim) => (
                      <label
                        key={dim.id}
                        className="flex cursor-pointer items-start gap-2 rounded px-1 py-0.5 hover:bg-muted/40"
                      >
                        <Checkbox
                          checked={selectedDims.has(dim.id)}
                          onCheckedChange={() => toggleDimension(dim.id)}
                          className="mt-0.5"
                        />
                        <div className="min-w-0">
                          <p className="text-xs font-medium leading-tight">{dim.name}</p>
                          <p className="text-[10px] text-muted-foreground leading-tight">{dim.description}</p>
                        </div>
                      </label>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} className="text-xs">Cancel</Button>
          <Button onClick={handleSave} disabled={!name.trim() || !selectedEvalId} className="text-xs">Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
