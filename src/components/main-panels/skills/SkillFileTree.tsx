"use client";

/**
 * SkillFileTree — read-only browser for one skill's helper files.
 *
 * `SKILL.md` is a synthetic node: it lives in the `skill.skill_md` column, not
 * in `skill_file`, so it is prepended rather than parsed out of the listing.
 * Helper files can only be added or removed by importing a `.skill` archive —
 * hence no write affordances anywhere in here. See docs/skills.md.
 */

import {
  ChevronDown,
  ChevronRight,
  FileText,
  Folder,
  FolderOpen,
  Terminal,
} from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";

/** Metadata row from `GET /api/skills/[id]` — path / size / contentType, no content. */
export interface SkillFileMeta {
  path: string;
  size: number;
  contentType: string | null;
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
  source: string;
  /** Normalized `scripts/<file>` entries from the frontmatter. */
  scriptsOnSsh: string[];
  missingSshScripts: string[];
  /** Unsaved SKILL.md edits — marked so switching files does not hide them. */
  skillMdDirty: boolean;
}

export function SkillFileTree({
  files,
  selected,
  onSelect,
  source,
  scriptsOnSsh,
  missingSshScripts,
  skillMdDirty,
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

  function renderNodes(nodes: TreeNode[], depth: number): ReactNode {
    return nodes.map((node) => {
      if (node.kind === "dir") {
        const open = expanded.has(node.path);
        return (
          <div key={node.path}>
            <button
              type="button"
              onClick={() => toggleDir(node.path)}
              style={{ paddingLeft: `${depth * 12 + 8}px` }}
              className="flex w-full cursor-pointer items-center gap-1 py-1 pr-2 text-left text-xs text-muted-foreground hover:bg-muted/40 hover:text-foreground"
              aria-expanded={open}
            >
              {open ? (
                <ChevronDown className="h-3 w-3 shrink-0" />
              ) : (
                <ChevronRight className="h-3 w-3 shrink-0" />
              )}
              {open ? (
                <FolderOpen className="h-3.5 w-3.5 shrink-0" />
              ) : (
                <Folder className="h-3.5 w-3.5 shrink-0" />
              )}
              <span className="truncate">{node.label}</span>
            </button>
            {open && renderNodes(node.children, depth + 1)}
          </div>
        );
      }
      return (
        <button
          key={node.path}
          type="button"
          onClick={() => onSelect(node.path)}
          style={{ paddingLeft: `${depth * 12 + 20}px` }}
          title={node.path}
          aria-current={selected === node.path}
          className={cn(
            "flex w-full cursor-pointer items-center gap-1.5 py-1 pr-2 text-left text-xs hover:bg-muted/40",
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
        </button>
      );
    });
  }

  return (
    <div className="flex h-full w-80 shrink-0 flex-col border-r">
      {source === "builtin" && (
        <div className="border-b px-3 py-2">
          <Badge
            variant="outline"
            className="h-4 px-1 text-[10px] leading-none text-muted-foreground"
          >
            builtin · read-only
          </Badge>
        </div>
      )}

      {missingSshScripts.length > 0 && (
        <div className="border-b border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] leading-snug text-amber-700 dark:text-amber-400">
          <code className="font-mono">scripts-on-ssh</code> declares missing
          file(s): {missingSshScripts.join(", ")}. Drop them from the
          declaration, or re-import the archive with them.
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
          {skillMdDirty && (
            <span
              className="ml-auto h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500"
              aria-label="Unsaved changes"
              title="Unsaved changes"
            />
          )}
        </button>

        {files.length === 0 ? (
          <p className="px-3 py-3 text-[11px] leading-snug text-muted-foreground">
            No helper files. Files can only be added by importing a{" "}
            <code className="font-mono">.skill</code> archive.
          </p>
        ) : (
          <div className="py-1">{renderNodes(tree, 0)}</div>
        )}
      </ScrollArea>
    </div>
  );
}
