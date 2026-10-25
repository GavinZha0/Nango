"use client";

/**
 * KbPageDialog — a page's identity: which group it sits in, its name, and where
 * it came from.
 *
 * Deliberately not the whole page. `POST /api/kb/[id]/pages` refuses an empty
 * `content`, so creating here would either write an agent-visible empty page or
 * put a body field in a dialog; instead the dialog hands the identity back and
 * the detail pane opens on the description and the body, which is where the row
 * is actually created. Editing an existing page does write from here, because
 * its body is already on the server and is none of this dialog's business.
 *
 * There is no format field. A page is plain text; `content_type` is a parse hint
 * the service defaults to `text/markdown` and no author is asked to choose it.
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { MAX_LABEL_CHARS } from "@/lib/kb/limits";
import type { KbGroupRow, KbPageDetail, KbPageSummary } from "@/lib/types/kb";

/** Sentinel for "no group" inside a Select, whose value cannot be null. */
const NO_GROUP = "__none__";

/**
 * How a group is spelled in the Group list. A nested one is prefixed so the
 * two levels read apart; the same string is the option's `label`, which is
 * what Base UI's Select shows once closed.
 */
function groupOptionLabel(group: KbGroupRow): string {
  return group.parentId === null ? group.name : `— ${group.name}`;
}

/** The three fields that say what a page is, apart from what it says. */
export interface KbPageIdentity {
  name: string;
  /** The containing group; `null` = Top level. */
  groupId: number | null;
  /** Human provenance, never shown to an agent. */
  sourceRef: string;
}

export interface KbPageDialogProps {
  collectionId: string;
  groups: KbGroupRow[];
  /** Present = edit this page's identity; absent = name a new page. */
  page?: KbPageSummary | undefined;
  /** Create only: which group the new page lands in; `null` = Top level. */
  defaultGroupId?: number | null;
  onClose: () => void;
  /** `page` is null when nothing was written: the caller starts the body. */
  onConfirmed: (identity: KbPageIdentity, page: KbPageDetail | null) => void;
}

export function KbPageDialog({
  collectionId,
  groups,
  page,
  defaultGroupId = null,
  onClose,
  onConfirmed,
}: KbPageDialogProps): ReactNode {
  const openingGroupId: number | null = page?.groupId ?? defaultGroupId;
  const [name, setName] = useState(page?.name ?? "");
  const [sourceRef, setSourceRef] = useState(page?.sourceRef ?? "");
  const [groupId, setGroupId] = useState<string>(
    openingGroupId === null ? NO_GROUP : String(openingGroupId),
  );
  const [saving, setSaving] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  const trimmedName = name.trim();
  const identity: KbPageIdentity = {
    name: trimmedName,
    groupId: groupId === NO_GROUP ? null : Number(groupId),
    sourceRef: sourceRef.trim(),
  };
  const dirty: boolean =
    page === undefined ||
    trimmedName !== page.name ||
    sourceRef.trim() !== (page.sourceRef ?? "") ||
    identity.groupId !== page.groupId;
  const canSubmit = !saving && trimmedName !== "" && dirty;

  const chosenGroup: KbGroupRow | undefined = groups.find(
    (g) => g.id === identity.groupId,
  );
  const selectedGroupLabel: string = chosenGroup
    ? groupOptionLabel(chosenGroup)
    : "Top level";

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
        `/api/kb/${collectionId}/pages/${page.id}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: identity.name,
            groupId: identity.groupId,
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
            <Label htmlFor="kb-page-group">Group</Label>
            <Select
              value={groupId}
              onValueChange={(v) => setGroupId(v ?? NO_GROUP)}
              disabled={saving}
            >
              <SelectTrigger id="kb-page-group" className="w-full">
                <SelectValue placeholder="Top level">
                  {selectedGroupLabel}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_GROUP} label="Top level">
                  Top level
                </SelectItem>
                {groups.map((g) => (
                  <SelectItem
                    key={g.id}
                    value={String(g.id)}
                    label={groupOptionLabel(g)}
                  >
                    {groupOptionLabel(g)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="kb-page-name">Name</Label>
            <Input
              id="kb-page-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={MAX_LABEL_CHARS}
              disabled={saving}
              autoFocus
            />
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
