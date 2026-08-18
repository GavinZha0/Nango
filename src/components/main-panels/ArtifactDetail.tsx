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
  Camera,
  ChevronRight as ChevronRightCrumb,
  Folder,
  FolderInput,
  GitCompare,
  LineChart,
  Loader2,
  Pencil,
  RefreshCw,
  Save,
  Sparkles,
  Trash2,
  Workflow,
} from "lucide-react";
import { useRouter } from "next/navigation";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
} from "react";
import { toast } from "sonner";
import useSWR, { mutate as globalMutate } from "swr";
import {
  type PanelImperativeHandle,
} from "react-resizable-panels";

import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

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
import { Button, buttonVariants } from "@/components/ui/button";
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
import { ArtifactFilterPanel } from "@/components/main-panels/ArtifactFilterPanel";
import {
  useArtifactTree,
  indexById,
  pathOf,
  type ArtifactNode,
} from "@/hooks/useArtifactTree";
import type { ArtifactEntity } from "@/lib/db/schema";
import { cn } from "@/lib/utils";
import { useDisplayTimezone } from "@/hooks/useDisplayTimezone";
import { formatTimestamp } from "@/components/admin/format";
import type {
  CanonicalNode,
  CanonicalWorkflowSpec,
} from "@/lib/workflows/spec/schema";

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
  /** True when data came from stored snapshot without workflow execution. */
  fromSnapshot?: boolean;
  /** ISO-8601 timestamp of when the snapshot was saved. Present when fromSnapshot=true. */
  snapshotAt?: string;
  /** User-supplied input values applied during live execution. */
  appliedInputs?: Record<string, unknown>;
}

interface SnapshotInfo {
  /** Whether data came from stored snapshot (true) or live execution (false). */
  fromSnapshot: boolean;
  /** Pre-formatted timestamp string for display. */
  timestamp: string;
}



/** Map to preserve user's active session filter inputs per artifact across tab navigation without writing DB. */
const sessionAppliedInputsMap = new Map<string, Record<string, unknown>>();

/** Map to track transient viewMode overrides in session. */
const sessionViewModeMap = new Map<string, "snapshot" | "live">();

const fetcher = async (url: string): Promise<ArtifactBundleResponse> => {
  const artifactId = url.split("/").pop();
  const sessionInputs = artifactId ? sessionAppliedInputsMap.get(artifactId) : undefined;
  const viewModeOverride = artifactId ? sessionViewModeMap.get(artifactId) : undefined;

  const res = await fetch(url);
  if (!res.ok) {
    const detail: string = (await res.json().catch(() => ({})))?.message
      ?? `${res.status} ${res.statusText}`;
    throw new Error(detail);
  }
  const bundle = (await res.json()) as ArtifactBundleResponse;

  const currentViewMode = viewModeOverride ?? bundle.node?.viewMode ?? "live";

  if (currentViewMode === "live" && sessionInputs && Object.keys(sessionInputs).length > 0) {
    const refreshRes = await fetch(`${url}/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ inputs: sessionInputs }),
    });
    if (refreshRes.ok) {
      const refreshedBundle = (await refreshRes.json()) as ArtifactBundleResponse;
      if (refreshedBundle.node) {
        refreshedBundle.node.viewMode = "live";
      }
      return refreshedBundle;
    }
  }

  return bundle;
};

export interface ArtifactDetailProps {
  artifactId: string;
}

export function ArtifactDetail({ artifactId }: ArtifactDetailProps): ReactElement {
  const tz = useDisplayTimezone();
  const router = useRouter();
  const { data, error, isLoading, mutate } = useSWR<ArtifactBundleResponse>(
    `/api/artifacts/${artifactId}`,
    fetcher,
    { revalidateOnFocus: false },
  );
  const { tree, mutate: mutateTree } = useArtifactTree();

  const [dialog, setDialog] = useState<"rename" | "move" | "delete" | null>(null);
  const [activeView, setActiveView] = useState<"preview" | "workflow">("preview");

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

  // ── Snapshot actions ────────────────────────────────────────────
  const [isRefreshing, setIsRefreshing] = useState(false);

  const handleRefresh = useCallback(async (inputs?: Record<string, unknown>): Promise<void> => {
    setIsRefreshing(true);
    try {
      if (inputs) {
        sessionAppliedInputsMap.set(artifactId, inputs);
      }
      sessionViewModeMap.set(artifactId, "live");
      const res = await fetch(`/api/artifacts/${artifactId}/refresh`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: inputs ? JSON.stringify({ inputs }) : undefined,
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { message?: string } | null;
        throw new Error(body?.message ?? `HTTP ${res.status}`);
      }
      const bundle = (await res.json()) as ArtifactBundleResponse;

      // Automatically switch viewMode to live when user explicitly refreshes data
      if (node?.viewMode === "snapshot") {
        const patchRes = await fetch(`/api/artifacts/${artifactId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ view_mode: "live" }),
        });
        if (patchRes.ok && bundle.node) {
          bundle.node.viewMode = "live";
        }
      } else if (bundle.node && node?.viewMode) {
        bundle.node.viewMode = node.viewMode;
      }

      await globalMutate(`/api/artifacts/${artifactId}`, bundle, { revalidate: false });
      toast.success("Chart refreshed");
    } catch (err) {
      toast.error(`Refresh failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setIsRefreshing(false);
    }
  }, [artifactId, node]);

  const handleSaveSnapshot = useCallback(async (inputs?: Record<string, unknown>): Promise<void> => {
    try {
      const activeSessionInputs = sessionAppliedInputsMap.get(artifactId);
      const inputsToSave = inputs ?? activeSessionInputs;

      const res = await fetch(`/api/artifacts/${artifactId}/snapshot`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: inputsToSave && Object.keys(inputsToSave).length > 0
          ? JSON.stringify({ inputs: inputsToSave })
          : undefined,
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { message?: string } | null;
        throw new Error(body?.message ?? `HTTP ${res.status}`);
      }
      const bundle = (await res.json()) as ArtifactBundleResponse;

      if (inputsToSave && Object.keys(inputsToSave).length > 0) {
        sessionAppliedInputsMap.set(artifactId, inputsToSave);
      }

      await globalMutate(`/api/artifacts/${artifactId}`, bundle, { revalidate: false });
      toast.success("Snapshot saved");
    } catch (err) {
      toast.error(`Save snapshot failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [artifactId]);

  const handleLoadSnapshot = useCallback(async (): Promise<void> => {
    if (!node || node.viewMode === "snapshot") return;
    sessionViewModeMap.set(artifactId, "snapshot");
    try {
      const res = await fetch(`/api/artifacts/${artifactId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ view_mode: "snapshot" }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { message?: string } | null;
        throw new Error(body?.message ?? `HTTP ${res.status}`);
      }
      await mutate();
      toast.success("Loaded snapshot");
    } catch (err) {
      toast.error(`Load snapshot failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [artifactId, node, mutate]);

  const handleSaveWorkflowNode = useCallback(
    async (updatedNode: CanonicalNode): Promise<void> => {
      try {
        const res = await fetch(`/api/artifacts/${artifactId}/nodes/${updatedNode.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(updatedNode),
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as { message?: string } | null;
          throw new Error(body?.message ?? `HTTP ${res.status}`);
        }
        const bundle = (await res.json()) as ArtifactBundleResponse;
        await mutate(bundle, { revalidate: false });
        toast.success("Workflow node saved.");
      } catch (err) {
        toast.error(`Save node failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
    [artifactId, mutate],
  );

  const handleDeleteNode = useCallback(
    async (nodeIdToDelete: number): Promise<void> => {
      if (!data?.workflow?.spec) return;
      const spec = data.workflow.spec;
      const newSpec = {
        ...spec,
        nodes: spec.nodes.filter((n: CanonicalNode) => n.id !== nodeIdToDelete),
      };
      
      try {
        const res = await fetch(`/api/artifacts/${artifactId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ workflow_spec: newSpec }),
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as { message?: string } | null;
          throw new Error(body?.message ?? `HTTP ${res.status}`);
        }
        const bundle = (await res.json()) as ArtifactBundleResponse;
        await mutate(bundle, { revalidate: false });
        toast.success("Node deleted.");
      } catch (err) {
        toast.error(`Delete node failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
    [artifactId, data, mutate],
  );

  // Compute the snapshot timestamp for the title row (only in snapshot mode).
  const snapshotInfo: SnapshotInfo | undefined = useMemo(() => {
    if (data?.fromSnapshot === true && data.snapshotAt) {
      return { fromSnapshot: true, timestamp: formatTimestamp(data.snapshotAt, tz) };
    }
    return undefined;
  }, [data, tz]);

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
        snapshotInfo={snapshotInfo}
        activeView={activeView}
        setActiveView={setActiveView}
        hasWorkflow={Boolean(data?.workflow)}
        actions={
          isSeedCategory ? null : (
            <ActionBar
              viewMode={node?.viewMode ?? "snapshot"}
              disableManagement={activeView === "workflow"}
              onRefresh={() => {
                if (activeView === "workflow") setActiveView("preview");
                void handleRefresh();
              }}
              onSaveSnapshot={() => {
                if (activeView === "workflow") setActiveView("preview");
                void handleSaveSnapshot();
              }}
              onLoadSnapshot={() => {
                if (activeView === "workflow") setActiveView("preview");
                void handleLoadSnapshot();
              }}
              onCompare={() => {
                if (activeView === "workflow") setActiveView("preview");
                // TODO: Compare modal
              }}
              onRename={() => setDialog("rename")}
              onMove={() => setDialog("move")}
              onDelete={() => setDialog("delete")}
            />
          )
        }
      />

      {/* Body layout */}
      {data?.workflow && node.kind !== "folder" ? (
        <WorkflowOrPreviewLayout
          activeView={activeView}
          node={node}
          tree={tree}
          router={router}
          spec={data.workflow.spec}
          data={data.data}
          appliedInputs={data.appliedInputs}
          onRefreshWithInputs={handleRefresh}
          onSaveWorkflowNode={handleSaveWorkflowNode}
          onDeleteWorkflowNode={handleDeleteNode}
          isRefreshing={isRefreshing}
        />
      ) : (
        <ArtifactScrollBody
          node={node}
          tree={tree}
          router={router}
          data={data?.data}
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
}

function ArtifactScrollBody({
  node,
  tree,
  router,
  data,
}: ArtifactScrollBodyProps): ReactElement {
  if (node.kind === "folder") {
    return (
      <ScrollArea className="min-h-0 flex-1">
        <div className="mx-auto flex w-full max-w-5xl flex-col gap-5 px-6 py-6">
          {node.description && (
            <p className="text-sm text-muted-foreground">{node.description}</p>
          )}
          <FolderBody node={node} tree={tree} router={router} />
        </div>
      </ScrollArea>
    );
  }

  return (
    <div className="flex h-full w-full min-h-0 min-w-0 flex-1 flex-col gap-3 px-6 py-6">
      {node.description && (
        <p className="shrink-0 text-sm text-muted-foreground">
          {node.description}
        </p>
      )}
      <div className="min-h-0 w-full flex-1">
        <ArtifactBody node={node} data={data} />
      </div>
    </div>
  );
}

interface WorkflowOrPreviewLayoutProps {
  activeView: "preview" | "workflow";
  node: ArtifactEntity;
  tree: ArtifactNode[] | undefined;
  router: ReturnType<typeof useRouter>;
  spec: CanonicalWorkflowSpec;
  data?: unknown;
  appliedInputs?: Record<string, unknown>;
  onRefreshWithInputs?: (inputs: Record<string, unknown>) => Promise<void>;
  onSaveWorkflowNode?: (updatedNode: CanonicalNode) => Promise<void>;
  onDeleteWorkflowNode?: (nodeId: number) => Promise<void>;
  isRefreshing?: boolean;
}

/**
 * Single view layout for workflow-backed artifacts: conditionally
 * renders either the artifact preview (chart + filters) or the
 * full-screen workflow graph, based on `activeView`.
 */
function WorkflowOrPreviewLayout({
  activeView,
  node,
  tree,
  router,
  spec,
  data,
  appliedInputs,
  onRefreshWithInputs,
  onSaveWorkflowNode,
  onDeleteWorkflowNode,
  isRefreshing = false,
}: WorkflowOrPreviewLayoutProps): ReactElement {

  const hasFilters = Boolean(
    spec?.input_schema?.properties &&
    Object.keys(spec.input_schema.properties).length > 0,
  );

  const initialFilterValues = useMemo(() => {
    const initial: Record<string, unknown> = {};
    if (spec?.input_schema?.properties) {
      const props = spec.input_schema.properties as Record<string, Record<string, unknown>>;
      for (const k of Object.keys(props)) {
        const field = props[k];
        if (field) {
          if (field.value !== undefined) {
            initial[k] = field.value;
          } else if (field.default !== undefined) {
            initial[k] = field.default;
          }
        }
      }
    }
    const sessionInputs = sessionAppliedInputsMap.get(node.id);
    if (node.viewMode === "live" && sessionInputs && Object.keys(sessionInputs).length > 0) {
      return { ...initial, ...sessionInputs };
    }
    // If live mode with appliedInputs from SWR cache or dynamic refresh, overlay appliedInputs
    if (appliedInputs && Object.keys(appliedInputs).length > 0) {
      return { ...initial, ...appliedInputs };
    }
    return initial;
  }, [spec.input_schema, appliedInputs, node.id, node.viewMode]);

  const filterPanelRef = useRef<PanelImperativeHandle>(null);

  useEffect(() => {
    const panel = filterPanelRef.current;
    if (hasFilters && panel) {
      if (panel.isCollapsed()) {
        panel.expand();
      }
    }
  }, [hasFilters]);

  if (activeView === "workflow") {
    return (
      <div className="flex min-h-0 flex-1 border-t bg-muted/20">
        <WorkflowGraph
          spec={spec}
          onSaveNode={onSaveWorkflowNode}
          onDeleteNode={onDeleteWorkflowNode}
        />
      </div>
    );
  }

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <ResizablePanelGroup
        key={`horizontal-${node.id}-${hasFilters}`}
        orientation="horizontal"
        className="h-full w-full flex-1"
      >
        <ResizablePanel
          id="artifact-chart-pane"
          defaultSize={hasFilters ? "80%" : "100%"}
          minSize="50%"
          className="flex h-full w-full min-h-0 min-w-0 flex-col"
        >
          <ArtifactScrollBody
            node={node}
            tree={tree}
            router={router}
            data={data}
          />
        </ResizablePanel>
        <ResizableHandle withHandle />
        <ResizablePanel
          panelRef={filterPanelRef}
          id="artifact-filter-pane"
          defaultSize={hasFilters ? "20%" : "0%"}
          minSize="15%"
          maxSize="20%"
          collapsible
          collapsedSize="0%"
          className="flex h-full w-full min-h-0 min-w-0 flex-col"
        >
          <ArtifactFilterPanel
            schema={spec.input_schema}
            initialValues={initialFilterValues}
            onApply={(values) => void onRefreshWithInputs?.(values)}
            loading={isRefreshing}
          />
        </ResizablePanel>
      </ResizablePanelGroup>
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
  /** Snapshot / live timestamp shown right-aligned in the title row. */
  snapshotInfo?: SnapshotInfo;
  activeView?: "preview" | "workflow";
  setActiveView?: (view: "preview" | "workflow") => void;
  hasWorkflow?: boolean;
}

function DetailHeader({
  title,
  breadcrumb,
  onBack,
  onCrumbClick,
  actions,
  snapshotInfo,
  activeView,
  setActiveView,
  hasWorkflow,
}: DetailHeaderProps): ReactElement {
  return (
    <header className="relative flex h-12 items-center gap-2 border-b px-4">
      <Button
        variant="ghost"
        size="icon"
        className="h-7 w-7"
        onClick={onBack}
        aria-label="Back"
      >
        <ArrowLeft className="h-4 w-4" />
      </Button>
      {/* Title area: title text truncates before the timestamp when the row is narrow. */}
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <div className="min-w-0 flex-1 overflow-hidden">
          {breadcrumb && breadcrumb.length > 0 ? (
            <div className="flex items-center gap-1 text-xs text-muted-foreground">
              {breadcrumb.map((n, i) => (
                <span key={n.id} className="flex min-w-0 items-center gap-1">
                  {i > 0 && <ChevronRightCrumb className="h-3 w-3 shrink-0" />}
                  <button
                    type="button"
                    onClick={() => onCrumbClick?.(n.id)}
                    className={cn(
                      "min-w-0 truncate",
                      i === breadcrumb.length - 1
                        ? "font-medium text-foreground"
                        : "hover:underline",
                    )}
                  >
                    {n.name}
                  </button>
                </span>
              ))}
            </div>
          ) : (
            <h1 className="truncate text-sm font-semibold text-foreground">
              {title}
            </h1>
          )}
        </div>

        {/* Snapshot timestamp — amber camera label shown only in snapshot mode. */}
        {snapshotInfo !== undefined && snapshotInfo.fromSnapshot && (
          <span className="shrink-0 flex items-center gap-1 text-xs text-amber-400">
            {snapshotInfo.timestamp}
          </span>
        )}
      </div>

      {/* View Toggle (Absolute Centered) */}
      {hasWorkflow && activeView && setActiveView && (
        <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setActiveView(activeView === "preview" ? "workflow" : "preview")}
            className="h-8 gap-1.5 px-3 text-muted-foreground hover:text-foreground shadow-sm"
          >
            {activeView === "preview" ? (
              <>
                <Workflow className="h-4 w-4 text-blue-500" />
                Edit Workflow
              </>
            ) : (
              <>
                <LineChart className="h-4 w-4 text-emerald-500" />
                View Artifact
              </>
            )}
          </Button>
        </div>
      )}

      {actions && <div className="flex shrink-0 items-center gap-1">{actions}</div>}
    </header>
  );
}

function ActionBar({
  viewMode,
  disableManagement,
  onRefresh,
  onSaveSnapshot,
  onLoadSnapshot,
  onCompare,
  onRename,
  onMove,
  onDelete,
}: {
  viewMode: "snapshot" | "live";
  disableManagement?: boolean;
  onRefresh: () => void;
  onSaveSnapshot: () => void;
  onLoadSnapshot: () => void;
  onCompare: () => void;
  onRename: () => void;
  onMove: () => void;
  onDelete: () => void;
}): ReactElement {
  return (
    <TooltipProvider delay={200}>
      <div className="flex items-center gap-1">

        {/* Data & View Action Group */}
        <Tooltip>
          <TooltipTrigger
            onClick={onRefresh}
            className={cn(buttonVariants({ size: "icon", variant: "ghost" }), "h-8 w-8 text-muted-foreground hover:text-foreground")}
            aria-label="Refresh live data"
          >
            <RefreshCw className="h-4 w-4" />
          </TooltipTrigger>
          <TooltipContent side="bottom">Refresh</TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger
            onClick={onSaveSnapshot}
            className={cn(buttonVariants({ size: "icon", variant: "ghost" }), "h-8 w-8 text-muted-foreground hover:text-foreground")}
            aria-label="Save snapshot"
          >
            <Save className="h-4 w-4" />
          </TooltipTrigger>
          <TooltipContent side="bottom">Save Snapshot</TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger
            onClick={onLoadSnapshot}
            className={cn(
              buttonVariants({ size: "icon", variant: "ghost" }),
              "h-8 w-8",
              viewMode === "snapshot"
                ? "bg-amber-500/10 text-amber-500 hover:bg-amber-500/20 hover:text-amber-600"
                : "text-muted-foreground hover:text-foreground",
            )}
            aria-label="Load snapshot"
          >
            <Camera className="h-4 w-4" />
          </TooltipTrigger>
          <TooltipContent side="bottom">Load Snapshot</TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger
            onClick={onCompare}
            className={cn(buttonVariants({ size: "icon", variant: "ghost" }), "h-8 w-8 text-muted-foreground hover:text-foreground")}
            aria-label="Compare snapshot vs live"
          >
            <GitCompare className="h-4 w-4" />
          </TooltipTrigger>
          <TooltipContent side="bottom">Compare</TooltipContent>
        </Tooltip>

        {/* Vertical Divider */}
        <div className="mx-1 h-4 w-px shrink-0 bg-border" />

        {/* Node Management Group */}
        <Tooltip>
          <TooltipTrigger
            onClick={(e) => {
              if (disableManagement) { e.preventDefault(); return; }
              onRename();
            }}
            disabled={disableManagement}
            className={cn(
              buttonVariants({ size: "icon", variant: "ghost" }),
              "h-8 w-8 text-muted-foreground hover:text-foreground",
              disableManagement && "opacity-50 cursor-not-allowed"
            )}
            aria-label="Rename"
          >
            <Pencil className="h-4 w-4" />
          </TooltipTrigger>
          <TooltipContent side="bottom">Rename</TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger
            onClick={(e) => {
              if (disableManagement) { e.preventDefault(); return; }
              onMove();
            }}
            disabled={disableManagement}
            className={cn(
              buttonVariants({ size: "icon", variant: "ghost" }),
              "h-8 w-8 text-muted-foreground hover:text-foreground",
              disableManagement && "opacity-50 cursor-not-allowed"
            )}
            aria-label="Move"
          >
            <FolderInput className="h-4 w-4" />
          </TooltipTrigger>
          <TooltipContent side="bottom">Move</TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger
            onClick={(e) => {
              if (disableManagement) { e.preventDefault(); return; }
              onDelete();
            }}
            disabled={disableManagement}
            className={cn(
              buttonVariants({ size: "icon", variant: "ghost" }),
              "h-8 w-8 text-muted-foreground hover:bg-destructive/10 hover:text-destructive",
              disableManagement && "opacity-50 cursor-not-allowed"
            )}
            aria-label="Delete"
          >
            <Trash2 className="h-4 w-4" />
          </TooltipTrigger>
          <TooltipContent side="bottom">Delete</TooltipContent>
        </Tooltip>
      </div>
    </TooltipProvider>
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
}

function ArtifactBody({
  node,
  data,
}: ArtifactBodyProps): ReactElement {
  // Chart artifacts: `bundle.data` is the merged ECharts option
  // produced by the workflow's chart node. Render it directly so
  // the body always reflects the latest workflow execution.
  if (node.type === "chart" && isChartOption(data)) {
    return (
      <ChartErrorBoundary resetKey={node.id}>
        <div className="h-full min-h-0 w-full">
          <EChartsRenderer option={data as Record<string, unknown>} />
        </div>
      </ChartErrorBoundary>
    );
  }

  // HTML artifacts: `bundle.data` is the HTML string produced by
  // the generate_html_page tool. Render via sandboxed iframe.
  if (node.type === "html" && isHtmlContent(data)) {
    return (
      <div className="h-full min-h-0 w-full">
        <iframe
          srcDoc={data as string}
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          title={node.name ?? "HTML page"}
          className="h-full w-full rounded border border-border bg-white"
        />
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

/** Cheap check — HTML content is a non-empty string. */
function isHtmlContent(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
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
