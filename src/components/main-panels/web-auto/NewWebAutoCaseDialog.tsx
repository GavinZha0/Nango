"use client";

import { useState, type ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import useSWR, { mutate } from "swr";

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
import { useWebAutoStore, type WebAutoCaseRow } from "@/store/web-auto-store";
import { computeNextCasePrefix } from "@/lib/testing/case-prefix";

const fetcher = async (url: string) => {
  const res = await fetch(url);
  if (!res.ok) throw new Error("Failed to fetch cases");
  return res.json();
};

export interface NewWebAutoCaseDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  suiteId: string;
  caseToEdit?: { id: number; name: string } | null;
  cases?: Array<{ name: string }>;
}

export function NewWebAutoCaseDialog({
  open,
  onOpenChange,
  suiteId,
  caseToEdit,
  cases,
}: NewWebAutoCaseDialogProps): ReactNode {
  const bumpCaseCount = useWebAutoStore((s) => s.bumpCaseCount);
  const setSelectedCaseId = useWebAutoStore((s) => s.setSelectedCaseId);

  // Fallback fetch if cases prop is not provided by parent
  const { data: fetchedCases } = useSWR<WebAutoCaseRow[]>(
    open && !cases ? `/api/web-auto-suites/${suiteId}/cases` : null,
    fetcher
  );
  const effectiveCases = cases ?? fetchedCases ?? [];

  const [name, setName] = useState<string>(() => {
    if (caseToEdit) return caseToEdit.name;
    return computeNextCasePrefix(effectiveCases);
  });
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Track open and fallback transitions during render
  const [prevOpen, setPrevOpen] = useState(open);
  const [prevCaseToEdit, setPrevCaseToEdit] = useState(caseToEdit);
  const [prevFetchedCases, setPrevFetchedCases] = useState(fetchedCases);

  if (open && !prevOpen) {
    setPrevOpen(true);
    setPrevCaseToEdit(caseToEdit);
    setSubmitError(null);
    if (caseToEdit) {
      setName(caseToEdit.name);
    } else {
      setName(computeNextCasePrefix(effectiveCases));
    }
  } else if (!open && prevOpen) {
    setPrevOpen(false);
  } else if (caseToEdit !== prevCaseToEdit) {
    setPrevCaseToEdit(caseToEdit);
    if (caseToEdit) {
      setName(caseToEdit.name);
    }
  } else if (!cases && fetchedCases !== prevFetchedCases) {
    setPrevFetchedCases(fetchedCases);
    if (!caseToEdit && fetchedCases && fetchedCases.length > 0) {
      if (/^\d+_?$/.test(name.trim()) || name.trim() === "") {
        setName(computeNextCasePrefix(fetchedCases));
      }
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
        await mutate(`/api/web-auto-suites/${suiteId}/cases`);
        toast.success("Updated successfully");
        onOpenChange(false);
        return;
      }

      const res = await fetch(`/api/web-auto-suites/${suiteId}/cases`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: trimmedName,
          input: { script: "", steps: "" },
          assertions: [],
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => null);
        throw new Error(err?.message || "Failed to create case");
      }
      const createdCase = await res.json();

      await mutate(`/api/web-auto-suites/${suiteId}/cases`);
      bumpCaseCount(suiteId, 1);
      setSelectedCaseId(createdCase.id);

      toast.success("Created case", {
        description: `Case "${createdCase.name}"`,
      });

      onOpenChange(false);
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

        <div className="space-y-4 py-3">
          <div className="grid grid-cols-[100px_1fr] items-start gap-2">
            <Label htmlFor="caseName" className="text-xs pt-2.5">
              Case Name <span className="text-destructive">*</span>
            </Label>
            <div className="space-y-1 flex-1">
              <Input
                id="caseName"
                data-testid="web-auto-case-name-input"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="text-xs"
                autoFocus
                disabled={submitting}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && canSubmit) {
                    e.preventDefault();
                    void handleSubmit();
                  }
                }}
              />
              <p className="text-[11px] text-muted-foreground">
                Use 3-digit prefix (e.g. <code>010_login</code>) for ordered serial execution.
              </p>
            </div>
          </div>

          {submitError && (
            <div className="text-xs text-destructive font-medium">{submitError}</div>
          )}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={submitting}
            className="text-xs"
            data-testid="cancel-web-auto-case-button"
          >
            Cancel
          </Button>
          <Button
            onClick={() => void handleSubmit()}
            disabled={!canSubmit}
            className="text-xs"
            data-testid="save-web-auto-case-dialog-button"
          >
            {submitting && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
            {caseToEdit ? "Save" : "Create"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
