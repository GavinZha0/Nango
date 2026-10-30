"use client";

/**
 * KbFolderDialog — rename a folder, which is the same write as moving it.
 *
 * A folder is a prefix its pages share, so there is nothing to describe and
 * nothing to create here: the field is the prefix's new spelling, and the
 * server rewrites every page under it. That is also why a folder is not a row
 * the detail pane can open — it has no body.
 *
 * See docs/kb.md.
 */

import { useState, type FormEvent, type ReactNode } from "react";
import { Loader2 } from "lucide-react";

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
import { cn } from "@/lib/utils";
import { encodePathSegments } from "@/lib/paths";
import { folderProblem } from "@/lib/kb/paths";
import { MAX_PATH_CHARS } from "@/lib/kb/limits";

export interface KbFolderDialogProps {
  collectionId: string;
  /** The prefix being renamed, exactly as the tree drew it. */
  folder: string;
  /** Pages whose path starts with `folder/` — the rewrite's blast radius. */
  pageCount: number;
  onClose: () => void;
  /** The tree reloads from the caller. */
  onSaved: () => void;
}

export function KbFolderDialog({
  collectionId,
  folder,
  pageCount,
  onClose,
  onSaved,
}: KbFolderDialogProps): ReactNode {
  const [next, setNext] = useState(folder);
  const [saving, setSaving] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  const trimmed = next.trim();
  const problem: string | null = trimmed === folder ? null : folderProblem(trimmed);
  const dirty: boolean = trimmed !== "" && trimmed !== folder;
  const canSubmit: boolean = !saving && dirty && problem === null;

  async function handleSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (!canSubmit) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/kb/${collectionId}/pages/${encodePathSegments(folder)}?kind=folder`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ newPath: trimmed }),
        },
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          message?: string;
          error?: string;
        } | null;
        throw new Error(body?.message ?? body?.error ?? `HTTP ${res.status}`);
      }
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !saving) onClose();
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Rename folder</DialogTitle>
        </DialogHeader>

        <form onSubmit={(e) => void handleSubmit(e)} className="space-y-4 py-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="kb-folder-next">Path</Label>
            <Input
              id="kb-folder-next"
              value={next}
              onChange={(e) => setNext(e.target.value)}
              maxLength={MAX_PATH_CHARS}
              disabled={saving}
              autoFocus
              className="font-mono text-xs"
            />
            <p
              className={cn(
                "text-[11px]",
                problem ? "text-destructive" : "text-muted-foreground",
              )}
            >
              {problem ??
                `Rewrites the path of ${pageCount} page${
                  pageCount === 1 ? "" : "s"
                } under this folder.`}
            </p>
          </div>

          {error && (
            <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {error}
            </p>
          )}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={onClose}
              disabled={saving}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={!canSubmit}>
              {saving && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
              Rename
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
