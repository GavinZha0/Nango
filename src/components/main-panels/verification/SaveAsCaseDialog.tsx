"use client";

import { useEffect, useState, type ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

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
import {
  caseActions,
  useCasesStore,
  type VerificationCaseRow,
} from "@/store/verification-cases";
import { computeNextCasePrefix } from "@/lib/verification/prefix";

export interface SaveAsCaseDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** UUID of the MCP server whose tool was just executed. */
  mcpServerId: string;
  /** Display name of the server, shown read-only in the dialog. */
  serverName: string;
  /** Tool name (string identifier on the server). */
  toolName: string;
  /** Args passed to the just-completed tool call. Saved verbatim as
   *  `verification_case.input`. */
  input: Record<string, unknown>;
}

export function SaveAsCaseDialog({
  open,
  onOpenChange,
  mcpServerId,
  serverName,
  toolName,
  input,
}: SaveAsCaseDialogProps): ReactNode {
  // Form state — reset on each open.
  const [caseName, setCaseName] = useState<string>("");
  const [draftSuiteId, setDraftSuiteId] = useState<string | undefined>(undefined);
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Reset form whenever the dialog opens.
  const [lastOpen, setLastOpen] = useState<boolean>(open);
  if (open !== lastOpen) {
    setLastOpen(open);
    if (open) {
      setCaseName(`010_${toolName}`);
      setDraftSuiteId(undefined);
      setSubmitError(null);
    }
  }

  useEffect(() => {
    if (!open) return;
    let cancelled = false;

    async function resolveDraftsPrefix(): Promise<void> {
      try {
        const res = await fetch("/api/verification-suites");
        if (!res.ok || cancelled) return;
        const suites = (await res.json()) as Array<{
          id: string;
          name: string;
          mcpServerId?: string | null;
        }>;
        const targetDraftName = `Drafts (${serverName})`;
        const draft = suites.find(
          (s) =>
            s.mcpServerId === mcpServerId &&
            (s.name === targetDraftName || s.name === "Drafts"),
        );
        if (!draft || cancelled) return;

        setDraftSuiteId(draft.id);

        // Check cache first for instant feedback
        const cached = useCasesStore.getState().bySuite[draft.id];
        if (cached && !cancelled) {
          const prefix = computeNextCasePrefix(cached);
          setCaseName(`${prefix}${toolName}`);
        }

        // Fetch fresh cases for this Drafts suite to guarantee accurate step ordering
        const casesRes = await fetch(`/api/verification-suites/${draft.id}/cases`);
        if (!casesRes.ok || cancelled) return;
        const cases = (await casesRes.json()) as VerificationCaseRow[];
        if (cancelled) return;

        useCasesStore.getState().setItemsFor(draft.id, cases);
        const freshPrefix = computeNextCasePrefix(cases);
        setCaseName((prev) => {
          // If user hasn't typed a completely custom name, update with fresh prefix
          if (/^\d{3}_/.test(prev) || prev === "") {
            return `${freshPrefix}${toolName}`;
          }
          return prev;
        });
      } catch (err) {
        console.error("Failed to resolve Drafts suite prefix", err);
      }
    }

    void resolveDraftsPrefix();

    return () => {
      cancelled = true;
    };
  }, [open, mcpServerId, serverName, toolName]);

  const trimmedCaseName: string = caseName.trim();
  const canSubmit: boolean = !submitting && trimmedCaseName.length > 0;

  const handleSubmit = async (): Promise<void> => {
    if (!canSubmit) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const caseRow = await caseActions.create({
        name: trimmedCaseName,
        mcpServerId,
        toolName,
        suiteId: draftSuiteId,
        input,
        assertions: [],
      });

      if (!caseRow) {
        throw new Error("Failed to create case");
      }

      toast.success(`Saved to Drafts (${serverName})`);
      onOpenChange(false);
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Save as verification case</DialogTitle>
        </DialogHeader>

        <div className="space-y-3 py-2">
          {/* Server (read-only) */}
          <div className="grid grid-cols-[100px_1fr] items-center gap-2">
            <Label className="text-muted-foreground">Server</Label>
            <div className="truncate text-xs font-mono bg-muted/40 border rounded-md px-2.5 py-1.5 text-foreground">
              {serverName}
            </div>
          </div>

          {/* Tool (read-only) */}
          <div className="grid grid-cols-[100px_1fr] items-center gap-2">
            <Label className="text-muted-foreground">Tool</Label>
            <div
              className="break-all text-xs font-mono bg-muted/40 border rounded-md px-2.5 py-1.5 text-foreground select-text"
              title={toolName}
            >
              {toolName}
            </div>
          </div>

          {/* Case name */}
          <div className="grid grid-cols-[100px_1fr] items-center gap-2">
            <Label htmlFor="save-case-name">
              Case name <span className="text-destructive">*</span>
            </Label>
            <Input
              id="save-case-name"
              value={caseName}
              onChange={(e) => setCaseName(e.target.value)}
              autoFocus
            />
          </div>

          <p className="text-[11px] text-muted-foreground">
            Saves to Drafts ({serverName}) under Ungrouped. You can review and add assertions in the
            Verification panel before moving to a suite.
          </p>

          {submitError && (
            <p className="text-xs text-destructive">
              {submitError}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={submitting}
          >
            Cancel
          </Button>
          <Button
            type="button"
            onClick={() => void handleSubmit()}
            disabled={!canSubmit}
          >
            {submitting && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
