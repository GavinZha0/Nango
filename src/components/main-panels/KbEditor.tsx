"use client";

/**
 * KbEditor — center workspace pane for one knowledge collection.
 *
 * Two columns: the structure tree on the left, the selected page's description
 * and body on the right. Nothing else is authored here. A group is pure
 * metadata and a page's name, group and source are metadata too, so both node
 * kinds are created and changed from the dialogs on their rows; a group row only
 * folds its subtree and never moves the detail pane. Pages are plain text:
 * the body is a plain textarea whatever `content_type` says, there is no
 * rendered view, and there is no file import — an author opens the source
 * themselves and pastes what an agent will read.
 *
 * No `useCopilotDraft` here: that mechanism lets an agent rewrite a resource,
 * and agents cannot write knowledge. See docs/kb.md.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { ArrowLeft, Loader2, Save, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { DeleteConfirmDialog } from "@/components/ui/delete-confirm-dialog";
import { UnsavedChangesDialog } from "@/components/main-panels/skills/UnsavedChangesDialog";
import {
  KbTree,
  selectionKey,
  type KbSelection,
} from "@/components/main-panels/kb/KbTree";
import { KbGroupDialog } from "@/components/main-panels/kb/KbGroupDialog";
import {
  KbPageDialog,
  type KbPageIdentity,
} from "@/components/main-panels/kb/KbPageDialog";
import { useResourcePermissions } from "@/hooks/useResourcePermissions";
import { cn, formatBytes } from "@/lib/utils";
import { MAX_DESCRIPTION_CHARS } from "@/lib/kb/limits";
import {
  kbTopTally,
  type KbGroupRow,
  type KbPageDetail,
  type KbPageSummary,
  type KbTreeDetail,
} from "@/lib/types/kb";

/**
 * What the pane's draft holds. `name`, `groupId` and `sourceRef` are not fields
 * of this form — the identity dialog owns them — but a new page has to carry
 * them to the `POST`, and a saved page has to keep them out of its `PATCH` so a
 * dialog rename cannot be rolled back by a body save.
 */
interface Draft {
  name: string;
  description: string;
  /** The containing group; `null` = Top level. */
  groupId: number | null;
  /** Human provenance, never shown to an agent. */
  sourceRef: string;
  content: string;
}

const BLANK_DRAFT: Draft = {
  name: "",
  description: "",
  groupId: null,
  sourceRef: "",
  content: "",
};

function draftOfPage(page: KbPageDetail): Draft {
  return {
    name: page.name,
    description: page.description ?? "",
    groupId: page.groupId,
    sourceRef: page.sourceRef ?? "",
    content: page.content,
  };
}

function identityPatch(
  identity: KbPageIdentity,
): Pick<Draft, "name" | "groupId" | "sourceRef"> {
  return {
    name: identity.name,
    groupId: identity.groupId,
    sourceRef: identity.sourceRef,
  };
}

/** A new page sends its whole row; the service defaults `content_type`. */
function createPayload(draft: Draft): Record<string, unknown> {
  const description = draft.description.trim();
  const sourceRef = draft.sourceRef.trim();
  return {
    name: draft.name.trim(),
    description: description === "" ? null : description,
    groupId: draft.groupId,
    content: draft.content,
    sourceRef: sourceRef === "" ? null : sourceRef,
  };
}

/** A saved page sends only the two fields the pane edits. */
function bodyPayload(draft: Draft): Record<string, unknown> {
  const description = draft.description.trim();
  return {
    description: description === "" ? null : description,
    content: draft.content,
  };
}

async function request<T = unknown>(
  method: string,
  url: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    const payload = (await res.json().catch(() => null)) as {
      message?: string;
      error?: string;
    } | null;
    throw new Error(payload?.message ?? payload?.error ?? `HTTP ${res.status}`);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

async function fetchTree(collectionId: string): Promise<KbTreeDetail | null> {
  try {
    const res = await fetch(`/api/kb/${collectionId}`);
    if (!res.ok) return null;
    return (await res.json()) as KbTreeDetail;
  } catch {
    return null;
  }
}

/** Which node a row's trash button is asking to remove. */
type DeleteTarget = { kind: "group" | "page"; id: number } | "collection" | null;

export interface KbEditorProps {
  initialDetail: KbTreeDetail;
  onBack: () => void;
  /** Invalidate the left panel's list cache — counts move with every write. */
  onChanged: () => void;
  onDeleted: () => void;
}

export function KbEditor({
  initialDetail,
  onBack,
  onChanged,
  onDeleted,
}: KbEditorProps): ReactNode {
  const [detail, setDetail] = useState<KbTreeDetail>(initialDetail);
  const [selection, setSelection] = useState<KbSelection>({ kind: "none" });
  const [draft, setDraft] = useState<Draft>(BLANK_DRAFT);
  const [saved, setSaved] = useState<Draft>(BLANK_DRAFT);

  /** Page bodies are not in the tree response, so they are fetched per node. */
  const [pageCache, setPageCache] = useState<Map<number, KbPageDetail>>(
    () => new Map(),
  );
  const [pageLoading, setPageLoading] = useState<boolean>(false);
  const [saving, setSaving] = useState<boolean>(false);
  const [deleting, setDeleting] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget>(null);
  /** Which group dialog is open, and for which row. `null` = none. */
  const [groupDialog, setGroupDialog] = useState<
    { mode: "create" } | { mode: "edit"; group: KbGroupRow } | null
  >(null);
  const [pageDialog, setPageDialog] = useState<
    { mode: "create" } | { mode: "edit"; page: KbPageSummary } | null
  >(null);
  /** Tree node the author is being asked to abandon unsaved edits for. */
  const [pending, setPending] = useState<KbSelection | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(
    () => () => {
      abortRef.current?.abort();
      // Nulling the ref is what makes the aborted read's continuation a no-op:
      // both of its paths compare the controller identity before touching state.
      abortRef.current = null;
    },
    [],
  );

  const {
    canEdit,
    canDelete,
    loading: permsLoading,
  } = useResourcePermissions({
    visibility: detail.visibility as "private" | "public",
    createdBy: detail.createdBy,
  });

  /** QUIRK: the session and role resolve a beat after mount, so the header and
   *  the row actions wait rather than flashing "Read-only" at an author who can
   *  edit. The form fields assume the reachability rule (every collection this
   *  page can load is editable by whoever loaded it) and stay open in the
   *  meantime. */
  const editable: boolean = canEdit || permsLoading;

  const isDirty: boolean = useMemo(
    () => JSON.stringify(draft) !== JSON.stringify(saved),
    [draft, saved],
  );

  /**
   * The header's number is the panel's, from the same helper: the tree endpoint
   * ships no tallies, so both sides of the rule are counted here.
   */
  const headerTally: number = kbTopTally({
    groups: detail.groups.reduce((n, g) => (g.parentId === null ? n + 1 : n), 0),
    pages: detail.pages.length,
  });

  const isNewNode: boolean = selection.kind === "new-page";

  /** Only a page has a form here; a group row folds and its dialog edits it. */
  const showPageForm: boolean =
    selection.kind === "page" || selection.kind === "new-page";

  /** Where the page dialog opens: the group of the page in view, else Top level. */
  const pageGroupDefault: number | null =
    selection.kind === "page"
      ? (detail.pages.find((p) => p.id === selection.id)?.groupId ?? null)
      : selection.kind === "new-page"
        ? selection.identity.groupId
        : null;

  const labelOf = useCallback(
    (sel: KbSelection): string => {
      switch (sel.kind) {
        case "none":
          return "New page";
        case "page":
          return detail.pages.find((p) => p.id === sel.id)?.name ?? "Page";
        case "new-page":
          return sel.identity.name || "New page";
      }
    },
    [detail],
  );
  const currentLabel: string = labelOf(selection);

  /** Create waits for a body: `POST` refuses an empty `content`. */
  const createBlocked: boolean = isNewNode && draft.content === "";
  const canSubmit: boolean = isNewNode ? !createBlocked : isDirty;

  // ── Selection ────────────────────────────────────────────────────

  /** Commit a node and its draft together, resetting the dirty baseline. */
  function adopt(sel: KbSelection, next: Draft): void {
    setSelection(sel);
    setDraft(next);
    setSaved(next);
    setError(null);
  }

  /**
   * Drop the in-flight page read. Called before the pane moves to any other
   * target, so a response that is no longer wanted can never land over the
   * selection that replaced it — including a cached page, or leaving the pane
   * while the previous page is still loading.
   */
  function cancelPageLoad(): void {
    abortRef.current?.abort();
    abortRef.current = null;
    setPageLoading(false);
  }

  function loadPage(sel: { kind: "page"; id: number }): void {
    cancelPageLoad();
    const cached = pageCache.get(sel.id);
    if (cached) {
      adopt(sel, draftOfPage(cached));
      return;
    }
    const previous = { selection, draft, saved };
    setSelection(sel);
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setPageLoading(true);
    void (async () => {
      try {
        const page = await request<KbPageDetail>(
          "GET",
          `/api/kb/${detail.id}/pages/${sel.id}`,
          undefined,
          ctrl.signal,
        );
        if (abortRef.current !== ctrl) return;
        setPageCache((prev) => new Map(prev).set(sel.id, page));
        adopt(sel, draftOfPage(page));
      } catch (err) {
        // A superseded read (or an unmount) lands here; the selection that
        // replaced it is the one on screen, so there is nothing to restore.
        if (abortRef.current !== ctrl) return;
        // Stay on the node the author was reading rather than opening a pane
        // with no body behind it.
        setSelection(previous.selection);
        setDraft(previous.draft);
        setSaved(previous.saved);
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (abortRef.current === ctrl) setPageLoading(false);
      }
    })();
  }

  /** Move the detail pane to a page, always re-deriving its draft. */
  function applySelect(sel: KbSelection): void {
    switch (sel.kind) {
      case "none":
        cancelPageLoad();
        adopt(sel, BLANK_DRAFT);
        return;
      case "new-page":
        cancelPageLoad();
        adopt(sel, { ...BLANK_DRAFT, ...identityPatch(sel.identity) });
        return;
      case "page":
        loadPage(sel);
        return;
    }
  }

  /** Tree entry point: refuses to drop unsaved edits silently. */
  function requestSelect(sel: KbSelection): void {
    if (selectionKey(sel) === selectionKey(selection)) return;
    if (isDirty) {
      setPending(sel);
      return;
    }
    applySelect(sel);
  }

  // ── Dialogs ──────────────────────────────────────────────────────

  /** Opening a dialog leaves the pane untouched, so it needs no unsaved guard. */
  function handleNewGroup(): void {
    setGroupDialog({ mode: "create" });
  }

  function handleEditGroup(group: KbGroupRow): void {
    setGroupDialog({ mode: "edit", group });
  }

  async function handleGroupSaved(): Promise<void> {
    setGroupDialog(null);
    onChanged();
    await reloadTree();
  }

  function handleNewPage(): void {
    setPageDialog({ mode: "create" });
  }

  function handleEditPage(page: KbPageSummary): void {
    setPageDialog({ mode: "edit", page });
  }

  async function handlePageConfirmed(
    identity: KbPageIdentity,
    page: KbPageDetail | null,
  ): Promise<void> {
    setPageDialog(null);
    if (page === null) {
      // Creating: the row cannot exist before its body does, so the pane takes
      // the identity and the header's Create stays the write. Going through
      // `requestSelect` means an unsaved body is not dropped silently.
      requestSelect({ kind: "new-page", identity });
      return;
    }
    onChanged();
    setPageCache((prev) => new Map(prev).set(page.id, page));
    // Move the identity into both the draft and its baseline: the pane keeps
    // those fields for the create path only, and leaving the old name behind
    // would read as a rename the author never made.
    if (selection.kind === "page" && selection.id === page.id) {
      setDraft((prev) => ({ ...prev, ...identityPatch(identity) }));
      setSaved((prev) => ({ ...prev, ...identityPatch(identity) }));
    }
    await reloadTree();
  }

  async function reloadTree(): Promise<void> {
    const next = await fetchTree(detail.id);
    if (next) setDetail(next);
  }

  function update<K extends keyof Draft>(key: K, value: Draft[K]): void {
    setDraft((prev) => ({ ...prev, [key]: value }));
  }

  // ── Saving ───────────────────────────────────────────────────────

  async function runSave(): Promise<boolean> {
    if (!canEdit || !canSubmit) return false;
    setSaving(true);
    setError(null);
    const base = `/api/kb/${detail.id}`;
    try {
      const row =
        selection.kind === "page"
          ? await request<KbPageDetail>(
              "PATCH",
              `${base}/pages/${selection.id}`,
              bodyPayload(draft),
            )
          : await request<KbPageDetail>("POST", `${base}/pages`, createPayload(draft));
      setPageCache((prev) => new Map(prev).set(row.id, row));
      // Re-adopt the server's normalized row rather than keeping the local
      // draft: text typed with a trailing space would otherwise stay dirty while
      // the tree around it shows the trimmed one.
      adopt({ kind: "page", id: row.id }, draftOfPage(row));
      onChanged();
      await reloadTree();
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function saveAndContinue(): Promise<void> {
    const ok = await runSave();
    const next = pending;
    setPending(null);
    if (ok && next) applySelect(next);
  }

  function discardAndContinue(): void {
    const next = pending;
    setPending(null);
    if (next) applySelect(next);
  }

  // ── Deleting ─────────────────────────────────────────────────────

  async function runDelete(): Promise<void> {
    if (deleteTarget === null) return;
    setDeleting(true);
    setError(null);
    const base = `/api/kb/${detail.id}`;
    try {
      if (deleteTarget === "collection") {
        await request("DELETE", base);
        setDeleteTarget(null);
        onDeleted();
        return;
      }
      const { kind, id } = deleteTarget;
      // A deleted group takes its pages with it, so every body cached under one
      // of them is stale — and the open form is reset when it held one of them.
      const lostPageIds: number[] =
        kind === "group"
          ? detail.pages.filter((p) => p.groupId === id).map((p) => p.id)
          : [id];
      if (kind === "group") {
        await request("DELETE", `${base}/groups/${id}`);
      } else {
        await request("DELETE", `${base}/pages/${id}`);
      }
      setDeleteTarget(null);
      onChanged();
      setPageCache((prev) => {
        const next = new Map(prev);
        for (const pageId of lostPageIds) next.delete(pageId);
        return next;
      });
      if (selection.kind === "page" && lostPageIds.includes(selection.id)) {
        // An in-flight read of the page just deleted must not adopt it back
        // once its response lands.
        cancelPageLoad();
        adopt({ kind: "none" }, BLANK_DRAFT);
      } else if (
        kind === "group" &&
        selection.kind === "new-page" &&
        selection.identity.groupId === id
      ) {
        // The draft's row would point at a group that no longer exists, so it
        // loses its home along with the directory rather than rendering nowhere.
        adopt({ kind: "none" }, BLANK_DRAFT);
      }
      await reloadTree();
    } catch (err) {
      setDeleteTarget(null);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDeleting(false);
    }
  }

  // ── Render ───────────────────────────────────────────────────────

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
        <h1 className="flex min-w-0 items-baseline gap-1.5 text-sm font-semibold leading-none">
          <span className="truncate">{detail.name}</span>
          <span className="shrink-0 font-normal text-muted-foreground tabular-nums">
            ({headerTally})
          </span>
        </h1>

        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          {!permsLoading &&
            (canEdit ? (
              <Button
                size="sm"
                onClick={() => void runSave()}
                disabled={saving || deleting || !canSubmit}
                className={cn(
                  "h-6 gap-1 px-2 text-xs",
                  canSubmit && "bg-amber-600 text-white hover:bg-amber-700",
                )}
              >
                {saving ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Save className="h-3.5 w-3.5" />
                )}
                Save
              </Button>
            ) : (
              /* A denied action is a static label, never a disabled button. */
              <span className="text-[11px] text-muted-foreground">Read-only</span>
            ))}

          {/* The collection's delete is permanent and stays in the header: node
              deletes belong to the rows they name, and the panel list keeps
              destructive actions out of its own scrolling rows. */}
          {!permsLoading &&
            canDelete && (
              <Button
                size="sm"
                className="h-6 shrink-0 gap-1 bg-primary px-2 text-xs text-destructive hover:bg-primary/80 hover:text-destructive"
                onClick={() => setDeleteTarget("collection")}
                disabled={saving || deleting}
                title="Delete this collection (cannot be undone)"
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

      <div className="flex min-h-0 flex-1">
        <KbTree
          pageCount={detail.pages.length}
          groups={detail.groups}
          pages={detail.pages}
          selection={selection}
          onSelect={requestSelect}
          editable={editable}
          onNewGroup={handleNewGroup}
          onEditGroup={handleEditGroup}
          onNewPage={handleNewPage}
          onEditPage={handleEditPage}
          onDeleteGroup={(group) => setDeleteTarget({ kind: "group", id: group.id })}
          onDeletePage={(page) => setDeleteTarget({ kind: "page", id: page.id })}
          dirtyLabel={isDirty ? currentLabel : null}
        />

        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex min-h-0 flex-1 flex-col gap-4 px-6 py-5">
            {error && (
              <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                {error}
              </p>
            )}

            {pageLoading ? (
              <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground">
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                Loading…
              </div>
            ) : !showPageForm ? (
              <p className="text-xs text-muted-foreground">
                Pick a page to check or edit.
              </p>
            ) : (
              <PageForm
                draft={draft}
                canEdit={editable}
                onUpdate={update}
              />
            )}
          </div>
        </div>
      </div>

      {groupDialog && (
        <KbGroupDialog
          collectionId={detail.id}
          groups={detail.groups}
          group={groupDialog.mode === "edit" ? groupDialog.group : undefined}
          onClose={() => setGroupDialog(null)}
          onSaved={() => void handleGroupSaved()}
        />
      )}

      {pageDialog && (
        <KbPageDialog
          collectionId={detail.id}
          groups={detail.groups}
          page={pageDialog.mode === "edit" ? pageDialog.page : undefined}
          defaultGroupId={
            pageDialog.mode === "create" ? pageGroupDefault : null
          }
          onClose={() => setPageDialog(null)}
          onConfirmed={(identity, page) =>
            void handlePageConfirmed(identity, page)
          }
        />
      )}

      <DeleteConfirmDialog
        title={
          deleteTarget === "collection"
            ? "Delete knowledge"
            : deleteTarget?.kind === "group"
              ? "Delete group"
              : "Delete page"
        }
        description={
          <DeleteBody target={deleteTarget} detail={detail} />
        }
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open && !deleting) setDeleteTarget(null);
        }}
        onConfirm={() => void runDelete()}
        deleting={deleting}
      />

      <UnsavedChangesDialog
        open={pending !== null}
        fileName={currentLabel}
        saving={saving}
        error={error}
        onSave={() => void saveAndContinue()}
        onIgnore={discardAndContinue}
        onCancel={() => setPending(null)}
      />
    </div>
  );
}

// ── Confirm body ───────────────────────────────────────────────────

/**
 * The body states its own consequence instead of querying for it: the counts are
 * already in the tree, and `builtin_agent_tool.kb_collection_id` cascades, so
 * the bindings go with the collection.
 */
function DeleteBody({
  target,
  detail,
}: {
  target: DeleteTarget;
  detail: KbTreeDetail;
}): ReactNode {
  if (target === "collection") {
    return (
      <>
        This permanently removes <strong>{detail.name}</strong>, its{" "}
        {detail.groups.length} group{detail.groups.length === 1 ? "" : "s"} and{" "}
        {detail.pages.length} page{detail.pages.length === 1 ? "" : "s"}. Agents
        bound to it lose the mount — they cannot read it afterwards. This cannot
        be undone.
      </>
    );
  }
  if (target === null) return null;
  if (target.kind === "group") {
    const group = detail.groups.find((g) => g.id === target.id);
    const pages = detail.pages.filter((p) => p.groupId === target.id);
    const children = detail.groups.filter((g) => g.parentId === target.id);
    return (
      <>
        Permanently delete group <strong>{group?.name ?? "this group"}</strong>?
        {pages.length > 0 && (
          <>
            {" "}
            Its {pages.length} page{pages.length === 1 ? "" : "s"} are deleted
            with it. This cannot be undone.
          </>
        )}
        {children.length > 0 && (
          <>
            {" "}
            It still holds {children.length} nested group
            {children.length === 1 ? "" : "s"}, so the delete will be refused
            until they are moved or deleted.
          </>
        )}
      </>
    );
  }
  const page = detail.pages.find((p) => p.id === target.id);
  return (
    <>
      Permanently delete page <strong>{page?.name ?? "this page"}</strong> and
      its {formatBytes(page?.size ?? 0)} of content? An agent that asks for it
      afterwards gets <code>NO_SUCH_PAGE</code>. This cannot be undone.
    </>
  );
}

// ── Detail form ────────────────────────────────────────────────────

interface PageFormProps {
  draft: Draft;
  canEdit: boolean;
  onUpdate: <K extends keyof Draft>(key: K, value: Draft[K]) => void;
}

/**
 * The two things the pane owns: the line an agent sees in `list_kb_pages`, and
 * the body `read_kb_page` returns. Name, group and source are the identity
 * dialog's, so they are not repeated here.
 */
function PageForm({ draft, canEdit, onUpdate }: PageFormProps): ReactNode {
  return (
    <>
      <div className="flex shrink-0 items-start gap-3">
        <Label htmlFor="kb-field-description" className="w-24 shrink-0 pt-2">
          Description
        </Label>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <Textarea
            id="kb-field-description"
            value={draft.description}
            readOnly={!canEdit}
            onChange={(e) => onUpdate("description", e.target.value)}
            maxLength={MAX_DESCRIPTION_CHARS}
            rows={3}
            className="resize-none text-xs"
          />
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-1.5">
        <Textarea
          id="kb-field-content"
          value={draft.content}
          readOnly={!canEdit}
          onChange={(e) => onUpdate("content", e.target.value)}
          rows={24}
          className="min-h-0 flex-1 resize-none font-mono text-xs [field-sizing:fixed]"
        />
      </div>
    </>
  );
}
