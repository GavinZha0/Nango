"use client";

/**
 * KbGroupDialog — create a group, or rename / re-describe / move one.
 *
 * Metadata only, and it writes for itself rather than routing through the
 * editor: a group has no body, so unlike a page there is nothing to author, and
 * a dialog keeps the tree from being interrupted by a half-filled form in the
 * detail pane.
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
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { MAX_DESCRIPTION_CHARS, MAX_LABEL_CHARS, MIN_DESCRIPTION_CHARS } from "@/lib/kb/limits";
import type { KbGroupRow } from "@/lib/types/kb";

/** Sentinel for "no parent" inside a Select, whose value cannot be null. */
const NO_PARENT = "__none__";

export interface KbGroupDialogProps {
  collectionId: string;
  groups: KbGroupRow[];
  /** Present = edit this group; absent = create one. */
  group?: KbGroupRow | undefined;
  onClose: () => void;
  /** The tree reloads from the caller; the row this dialog saved is its own. */
  onSaved: () => void;
}

export function KbGroupDialog({
  collectionId,
  groups,
  group,
  onClose,
  onSaved,
}: KbGroupDialogProps): ReactNode {
  const openingParentId: number | null = group?.parentId ?? null;
  const [name, setName] = useState(group?.name ?? "");
  const [description, setDescription] = useState(group?.description ?? "");
  const [parentId, setParentId] = useState<string>(
    openingParentId === null ? NO_PARENT : String(openingParentId),
  );
  const [saving, setSaving] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  // Level-1 parents only: a third level is refused by the server, so offering
  // one would be a choice the author has to discover by failing. A group is not
  // its own parent, and one that already owns children is pinned at level 1 —
  // moving it down would push its own children to level 3.
  const ownsChildren: boolean =
    group !== undefined && groups.some((g) => g.parentId === group.id);
  const levelOne = groups.filter(
    (g) => g.parentId === null && g.id !== group?.id,
  );

  const trimmedName = name.trim();
  const descLength = description.trim().length;
  const descOk =
    descLength >= MIN_DESCRIPTION_CHARS && descLength <= MAX_DESCRIPTION_CHARS;
  const dirty: boolean =
    group === undefined ||
    trimmedName !== group.name ||
    description.trim() !== (group.description ?? "") ||
    parentId !== (openingParentId === null ? NO_PARENT : String(openingParentId));
  const canSubmit = !saving && trimmedName !== "" && descOk && dirty;

  async function handleSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (!canSubmit) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(
        group
          ? `/api/kb/${collectionId}/groups/${group.id}`
          : `/api/kb/${collectionId}/groups`,
        {
          method: group ? "PATCH" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: trimmedName,
            description: description.trim(),
            parentId: parentId === NO_PARENT ? null : Number(parentId),
          }),
        },
      );
      const body = (await res.json().catch(() => null)) as
        | (KbGroupRow & { message?: string; error?: string })
        | null;
      if (!res.ok) {
        throw new Error(body?.message ?? body?.error ?? `HTTP ${res.status}`);
      }
      if (!body?.id) throw new Error("The write returned no group row.");
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
          <DialogTitle>{group ? "Edit group" : "New group"}</DialogTitle>
        </DialogHeader>

        <form onSubmit={(e) => void handleSubmit(e)} className="space-y-4 py-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="kb-group-name">Name</Label>
            <Input
              id="kb-group-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={MAX_LABEL_CHARS}
              disabled={saving}
              autoFocus
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="kb-group-description">Description</Label>
            <Textarea
              id="kb-group-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={MAX_DESCRIPTION_CHARS}
              rows={3}
              disabled={saving}
              className="resize-none text-xs"
            />
            <p
              className={cn(
                "text-[11px]",
                descOk ? "text-muted-foreground" : "text-destructive",
              )}
            >
              {descLength}/{MAX_DESCRIPTION_CHARS} · at least{" "}
              {MIN_DESCRIPTION_CHARS} characters
            </p>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="kb-group-parent">Parent</Label>
            {ownsChildren ? (
              <p className="text-xs text-muted-foreground">
                Level 1 — this group owns nested groups, so it cannot be moved
                under another one.
              </p>
            ) : (
              <Select
                value={parentId}
                onValueChange={(v) => setParentId(v ?? NO_PARENT)}
                disabled={saving}
              >
                <SelectTrigger id="kb-group-parent" className="w-full">
                  <SelectValue placeholder="Top level">
                    {levelOne.find((g) => String(g.id) === parentId)?.name ??
                      "Top level"}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_PARENT} label="Top level">
                    Top level
                  </SelectItem>
                  {levelOne.map((g) => (
                    <SelectItem key={g.id} value={String(g.id)} label={g.name}>
                      {g.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
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
              {group ? "Save" : "Create"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
