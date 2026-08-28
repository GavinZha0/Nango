"use client";

import { useState, type ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { mutate } from "swr";

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
import { useWebAutoStore } from "@/store/web-auto-store";

export interface NewWebAutoCaseDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  suiteId: string;
  caseToEdit?: { id: number; name: string } | null;
}

export function NewWebAutoCaseDialog({
  open,
  onOpenChange,
  suiteId,
  caseToEdit,
}: NewWebAutoCaseDialogProps): ReactNode {
  const bumpCaseCount = useWebAutoStore((s) => s.bumpCaseCount);
  const setSelectedCaseId = useWebAutoStore((s) => s.setSelectedCaseId);
  
  const [name, setName] = useState("");
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Initialize form state when editing
  const [lastOpen, setLastOpen] = useState<boolean>(open);
  if (open !== lastOpen) {
    setLastOpen(open);
    if (open) {
      if (caseToEdit) {
        setName(caseToEdit.name);
      } else {
        setName("");
      }
      setSubmitError(null);
    }
  }

  const trimmedName = name.trim();
  const canSubmit = !submitting && trimmedName.length > 0;

  const handleSubmit = async (): Promise<void> => {
    if (!canSubmit) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      if (caseToEdit) {
        // Edit mode
        const res = await fetch(`/api/web-auto-cases/${caseToEdit.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: trimmedName,
          }),
        });
        if (!res.ok) throw new Error("Failed to update case");
        await mutate((key: string) => typeof key === "string" && key.startsWith(`/api/web-auto-cases?suiteId=${suiteId}`));
        toast.success("Updated successfully");
        onOpenChange(false);
        return;
      }

      const res = await fetch("/api/web-auto-cases", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          suiteId,
          name: trimmedName,
          scriptContent: null,
          assertions: [],
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => null);
        throw new Error(err?.message || "Failed to create case");
      }
      const createdCase = await res.json();

      await mutate((key: string) => typeof key === "string" && key.startsWith(`/api/web-auto-cases?suiteId=${suiteId}`));
      bumpCaseCount(suiteId, 1);
      setSelectedCaseId(createdCase.id);
      
      toast.success("Created case", {
        description: `Case "${createdCase.name}"`,
      });

      onOpenChange(false);
      setName("");
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(isOpen) => {
        if (!isOpen && !submitting) {
          onOpenChange(false);
          setName("");
          setSubmitError(null);
        } else if (isOpen) {
          onOpenChange(true);
        }
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{caseToEdit ? "Rename Case" : "New Case"}</DialogTitle>
        </DialogHeader>

        <div className="grid gap-4 py-4">
          <div className="grid grid-cols-[120px_1fr] items-center gap-2">
            <Label htmlFor="caseName" className="text-sm font-semibold">
              Case Name <span className="text-destructive">*</span>
            </Label>
            <Input
              id="caseName"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
              disabled={submitting}
              onKeyDown={(e) => {
                if (e.key === "Enter" && canSubmit) {
                  e.preventDefault();
                  void handleSubmit();
                }
              }}
            />
          </div>

          {submitError && (
            <div className="text-sm text-destructive font-medium">{submitError}</div>
          )}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={submitting}
          >
            Cancel
          </Button>
          <Button onClick={() => void handleSubmit()} disabled={!canSubmit}>
            {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
