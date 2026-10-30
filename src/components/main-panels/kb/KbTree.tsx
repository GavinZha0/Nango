"use client";

/**
 * KbTree — structure column of the knowledge editor.
 *
 * The tree is derived from the page paths: a folder is a prefix its pages
 * share, so there is no folder list to render and nothing here can show a
 * directory the server does not have. Subdirectories come before files at every
 * level, and the pages with no prefix last — bare rows, because no folder names
 * them. The collection itself has no row: it is already named by the panel that
 * opened this editor and the panel's dialog owns its metadata.
 *
 * A folder row is a disclosure control, not a selection: clicking it folds or
 * unfolds its subtree and touches nothing in the detail pane, because a folder
 * has no body to show. Only a page row selects. Both row kinds carry a pencil
 * and a trash that surface on hover; the dialogs behind them own the metadata
 * while the detail pane owns only a page's description and body. A page the
 * identity dialog has named but the `POST` has not created still gets a row, in
 * the folder its path puts it in, so a create is visible the moment it is
 * described — and that row is how a new folder appears before it holds anything
 * real.
 *
 * See docs/kb.md.
 */

import {
  ChevronDown,
  ChevronRight,
  FileText,
  Folder,
  FolderOpen,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { getBaseName, getParentPath } from "@/lib/paths";
import { isUnderFolder, ancestorFolders } from "@/lib/kb/paths";
import type { KbPageIdentity } from "@/components/main-panels/kb/KbPageDialog";
import type { KbPageSummary } from "@/lib/types/kb";

/**
 * Which page the detail column shows. `none` is the opening state and what the
 * pane falls back to when the page it held was deleted; a folder is never a
 * selection. `new-page` carries the identity the dialog collected and has no row
 * id yet.
 */
export type KbSelection =
  | { kind: "none" }
  | { kind: "page"; id: number }
  | { kind: "new-page"; identity: KbPageIdentity };

/** Identity of a selection, so a switch can be recognised as a no-op. */
export function selectionKey(sel: KbSelection): string {
  switch (sel.kind) {
    case "none":
      return "none";
    case "page":
      return `page:${sel.id}`;
    case "new-page": {
      const { identity } = sel;
      // The dialog can be re-opened with different answers while the pane still
      // holds an unsaved body, so the identity is part of the key: a changed
      // path is a switch the author has to be asked about, not a no-op.
      return `new-page:${identity.path}:${identity.sourceRef}`;
    }
  }
}

export interface KbTreeProps {
  /** Every page of the collection, in the server's `alphabeticCompare` order. */
  pages: KbPageSummary[];
  selection: KbSelection;
  onSelect: (selection: KbSelection) => void;
  /** Every action on a row is a write, so a read-only viewer sees none. */
  editable: boolean;
  /** Opens the create-page dialog. */
  onNewPage: () => void;
  /** Opens the same dialog in edit mode for that row. */
  onEditPage: (page: KbPageSummary) => void;
  /** Opens the rename dialog for that prefix; a move is the same write. */
  onRenameFolder: (folder: string) => void;
  /** Row deletes: the header keeps only the collection's. */
  onDeleteFolder: (folder: string) => void;
  onDeletePage: (page: KbPageSummary) => void;
  /** Path of the page with unsaved edits, so the mark survives a scroll. */
  dirtyPath: string | null;
}

/**
 * The row wrapper is `group` and every action keeps its slot whether or not it
 * shows, so hovering fades icons in without moving the row's text. They are
 * siblings of the row button, not children: a button cannot hold another.
 */
const ACTION =
  "shrink-0 rounded p-1 text-muted-foreground/70 opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100";

const WRAP =
  "group flex items-center gap-1 pr-1 transition-colors hover:bg-muted/40";

function RowActions({
  onEdit,
  editLabel,
  onDelete,
  deleteLabel,
}: {
  onEdit: () => void;
  editLabel: string;
  onDelete: () => void;
  deleteLabel: string;
}): ReactNode {
  return (
    <>
      <button
        type="button"
        onClick={onEdit}
        aria-label={editLabel}
        title={editLabel}
        className={cn(ACTION, "hover:text-foreground")}
      >
        <Pencil className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        onClick={onDelete}
        aria-label={deleteLabel}
        title={deleteLabel}
        className={cn(ACTION, "hover:text-destructive")}
      >
        <Trash2 className="h-3.5 w-3.5" />
      </button>
    </>
  );
}

function FolderRow({
  folder,
  depth,
  pages,
  open,
  onToggle,
  editable,
  onRenameFolder,
  onDeleteFolder,
}: {
  folder: string;
  depth: number;
  pages: number;
  open: boolean;
  onToggle: () => void;
  editable: boolean;
  onRenameFolder: (folder: string) => void;
  onDeleteFolder: (folder: string) => void;
}): ReactNode {
  const name: string = getBaseName(folder);
  return (
    <div className={WRAP} style={{ paddingLeft: depth * 12 + 8 }}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex min-w-0 flex-1 items-center gap-1 rounded py-1.5 text-left text-xs"
      >
        {open ? (
          <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground/70" />
        ) : (
          <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground/70" />
        )}
        {open ? (
          <FolderOpen className="h-3.5 w-3.5 shrink-0 text-muted-foreground/70" />
        ) : (
          <Folder className="h-3.5 w-3.5 shrink-0 text-muted-foreground/70" />
        )}
        <span className="flex min-w-0 items-baseline gap-1">
          <span className="min-w-0 truncate font-medium">{name}</span>
          <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">
            ({pages})
          </span>
        </span>
      </button>
      {editable && (
        <RowActions
          onEdit={() => onRenameFolder(folder)}
          editLabel={`Rename ${folder}`}
          onDelete={() => onDeleteFolder(folder)}
          deleteLabel={`Delete ${folder}`}
        />
      )}
    </div>
  );
}

/**
 * The page the identity dialog has just described and the `POST` has not created
 * yet. It gets a row, in the folder its path names and marked as the selection,
 * because an author who types a path and sees nothing assumes the create failed.
 * It is not clickable and carries no hover actions: there is no row behind it to
 * edit, delete, or reload — the pane already holds it, and Save turns it into a
 * real row.
 */
function DraftRow({
  path,
  depth,
  dirty,
}: {
  path: string;
  depth: number;
  dirty: boolean;
}): ReactNode {
  return (
    <div
      className={cn(WRAP, "bg-accent hover:bg-accent")}
      style={{ paddingLeft: depth * 12 + 8 }}
    >
      <div
        className={cn(
          "flex min-w-0 flex-1 items-center gap-1.5 rounded px-2 py-1 text-xs",
          dirty && "text-amber-600 dark:text-amber-400",
        )}
      >
        <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground/70" />
        <span className="min-w-0 flex-1 truncate">{getBaseName(path)}</span>
      </div>
    </div>
  );
}

function PageRow({
  page,
  depth,
  selection,
  onSelect,
  editable,
  onEditPage,
  onDeletePage,
  dirtyPath,
}: {
  page: KbPageSummary;
  depth: number;
  selection: KbSelection;
  onSelect: (selection: KbSelection) => void;
  editable: boolean;
  onEditPage: (page: KbPageSummary) => void;
  onDeletePage: (page: KbPageSummary) => void;
  dirtyPath: string | null;
}): ReactNode {
  const active: boolean = selection.kind === "page" && selection.id === page.id;
  return (
    // Only page rows take a dirty mark: a folded folder has no form, so it can
    // never hold unsaved edits. Paths are unique within the collection, so
    // matching on the path is exact rather than a collision risk.
    <div
      className={cn(WRAP, active && "bg-accent hover:bg-accent")}
      style={{ paddingLeft: depth * 12 + 8 }}
      title={page.path}
    >
      <button
        type="button"
        onClick={() => onSelect({ kind: "page", id: page.id })}
        className={cn(
          "flex min-w-0 flex-1 items-center gap-1.5 rounded px-2 py-1 text-left text-xs",
          dirtyPath === page.path && "text-amber-600 dark:text-amber-400",
        )}
      >
        <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground/70" />
        <span className="min-w-0 flex-1 truncate">{getBaseName(page.path)}</span>
      </button>
      {editable && (
        <RowActions
          onEdit={() => onEditPage(page)}
          editLabel={`Edit ${page.path}`}
          onDelete={() => onDeletePage(page)}
          deleteLabel={`Delete ${page.path}`}
        />
      )}
    </div>
  );
}

export function KbTree({
  pages,
  selection,
  onSelect,
  editable,
  onNewPage,
  onEditPage,
  onRenameFolder,
  onDeleteFolder,
  onDeletePage,
  dirtyPath,
}: KbTreeProps): ReactNode {
  /**
   * The implied folders, bucketed by their own parent prefix, plus the pages
   * bucketed by the prefix they carry. Both maps follow the order the server
   * sent, so no re-sorting happens here — a folder that only holds subfolders
   * still appears, because some page's path names it.
   */
  const { childFoldersOf, pagesOf, roots, topLevel } = useMemo(() => {
    const children = new Map<string, string[]>();
    const byFolder = new Map<string, KbPageSummary[]>();
    const rootPages: KbPageSummary[] = [];
    const seen = new Set<string>();
    for (const page of pages) {
      const folder: string = getParentPath(page.path);
      if (folder === "") rootPages.push(page);
      else {
        const list = byFolder.get(folder);
        if (list) list.push(page);
        else byFolder.set(folder, [page]);
      }
      // A path's ancestors are added outermost first, and once each: the first
      // page under a prefix is what brings that prefix into the tree.
      for (const prefix of ancestorFolders(page.path)) {
        if (!seen.has(prefix)) {
          seen.add(prefix);
          const parent = getParentPath(prefix);
          const siblings = children.get(parent);
          if (siblings) siblings.push(prefix);
          else children.set(parent, [prefix]);
        }
      }
    }
    return {
      childFoldersOf: children,
      pagesOf: byFolder,
      roots: children.get("") ?? [],
      topLevel: rootPages,
    };
  }, [pages]);

  /**
   * The folded set, not the open set: the tree starts expanded so nothing is
   * hidden from an author looking for one page, a folder implied by a new path
   * needs no seeding, and a tree reload after a write cannot undo what they
   * folded away. Keyed by prefix because a folder has no id.
   */
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());

  /** The page the pane is holding but the server has not been told about. */
  const draft: KbPageIdentity | null =
    selection.kind === "new-page" ? selection.identity : null;
  const draftDirty: boolean = draft !== null && dirtyPath === draft.path;

  function toggle(folder: string): void {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(folder)) next.delete(folder);
      else next.add(folder);
      return next;
    });
  }

  /** Every page below the prefix, not just the ones sitting directly in it. */
  function subtreeSize(folder: string): number {
    return pages.filter((page) => isUnderFolder(page.path, folder)).length;
  }

  function renderFolder(folder: string, depth: number): ReactNode {
    const open: boolean = !collapsed.has(folder);
    const direct: KbPageSummary[] = pagesOf.get(folder) ?? [];
    return (
      <div key={folder}>
        <FolderRow
          folder={folder}
          depth={depth}
          pages={subtreeSize(folder)}
          open={open}
          onToggle={() => toggle(folder)}
          editable={editable}
          onRenameFolder={onRenameFolder}
          onDeleteFolder={onDeleteFolder}
        />
        {open &&
          direct.map((page) => (
            <PageRow
              key={page.id}
              page={page}
              depth={depth + 1}
              selection={selection}
              onSelect={onSelect}
              editable={editable}
              onEditPage={onEditPage}
              onDeletePage={onDeletePage}
              dirtyPath={dirtyPath}
            />
          ))}
        {open &&
          draft !== null &&
          getParentPath(draft.path) === folder && (
            <DraftRow path={draft.path} depth={depth + 1} dirty={draftDirty} />
          )}
        {open &&
          (childFoldersOf.get(folder) ?? []).map((child) =>
            renderFolder(child, depth + 1),
          )}
      </div>
    );
  }

  return (
    <div className="flex h-full w-80 shrink-0 flex-col border-r">
      <div className="flex h-9 shrink-0 items-center justify-between border-b px-3">
        <span className="text-xs font-medium text-muted-foreground">
          Pages ({pages.length})
        </span>
        {/* Creating is a write with no read-only meaning, so a viewer who cannot
            edit sees the action absent rather than disabled. There is no
            "new folder": a folder exists as soon as a page path names it, so
            the page dialog's path field is the only way to make one. */}
        {editable && (
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            onClick={onNewPage}
            aria-label="New page"
            title="New page"
          >
            <Plus className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-0.5 p-2">
          {roots.length === 0 && topLevel.length === 0 && draft === null && (
            <p className="px-2 py-3 text-[11px] leading-snug text-muted-foreground">
              Nothing here yet. Add a page with the plus button, and put a
              folder in front of its path to structure them.
            </p>
          )}

          {roots.map((folder) => renderFolder(folder, 0))}

          {/* The collection's own pages come last, so every level reads as
              subdirectories first and its own files after — the order the Skills
              tree uses. No heading names them: a heading would be a folder the
              server cannot hold, and the agent surface spells the same set as
              paths with no prefix. */}
          {topLevel.map((page) => (
            <PageRow
              key={page.id}
              page={page}
              depth={0}
              selection={selection}
              onSelect={onSelect}
              editable={editable}
              onEditPage={onEditPage}
              onDeletePage={onDeletePage}
              dirtyPath={dirtyPath}
            />
          ))}
          {draft !== null && getParentPath(draft.path) === "" && (
            <DraftRow path={draft.path} depth={0} dirty={draftDirty} />
          )}
        </div>
      </ScrollArea>
    </div>
  );
}
