"use client";

/**
 * ArtifactFolderTreeSelect — shared folder picker for the Save dialog
 * and the detail page's "Move to…" action.
 *
 * Renders the user's artifact tree but **hides leaves** — only nodes
 * with `kind === "folder"` are selectable. Top-level (seed) categories
 * are selectable iff `allowRoot=true` (default `false` in M2 — leaves
 * always have a non-null `parentId`, sub-folder always has a non-null
 * parent, so root selection is a manual override for future use).
 *
 * See docs/artifact-dashboard-migration.md.
 */

import { ChevronDown, ChevronRight, Folder, FolderOpen, Loader2 } from "lucide-react";
import { Fragment, useMemo, useState, type ReactElement } from "react";

import { useArtifactTree, type ArtifactNode } from "@/hooks/useArtifactTree";
import { cn } from "@/lib/utils";

export interface ArtifactFolderTreeSelectProps {
  /** Currently selected folder id, or `null` for none. */
  value: string | null;
  onChange: (folderId: string) => void;
  /** Allow the user to pick a root (seed-category) folder. M2 callers
   *  pass `true` because the seed category IS the destination. */
  allowRoot?: boolean;
  /** Disable a specific subtree — used by the "Move to…" picker so
   *  the user cannot move a folder under itself or its descendants.
   *  Disabled nodes still render so the user sees them, but they
   *  cannot be selected and their children inherit the disabled state. */
  disabledSubtreeRootId?: string;
}

export function ArtifactFolderTreeSelect({
  value,
  onChange,
  allowRoot = true,
  disabledSubtreeRootId,
}: ArtifactFolderTreeSelectProps): ReactElement {
  const { tree, isLoading, error } = useArtifactTree();
  const [userExpanded, setUserExpanded] = useState<Set<string>>(new Set());

  // The actual `expanded` set rendered to the tree is derived during
  // render: the user's manually-toggled set unioned with the ancestor
  // path of the current `value`, so the selection is always visible
  // without having to push state through an effect (which would
  // trigger cascading renders — see
  // https://react.dev/learn/you-might-not-need-an-effect).
  //
  // Trade-off: while a selection exists the user can't fully collapse
  // its ancestor chain — toggling collapse will re-expand on next
  // render. Acceptable in a folder picker, where the selection is
  // typically the focus.
  const expanded: Set<string> = useMemo(() => {
    if (!tree || !value) return userExpanded;
    const next: Set<string> = new Set(userExpanded);
    for (const id of collectAncestorIds(tree, value)) next.add(id);
    return next;
  }, [userExpanded, tree, value]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        Loading folders…
      </div>
    );
  }
  if (error) {
    return (
      <div className="rounded border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive">
        Failed to load folders: {error.message}
      </div>
    );
  }
  if (!tree || tree.length === 0) {
    return (
      <div className="py-6 text-center text-sm text-muted-foreground">
        No folders.
      </div>
    );
  }

  const toggle = (id: string): void => {
    setUserExpanded((prev) => {
      const next: Set<string> = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div className="max-h-72 overflow-auto rounded border bg-background">
      {tree.map((node) => (
        <FolderRow
          key={node.id}
          node={node}
          depth={0}
          expanded={expanded}
          onToggle={toggle}
          value={value}
          onChange={onChange}
          allowRoot={allowRoot}
          disabledSubtreeRootId={disabledSubtreeRootId}
        />
      ))}
    </div>
  );
}

// helpers

interface FolderRowProps {
  node: ArtifactNode;
  depth: number;
  expanded: Set<string>;
  onToggle: (id: string) => void;
  value: string | null;
  onChange: (folderId: string) => void;
  allowRoot: boolean;
  disabledSubtreeRootId?: string;
  /** Propagated downwards when an ancestor is disabled. */
  inheritedDisabled?: boolean;
}

function FolderRow({
  node,
  depth,
  expanded,
  onToggle,
  value,
  onChange,
  allowRoot,
  disabledSubtreeRootId,
  inheritedDisabled = false,
}: FolderRowProps): ReactElement | null {
  // Leaves are skipped — selector is folder-only.
  if (node.kind !== "folder") return null;

  const isRoot: boolean = node.parentId === null;
  const isExpanded: boolean = expanded.has(node.id);
  const childFolders: ArtifactNode[] = node.children.filter(
    (c) => c.kind === "folder",
  );
  const hasChildFolders: boolean = childFolders.length > 0;
  const isSelected: boolean = value === node.id;

  const disabledByPolicy: boolean = (isRoot && !allowRoot)
    || inheritedDisabled
    || node.id === disabledSubtreeRootId;

  return (
    <Fragment>
      <button
        type="button"
        disabled={disabledByPolicy}
        onClick={() => onChange(node.id)}
        className={cn(
          "flex w-full items-center gap-1 px-2 py-1.5 text-left text-sm",
          "hover:bg-muted/60",
          isSelected && "bg-primary/10 text-primary",
          disabledByPolicy && "cursor-not-allowed opacity-50 hover:bg-transparent",
        )}
        style={{ paddingLeft: `${0.5 + depth * 1.25}rem` }}
      >
        <span
          role="button"
          tabIndex={0}
          onClick={(e) => {
            e.stopPropagation();
            if (hasChildFolders) onToggle(node.id);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              e.stopPropagation();
              if (hasChildFolders) onToggle(node.id);
            }
          }}
          className={cn(
            "inline-flex h-4 w-4 shrink-0 items-center justify-center rounded",
            hasChildFolders && "hover:bg-muted",
            !hasChildFolders && "invisible",
          )}
          aria-label={isExpanded ? "Collapse folder" : "Expand folder"}
        >
          {isExpanded ? (
            <ChevronDown className="h-3 w-3 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-3 w-3 text-muted-foreground" />
          )}
        </span>
        {isExpanded ? (
          <FolderOpen className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <Folder className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        )}
        <span className="truncate">{node.name}</span>
      </button>
      {isExpanded
        && childFolders.map((child) => (
          <FolderRow
            key={child.id}
            node={child}
            depth={depth + 1}
            expanded={expanded}
            onToggle={onToggle}
            value={value}
            onChange={onChange}
            allowRoot={allowRoot}
            disabledSubtreeRootId={disabledSubtreeRootId}
            inheritedDisabled={disabledByPolicy}
          />
        ))}
    </Fragment>
  );
}

function collectAncestorIds(roots: ArtifactNode[], targetId: string): string[] {
  const acc: string[] = [];
  // DFS that pushes folder ids on the way down and unwinds when the
  // target is found. Returns the chain of ancestor ids (root → target's
  // parent). Caller uses these to seed `expanded`.
  const walk = (nodes: ArtifactNode[], trail: string[]): boolean => {
    for (const n of nodes) {
      if (n.id === targetId) {
        acc.push(...trail);
        return true;
      }
      if (walk(n.children, [...trail, n.id])) return true;
    }
    return false;
  };
  walk(roots, []);
  return acc;
}
