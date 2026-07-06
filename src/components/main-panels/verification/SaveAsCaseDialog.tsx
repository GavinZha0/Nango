"use client";

import { useState, type ReactNode } from "react";
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
import { caseActions } from "@/store/verification-cases";

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
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Reset form whenever the dialog opens.
  const [lastOpen, setLastOpen] = useState<boolean>(open);
  if (open !== lastOpen) {
    setLastOpen(open);
    if (open) {
      setCaseName(toolName);
      setSubmitError(null);
    }
  }

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
        input,
        assertions: [],
      });

      if (!caseRow) {
        throw new Error("Failed to create case");
      }

      toast.success("Saved verification case", {
        description: `Added "${caseRow.name}" to the server regression test suite.`,
      });
      onOpenChange(false);
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Save as verification case</DialogTitle>
        </DialogHeader>

        <div className="space-y-3 py-2">
          {/* Server (read-only) */}
          <div className="grid grid-cols-[120px_1fr] items-center gap-2">
            <Label className="text-muted-foreground">Server</Label>
            <span className="truncate text-sm font-mono">{serverName}</span>
          </div>

          {/* Tool (read-only) */}
          <div className="grid grid-cols-[120px_1fr] items-center gap-2">
            <Label className="text-muted-foreground">Tool</Label>
            <span className="truncate text-sm font-mono">{toolName}</span>
          </div>

          {/* Case name */}
          <div className="grid grid-cols-[120px_1fr] items-center gap-2">
            <Label htmlFor="save-case-name">
              Case name <span className="text-destructive">*</span>
            </Label>
            <Input
              id="save-case-name"
              value={caseName}
              onChange={(e) => setCaseName(e.target.value)}
              placeholder="e.g. search returns at least one hit"
              autoFocus
            />
          </div>

          <p className="text-[11px] text-muted-foreground">
            Captures the input you just ran. Edit assertions later in the
            verification panel.
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
