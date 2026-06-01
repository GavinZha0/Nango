"use client";

/**
 * VerificationPanel — left-side panel listing the editor's verification
 * suites, split into two tabs (MCP / Workflow). Workflow suites are
 * V2-only on the backend, but we still surface the tab so the affordance
 * exists and "Coming soon" is friendly.
 *
 * Header layout mirrors SkillsPanel / AgentPanel: a single row with the
 * tab strip on the left and global actions (+ / refresh) on the right.
 * No separate title row — the tab labels (MCP / Workflow) already
 * identify the panel.
 *
 * Row anatomy is intentionally simpler than SchedulesPanel — a suite
 * doesn't have a per-row trigger spec or next-fire time. We show:
 *
 *   line 1 — name (left, click to open) + enabled toggle (right)
 *   line 2 — description, when set (otherwise omitted, no placeholder)
 *
 * Past-run summary (pass/fail/error counts, last-run time) lives in the
 * center editor's RecentRunsBanner — duplicating it here would force a
 * second fetch per row and clutter the panel.
 */

import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { useRouter, usePathname } from "next/navigation";
import {
  CircleCheck,
  CircleSlash,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
} from "lucide-react";

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
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import {
  useVerificationStore,
  verificationActions,
  type VerificationCategory,
  type VerificationSuiteRow,
} from "@/store/verification";

const CATEGORIES: ReadonlyArray<{ id: VerificationCategory; label: string }> = [
  { id: "mcp", label: "MCP" },
  { id: "workflow", label: "Workflow" },
];

// Status toggle — mirrors SchedulesPanel's inline enable/disable
// without the "last fire failed" amber state (suites don't carry a
// last-error field — case failures are tracked per run, not per suite).

interface StatusToggleProps {
  row: VerificationSuiteRow;
  onToggle: () => void;
}
function StatusToggle({ row, onToggle }: StatusToggleProps): ReactNode {
  const icon = row.enabled ? (
    <CircleCheck className="h-3.5 w-3.5 text-emerald-500" />
  ) : (
    <CircleSlash className="h-3.5 w-3.5 text-muted-foreground" />
  );
  const label = row.enabled ? "Disable suite" : "Enable suite";
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-label={label}
      className="shrink-0 cursor-pointer rounded p-0.5 hover:text-foreground"
    >
      {icon}
    </button>
  );
}

// Row

interface SuiteRowProps {
  row: VerificationSuiteRow;
  active: boolean;
  onSelect: () => void;
  onToggleEnabled: () => void;
  onRequestEdit: () => void;
  onRequestDelete: () => void;
}

function SuiteRow({
  row,
  active,
  onSelect,
  onToggleEnabled,
  onRequestEdit,
  onRequestDelete,
}: SuiteRowProps): ReactNode {
  return (
    <div
      className={cn(
        "flex flex-col gap-0.5 border-b border-border/70 last:border-0 px-3 py-2 transition-colors",
        active ? "bg-accent" : "hover:bg-muted/30",
        !row.enabled && "opacity-50",
      )}
    >
      <div className="flex items-center gap-2">
        {/* Wrap name in a flex-1 container so the button itself is
            content-sized — clicking the empty space after the name no
            longer fires `onSelect`. Mirrors AgentPanel's BackendRow. */}
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          <button
            type="button"
            onClick={onSelect}
            className="cursor-pointer truncate text-left text-base font-medium hover:underline underline-offset-2"
            aria-label={`Open ${row.name}`}
          >
            {row.name}
          </button>
          {/* Case count badge — quiet pill so it doesn't fight the
              name. Hidden for zero-case suites (empty badge would just
              be noise; the editor's empty state covers that). */}
          {row.caseCount > 0 && (
            <span
              className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[10px] leading-none text-muted-foreground"
              title={`${row.caseCount} case${row.caseCount === 1 ? "" : "s"}`}
            >
              {row.caseCount}
            </span>
          )}
        </div>
        {/* Row-level controls, left→right: edit · delete · enable.
            Edit + delete share the new-suite dialog (create/edit modes);
            always visible so users don’t have to hover-hunt. */}
        <button
          type="button"
          onClick={onRequestEdit}
          aria-label={`Edit ${row.name}`}
          className="shrink-0 cursor-pointer rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground"
        >
          <Pencil className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={onRequestDelete}
          aria-label={`Delete ${row.name}`}
          className="shrink-0 cursor-pointer rounded p-0.5 text-muted-foreground transition-colors hover:text-destructive"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
        <StatusToggle row={row} onToggle={onToggleEnabled} />
      </div>
      {row.description && (
        <p className="truncate text-xs text-muted-foreground">
          {row.description}
        </p>
      )}
    </div>
  );
}

// Tab button — visual + accessibility behaviour copied verbatim from
// SkillsPanel / AgentPanel so the three editor-group panels stay
// indistinguishable in chrome.

interface TabButtonProps {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
}

function TabButton({ label, count, active, onClick }: TabButtonProps): ReactNode {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex cursor-pointer items-center gap-1.5 px-3 py-1.5 text-sm font-medium border-b-2 transition-colors",
        active
          ? "border-primary text-foreground"
          : "border-transparent text-muted-foreground hover:text-foreground",
      )}
      aria-pressed={active}
    >
      {label}
      <span
        className={cn(
          "rounded-full px-1.5 py-0.5 text-[10px] leading-none",
          active
            ? "bg-primary/20 text-foreground"
            : "bg-muted text-muted-foreground",
        )}
      >
        {count}
      </span>
    </button>
  );
}

// Suite form dialog — dual-purpose: creates a new suite when `editing`
// is null, otherwise edits the supplied row in-place. The form is the
// same shape in both modes (only name + description), so we reuse a
// single component rather than maintaining two near-identical dialogs.
// Mirrors McpPanel's ServerFormDialog styling (sm:max-w-md, 80px label
// column).

interface SuiteFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Category for the *create* path. Ignored when editing (the row
   *  already carries its category and the API doesn't allow moving
   *  suites between categories). */
  category: VerificationCategory;
  /** When set, the dialog runs in edit mode for this row. */
  editing?: VerificationSuiteRow | null;
  onSaved: (row: VerificationSuiteRow) => void;
}

function SuiteFormDialog({
  open,
  onOpenChange,
  category,
  editing = null,
  onSaved,
}: SuiteFormDialogProps): ReactNode {
  const isEdit = editing !== null;
  const [name, setName] = useState<string>("");
  const [description, setDescription] = useState<string>("");
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [error, setError] = useState<string>("");

  // Reset whenever the dialog opens. Render-time detect avoids the
  // effect setState lint, same pattern as McpPanel's ServerFormDialog.
  // We key on (open, editing?.id) so opening the same dialog for a
  // different row re-seeds the inputs.
  const seedKey = `${open ? 1 : 0}:${editing?.id ?? ""}`;
  const [lastSeedKey, setLastSeedKey] = useState<string>(seedKey);
  if (seedKey !== lastSeedKey) {
    setLastSeedKey(seedKey);
    if (open) {
      setName(editing?.name ?? "");
      setDescription(editing?.description ?? "");
      setError("");
      setSubmitting(false);
    }
  }

  async function handleSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
    setError("");
    const trimmedName = name.trim();
    if (!trimmedName) {
      setError("Name is required.");
      return;
    }
    setSubmitting(true);
    const trimmedDesc = description.trim();
    const descValue = trimmedDesc === "" ? null : trimmedDesc;
    const row = isEdit
      ? await verificationActions.patch(editing.id, {
          name: trimmedName,
          description: descValue,
        })
      : await verificationActions.create({
          name: trimmedName,
          description: descValue,
          category,
        });
    setSubmitting(false);
    if (!row) {
      // The store's error state carries the upstream message; surface
      // it inline so the user doesn't have to look elsewhere.
      const storeError = useVerificationStore.getState().error;
      setError(
        storeError ??
          (isEdit ? "Failed to save suite." : "Failed to create suite."),
      );
      return;
    }
    onOpenChange(false);
    onSaved(row);
  }

  const effectiveCategory: VerificationCategory = editing?.category ?? category;
  const categoryLabel = effectiveCategory === "mcp" ? "MCP" : "Workflow";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {isEdit
              ? `Edit ${categoryLabel} verification suite`
              : `New ${categoryLabel} verification suite`}
          </DialogTitle>
        </DialogHeader>

        <form onSubmit={(e) => void handleSubmit(e)} className="space-y-3 py-2">
          <div className="grid grid-cols-[80px_1fr] items-center gap-2">
            <Label htmlFor="suite-name">
              Name <span className="text-destructive">*</span>
            </Label>
            <Input
              id="suite-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              autoFocus
              placeholder="e.g. Search API regression"
            />
          </div>

          <div className="grid grid-cols-[80px_1fr] items-start gap-2">
            <Label htmlFor="suite-description" className="pt-2">
              Description
            </Label>
            <Textarea
              id="suite-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              placeholder="Optional — what this suite covers."
            />
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={submitting}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={submitting}>
              {submitting && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}
              {isEdit ? "Save" : "Create"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// Panel

export function VerificationPanel(): ReactNode {
  const router = useRouter();
  const pathname = usePathname();

  const category = useVerificationStore((s) => s.category);
  // Subscribe to both buckets so both tab badges show accurate counts
  // even before the user clicks the other tab. The fetch itself is
  // still lazy (see effect below).
  const mcpItems = useVerificationStore((s) => s.items.mcp);
  const workflowItems = useVerificationStore((s) => s.items.workflow);
  const items = category === "mcp" ? mcpItems : workflowItems;
  const loadedForCategory = useVerificationStore(
    (s) => s.loaded[s.category],
  );
  const loading = useVerificationStore((s) => s.loading);
  const error = useVerificationStore((s) => s.error);

  // Active row id is derived from /verification/<id>. `new` is the
  // create sentinel; skipping it keeps highlight off mid-creation.
  const match = pathname.match(/^\/verification\/([^/]+)/);
  const activeSuiteId = match && match[1] !== "new" ? match[1] : null;

  // Lazy-load on tab activation. Each category caches independently
  // so flipping tabs the second time is free.
  useEffect(() => {
    if (!loadedForCategory) void verificationActions.refresh(category);
  }, [category, loadedForCategory]);

  const setCategory = (c: VerificationCategory): void => {
    useVerificationStore.getState().setCategory(c);
  };

  // Suite form dialog state. `formMode` is the discriminant; `null`
  // means closed. The same dialog component (`SuiteFormDialog`) handles
  // both create and edit so we render it once.
  type FormMode =
    | { kind: "create" }
    | { kind: "edit"; row: VerificationSuiteRow };
  const [formMode, setFormMode] = useState<FormMode | null>(null);
  // Delete dialog state — holds the row pending confirmation so the
  // dialog can quote `row.name` without timing-out on row removal.
  const [pendingDelete, setPendingDelete] =
    useState<VerificationSuiteRow | null>(null);
  const [deleting, setDeleting] = useState<boolean>(false);

  async function handleDeleteConfirm(): Promise<void> {
    if (!pendingDelete) return;
    setDeleting(true);
    // `verificationActions.remove` swallows errors into `state.error`
    // rather than throwing; sample it before+after to detect failure.
    const errBefore = useVerificationStore.getState().error;
    await verificationActions.remove(pendingDelete.id);
    setDeleting(false);
    const errAfter = useVerificationStore.getState().error;
    if (errAfter !== null && errAfter !== errBefore) {
      // Leave the dialog open so the error (rendered above the suite
      // list) stays visible alongside it; the user can retry or cancel.
      return;
    }
    // If the user was viewing the deleted suite, bounce them back to
    // the listing so the now-stale editor isn't left mounted.
    if (pendingDelete.id === activeSuiteId) {
      router.push("/verification");
    }
    setPendingDelete(null);
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Header — tab strip + global actions on a single row. */}
      <div className="flex items-stretch border-b bg-muted/40 pr-1.5">
        {CATEGORIES.map((c) => (
          <TabButton
            key={c.id}
            label={c.label}
            count={c.id === "mcp" ? mcpItems.length : workflowItems.length}
            active={category === c.id}
            onClick={() => setCategory(c.id)}
          />
        ))}
        <div className="ml-auto flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            onClick={() => setFormMode({ kind: "create" })}
            aria-label="New verification suite"
          >
            <Plus className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            onClick={() => void verificationActions.refresh(category)}
            disabled={loading}
            aria-label="Refresh suites"
          >
            <RefreshCw
              className={cn("h-3.5 w-3.5", loading && "animate-spin")}
            />
          </Button>
        </div>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="py-1">
          {error && (
            <p className="mx-3 my-2 rounded border border-destructive/40 bg-destructive/10 px-2 py-1.5 text-[11px] text-destructive">
              {error}
            </p>
          )}
          {category === "workflow" ? (
            <p className="px-4 py-4 text-xs text-muted-foreground">
              Workflow verification suites are coming in a later release.
            </p>
          ) : !loadedForCategory && loading ? (
            <p className="px-4 py-4 text-xs text-muted-foreground">Loading…</p>
          ) : items.length === 0 ? (
            <div className="px-4 py-4 text-xs text-muted-foreground">
              No verification suites yet.{" "}
              <button
                type="button"
                className="cursor-pointer underline underline-offset-2 hover:text-foreground"
                onClick={() => setFormMode({ kind: "create" })}
              >
                Add one
              </button>
            </div>
          ) : (
            items.map((row) => (
              <SuiteRow
                key={row.id}
                row={row}
                active={row.id === activeSuiteId}
                onSelect={() => router.push(`/verification/${row.id}`)}
                onToggleEnabled={() =>
                  void verificationActions.patch(row.id, {
                    enabled: !row.enabled,
                  })
                }
                onRequestEdit={() => setFormMode({ kind: "edit", row })}
                onRequestDelete={() => setPendingDelete(row)}
              />
            ))
          )}
        </div>
      </ScrollArea>

      <SuiteFormDialog
        open={formMode !== null}
        onOpenChange={(o) => {
          if (!o) setFormMode(null);
        }}
        category={category}
        editing={formMode?.kind === "edit" ? formMode.row : null}
        onSaved={(row) => {
          // On create, jump into the new suite's editor. On edit,
          // stay put — the row update is already reflected via the
          // store, no navigation needed.
          if (formMode?.kind === "create") {
            router.push(`/verification/${row.id}`);
          }
        }}
      />

      {/* Delete confirmation — same anatomy as the other editor delete
          dialogs (Schedule / Skill / Mcp), kept local to the panel since
          deletion now originates from the row. */}
      <AlertDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open && !deleting) setPendingDelete(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete verification suite</AlertDialogTitle>
            <AlertDialogDescription>
              Permanently delete{" "}
              <strong>{pendingDelete?.name}</strong>? All cases and past
              run history under this suite will be removed. This cannot be
              undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                void handleDeleteConfirm();
              }}
              disabled={deleting}
              className="bg-destructive hover:bg-destructive/90"
            >
              {deleting ? (
                <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
              ) : (
                <Trash2 className="mr-1 h-3.5 w-3.5" />
              )}
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
