"use client";

/**
 * KbEditor — center workspace pane for one knowledge collection.
 *
 * Two columns: the structure tree on the left, the selected page's description
 * and body on the right. Nothing else is authored here. A page's path and source
 * are metadata, so they are created and changed from the dialogs on their rows;
 * a folder row only folds its subtree and never moves the detail pane. Pages are
 * plain text: the body is a plain textarea whatever `content_type` says, there
 * is no rendered view, and there is no file import — an author opens the source
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
import { KbFolderDialog } from "@/components/main-panels/kb/KbFolderDialog";
import {
  KbPageDialog,
  type KbPageIdentity,
} from "@/components/main-panels/kb/KbPageDialog";
import { useResourcePermissions } from "@/hooks/useResourcePermissions";
import { cn, formatBytes } from "@/lib/utils";
import { encodePathSegments, getParentPath } from "@/lib/paths";
import { isUnderFolder, topLevelFolderCount } from "@/lib/kb/paths";
import { MAX_DESCRIPTION_CHARS } from "@/lib/kb/limits";
import {
  kbTopTally,
  type KbCollectionDetail,
  type KbPageDetail,
  type KbPageSummary,
} from "@/lib/types/kb";

/**
 * What the pane's draft holds. `path` and `sourceRef` are not fields of this
 * form — the identity dialog owns them — but a new page has to carry them to the
 * `POST`, and a saved page has to keep them out of its `PATCH` so a dialog rename
 * cannot be rolled back by a body save.
 */
interface Draft {
  path: string;
  description: string;
  /** Human provenance, never shown to an agent. */
  sourceRef: string;
  content: string;
}

const BLANK_DRAFT: Draft = {
  path: "",
  description: "",
  sourceRef: "",
  content: "",
};

function draftOfPage(page: KbPageDetail): Draft {
  return {
    path: page.path,
    description: page.description ?? "",
    sourceRef: page.sourceRef ?? "",
    content: page.content,
  };
}

function identityPatch(identity: KbPageIdentity): Pick<Draft, "path" | "sourceRef"> {
  return { path: identity.path, sourceRef: identity.sourceRef };
}

/** A new page sends its whole row; the service defaults `content_type`. */
function createPayload(draft: Draft): Record<string, unknown> {
  const description = draft.description.trim();
  const sourceRef = draft.sourceRef.trim();
  return {
    path: draft.path.trim(),
    description: description === "" ? null : description,
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

async function fetchCollection(id: string): Promise<KbCollectionDetail | null> {
  try {
    const res = await fetch(`/api/kb/${id}`);
    if (!res.ok) return null;
    return (await res.json()) as KbCollectionDetail;
  } catch {
    return null;
  }
}

/** Which node a row's trash button is asking to remove. */
type DeleteTarget =
  | { kind: "folder"; folder: string }
  | { kind: "page"; id: number }
  | "collection"
  | null;

export interface KbEditorProps {
  initialDetail: KbCollectionDetail;
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
  const [detail, setDetail] = useState<KbCollectionDetail>(initialDetail);
  const [selection, setSelection] = useState<KbSelection>({ kind: "none" });
  const [draft, setDraft] = useState<Draft>(BLANK_DRAFT);
  const [saved, setSaved] = useState<Draft>(BLANK_DRAFT);

  /** Page bodies are not in the collection read, so they are fetched per node. */
  const [pageCache, setPageCache] = useState<Map<number, KbPageDetail>>(
    () => new Map(),
  );
  const [pageLoading, setPageLoading] = useState<boolean>(false);
  const [saving, setSaving] = useState<boolean>(false);
  const [deleting, setDeleting] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget>(null);
  /** Which folder row is being renamed. */
  const [folderDialog, setFolderDialog] = useState<string | null>(null);
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

  /** The header's number is the panel's, from the same helper: the tree is made
   *  of these paths on both sides, so both count the same top level. */
  const headerTally: number = kbTopTally({
    folders: topLevelFolderCount(detail.pages.map((page) => page.path)),
    pages: detail.pages.length,
  });

  const isNewNode: boolean = selection.kind === "new-page";

  /** Only a page has a form here; a folder row folds and its dialog renames it. */
  const showPageForm: boolean =
    selection.kind === "page" || selection.kind === "new-page";

  /** The row a page selection points at, so the path can outlive a rename. */
  const pathOfSelection: string | null = useMemo(() => {
    if (selection.kind !== "page") return null;
    return (
      detail.pages.find((page) => page.id === selection.id)?.path ??
      pageCache.get(selection.id)?.path ??
      null
    );
  }, [selection, detail, pageCache]);

  /** Where the page dialog opens: the folder of the page in view, else root. */
  const pageFolderDefault: string =
    selection.kind === "new-page"
      ? getParentPath(selection.identity.path)
      : pathOfSelection === null
        ? ""
        : getParentPath(pathOfSelection);

  const labelOf = useCallback(
    (sel: KbSelection): string => {
      switch (sel.kind) {
        case "none":
          return "New page";
        case "page": {
          const page =
            detail.pages.find((p) => p.id === sel.id) ?? pageCache.get(sel.id);
          return page?.path ?? "Page";
        }
        case "new-page":
          return sel.identity.path || "New page";
      }
    },
    [detail, pageCache],
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
    const path: string | undefined = detail.pages.find(
      (page) => page.id === sel.id,
    )?.path;
    if (path === undefined) return;
    const previous = { selection, draft, saved };
    setSelection(sel);
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setPageLoading(true);
    void (async () => {
      try {
        const page = await request<KbPageDetail>(
          "GET",
          `/api/kb/${detail.id}/pages/${encodePathSegments(path)}`,
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
    // those fields for the create path only, and leaving the old path behind
    // would read as a rename the author never made.
    if (selection.kind === "page" && selection.id === page.id) {
      setDraft((prev) => ({ ...prev, ...identityPatch(identity) }));
      setSaved((prev) => ({ ...prev, ...identityPatch(identity) }));
    }
    await reloadTree();
  }

  async function handleFolderRenamed(): Promise<void> {
    setFolderDialog(null);
    onChanged();
    await reloadTree();
  }

  async function reloadTree(): Promise<void> {
    const next = await fetchCollection(detail.id);
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
        selection.kind === "page" && pathOfSelection !== null
          ? await request<KbPageDetail>(
              "PATCH",
              `${base}/pages/${encodePathSegments(pathOfSelection)}`,
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
      // A deleted folder takes its whole subtree with it, so every body cached
      // under one of those paths is stale — and the open form is reset when it
      // held one of them.
      const lostPages: KbPageSummary[] =
        deleteTarget.kind === "folder"
          ? detail.pages.filter((page) =>
              isUnderFolder(page.path, deleteTarget.folder),
            )
          : detail.pages.filter((page) => page.id === deleteTarget.id);
      const targetPath: string =
        deleteTarget.kind === "folder"
          ? deleteTarget.folder
          : lostPages[0]?.path ?? "";
      const lostPageIds: number[] = lostPages.map((page) => page.id);
      await request(
        "DELETE",
        `${base}/pages/${encodePathSegments(targetPath)}` +
          (deleteTarget.kind === "folder" ? "?kind=folder" : ""),
      );
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
        deleteTarget.kind === "folder" &&
        selection.kind === "new-page" &&
        isUnderFolder(selection.identity.path, deleteTarget.folder)
      ) {
        // The draft's row would be created inside a folder that no longer has
        // any pages, so it loses its home along with the directory rather than
        // rendering nowhere.
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
          pages={detail.pages}
          selection={selection}
          onSelect={requestSelect}
          editable={editable}
          onNewPage={handleNewPage}
          onEditPage={handleEditPage}
          onRenameFolder={setFolderDialog}
          onDeleteFolder={(folder) => setDeleteTarget({ kind: "folder", folder })}
          onDeletePage={(page) => setDeleteTarget({ kind: "page", id: page.id })}
          dirtyPath={isDirty ? draft.path : null}
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

      {folderDialog !== null && (
        <KbFolderDialog
          collectionId={detail.id}
          folder={folderDialog}
          pageCount={
            detail.pages.filter((page) => isUnderFolder(page.path, folderDialog))
              .length
          }
          onClose={() => setFolderDialog(null)}
          onSaved={() => void handleFolderRenamed()}
        />
      )}

      {pageDialog && (
        <KbPageDialog
          collectionId={detail.id}
          page={pageDialog.mode === "edit" ? pageDialog.page : undefined}
          defaultFolder={pageDialog.mode === "create" ? pageFolderDefault : ""}
          existingPaths={detail.pages.map((page) => page.path)}
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
            : deleteTarget?.kind === "folder"
              ? "Delete folder"
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
  detail: KbCollectionDetail;
}): ReactNode {
  if (target === "collection") {
    const folders = new Set(
      detail.pages
        .map((page) => getParentPath(page.path))
        .filter((folder) => folder !== ""),
    );
    return (
      <>
        This permanently removes <strong>{detail.name}</strong>, its {folders.size}{" "}
        folder{folders.size === 1 ? "" : "s"} and {detail.pages.length} page
        {detail.pages.length === 1 ? "" : "s"}. Agents bound to it lose the mount —
        they cannot read it afterwards. This cannot be undone.
      </>
    );
  }
  if (target === null) return null;
  if (target.kind === "folder") {
    const pages = detail.pages.filter((page) =>
      isUnderFolder(page.path, target.folder),
    );
    return (
      <>
        Permanently delete folder <strong>{target.folder}</strong>?
        {pages.length > 0 && (
          <>
            {" "}
            Its {pages.length} page{pages.length === 1 ? "" : "s"}, including any
            deeper folder, are deleted with it. This cannot be undone.
          </>
        )}
      </>
    );
  }
  const page = detail.pages.find((p) => p.id === target.id);
  return (
    <>
      Permanently delete page <strong>{page?.path ?? "this page"}</strong> and its{" "}
      {formatBytes(page?.size ?? 0)} of content? An agent that asks for it
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
 * the body `read_kb_page` returns. Path and source are the identity dialog's, so
 * they are not repeated here.
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
