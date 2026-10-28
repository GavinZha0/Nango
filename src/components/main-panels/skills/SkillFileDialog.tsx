"use client";

/**
 * SkillFileDialog — create a text helper file, or rename a file/folder.
 *
 * Parent folders are derived from existing file paths; choosing
 * "+ Create new folder..." creates the folder implicitly with the new file.
 * Binary assets are imported, never created here.
 */

import { useMemo, useState, type ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

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
import type { SkillFileMeta } from "@/components/main-panels/skills/SkillFileTree";
import {
  getBaseName,
  getParentPath,
  isExecutableFileName,
  isRootSkillMd,
  isValidFileName,
  joinSkillPath,
} from "@/lib/skills/file-rules";
import {
  classifyEditorCreatePath,
  classifyEditorRenamePath,
} from "@/lib/skills/import-policy";

const ROOT_VALUE = "__root__";
const NEW_FOLDER_VALUE = "__new__";

export interface SkillFileDialogProps {
  skillId: string;
  mode: "add" | "rename";
  files: SkillFileMeta[];
  /** Add mode: preselected parent ("" = root). */
  defaultParentFolder?: string;
  /** Rename mode target. */
  target?: { path: string; kind: "file" | "folder" };
  onClose: () => void;
  onSaved: (path: string) => void;
}

function collectFolders(files: SkillFileMeta[]): string[] {
  const folders = new Set<string>();
  for (const file of files) {
    let parent = getParentPath(file.path);
    while (parent) {
      folders.add(parent);
      parent = getParentPath(parent);
    }
  }
  return [...folders].sort((a, b) =>
    a.localeCompare(b, undefined, { sensitivity: "base", numeric: true }),
  );
}

export function SkillFileDialog({
  skillId,
  mode,
  files,
  defaultParentFolder = "",
  target,
  onClose,
  onSaved,
}: SkillFileDialogProps): ReactNode {
  const folders = useMemo(() => collectFolders(files), [files]);
  const [name, setName] = useState<string>(() =>
    mode === "rename" && target ? getBaseName(target.path) : "",
  );
  const [parentFolder, setParentFolder] = useState<string>(() =>
    mode === "add"
      ? defaultParentFolder
        ? defaultParentFolder
        : ROOT_VALUE
      : ROOT_VALUE,
  );
  const [newFolderName, setNewFolderName] = useState<string>("");
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  const targetParent = target ? getParentPath(target.path) : "";
  const effectiveParent =
    mode === "add"
      ? parentFolder === ROOT_VALUE
        ? ""
        : parentFolder === NEW_FOLDER_VALUE
          ? newFolderName.trim()
          : parentFolder
      : targetParent;

  const trimmedName = name.trim();
  const resultingPath = joinSkillPath(effectiveParent, trimmedName);
  const isFolderRename = mode === "rename" && target?.kind === "folder";
  const descendantCount =
    isFolderRename && target
      ? files.filter((f) => f.path.startsWith(`${target.path}/`)).length
      : 0;

  const validationError = useMemo(() => {
    if (mode === "add" && parentFolder === NEW_FOLDER_VALUE) {
      if (!isValidFileName(newFolderName.trim())) {
        return "Enter a valid folder name (letters, digits, dot, underscore or hyphen).";
      }
    }
    if (trimmedName.length === 0) return null;
    if (!isValidFileName(trimmedName)) {
      return "Use letters, digits, dot, underscore or hyphen; do not start with a dot.";
    }
    const policy =
      mode === "add"
        ? classifyEditorCreatePath(resultingPath)
        : target?.kind === "file"
          ? classifyEditorRenamePath(resultingPath)
          : null;
    if (mode === "add" && policy && policy.action !== "allow-text") {
      return policy.reason ?? "This file type is not allowed.";
    }
    if (
      mode === "rename" &&
      target?.kind === "file" &&
      policy &&
      policy.action !== "allow-text" &&
      policy.action !== "allow-image"
    ) {
      return policy.reason ?? "This file type is not allowed.";
    }
    if (target?.kind === "folder" && target.path === "scripts") {
      return "The top-level scripts/ folder is reserved and cannot be renamed.";
    }
    if (
      (mode === "add" || target?.kind === "file") &&
      isExecutableFileName(trimmedName) &&
      !(effectiveParent === "scripts" || effectiveParent.startsWith("scripts/"))
    ) {
      return "Executable scripts must live under scripts/.";
    }
    if (mode === "add" && isRootSkillMd(resultingPath)) {
      return "SKILL.md is the main document; choose another name.";
    }
    return null;
  }, [
    mode,
    parentFolder,
    newFolderName,
    trimmedName,
    target?.kind,
    target?.path,
    effectiveParent,
    resultingPath,
  ]);

  const canSubmit =
    !submitting && trimmedName.length > 0 && validationError === null;

  async function submit(): Promise<void> {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      let res: Response;
      if (mode === "add") {
        res = await fetch(`/api/skills/${skillId}/files`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            parentFolder: effectiveParent,
            name: trimmedName,
          }),
        });
      } else if (target) {
        res = await fetch(
          `/api/skills/${skillId}/files/${encodeURI(target.path)}?kind=${target.kind}`,
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name: trimmedName }),
          },
        );
      } else {
        return;
      }

      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as
          | { message?: string; error?: string }
          | null;
        throw new Error(body?.message ?? body?.error ?? `HTTP ${res.status}`);
      }
      const data = (await res.json()) as { path?: string; warning?: string };
      if (data.warning) toast.warning(data.warning);
      toast.success(mode === "add" ? "File created" : "Renamed");
      onSaved(data.path ?? resultingPath);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !submitting) onClose();
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {mode === "add"
              ? "New file"
              : isFolderRename
                ? "Rename folder"
                : "Rename file"}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {mode === "add" ? (
            <>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="skill-file-parent">Parent folder</Label>
                <Select
                  value={parentFolder}
                  onValueChange={(value) => setParentFolder(value ?? ROOT_VALUE)}
                  disabled={submitting}
                >
                  <SelectTrigger id="skill-file-parent" className="w-full">
                    <SelectValue placeholder="Select folder">
                      {parentFolder === ROOT_VALUE
                        ? "Root"
                        : parentFolder === NEW_FOLDER_VALUE
                          ? "+ Create new folder..."
                          : parentFolder}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={ROOT_VALUE} label="Root">
                      Root
                    </SelectItem>
                    {folders.map((folder) => (
                      <SelectItem key={folder} value={folder} label={folder}>
                        {folder}
                      </SelectItem>
                    ))}
                    <SelectItem
                      value={NEW_FOLDER_VALUE}
                      label="+ Create new folder..."
                      className="text-primary font-semibold"
                    >
                      + Create new folder...
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {parentFolder === NEW_FOLDER_VALUE && (
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="skill-new-folder">New folder name</Label>
                  <Input
                    id="skill-new-folder"
                    value={newFolderName}
                    onChange={(e) => setNewFolderName(e.target.value)}
                    placeholder="references"
                    disabled={submitting}
                    autoFocus
                  />
                </div>
              )}

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="skill-file-name">File name</Label>
                <Input
                  id="skill-file-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="guide.md"
                  disabled={submitting}
                  autoFocus={parentFolder !== NEW_FOLDER_VALUE}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && canSubmit) {
                      e.preventDefault();
                      void submit();
                    }
                  }}
                />
                <p className="text-[11px] text-muted-foreground">
                  Helper files are text. Use a folder import for
                  binary assets.
                </p>
              </div>
            </>
          ) : (
            <>
              <div className="rounded-md border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
                <div className="truncate font-mono">{target?.path}</div>
                {isFolderRename && (
                  <div className="mt-1">
                    This folder contains {descendantCount} file
                    {descendantCount === 1 ? "" : "s"}.
                  </div>
                )}
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="skill-file-rename">
                  {isFolderRename ? "Folder name" : "File name"}
                </Label>
                <Input
                  id="skill-file-rename"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  disabled={submitting}
                  autoFocus
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && canSubmit) {
                      e.preventDefault();
                      void submit();
                    }
                  }}
                />
              </div>
            </>
          )}

          {(error ?? validationError) && (
            <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {error ?? validationError}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={onClose}
            disabled={submitting}
          >
            Cancel
          </Button>
          <Button type="button" onClick={() => void submit()} disabled={!canSubmit}>
            {submitting && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
            {mode === "add" ? "Create" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
