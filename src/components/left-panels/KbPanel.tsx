"use client";

/**
 * KbPanel — knowledge-collection list in the left sidebar.
 *
 * One row per collection: the slug, how many pages an agent could read from it,
 * and the two shared-state toggles. Creating a collection is a two-field dialog
 * rather than a `/kb/new` route because an empty collection has nothing to
 * edit — the editor only becomes meaningful once a group or page exists. That
 * same dialog is the only place a collection's name and description are edited:
 * the editor has no row for the corpus it shows.
 *
 * See docs/kb.md.
 */

import {
  Globe,
  Lock,
  Pencil,
  Plus,
  RefreshCw,
  ToggleLeft,
  ToggleRight,
  Loader2,
} from "lucide-react";
import {
  type ReactNode,
  useState,
  type FormEvent,
} from "react";
import { useRouter, usePathname } from "next/navigation";
import useSWR from "swr";

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
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";
import { useResourcePermissions } from "@/hooks/useResourcePermissions";
import { cn } from "@/lib/utils";
import { KB_COLLECTION_NAME_RE } from "@/lib/kb/validation";
import { MAX_DESCRIPTION_CHARS, MIN_DESCRIPTION_CHARS } from "@/lib/kb/limits";
import {
  kbTopTally,
  type KbCollectionListItem,
  type KbCollectionRow,
} from "@/lib/types/kb";

/** Shared so the editor route can invalidate the panel's list cache. */
export const KB_LIST_KEY = "/api/kb";

const fetcher = (url: string) =>
  fetch(url).then((res) => {
    if (!res.ok) throw new Error("Failed to load knowledge collections");
    return res.json();
  });

// Collection row

interface KbItemProps {
  row: KbCollectionListItem;
  /** True when the route is /kb/<row.id> — the editor owns that collection. */
  active: boolean;
  onOpen: (row: KbCollectionListItem) => void;
  onEdit: (row: KbCollectionListItem) => void;
  onPatch: (
    row: KbCollectionListItem,
    patch: Partial<KbCollectionListItem>,
  ) => Promise<void>;
}

/**
 * Delete is deliberately absent here, as in SkillsPanel: destructive actions
 * live beside Save in the editor so a scroll gesture cannot destroy a corpus.
 */
function KbItem({ row, active, onOpen, onEdit, onPatch }: KbItemProps): ReactNode {
  const isPublic: boolean = row.visibility === "public";
  const { canEdit, canChangeVisibility } = useResourcePermissions({
    visibility: row.visibility as "private" | "public",
    createdBy: row.createdBy,
  });
  /** The editor header prints the same helper's answer for this collection. */
  const tally: number = kbTopTally({
    groups: row.topLevelGroupCount,
    pages: row.pageCount,
  });

  return (
    <div
      className={cn(
        "flex flex-col gap-0.5 border-b border-border/70 last:border-0 px-3 py-2 transition-colors",
        active ? "bg-accent" : "hover:bg-muted/30",
        !row.enabled && "opacity-50",
      )}
    >
      <div className="flex items-center gap-2">
        <div className="flex min-w-0 flex-1 items-baseline gap-1.5">
          <button
            type="button"
            onClick={() => onOpen(row)}
            className="cursor-pointer truncate text-left text-base font-medium hover:underline underline-offset-2"
            aria-label={canEdit ? `Edit ${row.name}` : `View ${row.name}`}
          >
            {row.name}
          </button>
          {/* Outside the button so a truncated slug still shows its size. */}
          <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
            ({tally})
          </span>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {/* Absent rather than disabled: reading the corpus needs no grant,
              but the name and description do. */}
          {canEdit && (
            <button
              type="button"
              onClick={() => onEdit(row)}
              className="cursor-pointer rounded p-0.5 text-muted-foreground/70 hover:text-foreground"
              aria-label={`Edit ${row.name}`}
            >
              <Pencil className="h-3.5 w-3.5" />
            </button>
          )}

          {canChangeVisibility ? (
            <button
              type="button"
              onClick={() => void onPatch(row, { visibility: isPublic ? "private" : "public" })}
              className="cursor-pointer rounded p-0.5 text-muted-foreground/70 hover:text-foreground"
              aria-label={isPublic ? "Set to private" : "Set to public"}
            >
              {isPublic ? <Globe className="h-3.5 w-3.5" /> : <Lock className="h-3.5 w-3.5" />}
            </button>
          ) : (
            <span
              className="p-0.5 text-muted-foreground/70"
              aria-label={isPublic ? "Public collection" : "Private collection"}
            >
              {isPublic ? <Globe className="h-3.5 w-3.5" /> : <Lock className="h-3.5 w-3.5" />}
            </span>
          )}

          {canChangeVisibility ? (
            <button
              type="button"
              onClick={() => void onPatch(row, { enabled: !row.enabled })}
              className="cursor-pointer rounded p-0.5 hover:text-foreground"
              aria-label={row.enabled ? "Disable collection" : "Enable collection"}
            >
              {row.enabled ? (
                <ToggleRight className="h-3.5 w-3.5 text-emerald-500" />
              ) : (
                <ToggleLeft className="h-3.5 w-3.5 text-muted-foreground/40" />
              )}
            </button>
          ) : (
            <span className="p-0.5">
              {row.enabled ? (
                <ToggleRight className="h-3.5 w-3.5 text-emerald-500" />
              ) : (
                <ToggleLeft className="h-3.5 w-3.5 text-muted-foreground/40" />
              )}
            </span>
          )}
        </div>
      </div>

      {row.description && (
        <p className="line-clamp-2 text-xs text-muted-foreground">
          {row.description}
        </p>
      )}
    </div>
  );
}

// Create / edit dialog

interface CollectionDialogProps {
  /** Present = edit this collection's metadata; absent = create one. */
  row?: KbCollectionListItem | undefined;
  onClose: () => void;
  /** Receives the id and whether it is new — only a new one is navigated to. */
  onSaved: (id: string, created: boolean) => void;
}

function CollectionDialog({
  row,
  onClose,
  onSaved,
}: CollectionDialogProps): ReactNode {
  const [name, setName] = useState(row?.name ?? "");
  const [description, setDescription] = useState(row?.description ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trimmedName = name.trim();
  const nameOk = KB_COLLECTION_NAME_RE.test(trimmedName);
  const descOk =
    description.trim().length >= MIN_DESCRIPTION_CHARS &&
    description.trim().length <= MAX_DESCRIPTION_CHARS;

  async function handleSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (!nameOk || !descOk) {
      setError(
        !nameOk
          ? "name must start with a-z and contain only [a-z0-9_-] (max 63 chars)"
          : `description must be ${MIN_DESCRIPTION_CHARS}–${MAX_DESCRIPTION_CHARS} characters`,
      );
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(
        row ? `${KB_LIST_KEY}/${row.id}` : KB_LIST_KEY,
        {
          method: row ? "PATCH" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: trimmedName,
            description: description.trim(),
          }),
        },
      );
      const body = (await res.json().catch(() => null)) as
        | (KbCollectionRow & { message?: string; error?: string })
        | null;
      if (!res.ok) {
        throw new Error(body?.message ?? body?.error ?? `HTTP ${res.status}`);
      }
      // The POST returns the row without the list's counts, and the panel
      // refetches anyway — only the new id is needed to navigate.
      const id = row?.id ?? body?.id;
      if (!id) throw new Error("Create returned no collection id.");
      onSaved(id, row === undefined);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next && !saving) onClose();
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{row ? "Edit knowledge" : "New knowledge"}</DialogTitle>
        </DialogHeader>

        <form onSubmit={(e) => void handleSubmit(e)} className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="kb-create-name">Name</Label>
            <Input
              id="kb-create-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={63}
              autoFocus
              className="font-mono text-xs"
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="kb-create-description">Description</Label>
            <Textarea
              id="kb-create-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              maxLength={MAX_DESCRIPTION_CHARS}
              className="resize-none text-xs"
              placeholder="What an agent should route here for."
            />
            <p
              className={cn(
                "text-[11px]",
                descOk ? "text-muted-foreground" : "text-destructive",
              )}
            >
              {description.trim().length}/{MAX_DESCRIPTION_CHARS} · at least{" "}
              {MIN_DESCRIPTION_CHARS} characters
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
              size="sm"
              onClick={onClose}
              disabled={saving}
            >
              Cancel
            </Button>
            <Button type="submit" size="sm" disabled={saving}>
              {saving && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
              {row ? "Save" : "Create"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// Main component

export function KbPanel(): ReactNode {
  const router = useRouter();
  const pathname = usePathname();
  const kbMatch = pathname.match(/^\/kb\/([^/]+)/);
  const activeKbId = kbMatch ? kbMatch[1] : null;

  const [metaDialog, setMetaDialog] = useState<
    { mode: "create" } | { mode: "edit"; row: KbCollectionListItem } | null
  >(null);

  // CONTRACT: the SWR cache is the only source of truth for this list. The
  // panel stays mounted across /kb and /kb/<id>, so writers outside it (the
  // editor's save/delete, group and page writes) must mutate KB_LIST_KEY.
  const {
    data: collections = [],
    isLoading: loading,
    isValidating,
    mutate,
  } = useSWR<KbCollectionListItem[]>(KB_LIST_KEY, fetcher, {
    revalidateOnFocus: false,
  });

  async function patchCollection(
    row: KbCollectionListItem,
    patch: Partial<KbCollectionListItem>,
  ): Promise<void> {
    void mutate(
      (prev) =>
        (prev ?? []).map((c) => (c.id === row.id ? { ...c, ...patch } : c)),
      { revalidate: false },
    );
    try {
      const res = await fetch(`${KB_LIST_KEY}/${row.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch {
      // Revert by pulling the server's truth back into the cache.
      void mutate();
    }
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center border-b bg-muted/40 px-3 py-1.5">
        <span className="text-sm font-medium">Knowledge</span>
        <span className="ml-1.5 rounded-full bg-muted px-1.5 py-0.5 text-[10px] leading-none text-muted-foreground">
          {collections.length}
        </span>
        <div className="ml-auto flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            onClick={() => setMetaDialog({ mode: "create" })}
            aria-label="New knowledge"
          >
            <Plus className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            onClick={() => void mutate()}
            disabled={isValidating}
            aria-label="Refresh knowledge collections"
          >
            <RefreshCw className={cn("h-3.5 w-3.5", isValidating && "animate-spin")} />
          </Button>
        </div>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        {loading ? (
          <div className="p-6 text-center text-xs text-muted-foreground">Loading…</div>
        ) : collections.length === 0 ? (
          <div className="px-4 py-3 text-xs text-muted-foreground">
            No knowledge collections yet.{" "}
            <button
              type="button"
              className="cursor-pointer underline underline-offset-2 hover:text-foreground"
              onClick={() => setMetaDialog({ mode: "create" })}
            >
              Create one
            </button>{" "}
            and bind it to an agent.
          </div>
        ) : (
          // Server order (newest first) is kept: a KB list is authored, not
          // browsed by name, and the newest one is what the user just made.
          collections.map((row) => (
            <KbItem
              key={row.id}
              row={row}
              active={row.id === activeKbId}
              onOpen={(r) => router.push(`/kb/${r.id}`)}
              onEdit={(r) => setMetaDialog({ mode: "edit", row: r })}
              onPatch={patchCollection}
            />
          ))
        )}
      </ScrollArea>

      {metaDialog !== null && (
        <CollectionDialog
          row={metaDialog.mode === "edit" ? metaDialog.row : undefined}
          onClose={() => setMetaDialog(null)}
          onSaved={(id, created) => {
            void mutate();
            setMetaDialog(null);
            // Only a create navigates: editing metadata leaves the author
            // wherever they were, including inside the editor they opened.
            if (created) router.push(`/kb/${id}`);
          }}
        />
      )}
    </div>
  );
}
