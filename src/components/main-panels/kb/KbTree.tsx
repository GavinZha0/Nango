"use client";

/**
 * KbTree — structure column of the knowledge editor.
 *
 * Lists level-1 groups with their children nested, each group's pages
 * underneath, and the pages with no group last — bare rows, because no group
 * names them. The collection itself has no row: it is already named by the panel
 * that opened this editor and the panel's dialog owns its metadata.
 *
 * A group row is a disclosure control, not a selection: clicking it folds or
 * unfolds its subtree and touches nothing in the detail pane, because a group has
 * no body to show. Only a page row selects. Both row kinds carry a pencil and a
 * trash that surface on hover, and the dialogs behind them own the metadata while
 * the detail pane owns only a page's description and body. A page the identity
 * dialog has named but the `POST` has not created still gets a row, in the group
 * it was aimed at, so a create is visible the moment it is described.
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
  Layers,
} from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import type { KbPageIdentity } from "@/components/main-panels/kb/KbPageDialog";
import type { KbGroupRow, KbPageSummary } from "@/lib/types/kb";

/**
 * Which page the detail column shows. `none` is the opening state and what the
 * pane falls back to when the page it held was deleted; a group is never a
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
      // name is a switch the author has to be asked about, not a no-op.
      return `new-page:${identity.groupId ?? "top"}:${identity.name}:${identity.sourceRef}`;
    }
  }
}

export interface KbTreeProps {
  pageCount: number;
  groups: KbGroupRow[];
  pages: KbPageSummary[];
  selection: KbSelection;
  onSelect: (selection: KbSelection) => void;
  /** Every action on a row is a write, so a read-only viewer sees none. */
  editable: boolean;
  /** Opens the create-group dialog. */
  onNewGroup: () => void;
  /** Opens the same dialog in edit mode for that row. */
  onEditGroup: (group: KbGroupRow) => void;
  /** Opens the create-page dialog. */
  onNewPage: () => void;
  /** Opens the same dialog in edit mode for that row. */
  onEditPage: (page: KbPageSummary) => void;
  /** Row deletes: the header keeps only the collection's. */
  onDeleteGroup: (group: KbGroupRow) => void;
  onDeletePage: (page: KbPageSummary) => void;
  /** Name of the page with unsaved edits, so the mark survives a scroll. */
  dirtyLabel: string | null;
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

function GroupRow({
  group,
  depth,
  pages,
  open,
  onToggle,
  editable,
  onEditGroup,
  onDeleteGroup,
}: {
  group: KbGroupRow;
  depth: number;
  pages: number;
  open: boolean;
  onToggle: () => void;
  editable: boolean;
  onEditGroup: (group: KbGroupRow) => void;
  onDeleteGroup: (group: KbGroupRow) => void;
}): ReactNode {
  return (
    <div
      className={WRAP}
      style={{ paddingLeft: depth * 12 + 8 }}
      title={group.description ?? undefined}
    >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex min-w-0 flex-1 flex-col items-start gap-0 rounded py-1.5 text-left text-xs"
      >
        <span className="flex w-full min-w-0 items-center gap-1.5">
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
            <span className="min-w-0 truncate font-medium">{group.name}</span>
            <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">
              ({pages})
            </span>
          </span>
        </span>
        {group.description && (
          // Indented past the chevron and the folder so the second line starts
          // under the name rather than under the icons.
          <span className="w-full truncate pl-[38px] text-[11px] leading-snug text-muted-foreground">
            {group.description}
          </span>
        )}
      </button>
      {editable && (
        <RowActions
          onEdit={() => onEditGroup(group)}
          editLabel={`Edit ${group.name}`}
          onDelete={() => onDeleteGroup(group)}
          deleteLabel={`Delete ${group.name}`}
        />
      )}
    </div>
  );
}

/**
 * The page the identity dialog has just described and the `POST` has not created
 * yet. It gets a row, in the group the dialog named and marked as the selection,
 * because an author who types a page name and sees nothing assumes the create
 * failed. It is not clickable and carries no hover actions: there is no row
 * behind it to edit, delete, or reload — the pane already holds it, and Save turns
 * it into a real row.
 */
function DraftRow({
  name,
  depth,
  dirty,
}: {
  name: string;
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
        <span className="min-w-0 flex-1 truncate">{name}</span>
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
  dirtyLabel,
}: {
  page: KbPageSummary;
  depth: number;
  selection: KbSelection;
  onSelect: (selection: KbSelection) => void;
  editable: boolean;
  onEditPage: (page: KbPageSummary) => void;
  onDeletePage: (page: KbPageSummary) => void;
  dirtyLabel: string | null;
}): ReactNode {
  const active: boolean = selection.kind === "page" && selection.id === page.id;
  return (
    // Only page rows take a dirty mark: a folded group has no form, so it can
    // never hold unsaved edits. Page names are unique within the collection, so
    // matching the label is exact rather than a collision risk.
    <div
      className={cn(WRAP, active && "bg-accent hover:bg-accent")}
      style={{ paddingLeft: depth * 12 + 8 }}
      title={page.description ?? undefined}
    >
      <button
        type="button"
        onClick={() => onSelect({ kind: "page", id: page.id })}
        className={cn(
          "flex min-w-0 flex-1 items-center gap-1.5 rounded px-2 py-1 text-left text-xs",
          dirtyLabel === page.name && "text-amber-600 dark:text-amber-400",
        )}
      >
        <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground/70" />
        <span className="min-w-0 flex-1 truncate">{page.name}</span>
      </button>
      {editable && (
        <RowActions
          onEdit={() => onEditPage(page)}
          editLabel={`Edit ${page.name}`}
          onDelete={() => onDeletePage(page)}
          deleteLabel={`Delete ${page.name}`}
        />
      )}
    </div>
  );
}

export function KbTree({
  pageCount,
  groups,
  pages,
  selection,
  onSelect,
  editable,
  onNewGroup,
  onEditGroup,
  onNewPage,
  onEditPage,
  onDeleteGroup,
  onDeletePage,
  dirtyLabel,
}: KbTreeProps): ReactNode {
  // Group → children and group → pages, both keyed by parent id, with the
  // ungrouped rows collected separately. The server already returns tree order,
  // so the grouping below preserves it rather than re-sorting.
  const { childrenOf, pagesOf, levelOne, topLevel } = useMemo(() => {
    const children: Map<number, KbGroupRow[]> = new Map();
    const byGroup: Map<number, KbPageSummary[]> = new Map();
    const root: KbGroupRow[] = [];
    const ungrouped: KbPageSummary[] = [];
    for (const group of groups) {
      if (group.parentId === null) root.push(group);
      else {
        const list = children.get(group.parentId);
        if (list) list.push(group);
        else children.set(group.parentId, [group]);
      }
    }
    for (const page of pages) {
      if (page.groupId === null) ungrouped.push(page);
      else {
        const list = byGroup.get(page.groupId);
        if (list) list.push(page);
        else byGroup.set(page.groupId, [page]);
      }
    }
    return {
      childrenOf: children,
      pagesOf: byGroup,
      levelOne: root,
      topLevel: ungrouped,
    };
  }, [groups, pages]);

  /**
   * The folded set, not the open set: the tree starts expanded so nothing is
   * hidden from an author looking for one page, a group created mid-session needs
   * no seeding, and a tree reload after a write cannot undo what they folded away.
   */
  const [collapsed, setCollapsed] = useState<Set<number>>(() => new Set());

  /** The page the pane is holding but the server has not been told about. */
  const draft: KbPageIdentity | null =
    selection.kind === "new-page" ? selection.identity : null;
  const draftDirty: boolean = draft !== null && dirtyLabel === draft.name;

  function toggle(groupId: number): void {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
      return next;
    });
  }

  function renderGroup(group: KbGroupRow, depth: number): ReactNode {
    const open: boolean = !collapsed.has(group.id);
    return (
      <div key={group.id}>
        <GroupRow
          group={group}
          depth={depth}
          pages={pagesOf.get(group.id)?.length ?? 0}
          open={open}
          onToggle={() => toggle(group.id)}
          editable={editable}
          onEditGroup={onEditGroup}
          onDeleteGroup={onDeleteGroup}
        />
        {open &&
          (pagesOf.get(group.id) ?? []).map((page) => (
            <PageRow
              key={page.id}
              page={page}
              depth={depth + 1}
              selection={selection}
              onSelect={onSelect}
              editable={editable}
              onEditPage={onEditPage}
              onDeletePage={onDeletePage}
              dirtyLabel={dirtyLabel}
            />
          ))}
        {open && draft !== null && draft.groupId === group.id && (
          <DraftRow name={draft.name} depth={depth + 1} dirty={draftDirty} />
        )}
        {open &&
          (childrenOf.get(group.id) ?? []).map((child) =>
            renderGroup(child, depth + 1),
          )}
      </div>
    );
  }

  return (
    <div className="flex h-full w-80 shrink-0 flex-col border-r">
      <div className="flex h-9 shrink-0 items-center justify-between border-b px-3">
        <span className="text-xs font-medium text-muted-foreground">
          Pages ({pageCount})
        </span>
        {/* Creating is a write with no read-only meaning, so a viewer who cannot
            edit sees the two actions absent rather than disabled. */}
        {editable && (
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6"
              onClick={onNewGroup}
              aria-label="New group"
              title="New group"
            >
              <Layers className="h-3.5 w-3.5" />
            </Button>
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
          </div>
        )}
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-0.5 p-2">
          {levelOne.length === 0 &&
            topLevel.length === 0 &&
            draft === null && (
            <p className="px-2 py-3 text-[11px] leading-snug text-muted-foreground">
              Nothing here yet. Add a page with the plus button, or a group to
              structure them.
            </p>
          )}

          {levelOne.map((group) => renderGroup(group, 0))}

          {/* The collection's own pages come last, so every level reads as
              subdirectories first and its own files after — the order the Skills
              tree uses. No heading names them: it would be a group the server
              refuses to create, and the agent surface spells the same set
              `ungroupedPages`. */}
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
              dirtyLabel={dirtyLabel}
            />
          ))}
          {draft !== null && draft.groupId === null && (
            <DraftRow name={draft.name} depth={0} dirty={draftDirty} />
          )}
        </div>
      </ScrollArea>
    </div>
  );
}
