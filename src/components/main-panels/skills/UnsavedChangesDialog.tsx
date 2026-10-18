"use client";

/**
 * UnsavedChangesDialog — Save / Ignore gate shown before switching files or
 * opening a file action while the current editor is dirty.
 *
 * Closing via Escape / outside click cancels the switch and keeps editing.
 */

import type { ReactNode } from "react";
import { Loader2 } from "lucide-react";

import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";

export interface UnsavedChangesDialogProps {
  open: boolean;
  fileName: string;
  saving: boolean;
  error: string | null;
  onSave: () => void;
  onIgnore: () => void;
  onCancel: () => void;
}

export function UnsavedChangesDialog({
  open,
  fileName,
  saving,
  error,
  onSave,
  onIgnore,
  onCancel,
}: UnsavedChangesDialogProps): ReactNode {
  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !saving) onCancel();
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Unsaved changes</AlertDialogTitle>
          <AlertDialogDescription>
            <strong>{fileName}</strong> has unsaved changes. Save before
            continuing? Ignoring will discard the current edits.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {error && (
          <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {error}
          </p>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel
            disabled={saving}
            onClick={(e) => {
              e.preventDefault();
              onIgnore();
            }}
          >
            Ignore
          </AlertDialogCancel>
          <Button
            type="button"
            disabled={saving}
            onClick={() => onSave()}
            data-testid="unsaved-save-button"
          >
            {saving && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
            Save
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
