"use client";

/**
 * SkillEditor — full-area form for creating / editing one Skill.
 */

import {
  useState,
  useCallback,
  startTransition,
  type ReactNode,
} from "react";
import { ArrowLeft, Loader2, Save, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useCopilotDraft } from "@/hooks/useCopilotDraft";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
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

interface SkillRow {
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

interface SkillDetail extends SkillRow {
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

  // Lazy initialiser keeps the template generation off the React-19
  // purity hot-path — `Date.now()` etc. would be flagged otherwise.
  // On edit, the row's existing skillMd is the source of truth.
  const [name, setName] = useState<string>(() =>
    initialDetail?.name ?? "",
  );
  const [skillMd, setSkillMd] = useState<string>(() =>
    initialDetail?.skillMd ?? buildTemplate(""),
  );
  const [saving, setSaving] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  /** Auto-rewrite the template's `name:` line as the user types in
   *  the Name input — but only on initial create, before the user
   *  has touched the textarea. A "user has touched" flag would be
   *  more robust; the cheap proxy is "still equal to a template we
   *  could have built". Keeps the auto-fill helpful without
   *  fighting the user. */
  const onNameChange = useCallback((next: string): void => {
    setName(next);
    if (!isCreating) return;
    if (skillMd === buildTemplate(name) || skillMd === buildTemplate("")) {
      setSkillMd(buildTemplate(next));
    }
  }, [isCreating, skillMd, name]);

  const getCurrentData = useCallback(() => ({ name, skillMd }), [name, skillMd]);
  const applyDraft = useCallback((draft: Partial<{ name: string; skillMd: string }>) => {
    if (draft.name !== undefined && draft.skillMd === undefined) {
      // Use the component's sync logic if the agent only touched the name
      onNameChange(draft.name);
    } else {
      if (draft.name !== undefined) setName(draft.name);
      if (draft.skillMd !== undefined) setSkillMd(draft.skillMd);
    }
  }, [onNameChange]);

  const { draftApplied, clearDraftState } = useCopilotDraft({
    resourceType: "skill",
    getCurrentData,
    applyDraft,
  });

  const submit = async (): Promise<void> => {
    if (readOnly) return;
    if (!skillMd.trim()) {
      setError("SKILL.md cannot be empty.");
      return;
    }
    if (isCreating && !name.trim()) {
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
        body: JSON.stringify({ skillMd }),
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
        <h1 className="text-sm font-semibold">
          {isCreating
            ? "New skill"
            : isBuiltin
              ? "View skill (built-in)"
              : "Edit skill"}
        </h1>
        {(!readOnly || canDelete) && (
          <div className="ml-auto flex items-center gap-2">
            {!readOnly && (
              <Button
                size="sm"
                onClick={() => void submit()}
                disabled={saving || deleting}
                className={cn("h-8 gap-1.5", draftApplied && "bg-amber-600 hover:bg-amber-700 text-white")}
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

      {/* Delete confirmation dialog */}
      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete skill</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently removes <strong>{initialDetail?.name ?? "this skill"}</strong>{" "}
              from the database and from disk. Agents that bind this skill
              will lose the binding.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                // The dialog auto-closes on action; preventDefault
                // keeps it up while DELETE is in flight, then we close
                // explicitly on success inside handleDeleteConfirm.
                e.preventDefault();
                void handleDeleteConfirm();
              }}
              disabled={deleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleting ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Trash2 className="h-3.5 w-3.5" />
              )}
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <ScrollArea className="flex-1">
        <div className="mx-auto flex w-full max-w-5xl flex-col gap-5 px-6 py-6">
          {error && (
            <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {error}
            </p>
          )}

          {/* Name */}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="skill-name">Name</Label>
            <Input
              id="skill-name"
              placeholder="my-skill"
              value={name}
              onChange={(e) => onNameChange(e.target.value)}
              disabled={!isCreating || readOnly}
            />
            {!isCreating && (
              <p className="text-[11px] text-muted-foreground">
                Renaming a skill is not supported via PATCH. Delete and
                recreate to change the name.
              </p>
            )}
          </div>

          {/* SKILL.md */}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="skill-md">SKILL.md</Label>
            <Textarea
              id="skill-md"
              rows={24}
              value={skillMd}
              onChange={(e) => setSkillMd(e.target.value)}
              disabled={readOnly}
              className="min-h-[28rem] resize-y font-mono text-xs"
              placeholder="--- name: ..."
            />
            <p className="text-[11px] text-muted-foreground">
              Must start with a YAML frontmatter block declaring{" "}
              <code className="font-mono">name</code> and{" "}
              <code className="font-mono">description</code>. The
              frontmatter <code className="font-mono">name</code> must
              match the Name input above.
            </p>
          </div>
        </div>
      </ScrollArea>
    </div>
  );
}
