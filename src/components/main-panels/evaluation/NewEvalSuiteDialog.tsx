"use client";

import { useState, useMemo, type ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
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
import { evalActions, type EvalSuiteRow } from "@/store/evaluation";

export interface NewEvalSuiteDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultAgentId?: string;
  defaultAgentSource?: "builtin" | "backend";
  defaultCredentialId?: string | null;
  onCreated?: (created: EvalSuiteRow) => void;
}

export function NewEvalSuiteDialog({
  open,
  onOpenChange,
  defaultAgentId,
  defaultAgentSource = "builtin",
  defaultCredentialId,
  onCreated,
}: NewEvalSuiteDialogProps): ReactNode {
  const builtinAgents = useWorkspaceStore((s) => s.builtinAgents);
  const evaluators = useMemo(
    () => builtinAgents.filter((a) => a.role === "evaluator"),
    [builtinAgents],
  );

  const candidateAgents = useMemo(
    () => builtinAgents.filter((a) => a.role !== "evaluator"),
    [builtinAgents],
  );

  const [name, setName] = useState<string>("");
  const [selectedAgentId, setSelectedAgentId] = useState<string>(defaultAgentId ?? "");
  const [selectedEvalId, setSelectedEvalId] = useState<string>("");
  const [selectedDims, setSelectedDims] = useState<Set<string>>(
    new Set(["groundedness", "task_completion"]),
  );
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  // Reset form when dialog opens
  const [lastOpen, setLastOpen] = useState<boolean>(open);
  if (open !== lastOpen) {
    setLastOpen(open);
    if (open) {
      setName("");
      setSelectedAgentId(defaultAgentId ?? (candidateAgents[0]?.id ?? ""));
      setSelectedEvalId(evaluators[0]?.id ?? "");
      setSelectedDims(new Set(["groundedness", "task_completion"]));
      setError(null);
    }
  }

  const grouped = useMemo(() => {
    return DIMENSION_CATEGORIES.map((cat) => ({
      category: cat,
      dimensions: BUILTIN_DIMENSIONS.filter((d) => d.category === cat),
    }));
  }, []);

  function toggleDimension(dimId: string): void {
    setSelectedDims((prev) => {
      const next = new Set(prev);
      if (next.has(dimId)) next.delete(dimId);
      else next.add(dimId);
      return next;
    });
  }

  const handleSave = async (): Promise<void> => {
    const trimmed = name.trim();
    if (!trimmed) {
      setError("Please provide a suite name.");
      return;
    }
    if (!selectedAgentId) {
      setError("Please select a target agent.");
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      const created = await evalActions.create({
        agentId: selectedAgentId,
        agentSource: defaultAgentSource,
        credentialId: defaultCredentialId ?? null,
        name: trimmed,
        evaluatorAgentId: selectedEvalId ? selectedEvalId : null,
        dimensionIds: Array.from(selectedDims),
      });

      if (created) {
        toast.success("Evaluation suite created");
        onCreated?.(created);
        onOpenChange(false);
      } else {
        setError("Failed to create evaluation suite");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md max-h-[85vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>New Suite</DialogTitle>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto space-y-4 py-2 pr-1">
          {error && (
            <p className="rounded border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {error}
            </p>
          )}

          {/* Target Agent */}
          <div className="space-y-1.5">
            <Label htmlFor="target-agent">Target Agent <span className="text-destructive">*</span></Label>
            <Select
              required
              value={selectedAgentId}
              onValueChange={(val) => setSelectedAgentId(val ?? "")}
              disabled={submitting || !!defaultAgentId}
            >
              <SelectTrigger id="target-agent" className="w-full">
                <SelectValue placeholder="Select target agent">
                  {selectedAgentId ? (
                    candidateAgents.find((a) => a.id === selectedAgentId)?.name || "Unknown agent"
                  ) : null}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {candidateAgents.map((a) => (
                  <SelectItem key={a.id} value={a.id} label={a.name}>
                    {a.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Suite Name */}
          <div className="space-y-1.5">
            <Label htmlFor="eval-suite-name">Suite Name <span className="text-destructive">*</span></Label>
            <Input
              id="eval-suite-name"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={submitting}
              autoFocus
            />
          </div>

          {/* Evaluator Agent */}
          <div className="space-y-1.5">
            <Label htmlFor="eval-agent">Evaluator <span className="text-destructive">*</span></Label>
            <Select
              required
              value={selectedEvalId || "__none__"}
              onValueChange={(val) => setSelectedEvalId(val === "__none__" ? "" : (val ?? ""))}
              disabled={submitting}
            >
              <SelectTrigger id="eval-agent" className="w-full">
                <SelectValue placeholder="Select evaluator agent">
                  {selectedEvalId === "" || selectedEvalId === "__none__" ? (
                    "Default (Platform System Evaluator)"
                  ) : (
                    evaluators.find((a) => a.id === selectedEvalId)?.name || "Unknown evaluator"
                  )}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {evaluators.map((a) => (
                  <SelectItem key={a.id} value={a.id} label={a.name}>
                    {a.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Evaluation Dimensions */}
          <div className="space-y-2">
            <Label>Evaluation Dimensions</Label>
            <div className="max-h-[220px] overflow-y-auto rounded-md border p-2.5 space-y-3">
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
                          disabled={submitting}
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

        <DialogFooter className="pt-2 border-t">
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={submitting}
          >
            Cancel
          </Button>
          <Button type="button" onClick={() => void handleSave()} disabled={submitting || !name.trim()}>
            {submitting ? (
              <>
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> Saving…
              </>
            ) : (
              "Save"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
