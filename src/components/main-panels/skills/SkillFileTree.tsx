"use client";

/**
 * SkillFileTree — read-only browser for one skill's helper files plus the
 * per-node rename/delete actions and the add-file button.
 *
 * `SKILL.md` is a synthetic node: it lives in the `skill.skill_md` column, not
 * in `skill_file`, so it is prepended rather than parsed out of the listing
 * and gets no file actions. Folders are implicit path prefixes: they exist
 * only while at least one file lives under them. See docs/skills.md.
 */

import {
  ChevronDown,
  ChevronRight,
  FileText,
  Folder,
  FolderOpen,
  Pencil,
  Plus,
  Terminal,
  Trash2,
} from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";

/** Metadata row from `GET /api/skills/[id]` — path / size / contentType, no content. */
export interface SkillFileMeta {
  path: string;
  size: number;
  contentType: string | null;
}

export type SkillFileNodeKind = "file" | "folder";

export interface SkillFileTarget {
  path: string;
  kind: SkillFileNodeKind;
}

/** Selection sentinel for the `skill.skill_md` column. Not a `skill_file.path`. */
export const SKILL_MD_PATH = "SKILL.md";

export interface TreeNode {
  /** Last path segment — what the row renders. */
  label: string;
  /** Full path: a file's `skill_file.path`, or a directory prefix. */
  path: string;
  kind: "dir" | "file";
  children: TreeNode[];
}

const collator = new Intl.Collator(undefined, {
  sensitivity: "base",
  numeric: true,
});

function sortNodes(nodes: TreeNode[]): TreeNode[] {
  return nodes
    .map((n) =>
      n.kind === "dir" ? { ...n, children: sortNodes(n.children) } : n,
    )
    // Directories first so a group stays contiguous regardless of name.
    .sort((a, b) =>
      a.kind === b.kind ? collator.compare(a.label, b.label) : a.kind === "dir" ? -1 : 1,
    );
}

export function buildTree(files: SkillFileMeta[]): TreeNode[] {
  const root: TreeNode[] = [];
  for (const file of files) {
    const segments = file.path.split("/");
    let level = root;
    let prefix = "";
    for (let i = 0; i < segments.length; i += 1) {
      prefix = prefix ? `${prefix}/${segments[i]}` : segments[i];
      const isLeaf = i === segments.length - 1;
      const kind: TreeNode["kind"] = isLeaf ? "file" : "dir";
      let node = level.find((n) => n.path === prefix && n.kind === kind);
      if (!node) {
        node = {
          label: segments[i],
          path: prefix,
          kind,
          children: [],
        };
        level.push(node);
      }
      level = node.children;
    }
  }
  return sortNodes(root);
}

export interface SkillFileTreeProps {
  files: SkillFileMeta[];
  /** `SKILL_MD_PATH` or a `skill_file.path`. */
  selected: string;
  onSelect: (path: string) => void;
  onAdd: () => void;
  onRename: (target: SkillFileTarget) => void;
  onDelete: (target: SkillFileTarget) => void;
  /** Normalized `scripts/<file>` entries from the frontmatter. */
  scriptsOnSsh: string[];
  missingSshScripts: string[];
  /** Path with unsaved edits — rendered with a dot. */
  dirtyPath: string | null;
}

export function SkillFileTree({
  files,
  selected,
  onSelect,
  onAdd,
  onRename,
  onDelete,
  scriptsOnSsh,
  missingSshScripts,
  dirtyPath,
}: SkillFileTreeProps): ReactNode {
  const tree = useMemo(() => buildTree(files), [files]);
  const sshSet = useMemo(() => new Set(scriptsOnSsh), [scriptsOnSsh]);
  // Folders start collapsed: imported archives carry author-chosen layouts of
  // arbitrary depth, so the top level is the only thing worth scanning on open.
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  function toggleDir(path: string): void {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  function renderActions(target: SkillFileTarget): ReactNode {
    return (
      <div className="ml-2 flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
        <button
          type="button"
          title={target.kind === "folder" ? "Rename folder" : "Rename file"}
          aria-label={`Rename ${target.path}`}
          className="cursor-pointer rounded p-0.5 text-muted-foreground/70 transition-colors hover:text-blue-500"
          onClick={(e) => {
            e.stopPropagation();
            onRename(target);
          }}
        >
          <Pencil className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          title={target.kind === "folder" ? "Delete folder" : "Delete file"}
          aria-label={`Delete ${target.path}`}
          className="cursor-pointer rounded p-0.5 text-muted-foreground/70 transition-colors hover:text-destructive"
          onClick={(e) => {
            e.stopPropagation();
            onDelete(target);
          }}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
    );
  }

  function renderNodes(nodes: TreeNode[], depth: number): ReactNode {
    return nodes.map((node) => {
      if (node.kind === "dir") {
        const open = expanded.has(node.path);
        return (
          <div key={node.path}>
            <div className="group flex items-center pr-2 hover:bg-muted/30">
              <button
                type="button"
                onClick={() => toggleDir(node.path)}
                style={{ paddingLeft: `${depth * 12 + 8}px` }}
                className="flex min-w-0 flex-1 cursor-pointer items-center gap-1 py-1 text-left text-xs text-muted-foreground hover:text-foreground"
                aria-expanded={open}
              >
                {open ? (
                  <ChevronDown className="h-3 w-3 shrink-0" />
                ) : (
                  <ChevronRight className="h-3 w-3 shrink-0" />
                )}
                {open ? (
                  <FolderOpen className="h-3.5 w-3.5 shrink-0 text-blue-500/80 dark:text-blue-400/80" />
                ) : (
                  <Folder className="h-3.5 w-3.5 shrink-0 text-blue-500/80 dark:text-blue-400/80" />
                )}
                <span className="truncate">{node.label}</span>
              </button>
              {renderActions({ path: node.path, kind: "folder" })}
            </div>
            {open && renderNodes(node.children, depth + 1)}
          </div>
        );
      }
      return (
        <div
          key={node.path}
          className="group flex items-center pr-2 hover:bg-muted/30"
        >
          <button
            type="button"
            onClick={() => onSelect(node.path)}
            style={{ paddingLeft: `${depth * 12 + 20}px` }}
            title={node.path}
            aria-current={selected === node.path}
            className={cn(
              "flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 py-1 text-left text-xs",
              selected === node.path
                ? "bg-accent text-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <FileText className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate">{node.label}</span>
            {sshSet.has(node.path) && (
              <Terminal
                className="h-3 w-3 shrink-0 text-sky-500"
                aria-label="Runs on a bound SSH host"
              />
            )}
            {dirtyPath === node.path && (
              <span
                className="ml-1 h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500"
                aria-label="Unsaved changes"
                title="Unsaved changes"
              />
            )}
          </button>
          {renderActions({ path: node.path, kind: "file" })}
        </div>
      );
    });
  }

  return (
    <div className="flex h-full w-80 shrink-0 flex-col border-r">
      <div className="flex h-9 shrink-0 items-center justify-between border-b px-3">
        <span className="text-xs font-medium text-muted-foreground">Files</span>
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6"
          onClick={onAdd}
          aria-label="Add file"
          title="Add file"
        >
          <Plus className="h-3.5 w-3.5" />
        </Button>
      </div>

      {missingSshScripts.length > 0 && (
        <div className="border-b border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] leading-snug text-amber-700 dark:text-amber-400">
          <code className="font-mono">scripts-on-ssh</code> declares missing
          file(s): {missingSshScripts.join(", ")}. Drop them from the
          declaration, add the missing file under scripts/, or delete the
          declaration.
        </div>
      )}

      <ScrollArea className="min-h-0 flex-1">
        <button
          type="button"
          onClick={() => onSelect(SKILL_MD_PATH)}
          aria-current={selected === SKILL_MD_PATH}
          className={cn(
            "flex w-full cursor-pointer items-center gap-1.5 border-b border-border/60 px-3 py-1.5 text-left text-xs font-medium hover:bg-muted/40",
            selected === SKILL_MD_PATH
              ? "bg-accent text-foreground"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          <FileText className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">{SKILL_MD_PATH}</span>
          {dirtyPath === SKILL_MD_PATH && (
            <span
              className="ml-auto h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500"
              aria-label="Unsaved changes"
              title="Unsaved changes"
            />
          )}
        </button>

        {files.length === 0 ? (
          <p className="px-3 py-3 text-[11px] leading-snug text-muted-foreground">
            No helper files. Use the + button to add a text file; binary assets
            come from a <code className="font-mono">.skill</code> import.
          </p>
        ) : (
          <div className="py-1">{renderNodes(tree, 0)}</div>
        )}
      </ScrollArea>
    </div>
  );
}
