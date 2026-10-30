"use client";

/**
 * KbPanel — knowledge-collection list in the left sidebar.
 *
 * One row per collection: the slug, how many pages an agent could read from it,
 * and the two shared-state toggles. Creating a collection is a two-field dialog
 * rather than a `/kb/new` route because an empty collection has nothing to
 * edit — the editor only becomes meaningful once a page exists. That
 * same dialog is the only place a collection's name and description are edited:
 * the editor has no row for the corpus it shows.
 *
 * The third thing the toolbar does is turn a picked folder into a collection
 * (`FolderUp`) with no dialog at all: the collector and the caps are the shared
 * folder-import ones, the folder's own name becomes the slug, and the import
 * lands unpublished so the author can read the corpus before writing the
 * routing line it needs to be enabled.
 *
 * See docs/kb.md.
 */

import {
  Globe,
  Lock,
  Pencil,
  Plus,
  FolderUp,
  RefreshCw,
  ToggleLeft,
  ToggleRight,
  Loader2,
} from "lucide-react";
import {
  type ReactNode,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { useRouter, usePathname } from "next/navigation";
import { toast } from "sonner";
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
import { collectFolderFiles } from "@/lib/folder-import/collect";
import { classifyKbImportPath } from "@/lib/kb/import-policy";
import {
  KB_COLLECTION_NAME_RE,
  KB_COLLECTION_NAME_RULE,
  kbSlugFromFolderName,
} from "@/lib/kb/validation";
import { MAX_DESCRIPTION_CHARS } from "@/lib/kb/limits";
import {
  kbTopTally,
  type KbCollectionListItem,
  type KbCollectionRow,
} from "@/lib/types/kb";

/** Shared so the editor route can invalidate the panel's list cache. */
export const KB_LIST_KEY = "/api/kb";

/**
 * CONTRACT: these mirror the server's *defaults* (kb.max_pages, kb.page_max_bytes)
 * so an oversized folder fails without a round-trip. The route re-checks
 * everything against live config, so this mirror can delay a rejection but never
 * grant one.
 */
const IMPORT_CAPS = {
  admit: classifyKbImportPath,
  maxFiles: 50,
  maxFileBytes: 256 * 1024,
  maxTotalBytes: 10 * 1024 * 1024,
};

const fetcher = (url: string) =>
  fetch(url).then((res) => {
    if (!res.ok) throw new Error("Failed to load knowledge bases");
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
    folders: row.folderCount,
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
              aria-label={isPublic ? "Public KB" : "Private KB"}
            >
              {isPublic ? <Globe className="h-3.5 w-3.5" /> : <Lock className="h-3.5 w-3.5" />}
            </span>
          )}

          {canChangeVisibility ? (
            <button
              type="button"
              onClick={() => void onPatch(row, { enabled: !row.enabled })}
              className="cursor-pointer rounded p-0.5 hover:text-foreground"
              aria-label={row.enabled ? "Disable KB" : "Enable KB"}
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

      {row.description ? (
        <p className="line-clamp-2 text-xs text-muted-foreground">
          {row.description}
        </p>
      ) : (
        // A collection with no routing line is by definition not mounted, so
        // this is the row's own state rather than a generic warning.
        <p className="text-xs text-muted-foreground italic">
          No description — add one to enable this KB.
        </p>
      )}
    </div>
  );
}

// Create / edit dialog

/**
 * Both sides of a folder pick get reported: the picker silently drops OS and tool
 * noise plus every image, and the route can drop what the mirrored caps let
 * through. Naming the count is enough — the files left out are the ones that
 * cannot be a page.
 *
 * The hint is the point of the toast: an import leaves the KB disabled, and
 * nothing else tells the author why it never reached their agent.
 */
function reportImportResult(
  imported: number,
  clientSkipped: string[],
  serverSkipped: string[] | undefined,
): void {
  const skipped: string[] = [...clientSkipped, ...(serverSkipped ?? [])];
  const summary: string = `Imported successfully — ${imported} page(s). Please add a description to enable it.`;
  if (skipped.length === 0) {
    toast.success(summary, { duration: 10_000 });
    return;
  }
  const preview: string = skipped.slice(0, 3).join(", ");
  toast.warning(
    `${summary} Ignored ${skipped.length} file(s): ${preview}${skipped.length > 3 ? "…" : ""}.`,
    { duration: 10_000 },
  );
}

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
  const trimmedDescription = description.trim();
  const nameOk = KB_COLLECTION_NAME_RE.test(trimmedName);

  async function handleSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (!nameOk) {
      setError(KB_COLLECTION_NAME_RULE);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const url = row ? `${KB_LIST_KEY}/${row.id}` : KB_LIST_KEY;
      const res = await fetch(url, {
        method: row ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: trimmedName,
          description: trimmedDescription,
        }),
      });
      const body = (await res.json().catch(() => null)) as
        | (KbCollectionRow & { message?: string; error?: string })
        | null;
      if (!res.ok) {
        throw new Error(body?.message ?? body?.error ?? `HTTP ${res.status}`);
      }
      // The POST returns the row without the list's counts, and the panel
      // refetches anyway — only the new id is needed to navigate.
      const id = row?.id ?? body?.id;
      if (!id) throw new Error("Save returned no KB id.");
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
                trimmedDescription === "" && row?.enabled
                  ? "text-destructive"
                  : "text-muted-foreground",
              )}
            >
              {trimmedDescription.length}/{MAX_DESCRIPTION_CHARS} · an empty one
              keeps this KB unmounted
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

  const [dialog, setDialog] = useState<
    { mode: "create" } | { mode: "edit"; row: KbCollectionListItem } | null
  >(null);

  const [importing, setImporting] = useState<boolean>(false);
  const importInputRef = useRef<HTMLInputElement>(null);

  // CONTRACT: the SWR cache is the only source of truth for this list. The
  // panel stays mounted across /kb and /kb/<id>, so writers outside it (the
  // editor's collection save/delete and its page writes) must mutate KB_LIST_KEY.
  const {
    data: collections = [],
    isLoading: loading,
    isValidating,
    mutate,
  } = useSWR<KbCollectionListItem[]>(KB_LIST_KEY, fetcher, {
    revalidateOnFocus: false,
  });

  /**
   * The toggles are optimistic, so a refusal has to be undone *and* said: the
   * server refuses to mount a collection with no description, and a switch that
   * silently springs back reads as a broken button rather than as a rule.
   */
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
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          message?: string;
          error?: string;
        } | null;
        throw new Error(body?.message ?? body?.error ?? `HTTP ${res.status}`);
      }
    } catch (err) {
      // Revert by pulling the server's truth back into the cache.
      void mutate();
      toast.error("Change rejected", {
        description: err instanceof Error ? err.message : String(err),
        duration: 10_000,
      });
    }
  }

  /**
   * Pick a folder, get a collection: the folder's own name is the slug and the
   * description is left for the author, who has not read the corpus yet. The
   * route still enforces every cap and every path rule, so this only skips the
   * dialog — never a check.
   */
  async function handleImportFiles(files: File[]): Promise<void> {
    setImporting(true);
    const folderName: string = files[0]?.webkitRelativePath.split("/")[0] ?? "";
    try {
      const slug = kbSlugFromFolderName(folderName);
      if (slug === null) {
        toast.error(`Cannot name a knowledge base from “${folderName}”`, {
          description: `${KB_COLLECTION_NAME_RULE}. Rename the folder and pick it again.`,
          duration: 10_000,
        });
        return;
      }
      const collected = await collectFolderFiles(files, IMPORT_CAPS);
      if (!collected.ok) {
        toast.error("Import failed", {
          description: collected.message,
          duration: 10_000,
        });
        return;
      }
      if (collected.entries.length === 0) {
        toast.warning("Nothing to import", {
          description: "The folder held no text file.",
        });
        return;
      }
      const res = await fetch(`${KB_LIST_KEY}/import`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: slug, entries: collected.entries }),
      });
      const body = (await res.json().catch(() => null)) as
        | (KbCollectionRow & { message?: string; error?: string; skipped?: string[] })
        | null;
      if (!res.ok) {
        toast.error("Import failed", {
          description: body?.message ?? body?.error ?? `HTTP ${res.status}`,
          duration: 10_000,
        });
        return;
      }
      reportImportResult(
        collected.entries.length,
        collected.skipped,
        body?.skipped,
      );
      void mutate();
      // Same as a create: the author is sent to what they just imported, which
      // is where the description gets written.
      if (body?.id) router.push(`/kb/${body.id}`);
    } catch (err) {
      toast.error("Import failed", {
        description: err instanceof Error ? err.message : "Import failed",
        duration: 10_000,
      });
    } finally {
      setImporting(false);
      if (importInputRef.current) importInputRef.current.value = "";
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
            onClick={() => setDialog({ mode: "create" })}
            aria-label="New knowledge"
          >
            <Plus className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            onClick={() => importInputRef.current?.click()}
            disabled={importing}
            aria-label="Import knowledge folder"
          >
            <FolderUp className={cn("h-3.5 w-3.5", importing && "animate-pulse")} />
          </Button>
          <input
            ref={importInputRef}
            type="file"
            multiple
            className="hidden"
            {...({ webkitdirectory: "" } as object)}
            onChange={(e) => {
              const files = Array.from(e.target.files ?? []);
              if (files.length > 0) void handleImportFiles(files);
            }}
          />
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            onClick={() => void mutate()}
            disabled={isValidating}
            aria-label="Refresh knowledge bases"
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
            No knowledge bases yet.{" "}
            <button
              type="button"
              className="cursor-pointer underline underline-offset-2 hover:text-foreground"
              onClick={() => setDialog({ mode: "create" })}
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
              onEdit={(r) => setDialog({ mode: "edit", row: r })}
              onPatch={patchCollection}
            />
          ))
        )}
      </ScrollArea>

      {dialog !== null && (
        <CollectionDialog
          row={dialog.mode === "edit" ? dialog.row : undefined}
          onClose={() => setDialog(null)}
          onSaved={(id, created) => {
            void mutate();
            setDialog(null);
            // Only a create navigates: editing metadata leaves the author
            // wherever they were, including inside the editor they opened.
            if (created) router.push(`/kb/${id}`);
          }}
        />
      )}
    </div>
  );
}
