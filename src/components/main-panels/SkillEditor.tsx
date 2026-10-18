"use client";

/**
 * SkillEditor — full-area form for creating / editing one Skill.
 *
 * Two columns: a read-only file tree on the left, the editable document on the
 * right. `SKILL.md` is the only writable surface — helper files are fetched on
 * demand and rendered read-only, because importing a `.skill` archive is the
 * sole way to add or remove them. See docs/skills.md.
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
import {
  ArrowLeft,
  Download,
  FileText,
  Loader2,
  Save,
  Trash2,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useCopilotDraft } from "@/hooks/useCopilotDraft";
import { DeleteConfirmDialog } from "@/components/ui/delete-confirm-dialog";
import {
  SkillFileTree,
  SKILL_MD_PATH,
  type SkillFileMeta,
} from "@/components/main-panels/skills/SkillFileTree";
import { cn, formatBytes } from "@/lib/utils";

export interface SkillRow {
  id: string;
  path: string;
  name: string;
  description: string | null;
  source: "builtin" | "local";
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
  name: string;
  skillMd: string;
}

/** Default SKILL.md template seeded on create. Mirrors Claude Skills convention. */
function buildTemplate(name: string): string {
  const slug = name.trim() || "my-skill";
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
  const isBuiltin = initialDetail?.source === "builtin";
  const readOnly = !isCreating && isBuiltin;

  // Delete state — destructive action, gated by a confirm dialog.
  // Mirrors BuiltinAgentEditor's pattern: only shown for an existing
  // non-builtin skill, click opens an AlertDialog, the dialog action
  // fires the DELETE and waits for it before closing.
  const [deleteOpen, setDeleteOpen] = useState<boolean>(false);
  const [deleting, setDeleting] = useState<boolean>(false);

  // Form state — single object for all editable fields.
  // `savedForm` is the snapshot taken at load time; comparing the two
  // gives us a free `isDirty` flag for the Save button.
  const [form, setForm] = useState<FormState>(() => ({
    name: initialDetail?.name ?? "",
    skillMd: initialDetail?.skillMd ?? buildTemplate(""),
  }));
  const [savedForm] = useState<FormState>(() => ({
    name: initialDetail?.name ?? "",
    skillMd: initialDetail?.skillMd ?? buildTemplate(""),
  }));
  const isDirty = useMemo(
    () => form.name !== savedForm.name || form.skillMd !== savedForm.skillMd,
    [form, savedForm],
  );
  const update = useCallback(
    <K extends keyof FormState>(key: K, value: FormState[K]) =>
      setForm((prev) => ({ ...prev, [key]: value })),
    [],
  );

  const [saving, setSaving] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  // ── File viewing ────────────────────────────────────────────────
  const files: SkillFileMeta[] = initialDetail?.files ?? [];
  const [selected, setSelected] = useState<string>(SKILL_MD_PATH);
  const [fileCache, setFileCache] = useState<Map<string, FilePayload>>(
    () => new Map(),
  );
  const [fileLoading, setFileLoading] = useState<boolean>(false);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => () => abortRef.current?.abort(), []);

  const payload: FilePayload | null =
    selected === SKILL_MD_PATH ? null : (fileCache.get(selected) ?? null);
  const selectedMeta: SkillFileMeta | null =
    selected === SKILL_MD_PATH
      ? null
      : (files.find((f) => f.path === selected) ?? null);

  /**
   * Switch the right-hand pane. Helper files are fetched once and cached;
   * a failed fetch restores the previous selection so the pane never shows
   * an empty box that reads as "this file is empty".
   */
  async function selectPath(path: string): Promise<void> {
    if (path === selected) return;
    const previous = selected;
    setSelected(path);
    setError(null);
    if (path === SKILL_MD_PATH || fileCache.has(path)) return;

    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setFileLoading(true);
    try {
      const res = await fetch(`/api/skills/${skillId}/files/${encodeURI(path)}`, {
        signal: ctrl.signal,
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as
          | { message?: string; error?: string }
          | null;
        throw new Error(body?.message ?? body?.error ?? `HTTP ${res.status}`);
      }
      const data = (await res.json()) as FilePayload;
      setFileCache((prev) => new Map(prev).set(path, data));
    } catch (err) {
      if ((err as Error).name === "AbortError") return;
      setError(err instanceof Error ? err.message : String(err));
      setSelected(previous);
    } finally {
      if (abortRef.current === ctrl) setFileLoading(false);
    }
  }

  // SECURITY: the octet-stream fallback keeps Download working for rows stored
  // before contentType was populated. It is safe precisely because it is inert
  // — the browser can never render it as markup. Image *preview* stays gated on
  // a real `image/*` type so an unknown blob is never fed to an <img>.
  const dataUrl: string | null =
    payload?.encoding === "base64"
      ? `data:${selectedMeta?.contentType ?? "application/octet-stream"};base64,${payload.content}`
      : null;
  const isImage: boolean =
    payload?.encoding === "base64" &&
    (selectedMeta?.contentType?.startsWith("image/") ?? false);

  /** Auto-rewrite the template's `name:` line as the user types in
   *  the Name input — but only on initial create, before the user
   *  has touched the textarea. A "user has touched" flag would be
   *  more robust; the cheap proxy is "still equal to a template we
   *  could have built". Keeps the auto-fill helpful without
   *  fighting the user. */
  const onNameChange = useCallback((next: string): void => {
    setForm((prev) => {
      const md =
        isCreating &&
        (prev.skillMd === buildTemplate(prev.name) || prev.skillMd === buildTemplate(""))
          ? buildTemplate(next)
          : prev.skillMd;
      return { name: next, skillMd: md };
    });
  }, [isCreating]);

  const getCurrentData = useCallback(
    () => ({
      name: form.name,
      source: initialDetail?.source ?? "local",
      isReadOnly: Boolean(readOnly),
      skillMd: form.skillMd,
    } as Record<string, unknown>),
    [form, initialDetail?.source, readOnly],
  );
  const applyDraft = useCallback((draft: Partial<Record<string, unknown>>) => {
    if (readOnly) return [];
    const modified: string[] = [];
    if (typeof draft.skillMd === "string" && draft.skillMd !== form.skillMd) {
      setForm((prev) => ({ ...prev, skillMd: draft.skillMd as string }));
      modified.push("skillMd");
      // A draft lands in the SKILL.md draft buffer; show it, otherwise the
      // change is invisible while a helper file is on screen.
      setSelected(SKILL_MD_PATH);
    }
    if (isCreating && typeof draft.name === "string" && draft.name !== form.name) {
      onNameChange(draft.name);
      modified.push("name");
    }
    return modified;
  }, [readOnly, isCreating, form.skillMd, form.name, onNameChange]);

  const { draftApplied, clearDraftState } = useCopilotDraft({
    resourceType: "skills",
    resourceId: skillId ?? null,
    isReadOnly: Boolean(readOnly),
    getCurrentData,
    applyDraft,
  });

  const submit = async (): Promise<void> => {
    if (readOnly) return;
    if (!form.skillMd.trim()) {
      setError("SKILL.md cannot be empty.");
      return;
    }
    if (isCreating && !form.name.trim()) {
      setError("Please enter a name for the skill.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const url = isCreating ? "/api/skills" : `/api/skills/${skillId}`;
      const method = isCreating ? "POST" : "PATCH";
      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ skillMd: form.skillMd }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as
          | { message?: string; error?: string }
          | null;
        throw new Error(
          body?.message ?? body?.error ?? `HTTP ${res.status}`,
        );
      }
      clearDraftState();
      startTransition(() => onSaved());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  /**
   * Delete the current skill. Confirmation has happened in the
   * dialog, so this just fires the DELETE and routes the user back.
   * Errors surface in the existing `error` banner so the user can
   * retry or back out without losing context.
   */
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
      throw new Error(
        body?.message ?? body?.error ?? `HTTP ${res.status}`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDeleting(false);
    }
  };

  // Show Delete only when editing a non-builtin skill (creation has
  // nothing to delete; built-in skills are immutable).
  const canDelete: boolean = !isCreating && !isBuiltin;
  // Save writes the SKILL.md column only. Gating it on the selection keeps a
  // click made while a helper file is on screen from saving a document the
  // user is not looking at.
  const canSave: boolean =
    selected === SKILL_MD_PATH && (isCreating || isDirty);

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <header className="flex items-center gap-2 border-b px-4 py-3">
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          onClick={onBack}
          aria-label="Back"
        >
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <h1 className="flex items-baseline gap-1.5 text-sm font-semibold">
          {isCreating ? "New skill" : form.name}
          {!isCreating && initialDetail?.version && (
            <span className="font-normal text-muted-foreground">
              ({initialDetail.version})
            </span>
          )}
        </h1>
        {(!readOnly || canDelete) && (
          <div className="ml-auto flex items-center gap-2">
            {!readOnly && (
              <Button
                size="sm"
                onClick={() => void submit()}
                disabled={saving || deleting || !canSave}
                title={
                  selected !== SKILL_MD_PATH
                    ? "Save applies to SKILL.md only"
                    : undefined
                }
                className={cn(
                  "h-8 gap-1.5",
                  // Only advertise unsaved changes when the click would land.
                  // Highlighting a disabled Save reads as a broken button.
                  canSave &&
                    (draftApplied || isDirty) &&
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
            )}
            {canDelete && (
              <Button
                size="sm"
                // Same background as Save (default variant uses
                // `bg-primary`), only the text colour switches to
                // destructive red — mirrors BuiltinAgentEditor's
                // Delete button so the two editor pages match.
                className="h-8 shrink-0 gap-1.5 bg-primary text-destructive hover:bg-primary/80 hover:text-destructive"
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
        )}
      </header>

      <DeleteConfirmDialog
        title="Delete skill"
        description={<>This permanently removes <strong>{initialDetail?.name ?? "this skill"}</strong> and its {files.length} helper file{files.length === 1 ? "" : "s"}. Agents bound to it lose the binding. This cannot be undone.</>}
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        onConfirm={() => void handleDeleteConfirm()}
        deleting={deleting}
      />

      <div className="flex min-h-0 flex-1">
        {!isCreating && initialDetail && (
          <SkillFileTree
            files={files}
            selected={selected}
            onSelect={(path) => void selectPath(path)}
            source={initialDetail.source}
            scriptsOnSsh={initialDetail.scriptsOnSsh ?? []}
            missingSshScripts={initialDetail.missingSshScripts ?? []}
            skillMdDirty={form.skillMd !== savedForm.skillMd}
          />
        )}

        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex min-h-0 flex-1 flex-col gap-4 px-6 py-5">
            {error && (
              <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                {error}
              </p>
            )}

            {/* Name — always on screen, independent of the selected file.
                Renaming is not supported (it would orphan agent bindings),
                so this is editable only while creating. */}
            <div className="flex shrink-0 items-center gap-3">
              <Label htmlFor="skill-name" className="w-12">
                Name
              </Label>
              <Input
                id="skill-name"
                placeholder="my-skill"
                value={form.name}
                onChange={(e) => onNameChange(e.target.value)}
                readOnly={!isCreating || readOnly}
                className={cn(
                  "flex-1",
                  (!isCreating || readOnly) &&
                    "bg-muted/30 focus-visible:ring-0 cursor-default",
                )}
              />
            </div>

            {/* Content — no filename caption: the tree's selection already
                says which document is on screen. */}
            {selected === SKILL_MD_PATH ? (
              <div className="flex min-h-0 flex-1 flex-col">
                <Textarea
                  id="skill-md"
                  aria-label={SKILL_MD_PATH}
                  rows={24}
                  value={form.skillMd}
                  onChange={(e) => update("skillMd", e.target.value)}
                  readOnly={readOnly}
                  className={cn(
                    "flex-1 resize-none font-mono text-xs [field-sizing:fixed]",
                    readOnly && "bg-muted/30 focus-visible:ring-0",
                  )}
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
                  <pre className="min-h-0 flex-1 overflow-auto rounded-md border bg-muted/20 p-3 font-mono text-xs leading-relaxed whitespace-pre">
                    {payload.content}
                  </pre>
                ) : isImage && dataUrl ? (
                  <div className="flex min-h-0 flex-1 items-start justify-center overflow-auto rounded-md border bg-muted/20 p-4">
                    {/* eslint-disable-next-line @next/next/no-img-element -- bytes come from the DB, not a remote origin */}
                    <img
                      src={dataUrl}
                      alt={basename(selected)}
                      className="h-auto max-w-full"
                    />
                  </div>
                ) : (
                  <div className="flex flex-1 flex-col items-center justify-center gap-2 rounded-md border border-dashed p-10 text-center">
                    <FileText className="h-6 w-6 text-muted-foreground" />
                    <p className="text-xs text-muted-foreground">
                      Binary file · {formatBytes(payload.size)}
                      {selectedMeta?.contentType && ` · ${selectedMeta.contentType}`}
                    </p>
                    <p className="max-w-sm text-[11px] leading-snug text-muted-foreground/70">
                      Raw bytes are not rendered in the browser.
                    </p>
                    {dataUrl && (
                      <a
                        href={dataUrl}
                        download={basename(selected)}
                        className="mt-1 inline-flex h-7 items-center gap-1.5 rounded-md border px-3 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
                      >
                        <Download className="h-3.5 w-3.5" />
                        Download
                      </a>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
