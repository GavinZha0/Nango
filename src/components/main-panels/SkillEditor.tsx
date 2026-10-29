"use client";

/**
 * SkillEditor — full-area form for creating / editing one Skill.
 *
 * Two columns: a file tree on the left, the editable document on the right.
 * `SKILL.md` and text helper files are edited in the main pane; binary files
 * are preview-only. The tree's Edit action only renames. Switching files or
 * opening a file action while the current file is dirty goes through a
 * Save / Ignore gate, so at most one file is ever dirty.
 *
 * See docs/skills.md.
 */

import {
  useState,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  startTransition,
  type ReactNode,
} from "react";
import { ArrowLeft, FileText, Loader2, Save, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useCopilotDraft } from "@/hooks/useCopilotDraft";
import { parseSkillMd } from "@/lib/skills/parser";
import { DeleteConfirmDialog } from "@/components/ui/delete-confirm-dialog";
import {
  SkillFileTree,
  SKILL_MD_PATH,
  type SkillFileMeta,
  type SkillFileTarget,
} from "@/components/main-panels/skills/SkillFileTree";
import { SkillFileDialog } from "@/components/main-panels/skills/SkillFileDialog";
import { UnsavedChangesDialog } from "@/components/main-panels/skills/UnsavedChangesDialog";
import { getParentPath } from "@/lib/paths";
import { cn, formatBytes } from "@/lib/utils";

export interface SkillRow {
  id: string;
  path: string;
  name: string;
  description: string | null;
  /** Free-form origin label (e.g. "anthropic", "skills.sh"); "" = unlabeled. */
  source: string;
  enabled: boolean;
  visibility: "private" | "public" | string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface SkillDetail extends SkillRow {
  skillMd: string;
  version: string;
  /** Helper-file metadata (no content) — drives the tree. */
  files: SkillFileMeta[];
  /** Normalized `scripts/<file>` entries declared in the frontmatter. */
  scriptsOnSsh: string[];
  /** Declared SSH scripts with no backing `skill_file` row. */
  missingSshScripts: string[];
  /** Normalized `scripts/<path>.sql` entries declared in the frontmatter. */
  scriptsOnDb: string[];
  /** Declared SQL scripts with no backing `skill_file` row. */
  missingDbScripts: string[];
}

/** Payload of `GET /api/skills/[id]/files/[...path]`. */
interface FilePayload {
  path: string;
  /** Decided server-side by a NUL-byte heuristic, not by contentType. */
  encoding: "utf8" | "base64";
  content: string;
  size: number;
}

/** Form-level state for the skill editor. */
interface FormState {
  source: string;
  skillMd: string;
}

/** Default SKILL.md template seeded on create. Mirrors Claude Skills convention. */
function buildTemplate(): string {
  const slug = "my-skill";
  return `---
name: ${slug}
description: One-sentence description of what this skill does AND when to invoke it. Mention the keywords / phrasings the user is likely to use, since this is what drives auto-loading.
version: 1.0.0
---

# ${slug}

Procedure:

1. ...
2. ...

When to use:

- ...

Notes:

- ...
`;
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function encodePath(path: string): string {
  return encodeURI(path);
}

export interface SkillEditorProps {
  /** Existing id when editing; null when creating. */
  skillId: string | null;
  /** Passed by page wrapper after fetching /api/skills/[id]. Parent remounts via `key` on id change. */
  initialDetail?: SkillDetail;
  onBack: () => void;
  onSaved: () => void;
  /**
   * Called after a successful DELETE. If omitted, `onBack` runs so
   * the user always lands somewhere coherent. Matches the optional
   * onDeleted convention used by BuiltinAgentEditor.
   */
  onDeleted?: (deletedId: string) => void;
}

export function SkillEditor({
  skillId,
  initialDetail,
  onBack,
  onSaved,
  onDeleted,
}: SkillEditorProps): ReactNode {
  const isCreating = skillId === null;

  // Delete state — destructive action, gated by a confirm dialog.
  const [deleteOpen, setDeleteOpen] = useState<boolean>(false);
  const [deleting, setDeleting] = useState<boolean>(false);

  // Form state — single object for all editable fields.
  const [form, setForm] = useState<FormState>(() => ({
    source: initialDetail?.source ?? "",
    skillMd: initialDetail?.skillMd ?? buildTemplate(),
  }));
  const [savedForm, setSavedForm] = useState<FormState>(() => ({
    source: initialDetail?.source ?? "",
    skillMd: initialDetail?.skillMd ?? buildTemplate(),
  }));
  const isSkillMdDirty = useMemo(
    () => form.source !== savedForm.source || form.skillMd !== savedForm.skillMd,
    [form, savedForm],
  );
  const update = useCallback(
    <K extends keyof FormState>(key: K, value: FormState[K]) =>
      setForm((prev) => ({ ...prev, [key]: value })),
    [],
  );

  const [saving, setSaving] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  // ── Files ───────────────────────────────────────────────────────
  const [files, setFiles] = useState<SkillFileMeta[]>(
    () => initialDetail?.files ?? [],
  );
  const [scriptsOnSsh, setScriptsOnSsh] = useState<string[]>(
    () => initialDetail?.scriptsOnSsh ?? [],
  );
  const [missingSshScripts, setMissingSshScripts] = useState<string[]>(
    () => initialDetail?.missingSshScripts ?? [],
  );
  const [scriptsOnDb, setScriptsOnDb] = useState<string[]>(
    () => initialDetail?.scriptsOnDb ?? [],
  );
  const [missingDbScripts, setMissingDbScripts] = useState<string[]>(
    () => initialDetail?.missingDbScripts ?? [],
  );
  const [selected, setSelected] = useState<string>(SKILL_MD_PATH);
  const [fileCache, setFileCache] = useState<Map<string, FilePayload>>(
    () => new Map(),
  );
  const [fileDraft, setFileDraft] = useState<string | null>(null);
  const [savedFileContent, setSavedFileContent] = useState<string | null>(null);
  const [fileLoading, setFileLoading] = useState<boolean>(false);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => () => abortRef.current?.abort(), []);

  const payload: FilePayload | null =
    selected === SKILL_MD_PATH ? null : (fileCache.get(selected) ?? null);
  const selectedMeta: SkillFileMeta | null =
    selected === SKILL_MD_PATH
      ? null
      : (files.find((f) => f.path === selected) ?? null);
  const isTextFile: boolean =
    selected !== SKILL_MD_PATH && payload?.encoding === "utf8";
  const isFileDirty: boolean =
    isTextFile &&
    fileDraft !== null &&
    savedFileContent !== null &&
    fileDraft !== savedFileContent;
  // Source is skill-level metadata, not a helper file; editing it while a
  // helper is selected still counts as an unsaved change.
  const currentDirty: boolean = isSkillMdDirty || isFileDirty;

  // ── Dialogs ─────────────────────────────────────────────────────
  const [addOpen, setAddOpen] = useState<boolean>(false);
  const [renameTarget, setRenameTarget] = useState<SkillFileTarget | null>(null);
  const [fileDeleteTarget, setFileDeleteTarget] = useState<SkillFileTarget | null>(null);
  const [fileDeleting, setFileDeleting] = useState<boolean>(false);
  const [unsavedOpen, setUnsavedOpen] = useState<boolean>(false);
  const [pendingAction, setPendingAction] = useState<{ run: () => void } | null>(null);

  // ── File loading ─────────────────────────────────────────────────
  const applyCachedPayload = useCallback(
    (path: string): void => {
      if (path === SKILL_MD_PATH) {
        setFileDraft(null);
        setSavedFileContent(null);
        return;
      }
      const cached = fileCache.get(path);
      const text = cached?.encoding === "utf8" ? cached.content : null;
      setFileDraft(text);
      setSavedFileContent(text);
    },
    [fileCache],
  );

  async function loadPath(path: string, force = false): Promise<void> {
    abortRef.current?.abort();

    if (path === SKILL_MD_PATH) {
      setSelected(path);
      setError(null);
      setFileLoading(false);
      setFileDraft(null);
      setSavedFileContent(null);
      return;
    }

    const previous = selected;
    setSelected(path);
    setError(null);

    const cached = force ? undefined : fileCache.get(path);
    if (cached) {
      setFileLoading(false);
      setFileDraft(cached.encoding === "utf8" ? cached.content : null);
      setSavedFileContent(cached.encoding === "utf8" ? cached.content : null);
      return;
    }

    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setFileLoading(true);
    try {
      const res = await fetch(
        `/api/skills/${skillId}/files/${encodePath(path)}`,
        { signal: ctrl.signal },
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as
          | { message?: string; error?: string }
          | null;
        throw new Error(body?.message ?? body?.error ?? `HTTP ${res.status}`);
      }
      const data = (await res.json()) as FilePayload;
      setFileCache((prev) => new Map(prev).set(path, data));
      setFileDraft(data.encoding === "utf8" ? data.content : null);
      setSavedFileContent(data.encoding === "utf8" ? data.content : null);
    } catch (err) {
      if ((err as Error).name === "AbortError") return;
      setSelected(previous);
      applyCachedPayload(previous);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (abortRef.current === ctrl) setFileLoading(false);
    }
  }

  function guardUnsaved(action: () => void): void {
    if (!currentDirty) {
      action();
      return;
    }
    setError(null);
    setPendingAction({ run: action });
    setUnsavedOpen(true);
  }

  function requestSelectPath(path: string): void {
    if (path === selected) return;
    guardUnsaved(() => void loadPath(path));
  }

  // ── Saving ───────────────────────────────────────────────────────
  async function saveSkillMd(navigate: boolean): Promise<boolean> {
    if (!form.skillMd.trim()) {
      setError("SKILL.md cannot be empty.");
      return false;
    }
    setSaving(true);
    setError(null);
    try {
      const url = isCreating ? "/api/skills" : `/api/skills/${skillId}`;
      const method = isCreating ? "POST" : "PATCH";
      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ skillMd: form.skillMd, source: form.source }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as
          | { message?: string; error?: string }
          | null;
        throw new Error(body?.message ?? body?.error ?? `HTTP ${res.status}`);
      }
      setSavedForm(form);
      clearDraftState();
      if (navigate) startTransition(() => onSaved());
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function saveHelperFile(): Promise<boolean> {
    if (selected === SKILL_MD_PATH || fileDraft === null) return true;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/skills/${skillId}/files/${encodePath(selected)}?kind=file`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: fileDraft }),
        },
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as
          | { message?: string; error?: string }
          | null;
        throw new Error(body?.message ?? body?.error ?? `HTTP ${res.status}`);
      }
      const data = (await res.json()) as {
        size?: number;
        contentType?: string | null;
        warning?: string;
      };
      setSavedFileContent(fileDraft);
      setFileCache((prev) => {
        const existing = prev.get(selected);
        if (!existing) return prev;
        return new Map(prev).set(selected, {
          ...existing,
          content: fileDraft,
          size: data.size ?? existing.size,
        });
      });
      setFiles((prev) =>
        prev.map((f) =>
          f.path === selected
            ? {
                ...f,
                size: data.size ?? f.size,
                contentType: data.contentType ?? f.contentType,
              }
            : f,
        ),
      );
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function saveCurrent(navigate: boolean): Promise<boolean> {
    if (selected === SKILL_MD_PATH) return saveSkillMd(navigate);
    // A Source edit can be pending while a helper file is selected.
    if (isSkillMdDirty) {
      const ok = await saveSkillMd(false);
      if (!ok) return false;
    }
    return isFileDirty ? saveHelperFile() : true;
  }

  function discardCurrent(): void {
    if (selected === SKILL_MD_PATH) {
      setForm(savedForm);
      return;
    }
    setFileDraft(savedFileContent);
    if (isSkillMdDirty) setForm(savedForm);
  }

  async function handleUnsavedSave(): Promise<void> {
    const action = pendingAction;
    if (!action) return;
    const ok = await saveCurrent(false);
    if (!ok) return;
    setUnsavedOpen(false);
    setPendingAction(null);
    action.run();
  }

  function handleUnsavedIgnore(): void {
    discardCurrent();
    const action = pendingAction;
    setUnsavedOpen(false);
    setPendingAction(null);
    action?.run();
  }

  function handleUnsavedCancel(): void {
    setUnsavedOpen(false);
    setPendingAction(null);
  }

  // ── File mutations ───────────────────────────────────────────────
  async function reloadDetail(): Promise<SkillDetail> {
    if (skillId === null) throw new Error("Skill has not been saved yet.");
    const res = await fetch(`/api/skills/${skillId}`);
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as
        | { message?: string; error?: string }
        | null;
      throw new Error(body?.message ?? body?.error ?? `HTTP ${res.status}`);
    }
    const detail = (await res.json()) as SkillDetail;
    setFiles(detail.files ?? []);
    setScriptsOnSsh(detail.scriptsOnSsh ?? []);
    setMissingSshScripts(detail.missingSshScripts ?? []);
    setScriptsOnDb(detail.scriptsOnDb ?? []);
    setMissingDbScripts(detail.missingDbScripts ?? []);
    setForm({ source: detail.source ?? "", skillMd: detail.skillMd });
    setSavedForm({ source: detail.source ?? "", skillMd: detail.skillMd });
    return detail;
  }

  async function handleFileAdded(path: string): Promise<void> {
    setAddOpen(false);
    setError(null);
    try {
      await reloadDetail();
      setFileCache(new Map());
      await loadPath(path, true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleFileRenamed(
    newPath: string,
    oldTarget: SkillFileTarget,
  ): Promise<void> {
    setRenameTarget(null);
    setError(null);
    try {
      let nextSelected = selected;
      if (oldTarget.kind === "file") {
        if (selected === oldTarget.path) nextSelected = newPath;
      } else if (selected.startsWith(`${oldTarget.path}/`)) {
        nextSelected = newPath + selected.slice(oldTarget.path.length);
      }

      const detail = await reloadDetail();
      setFileCache(new Map());
      const stillExists =
        nextSelected === SKILL_MD_PATH ||
        detail.files.some((f) => f.path === nextSelected);
      if (stillExists) {
        await loadPath(nextSelected, true);
      } else {
        setSelected(SKILL_MD_PATH);
        setFileDraft(null);
        setSavedFileContent(null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleFileDeleteConfirm(): Promise<void> {
    if (!fileDeleteTarget) return;
    setFileDeleting(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/skills/${skillId}/files/${encodePath(fileDeleteTarget.path)}?kind=${fileDeleteTarget.kind}`,
        { method: "DELETE" },
      );
      if (!res.ok && res.status !== 204) {
        const body = (await res.json().catch(() => null)) as
          | { message?: string; error?: string }
          | null;
        throw new Error(body?.message ?? body?.error ?? `HTTP ${res.status}`);
      }
      setFileDeleteTarget(null);
      const detail = await reloadDetail();
      setFileCache(new Map());
      const stillExists =
        selected !== SKILL_MD_PATH &&
        detail.files.some((f) => f.path === selected);
      if (stillExists) {
        await loadPath(selected, true);
      } else {
        setSelected(SKILL_MD_PATH);
        setFileDraft(null);
        setSavedFileContent(null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setFileDeleting(false);
    }
  }

  // ── Header identity / Copilot ────────────────────────────────────
  const draftMeta = useMemo(() => {
    try {
      const parsed = parseSkillMd(form.skillMd);
      return {
        name: parsed.frontmatter.name,
        version: parsed.frontmatter.version,
      };
    } catch {
      return {
        name: initialDetail?.name ?? "",
        version: initialDetail?.version ?? "",
      };
    }
  }, [form.skillMd, initialDetail?.name, initialDetail?.version]);

  const getCurrentData = useCallback(
    () => ({
      source: form.source,
      skillMd: form.skillMd,
      isReadOnly: false,
    } as Record<string, unknown>),
    [form],
  );
  const applyDraft = useCallback(
    (draft: Partial<Record<string, unknown>>) => {
      if (selected !== SKILL_MD_PATH && currentDirty) {
        setError("Save or discard the current helper file before applying an AI draft.");
        return [];
      }
      const modified: string[] = [];
      if (typeof draft.source === "string" && draft.source !== form.source) {
        setForm((prev) => ({ ...prev, source: draft.source as string }));
        modified.push("source");
      }
      if (typeof draft.skillMd === "string" && draft.skillMd !== form.skillMd) {
        setForm((prev) => ({ ...prev, skillMd: draft.skillMd as string }));
        modified.push("skillMd");
        setSelected(SKILL_MD_PATH);
        setFileDraft(null);
        setSavedFileContent(null);
      }
      return modified;
    },
    [form.source, form.skillMd, selected, currentDirty],
  );

  const { draftApplied, clearDraftState } = useCopilotDraft({
    resourceType: "skills",
    resourceId: skillId ?? null,
    isReadOnly: false,
    getCurrentData,
    applyDraft,
  });

  // ── Skill delete ─────────────────────────────────────────────────
  const handleDeleteConfirm = async (): Promise<void> => {
    if (isCreating || skillId === null) return;
    setDeleting(true);
    setError(null);
    try {
      const res = await fetch(`/api/skills/${skillId}`, { method: "DELETE" });
      if (res.ok || res.status === 204) {
        setDeleteOpen(false);
        if (onDeleted) onDeleted(skillId);
        else onBack();
        return;
      }
      const body = (await res.json().catch(() => null)) as
        | { message?: string; error?: string }
        | null;
      throw new Error(body?.message ?? body?.error ?? `HTTP ${res.status}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDeleting(false);
    }
  };

  const canSave: boolean =
    selected === SKILL_MD_PATH
      ? isCreating || isSkillMdDirty
      : isFileDirty || isSkillMdDirty;
  const dirtyPath: string | null = isFileDirty
    ? selected
    : isSkillMdDirty
      ? SKILL_MD_PATH
      : null;

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-9 shrink-0 items-center gap-2 border-b bg-muted/40 px-3">
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6"
          onClick={onBack}
          aria-label="Back"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
        </Button>
        <h1 className="flex items-baseline gap-1.5 text-sm font-semibold leading-none">
          {isCreating ? "New skill" : draftMeta.name}
          {!isCreating && draftMeta.version && (
            <span className="font-normal text-muted-foreground">
              ({draftMeta.version})
            </span>
          )}
        </h1>
        <div className="ml-auto flex items-center gap-1.5">
          <Button
            size="sm"
            onClick={() => void saveCurrent(selected === SKILL_MD_PATH)}
            disabled={saving || deleting || !canSave}
            className={cn(
              "h-6 gap-1 px-2 text-xs",
              canSave &&
                (draftApplied || currentDirty) &&
                "bg-amber-600 hover:bg-amber-700 text-white",
            )}
          >
            {saving ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Save className="h-3.5 w-3.5" />
            )}
            Save
          </Button>
          {!isCreating && (
            <Button
              size="sm"
              className="h-6 shrink-0 gap-1 bg-primary px-2 text-xs text-destructive hover:bg-primary/80 hover:text-destructive"
              onClick={() => setDeleteOpen(true)}
              disabled={saving || deleting}
              title="Delete this skill (cannot be undone)"
            >
              {deleting ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Trash2 className="h-3.5 w-3.5" />
              )}
              Delete
            </Button>
          )}
        </div>
      </header>

      <DeleteConfirmDialog
        title="Delete skill"
        description={
          <>
            This permanently removes{" "}
            <strong>{initialDetail?.name ?? "this skill"}</strong> and its{" "}
            {files.length} helper file{files.length === 1 ? "" : "s"}. Agents
            bound to it lose the binding. This cannot be undone.
          </>
        }
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        onConfirm={() => void handleDeleteConfirm()}
        deleting={deleting}
      />

      <DeleteConfirmDialog
        title={
          fileDeleteTarget?.kind === "folder" ? "Delete folder" : "Delete file"
        }
        description={
          fileDeleteTarget?.kind === "folder" ? (
            <>
              Permanently delete folder{" "}
              <strong>{fileDeleteTarget.path}</strong> and all{" "}
              {
                files.filter((f) =>
                  f.path.startsWith(`${fileDeleteTarget.path}/`),
                ).length
              }{" "}
              file(s) inside it? This cannot be undone.
            </>
          ) : (
            <>
              Permanently delete file{" "}
              <strong>{fileDeleteTarget?.path}</strong>? This cannot be undone.
            </>
          )
        }
        open={fileDeleteTarget !== null}
        onOpenChange={(open) => {
          if (!open && !fileDeleting) setFileDeleteTarget(null);
        }}
        onConfirm={() => void handleFileDeleteConfirm()}
        deleting={fileDeleting}
      />

      <div className="flex min-h-0 flex-1">
        {!isCreating && initialDetail && (
          <SkillFileTree
            files={files}
            selected={selected}
            onSelect={(path) => requestSelectPath(path)}
            onAdd={() => guardUnsaved(() => setAddOpen(true))}
            onRename={(target) => guardUnsaved(() => setRenameTarget(target))}
            onDelete={(target) =>
              guardUnsaved(() => setFileDeleteTarget(target))
            }
            scriptsOnSsh={scriptsOnSsh}
            missingSshScripts={missingSshScripts}
            scriptsOnDb={scriptsOnDb}
            missingDbScripts={missingDbScripts}
            dirtyPath={dirtyPath}
          />
        )}

        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex min-h-0 flex-1 flex-col gap-4 px-6 py-5">
            {error && (
              <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                {error}
              </p>
            )}

            {/* Source — free-form origin label, independent of the selected
                file. The skill's name is owned by the SKILL.md frontmatter. */}
            <div className="flex shrink-0 items-center gap-3">
              <Label htmlFor="skill-source" className="w-12">
                Source
              </Label>
              <Input
                id="skill-source"
                placeholder="e.g. anthropic, skills.sh"
                value={form.source}
                onChange={(e) => update("source", e.target.value)}
                className="flex-1"
              />
            </div>

            {selected === SKILL_MD_PATH ? (
              <div className="flex min-h-0 flex-1 flex-col">
                <Textarea
                  id="skill-md"
                  aria-label={SKILL_MD_PATH}
                  rows={24}
                  value={form.skillMd}
                  onChange={(e) => update("skillMd", e.target.value)}
                  className="flex-1 resize-none font-mono text-xs [field-sizing:fixed]"
                  placeholder="--- name: ..."
                />
              </div>
            ) : (
              <div className="flex min-h-0 flex-1 flex-col">
                {fileLoading && !payload ? (
                  <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground">
                    <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                    Loading…
                  </div>
                ) : !payload ? (
                  <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground">
                    Select a file to view its content.
                  </div>
                ) : payload.encoding === "utf8" ? (
                  <Textarea
                    aria-label={selected}
                    value={fileDraft ?? payload.content}
                    onChange={(e) => setFileDraft(e.target.value)}
                    className="min-h-0 flex-1 resize-none font-mono text-xs [field-sizing:fixed]"
                  />
                ) : (
                  <div className="flex flex-1 flex-col items-center justify-center gap-2 rounded-md border border-dashed p-10 text-center">
                    <FileText className="h-6 w-6 text-muted-foreground" />
                    <p className="text-xs text-muted-foreground">
                      Binary file · {formatBytes(payload.size)}
                      {selectedMeta?.contentType &&
                        ` · ${selectedMeta.contentType}`}
                    </p>
                    <p className="max-w-sm text-[11px] leading-snug text-muted-foreground/70">
                      Raw bytes are not rendered in the browser.
                    </p>
                    {payload.encoding === "base64" &&
                      selectedMeta?.contentType?.startsWith("image/") && (
                        // eslint-disable-next-line @next/next/no-img-element -- bytes come from the DB, not a remote origin
                        <img
                          src={`data:${selectedMeta.contentType};base64,${payload.content}`}
                          alt={basename(selected)}
                          className="mt-2 h-auto max-w-full"
                        />
                      )}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {addOpen && (
        <SkillFileDialog
          skillId={skillId as string}
          mode="add"
          files={files}
          defaultParentFolder={
            selected === SKILL_MD_PATH ? "" : getParentPath(selected)
          }
          onClose={() => setAddOpen(false)}
          onSaved={(path) => void handleFileAdded(path)}
        />
      )}

      {renameTarget && (
        <SkillFileDialog
          skillId={skillId as string}
          mode="rename"
          files={files}
          target={renameTarget}
          onClose={() => setRenameTarget(null)}
          onSaved={(path) => void handleFileRenamed(path, renameTarget)}
        />
      )}

      <UnsavedChangesDialog
        open={unsavedOpen}
        fileName={selected === SKILL_MD_PATH ? "SKILL.md" : selected}
        saving={saving}
        error={error}
        onSave={() => void handleUnsavedSave()}
        onIgnore={handleUnsavedIgnore}
        onCancel={handleUnsavedCancel}
      />
    </div>
  );
}
