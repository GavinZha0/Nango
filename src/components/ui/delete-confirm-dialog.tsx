"use client";

/**
 * DeleteConfirmDialog — shared destructive-action confirmation dialog.
 *
 * Extracted from BuiltinAgentEditor / SkillEditor / DataSourceEditor /
 * SshServerEditor where the pattern was duplicated verbatim.
 */

import type { ReactNode } from "react";
import { Loader2, Trash2 } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

interface DeleteConfirmDialogProps {
  /** Dialog title, e.g. "Delete agent". */
  title: string;
  /** Descriptive text shown below the title. Supports JSX (e.g. <strong>). */
  description: ReactNode;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Fires when the user clicks the destructive "Delete" button. */
  onConfirm: () => void;
  /** Shows spinner + disables buttons while the delete request is in flight. */
  deleting: boolean;
}

export function DeleteConfirmDialog({
  title,
  description,
  open,
  onOpenChange,
  onConfirm,
  deleting,
}: DeleteConfirmDialogProps) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={(e) => {
              e.preventDefault();
              onConfirm();
            }}
            disabled={deleting}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            {deleting ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Trash2 className="h-3.5 w-3.5" />
            )}
            Delete
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
