"use client";

/**
 * ArtifactDetail — main-area renderer for `/artifact/[id]`.
 *
 * Renders the artifact + the metadata + the action bar (Rename /
 * Move / Delete). Folders use a folder-specific layout: list of
 * direct children with quick navigation. Chart leaves render the
 * bound workflow's resolved option (the bundle's `data` field) via
 * `<EChartsRenderer>`; other artifact types show a placeholder
 * until a workflow-node renderer for them lands.
 *
 * Workflow-backed artifacts get a two-row layout: the chart +
 * metadata stack on top, a node-graph visualization of the backing
 * workflow on the bottom, separated by a draggable handle. Folders
 * and standalone (no-workflow) artifacts keep the single-pane
 * layout.
 *
 * See docs/artifact-evolution.md.
 */

import {
  ArrowLeft,
  ChevronRight as ChevronRightCrumb,
  ChevronUp,
  Folder,
  Loader2,
  Move,
  Pencil,
  RefreshCw,
  Sparkles,
  Trash2,
} from "lucide-react";
import { useRouter } from "next/navigation";
import {
  useCallback,
  useMemo,
  useRef,
  useState,
  type ReactElement,
} from "react";
import { toast } from "sonner";
import useSWR, { mutate as globalMutate } from "swr";
import { useDefaultLayout, type PanelImperativeHandle } from "react-resizable-panels";

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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { ScrollArea } from "@/components/ui/scroll-area";
import { WorkflowGraph } from "@/components/workflow-graph/WorkflowGraph";
import { ChartErrorBoundary } from "@/components/workspace/ChartErrorBoundary";
import { EChartsRenderer } from "@/components/workspace/EChartsRenderer";
import {
  useArtifactTree,
  indexById,
  pathOf,
  type ArtifactNode,
} from "@/hooks/useArtifactTree";
import type { ArtifactEntity } from "@/lib/db/schema";
import { cn } from "@/lib/utils";
import type { CanonicalWorkflowSpec } from "@/lib/workflows/spec/schema";

/**
 * Bundle response shape returned by `GET /api/artifacts/[id]`.
 *
 * `workflow` is present only when the artifact is backed by a
 * stored workflow row (one workflow can back many artifacts).
 * Folders and standalone artifacts have `node` only.
 * See `src/lib/artifacts/bundle.ts`.
 */
interface ArtifactBundleResponse {
  node: ArtifactEntity;
  workflow?: {
    id: string;
    name: string;
    spec: CanonicalWorkflowSpec;
    outputField: string;
  };
  /** Resolved workflow output — the renderable payload for the
   *  artifact's body. For chart artifacts this is the merged
   *  ECharts option. Present only when the workflow executed
   *  successfully. */
  data?: unknown;
  /** Whether `data` came from a cache hit (L2 caching is not
   *  wired today; always `false`). */
  fromCache?: boolean;
  /** ISO-8601 timestamp of the execution that produced `data`. */
  executedAt?: string;
}

/**
 * localStorage id for the vertical (chart / workflow) split. One
 * global preference shared across all workflow-backed artifacts —
 * the user has one mental model of "how much space the workflow
 * deserves", not a per-artifact one.
 */
const VERTICAL_LAYOUT_ID = "nango:artifact-detail:vertical";

/**
 * Default share of the bottom (workflow) panel when newly mounting
 * AND when the user clicks the "Show workflow" reveal button. The
 * latter is critical: `PanelImperativeHandle.expand()` restores the
 * panel to its "most recent size" — which after a drag-collapse is
 * usually a few percent — so calling `expand()` only nudges the
 * panel back up a sliver. We pass this explicit size via `resize()`
 * instead to give a predictable substantial reveal.
 */
const WORKFLOW_PANEL_DEFAULT_SIZE = 40;

const fetcher = async (url: string): Promise<ArtifactBundleResponse> => {
  const res = await fetch(url);
  if (!res.ok) {
    const detail: string = (await res.json().catch(() => ({})))?.message
      ?? `${res.status} ${res.statusText}`;
    throw new Error(detail);
  }
  return res.json();
};

export interface ArtifactDetailProps {
  artifactId: string;
}

export function ArtifactDetail({ artifactId }: ArtifactDetailProps): ReactElement {
  const router = useRouter();
  const { data, error, isLoading, mutate } = useSWR<ArtifactBundleResponse>(
    `/api/artifacts/${artifactId}`,
    fetcher,
    { revalidateOnFocus: false },
  );
  const { tree, mutate: mutateTree } = useArtifactTree();

  const [dialog, setDialog] = useState<"rename" | "move" | "delete" | null>(null);

  const node: ArtifactEntity | undefined = data?.node;
  const isSeedCategory: boolean = node ? node.parentId === null && node.kind === "folder" : false;

  // Compute breadcrumb from the (already-loaded for the panel) tree.
  // Falls back to a single-segment trail of just the current node when
  // the tree hasn't loaded yet.
  const breadcrumb: ArtifactNode[] = useMemo(() => {
    if (!tree || !node) return [];
    const path = pathOf(indexById(tree), node.id);
    return path;
  }, [tree, node]);

  const handleRename = useCallback(
    async (next: string): Promise<void> => {
      if (!node) return;
      const ok = await patchNode(node.id, { name: next });
      if (ok) {
        await Promise.all([mutate(), mutateTree()]);
        setDialog(null);
      }
    },
    [node, mutate, mutateTree],
  );

  const handleMove = useCallback(
    async (parentId: string): Promise<void> => {
      if (!node) return;
      const ok = await patchNode(node.id, { parentId });
      if (ok) {
        await Promise.all([mutate(), mutateTree()]);
        setDialog(null);
      }
    },
    [node, mutate, mutateTree],
  );

  const handleDelete = useCallback(async (): Promise<void> => {
    if (!node) return;
    const ok = await deleteNode(node.id);
    if (ok) {
      await mutateTree();
      setDialog(null);
      // Return to the artifact section index instead of `/`, mirroring
      // the editor convention. The Artifacts panel stays open and the
      // Welcome card sits next to it.
      router.push("/artifact");
    }
  }, [node, mutateTree, router]);

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading…
      </div>
    );
  }

  if (error || !node) {
    return (
      <div className="flex h-full flex-col">
        <DetailHeader
          title="Artifact not found"
          onBack={() => router.push("/artifact")}
        />
        <div className="m-6 rounded border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
          {error?.message ?? "Unknown error."}
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <DetailHeader
        title={node.name}
        breadcrumb={breadcrumb}
        onBack={() => router.push("/artifact")}
        onCrumbClick={(id) => {
          if (id !== node.id) router.push(`/artifact/${id}`);
        }}
        actions={
          isSeedCategory ? null : (
            <ActionBar
              onRename={() => setDialog("rename")}
              onMove={() => setDialog("move")}
              onDelete={() => setDialog("delete")}
            />
          )
        }
      />

      {/* Body layout — workflow-backed artifacts get a vertical
          split (chart on top, workflow graph on bottom); folders
          and standalone artifacts keep the single-pane scroll. */}
      {data?.workflow && node.kind !== "folder" ? (
        <WorkflowBackedLayout
          node={node}
          tree={tree}
          router={router}
          spec={data.workflow.spec}
          data={data.data}
          executedAt={data.executedAt}
        />
      ) : (
        <ArtifactScrollBody
          node={node}
          tree={tree}
          router={router}
          data={data?.data}
          executedAt={data?.executedAt}
        />
      )}

      {/* Dialogs */}
      {dialog === "rename" && (
        <RenameDialog
          initialValue={node.name}
          onCancel={() => setDialog(null)}
          onConfirm={handleRename}
        />
      )}
      {dialog === "move" && (
        <MoveDialog
          node={node}
          onCancel={() => setDialog(null)}
          onConfirm={handleMove}
        />
      )}
      {dialog === "delete" && (
        <AlertDialog open onOpenChange={(o) => !o && setDialog(null)}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete this artifact?</AlertDialogTitle>
              <AlertDialogDescription>
                &ldquo;{node.name}&rdquo; will be permanently removed from your
                library. This cannot be undone.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                onClick={() => void handleDelete()}
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

// body layouts

interface ArtifactScrollBodyProps {
  node: ArtifactEntity;
  tree: ArtifactNode[] | undefined;
  router: ReturnType<typeof useRouter>;
  /** Resolved workflow output. Chart artifacts
   *  prefer this over `node.content.blocks` so the body always
   *  reflects the current workflow execution. */
  data?: unknown;
  executedAt?: string;
}

/**
 * Single-pane scrollable body — the legacy layout used by folders
 * and standalone (no-workflow) artifacts.
 *
 * `min-h-0` is the critical CSS escape from the flex gotcha: a
 * `flex-1` child's default `min-height: auto` lets the box grow
 * to fit content rather than constrain to the parent's remaining
 * space. Without it, a long card_list artifact pushes the trailing
 * MetaCard past the viewport bottom and the outer `<main>`'s
 * `overflow-hidden` prevents the page itself from scrolling to
 * recover.
 */
function ArtifactScrollBody({
  node,
  tree,
  router,
  data,
  executedAt,
}: ArtifactScrollBodyProps): ReactElement {
  return (
    <ScrollArea className="min-h-0 flex-1">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-5 px-6 py-6">
        {node.description && (
          <p className="text-sm text-muted-foreground">{node.description}</p>
        )}
        {node.kind === "folder" ? (
          <FolderBody node={node} tree={tree} router={router} />
        ) : (
          <ArtifactBody node={node} data={data} executedAt={executedAt} />
        )}
        <MetaCard node={node} />
      </div>
    </ScrollArea>
  );
}

interface WorkflowBackedLayoutProps {
  node: ArtifactEntity;
  tree: ArtifactNode[] | undefined;
  router: ReturnType<typeof useRouter>;
  spec: CanonicalWorkflowSpec;
  data?: unknown;
  executedAt?: string;
}

/**
 * Two-row layout for workflow-backed artifacts: chart + metadata
 * on top, workflow graph on the bottom, separated by a draggable
 * `<ResizableHandle>`. Layout proportions persist to localStorage
 * (`useDefaultLayout`) under a single shared key so the user's
 * "how much space for the workflow" preference carries across
 * artifacts.
 *
 * The bottom panel is `collapsible` (drag-to-bottom hides it).
 * When collapsed, a sticky "Show workflow" pill anchors to the
 * bottom-right and re-expands the panel via `panelRef.expand()`.
 */
function WorkflowBackedLayout({
  node,
  tree,
  router,
  spec,
  data,
  executedAt,
}: WorkflowBackedLayoutProps): ReactElement {
  const lowerPanelRef = useRef<PanelImperativeHandle | null>(null);
  // Track the lower panel's current size (asPercentage). The
  // initial value is conservative — onResize fires on mount so
  // this is immediately corrected.
  const [lowerSize, setLowerSize] = useState<number>(40);

  const storage = typeof window !== "undefined" ? window.localStorage : undefined;
  const { defaultLayout, onLayoutChanged } = useDefaultLayout({
    id: VERTICAL_LAYOUT_ID,
    panelIds: ["artifact-upper", "artifact-lower"],
    storage,
  });

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <ResizablePanelGroup
        orientation="vertical"
        defaultLayout={defaultLayout}
        onLayoutChanged={onLayoutChanged}
      >
        <ResizablePanel
          id="artifact-upper"
          defaultSize={60}
          minSize={20}
        >
          <ArtifactScrollBody
            node={node}
            tree={tree}
            router={router}
            data={data}
            executedAt={executedAt}
          />
        </ResizablePanel>
        <ResizableHandle withHandle />
        <ResizablePanel
          id="artifact-lower"
          defaultSize={WORKFLOW_PANEL_DEFAULT_SIZE}
          minSize={0}
          collapsible
          collapsedSize={0}
          panelRef={lowerPanelRef}
          onResize={(size) => setLowerSize(size.asPercentage)}
        >
          <WorkflowGraph spec={spec} />
        </ResizablePanel>
      </ResizablePanelGroup>

      {/* Reveal hook — visible only when the bottom panel is
          collapsed (or near-collapsed). Anchored bottom-right so it
          doesn't fight the resize handle's hit area.

          We call `resize("N%")` rather than `expand()` here on
          purpose: see WORKFLOW_PANEL_DEFAULT_SIZE doc-comment —
          `expand()` only restores the few-percent size the panel
          had right before collapsing, which is barely a reveal. */}
      {lowerSize < 2 && (
        <Button
          variant="secondary"
          size="sm"
          className="absolute bottom-3 right-4 z-20 h-7 gap-1 px-2.5 text-xs shadow"
          onClick={() =>
            lowerPanelRef.current?.resize(`${WORKFLOW_PANEL_DEFAULT_SIZE}%`)
          }
        >
          <ChevronUp className="h-3 w-3" />
          Show workflow
        </Button>
      )}
    </div>
  );
}

// header

interface DetailHeaderProps {
  title: string;
  breadcrumb?: ArtifactNode[];
  onBack: () => void;
  onCrumbClick?: (id: string) => void;
  actions?: ReactElement | null;
}

function DetailHeader({
  title,
  breadcrumb,
  onBack,
  onCrumbClick,
  actions,
}: DetailHeaderProps): ReactElement {
  return (
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
      <div className="flex flex-1 min-w-0 items-center gap-1 text-xs text-muted-foreground">
        {breadcrumb && breadcrumb.length > 0 ? (
          breadcrumb.map((n, i) => (
            <span key={n.id} className="flex items-center gap-1">
              {i > 0 && <ChevronRightCrumb className="h-3 w-3" />}
              <button
                type="button"
                onClick={() => onCrumbClick?.(n.id)}
                className={cn(
                  "truncate",
                  i === breadcrumb.length - 1
                    ? "font-medium text-foreground"
                    : "hover:underline",
                )}
              >
                {n.name}
              </button>
            </span>
          ))
        ) : (
          <h1 className="truncate text-sm font-semibold text-foreground">
            {title}
          </h1>
        )}
      </div>
      {actions && <div className="flex items-center gap-1">{actions}</div>}
    </header>
  );
}

function ActionBar({
  onRename,
  onMove,
  onDelete,
}: {
  onRename: () => void;
  onMove: () => void;
  onDelete: () => void;
}): ReactElement {
  return (
    <>
      <Button size="sm" variant="outline" onClick={onRename} className="h-8 gap-1.5">
        <Pencil className="h-3.5 w-3.5" />
        Rename
      </Button>
      <Button size="sm" variant="outline" onClick={onMove} className="h-8 gap-1.5">
        <Move className="h-3.5 w-3.5" />
        Move
      </Button>
      <Button
        size="sm"
        variant="outline"
        onClick={onDelete}
        className="h-8 gap-1.5 text-destructive hover:bg-destructive/10 hover:text-destructive"
      >
        <Trash2 className="h-3.5 w-3.5" />
        Delete
      </Button>
    </>
  );
}

// bodies

function FolderBody({
  node,
  tree,
  router,
}: {
  node: ArtifactEntity;
  tree: ArtifactNode[] | undefined;
  router: ReturnType<typeof useRouter>;
}): ReactElement {
  const children: ArtifactNode[] = useMemo(() => {
    if (!tree) return [];
    const idx = indexById(tree);
    return idx.get(node.id)?.children ?? [];
  }, [tree, node.id]);

  if (children.length === 0) {
    return (
      <div className="rounded border border-dashed bg-muted/20 p-8 text-center text-sm text-muted-foreground">
        This folder is empty.
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
      {children.map((child) => (
        <button
          key={child.id}
          type="button"
          onClick={() => router.push(`/artifact/${child.id}`)}
          className="flex items-start gap-2 rounded border bg-card p-3 text-left transition hover:border-primary/40 hover:bg-muted/40"
        >
          {child.kind === "folder" ? (
            <Folder className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
          ) : (
            <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
          )}
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">{child.name}</p>
            {child.description && (
              <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
                {child.description}
              </p>
            )}
            {child.kind === "artifact" && child.type && (
              <p className="mt-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                {child.type}
              </p>
            )}
          </div>
        </button>
      ))}
    </div>
  );
}

interface ArtifactBodyProps {
  node: ArtifactEntity;
  /** Resolved workflow output. For chart artifacts this is the
   *  merged ECharts option produced by the workflow's chart node.
   *  Other artifact types (html / report) have no workflow-node
   *  renderer yet and show a "not yet supported" placeholder until
   *  they migrate. */
  data?: unknown;
  /** ISO-8601 timestamp from the execution that produced `data` —
   *  surfaced as a small caption beneath the rendered body. */
  executedAt?: string;
}

function ArtifactBody({
  node,
  data,
  executedAt,
}: ArtifactBodyProps): ReactElement {
  // Chart artifacts: `bundle.data` is the merged ECharts option
  // produced by the workflow's chart node. Render it directly so
  // the body always reflects the latest workflow execution.
  if (node.type === "chart" && isChartOption(data)) {
    return (
      <div className="flex flex-col gap-2">
        <ChartErrorBoundary resetKey={node.id}>
          <div className="h-[480px] w-full">
            <EChartsRenderer option={data as Record<string, unknown>} />
          </div>
        </ChartErrorBoundary>
        <div className="flex items-center justify-end gap-3 text-xs text-muted-foreground">
          {executedAt !== undefined && (
            <span>Executed at {new Date(executedAt).toLocaleString()}</span>
          )}
          <RefreshChartButton artifactId={node.id} />
        </div>
      </div>
    );
  }

  return (
    <div className="rounded border border-dashed bg-muted/20 p-8 text-center text-sm text-muted-foreground">
      No renderer for this artifact type yet
      {node.type ? (
        <>
          {" "}(<code className="font-mono text-xs">{node.type}</code>)
        </>
      ) : null}
      . The workflow ran, but its output isn&apos;t a chart shape; a
      type-specific renderer will land in a future release.
    </div>
  );
}

/**
 * "Refresh" pill rendered beneath the chart body. POSTs to
 * `/api/artifacts/[id]/refresh` (which force-executes the
 * artifact's workflow) and overwrites the SWR cache with the new
 * bundle so `<EChartsRenderer>` re-mounts with the latest option.
 *
 * Failure modes surface as toasts — the chart keeps showing the
 * previously-rendered option so the user is never left with a
 * blank panel after a transient refresh error.
 */
interface RefreshChartButtonProps {
  artifactId: string;
}

function RefreshChartButton({
  artifactId,
}: RefreshChartButtonProps): ReactElement {
  const [pending, setPending] = useState(false);
  const onClick = useCallback(async (): Promise<void> => {
    if (pending) return;
    setPending(true);
    try {
      const res = await fetch(
        `/api/artifacts/${artifactId}/refresh`,
        { method: "POST" },
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as
          | { message?: string }
          | null;
        throw new Error(body?.message ?? `HTTP ${res.status}`);
      }
      const bundle = (await res.json()) as ArtifactBundleResponse;
      await globalMutate(`/api/artifacts/${artifactId}`, bundle, {
        revalidate: false,
      });
      toast.success("Chart refreshed");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      toast.error(`Refresh failed: ${message}`);
    } finally {
      setPending(false);
    }
  }, [artifactId, pending]);

  return (
    <Button
      size="sm"
      variant="ghost"
      className="h-7 gap-1.5 px-2 text-xs"
      onClick={() => void onClick()}
      disabled={pending}
      aria-busy={pending}
    >
      {pending ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
      ) : (
        <RefreshCw className="h-3.5 w-3.5" />
      )}
      Refresh
    </Button>
  );
}

/**
 * Cheap structural check — `bundle.data` for a chart artifact is
 * an ECharts option (a plain JSON object with at minimum a
 * `series` array). We use this to decide whether to take the
 * workflow-data render path or fall through to the legacy
 * `node.content.blocks` payload.
 */
function isChartOption(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const series = (value as { series?: unknown }).series;
  return Array.isArray(series);
}

function MetaCard({ node }: { node: ArtifactEntity }): ReactElement {
  const rows: Array<[string, string]> = [
    ["Kind", node.kind],
    ["Type", node.type ?? "—"],
    ["Visibility", node.visibility],
    ["Created", new Date(node.createdAt).toLocaleString()],
    ["Updated", new Date(node.updatedAt).toLocaleString()],
  ];
  if (node.sourceThreadId) {
    rows.push(["Source thread", node.sourceThreadId]);
  }
  if (node.sourceOutcomeId) {
    rows.push(["Source outcome", node.sourceOutcomeId]);
  }
  return (
    <div className="rounded border bg-card text-xs">
      <div className="border-b px-3 py-1.5 font-medium text-muted-foreground">
        Metadata
      </div>
      <dl className="grid grid-cols-[8rem_1fr] gap-x-3 gap-y-1.5 px-3 py-2.5">
        {rows.map(([k, v]) => (
          <span key={k} className="contents">
            <dt className="text-muted-foreground">{k}</dt>
            <dd className="truncate font-mono text-foreground">{v}</dd>
          </span>
        ))}
      </dl>
    </div>
  );
}

// dialogs

function RenameDialog({
  initialValue,
  onCancel,
  onConfirm,
}: {
  initialValue: string;
  onCancel: () => void;
  onConfirm: (name: string) => Promise<void>;
}): ReactElement {
  const [name, setName] = useState<string>(initialValue);
  const [busy, setBusy] = useState<boolean>(false);
  const trimmed: string = name.trim();
  const canSubmit: boolean = trimmed.length > 0 && !busy && trimmed !== initialValue;

  const handle = async (): Promise<void> => {
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
          <DialogTitle>Rename</DialogTitle>
        </DialogHeader>
        <div className="grid gap-1.5 py-2">
          <Label htmlFor="rename-name">Name</Label>
          <Input
            id="rename-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={200}
            autoFocus
            onKeyDown={(e) => {
              if (e.key === "Enter") void handle();
            }}
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={handle} disabled={!canSubmit}>
            {busy && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}
            Rename
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function MoveDialog({
  node,
  onCancel,
  onConfirm,
}: {
  node: ArtifactEntity;
  onCancel: () => void;
  onConfirm: (parentId: string) => Promise<void>;
}): ReactElement {
  const [target, setTarget] = useState<string | null>(node.parentId ?? null);
  const [busy, setBusy] = useState<boolean>(false);
  const canSubmit: boolean = target !== null && target !== node.parentId && !busy;

  const handle = async (): Promise<void> => {
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
            Pick a new parent folder.
            {node.kind === "folder"
              && " Folders cannot be moved under their own descendants."}
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
          <Button onClick={handle} disabled={!canSubmit}>
            {busy && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}
            Move
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// API helpers

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
