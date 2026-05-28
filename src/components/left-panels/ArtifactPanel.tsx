"use client";

/**
 * ArtifactPanel — left-sidebar tree view of the current user's
 * artifact library.
 *
 *  - Seed categories (Charts / Reports / Code / Images / HTML / PPT)
 *    are rendered as top-level rows. They cannot be renamed or
 *    deleted; their hover menu only offers `New sub-folder`.
 *  - User-created sub-folders + leaf artifacts expose
 *    `Rename` / `Move to…` (deferred to detail page in M2) / `Delete`
 *    via the same hover menu.
 *  - Clicking a leaf navigates to `/artifact/<id>` for full preview.
 *
 * Search box: client-side substring match on `name`. Matches preserve
 * their ancestor chain so the user always sees full path context.
 *
 * @see docs/artifact-dashboard-migration.md §11.2
 */

import {
  ChevronDown,
  ChevronRight,
  Folder,
  FolderOpen,
  FilePlus,
  FolderPlus,
  Loader2,
  MoreHorizontal,
  Pencil,
  RefreshCw,
  Search,
  Sparkles,
  Trash2,
  Sparkles as ArtifactIcon,
} from "lucide-react";
import { useRouter } from "next/navigation";
import {
  Fragment,
  useCallback,
  useMemo,
  useState,
  type ReactElement,
} from "react";
import { toast } from "sonner";

import { ArtifactFolderTreeSelect } from "@/components/library/ArtifactFolderTreeSelect";
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
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useArtifactTree, type ArtifactNode } from "@/hooks/useArtifactTree";
import { cn } from "@/lib/utils";

interface MenuTarget {
  node: ArtifactNode;
  /** Whether the node is a system-seeded top-level category. Read-
   *  only at the API layer; the panel mirrors that here. */
  isSeed: boolean;
}

type DialogState =
  | { kind: "none" }
  | { kind: "newFolder"; parent: ArtifactNode }
  | { kind: "rename"; node: ArtifactNode }
  | { kind: "move"; node: ArtifactNode }
  | { kind: "delete"; node: ArtifactNode };

export function ArtifactPanel(): ReactElement {
  const router = useRouter();
  const { tree, isLoading, error, mutate } = useArtifactTree();
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState<string>("");
  const [dialog, setDialog] = useState<DialogState>({ kind: "none" });

  const trimmedSearch: string = search.trim().toLowerCase();
  const filteredTree: ArtifactNode[] | undefined = useMemo(() => {
    if (!tree) return undefined;
    if (trimmedSearch.length === 0) return tree;
    return tree
      .map((root) => filterTree(root, trimmedSearch))
      .filter((n): n is ArtifactNode => n !== null);
  }, [tree, trimmedSearch]);

  const toggle = useCallback((id: string): void => {
    setExpanded((prev) => {
      const next: Set<string> = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // Search-driven expansion is derived during render rather than
  // pushed through setState in an effect/useMemo: while a search
  // term is active every matching folder is forced open so its hits
  // are visible. When the search clears we fall back to the user's
  // manually-toggled `expanded` set, preserving their collapse
  // state. See https://react.dev/learn/you-might-not-need-an-effect
  // ("Adjusting state based on props or state").
  const effectiveExpanded: Set<string> = useMemo(() => {
    if (trimmedSearch.length === 0 || !filteredTree) return expanded;
    const next: Set<string> = new Set(expanded);
    const walk = (xs: ArtifactNode[]): void => {
      for (const n of xs) {
        if (n.kind === "folder") {
          next.add(n.id);
          walk(n.children);
        }
      }
    };
    walk(filteredTree);
    return next;
  }, [expanded, trimmedSearch, filteredTree]);

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-center gap-2 border-b px-4 py-3">
        <Sparkles className="h-4 w-4 text-muted-foreground" />
        <h2 className="text-sm font-semibold">Artifacts</h2>
        <div className="ml-auto">
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            onClick={() => void mutate()}
            aria-label="Refresh"
            disabled={isLoading}
          >
            <RefreshCw
              className={cn("h-3.5 w-3.5", isLoading && "animate-spin")}
            />
          </Button>
        </div>
      </div>

      {/* Search */}
      <div className="border-b px-3 py-2">
        <div className="relative">
          <Search className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search…"
            className="h-7 pl-7 text-xs"
          />
        </div>
      </div>

      {/* Body */}
      <ScrollArea className="min-h-0 flex-1">
        {error && (
          <div className="m-3 rounded border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive">
            Failed to load: {error.message}
          </div>
        )}

        {isLoading && !tree && (
          <div className="flex items-center justify-center gap-2 py-8 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Loading…
          </div>
        )}

        {filteredTree && filteredTree.length === 0 && trimmedSearch.length > 0 && (
          <div className="py-8 text-center text-xs text-muted-foreground">
            No artifacts match &ldquo;{trimmedSearch}&rdquo;.
          </div>
        )}

        {filteredTree && filteredTree.length === 0 && trimmedSearch.length === 0 && (
          <div className="flex flex-col items-center justify-center gap-2 p-6 text-center">
            <Sparkles className="h-8 w-8 text-muted-foreground/50" />
            <p className="text-xs text-muted-foreground">
              No artifacts yet. Save a chart from a chat to populate
              the library.
            </p>
          </div>
        )}

        {filteredTree && filteredTree.length > 0 && (
          <div className="py-1">
            {filteredTree.map((node) => (
              <NodeRow
                key={node.id}
                node={node}
                depth={0}
                expanded={effectiveExpanded}
                onToggle={toggle}
                onOpenLeaf={(id) => router.push(`/artifact/${id}`)}
                onMenuAction={(action, target) => {
                  switch (action) {
                    case "newSubFolder":
                      setDialog({ kind: "newFolder", parent: target.node });
                      break;
                    case "rename":
                      setDialog({ kind: "rename", node: target.node });
                      break;
                    case "move":
                      setDialog({ kind: "move", node: target.node });
                      break;
                    case "delete":
                      setDialog({ kind: "delete", node: target.node });
                      break;
                  }
                }}
              />
            ))}
          </div>
        )}
      </ScrollArea>

      {/* Dialogs */}
      {dialog.kind === "newFolder" && (
        <NameInputDialog
          title="New sub-folder"
          description={`Create a folder under "${dialog.parent.name}".`}
          initialValue=""
          confirmLabel="Create"
          onCancel={() => setDialog({ kind: "none" })}
          onConfirm={async (name) => {
            const ok = await postFolder(dialog.parent.id, name);
            if (ok) {
              setExpanded((prev) => new Set(prev).add(dialog.parent.id));
              await mutate();
              setDialog({ kind: "none" });
            }
          }}
        />
      )}

      {dialog.kind === "rename" && (
        <NameInputDialog
          title={`Rename ${dialog.node.kind === "folder" ? "folder" : "artifact"}`}
          initialValue={dialog.node.name}
          confirmLabel="Rename"
          onCancel={() => setDialog({ kind: "none" })}
          onConfirm={async (name) => {
            const ok = await patchNode(dialog.node.id, { name });
            if (ok) {
              await mutate();
              setDialog({ kind: "none" });
            }
          }}
        />
      )}

      {dialog.kind === "move" && (
        <MoveDialog
          node={dialog.node}
          onCancel={() => setDialog({ kind: "none" })}
          onConfirm={async (parentId) => {
            const ok = await patchNode(dialog.node.id, { parentId });
            if (ok) {
              await mutate();
              setDialog({ kind: "none" });
            }
          }}
        />
      )}

      {dialog.kind === "delete" && (
        <AlertDialog open onOpenChange={(o) => !o && setDialog({ kind: "none" })}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                Delete {dialog.node.kind === "folder" ? "folder" : "artifact"}?
              </AlertDialogTitle>
              <AlertDialogDescription>
                {dialog.node.kind === "folder" ? (
                  <>
                    The folder &ldquo;{dialog.node.name}&rdquo; will be removed.
                    Folders with contents cannot be deleted — clear or
                    move their contents first.
                  </>
                ) : (
                  <>
                    The artifact &ldquo;{dialog.node.name}&rdquo; will be permanently
                    removed from your library. This cannot be undone.
                  </>
                )}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                onClick={async () => {
                  const ok = await deleteNode(dialog.node.id);
                  if (ok) {
                    await mutate();
                    setDialog({ kind: "none" });
                  }
                }}
              >
                Delete
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </div>
  );
}

// row renderer

interface NodeRowProps {
  node: ArtifactNode;
  depth: number;
  expanded: Set<string>;
  onToggle: (id: string) => void;
  onOpenLeaf: (id: string) => void;
  onMenuAction: (
    action: "newSubFolder" | "rename" | "move" | "delete",
    target: MenuTarget,
  ) => void;
}

function NodeRow({
  node,
  depth,
  expanded,
  onToggle,
  onOpenLeaf,
  onMenuAction,
}: NodeRowProps): ReactElement {
  const isFolder: boolean = node.kind === "folder";
  const isSeed: boolean = node.parentId === null && isFolder;
  const isExpanded: boolean = expanded.has(node.id);
  const hasChildren: boolean = node.children.length > 0;

  return (
    <Fragment>
      <div
        className={cn(
          "group flex items-center gap-1 px-2 py-1 text-xs",
          "hover:bg-muted/40",
        )}
        style={{ paddingLeft: `${0.5 + depth * 1}rem` }}
      >
        {/* Expand chevron — folders only */}
        {isFolder ? (
          <button
            type="button"
            className="cursor-pointer inline-flex h-4 w-4 shrink-0 items-center justify-center rounded hover:bg-muted"
            onClick={() => onToggle(node.id)}
            aria-label={isExpanded ? "Collapse" : "Expand"}
          >
            {hasChildren ? (
              isExpanded ? (
                <ChevronDown className="h-3 w-3 text-muted-foreground" />
              ) : (
                <ChevronRight className="h-3 w-3 text-muted-foreground" />
              )
            ) : null}
          </button>
        ) : (
          <span className="inline-block h-4 w-4 shrink-0" />
        )}

        {/* Icon */}
        {isFolder ? (
          isExpanded ? (
            <FolderOpen className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          ) : (
            <Folder className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          )
        ) : (
          <ArtifactIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        )}

        {/* Label — folders just toggle, leaves navigate */}
        <button
          type="button"
          className="cursor-pointer flex-1 min-w-0 truncate text-left"
          onClick={() => (isFolder ? onToggle(node.id) : onOpenLeaf(node.id))}
        >
          {node.name}
        </button>

        {/* Hover ⋯ menu */}
        <DropdownMenu>
          <DropdownMenuTrigger
            className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded opacity-0 transition-opacity group-hover:opacity-100 hover:bg-muted data-[popup-open]:opacity-100"
            aria-label="More actions"
            onClick={(e) => e.stopPropagation()}
          >
            <MoreHorizontal className="h-3.5 w-3.5 text-muted-foreground" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-44">
            {isFolder && (
              <DropdownMenuItem
                onClick={() =>
                  onMenuAction("newSubFolder", { node, isSeed })
                }
              >
                <FolderPlus className="mr-2 h-3.5 w-3.5" />
                New sub-folder
              </DropdownMenuItem>
            )}
            {!isSeed && (
              <Fragment>
                <DropdownMenuItem
                  onClick={() => onMenuAction("rename", { node, isSeed })}
                >
                  <Pencil className="mr-2 h-3.5 w-3.5" />
                  Rename
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => onMenuAction("move", { node, isSeed })}
                >
                  <FilePlus className="mr-2 h-3.5 w-3.5" />
                  Move to…
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  className="text-destructive focus:text-destructive"
                  onClick={() => onMenuAction("delete", { node, isSeed })}
                >
                  <Trash2 className="mr-2 h-3.5 w-3.5" />
                  Delete
                </DropdownMenuItem>
              </Fragment>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {isFolder
        && isExpanded
        && node.children.map((child) => (
          <NodeRow
            key={child.id}
            node={child}
            depth={depth + 1}
            expanded={expanded}
            onToggle={onToggle}
            onOpenLeaf={onOpenLeaf}
            onMenuAction={onMenuAction}
          />
        ))}
    </Fragment>
  );
}

// dialogs

interface NameInputDialogProps {
  title: string;
  description?: string;
  initialValue: string;
  confirmLabel: string;
  onCancel: () => void;
  onConfirm: (name: string) => Promise<void>;
}

function NameInputDialog({
  title,
  description,
  initialValue,
  confirmLabel,
  onCancel,
  onConfirm,
}: NameInputDialogProps): ReactElement {
  const [name, setName] = useState<string>(initialValue);
  const [busy, setBusy] = useState<boolean>(false);
  const trimmed: string = name.trim();
  const canSubmit: boolean = trimmed.length > 0 && !busy;

  const handleConfirm = async (): Promise<void> => {
    if (!canSubmit) return;
    setBusy(true);
    try {
      await onConfirm(trimmed);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onCancel()}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        <div className="grid gap-1.5 py-2">
          <Label htmlFor="folder-name">Name</Label>
          <Input
            id="folder-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={200}
            autoFocus
            onKeyDown={(e) => {
              if (e.key === "Enter") void handleConfirm();
            }}
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={handleConfirm} disabled={!canSubmit}>
            {busy && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface MoveDialogProps {
  node: ArtifactNode;
  onCancel: () => void;
  onConfirm: (parentId: string) => Promise<void>;
}

function MoveDialog({ node, onCancel, onConfirm }: MoveDialogProps): ReactElement {
  const [target, setTarget] = useState<string | null>(node.parentId ?? null);
  const [busy, setBusy] = useState<boolean>(false);
  const canSubmit: boolean = target !== null && target !== node.parentId && !busy;

  const handleConfirm = async (): Promise<void> => {
    if (!canSubmit || target === null) return;
    setBusy(true);
    try {
      await onConfirm(target);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onCancel()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Move &ldquo;{node.name}&rdquo;</DialogTitle>
          <DialogDescription>
            Pick a new parent folder. {node.kind === "folder" && "Folders cannot be moved under their own descendants."}
          </DialogDescription>
        </DialogHeader>
        <div className="py-2">
          <ArtifactFolderTreeSelect
            value={target}
            onChange={setTarget}
            allowRoot
            disabledSubtreeRootId={node.kind === "folder" ? node.id : undefined}
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={handleConfirm} disabled={!canSubmit}>
            {busy && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}
            Move
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// API helpers

async function postFolder(parentId: string, name: string): Promise<boolean> {
  try {
    const res = await fetch("/api/artifacts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "folder", name, parentId }),
    });
    if (!res.ok) {
      throw new Error((await res.json().catch(() => ({}))).message ?? res.statusText);
    }
    return true;
  } catch (err) {
    toast.error(err instanceof Error ? err.message : "Failed to create folder");
    return false;
  }
}

async function patchNode(
  id: string,
  patch: { name?: string; parentId?: string },
): Promise<boolean> {
  try {
    const res = await fetch(`/api/artifacts/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (!res.ok) {
      throw new Error((await res.json().catch(() => ({}))).message ?? res.statusText);
    }
    return true;
  } catch (err) {
    toast.error(err instanceof Error ? err.message : "Failed to update");
    return false;
  }
}

async function deleteNode(id: string): Promise<boolean> {
  try {
    const res = await fetch(`/api/artifacts/${id}`, { method: "DELETE" });
    if (!res.ok) {
      throw new Error((await res.json().catch(() => ({}))).message ?? res.statusText);
    }
    return true;
  } catch (err) {
    toast.error(err instanceof Error ? err.message : "Failed to delete");
    return false;
  }
}

// search helpers

/** Return a copy of `node` keeping only the subtrees whose names
 *  match `query` (substring match, case-insensitive). Returns `null`
 *  if no descendant matches. */
function filterTree(node: ArtifactNode, query: string): ArtifactNode | null {
  const selfMatch: boolean = node.name.toLowerCase().includes(query);
  const filteredChildren: ArtifactNode[] = node.children
    .map((c) => filterTree(c, query))
    .filter((n): n is ArtifactNode => n !== null);
  if (!selfMatch && filteredChildren.length === 0) return null;
  return { ...node, children: filteredChildren };
}
