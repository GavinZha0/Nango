"use client";

/**
 * KbPageDialog — a page's identity: where its path puts it, and where it came
 * from.
 *
 * Deliberately not the whole page. `POST /api/kb/[id]/pages` refuses an empty
 * `content`, so creating here would either write an agent-visible empty page or
 * put a body field in a dialog; instead the dialog hands the identity back and
 * the detail pane opens on the description and the body, which is where the row
 * is actually created. Editing an existing page does write from here, because
 * its body is already on the server and is none of this dialog's business.
 *
 * One field says where a page lives, because a path is both its name and its
 * folder: typing `onboarding/glossary` creates that folder for as long as the
 * page keeps it. There is no format field either — a page is plain text, and
 * `content_type` is a parse hint the service defaults to `text/markdown` that no
 * author is asked to choose.
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
import { encodePathSegments, getParentPath } from "@/lib/paths";
import { pathProblem } from "@/lib/kb/paths";
import { MAX_LABEL_CHARS, MAX_PATH_CHARS } from "@/lib/kb/limits";
import type { KbPageDetail, KbPageSummary } from "@/lib/types/kb";

/** The two fields that say what a page is, apart from what it says. */
export interface KbPageIdentity {
  /** `/`-separated, folder prefixes included. */
  path: string;
  /** Human provenance, never shown to an agent. */
  sourceRef: string;
}

export interface KbPageDialogProps {
  collectionId: string;
  /** Present = edit this page's identity; absent = name a new page. */
  page?: KbPageSummary | undefined;
  /** Create only: the folder the new page's path starts from. */
  defaultFolder?: string;
  /** Create only: so a path already taken is said here, not by a 409. */
  existingPaths: string[];
  onClose: () => void;
  /** `page` is null when nothing was written: the caller starts the body. */
  onConfirmed: (identity: KbPageIdentity, page: KbPageDetail | null) => void;
}

export function KbPageDialog({
  collectionId,
  page,
  defaultFolder = "",
  existingPaths,
  onClose,
  onConfirmed,
}: KbPageDialogProps): ReactNode {
  const openingPath: string =
    page?.path ?? (defaultFolder === "" ? "" : `${defaultFolder}/`);
  const [path, setPath] = useState(openingPath);
  const [sourceRef, setSourceRef] = useState(page?.sourceRef ?? "");
  const [saving, setSaving] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  const trimmedPath = path.trim();
  const identity: KbPageIdentity = {
    path: trimmedPath,
    sourceRef: sourceRef.trim(),
  };
  const taken: boolean =
    trimmedPath !== "" &&
    trimmedPath !== page?.path &&
    existingPaths.includes(trimmedPath);
  const problem: string | null =
    pathProblem(trimmedPath) ?? (taken ? "already exists in this KB" : null);
  const dirty: boolean =
    page === undefined ||
    trimmedPath !== page.path ||
    sourceRef.trim() !== (page.sourceRef ?? "");
  const canSubmit = !saving && trimmedPath !== "" && problem === null && dirty;

  async function handleSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (!canSubmit) return;
    if (page === undefined) {
      onConfirmed(identity, null);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/kb/${collectionId}/pages/${encodePathSegments(page.path)}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            // A move is the same write as a rename, so an unchanged path is not
            // sent at all — it would only re-assert the row's own value.
            ...(trimmedPath === page.path ? {} : { newPath: trimmedPath }),
            // An emptied source is a cleared one, not an empty string.
            sourceRef: identity.sourceRef === "" ? null : identity.sourceRef,
          }),
        },
      );
      const body = (await res.json().catch(() => null)) as
        | (KbPageDetail & { message?: string; error?: string })
        | null;
      if (!res.ok) {
        throw new Error(body?.message ?? body?.error ?? `HTTP ${res.status}`);
      }
      if (!body?.id) throw new Error("The write returned no page row.");
      onConfirmed(identity, body);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  const folder: string = getParentPath(trimmedPath);

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !saving) onClose();
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{page ? "Edit page" : "New page"}</DialogTitle>
        </DialogHeader>

        <form onSubmit={(e) => void handleSubmit(e)} className="space-y-4 py-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="kb-page-path">Path</Label>
            <Input
              id="kb-page-path"
              value={path}
              onChange={(e) => setPath(e.target.value)}
              maxLength={MAX_PATH_CHARS}
              disabled={saving}
              autoFocus
              className="font-mono text-xs"
            />
            <p
              className={cn(
                "text-[11px]",
                trimmedPath === "" || problem
                  ? "text-destructive"
                  : "text-muted-foreground",
              )}
            >
              {trimmedPath === ""
                ? "required"
                : (problem ??
                  `in ${folder === "" ? "the KB root" : folder}`)}
            </p>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="kb-page-source">Source</Label>
            <Input
              id="kb-page-source"
              value={sourceRef}
              onChange={(e) => setSourceRef(e.target.value)}
              maxLength={MAX_LABEL_CHARS}
              disabled={saving}
            />
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
              {page ? "Save" : "Continue"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
