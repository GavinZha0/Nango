"use client";

/**
 * WorkflowGraph — read-only node-graph visualization of a saved
 * workflow `spec` (`CanonicalWorkflowSpec`). Renders on the artifact
 * detail page below the chart, in a vertically-resizable bottom
 * panel.
 *
 * Layout + interaction:
 *   - Dagre LR auto-layout + ReactFlow renderer with card-style
 *     node bodies (tool / agent / code / sql), dotted background,
 *     and controls (zoom in/out/fit/lock). Connection handles are
 *     hidden via CSS — the graph is read-only; users can't draw
 *     edges.
 *   - Click-to-inspect drawer (nested horizontal resizable panel
 *     showing the full per-node spec). Selection state is owned
 *     here so React Flow stays pure-presentational; pane clicks
 *     deselect; Escape closes.
 *
 * Degenerate-spec handling: the save pipeline writes a single no-op
 * tool node when no upstream data tools were captured. We detect
 * that shape and render an empty-state hint instead of a one-node
 * graph that confuses more than it helps.
 *
 * See docs/workflow-architecture.md; canonical spec types live in
 * `src/lib/workflows/spec/schema.ts`.
 */

import "@xyflow/react/dist/style.css";

import {
  Background,
  BackgroundVariant,
  Controls,
  MarkerType,
  ReactFlow,
  type DefaultEdgeOptions,
  type Edge,
  type Node,
  type NodeMouseHandler,
  type NodeTypes,
  type ReactFlowInstance,
} from "@xyflow/react";
import { useTheme } from "next-themes";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactElement,
} from "react";

import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { cn } from "@/lib/utils";
import type { CanonicalWorkflowSpec } from "@/lib/workflows/spec/schema";

import { InspectorDrawer } from "./InspectorDrawer";
import { layoutWorkflow, type WorkflowNodeData } from "./layout";
import { WorkflowNodeCard } from "./node-cards";

/**
 * Per-type renderers registered with ReactFlow. Keys must match
 * the `type` string assigned in `layout.ts` (= `spec.type`).
 *
 * Module-scope constant so ReactFlow doesn't get a new identity
 * on every render — React Flow recommends a stable reference to
 * avoid an internal re-mount warning.
 */
const nodeTypes: NodeTypes = {
  tool: WorkflowNodeCard,
  agent: WorkflowNodeCard,
  code: WorkflowNodeCard,
  sql: WorkflowNodeCard,
  chart: WorkflowNodeCard,
};

/** Edge defaults for every connection. `markerEnd` makes data-
 *  flow direction explicit so collapsed branches or non-LR layouts
 *  don't lose the cue. Module-scope so React Flow doesn't see a
 *  new identity per render. */
const defaultEdgeOptions: DefaultEdgeOptions = {
  type: "default",
  markerEnd: {
    type: MarkerType.ArrowClosed,
    width: 16,
    height: 16,
  },
};

export interface WorkflowGraphProps {
  spec: CanonicalWorkflowSpec;
}

/**
 * True when the spec is the placeholder shape — exactly one
 * node, of type "tool", whose `tool` field is "noop". The save
 * pipeline emits this when an artifact had no captured upstream
 * tool calls (e.g. random-data scaffold) so the workflow row's
 * NOT-NULL `spec` invariant holds without lying about provenance.
 */
function isDegenerateSpec(spec: CanonicalWorkflowSpec): boolean {
  if (spec.nodes.length !== 1) return false;
  const only = spec.nodes[0]!;
  return only.type === "tool" && only.inputs.name === "noop";
}

export function WorkflowGraph({ spec }: WorkflowGraphProps): ReactElement {
  const { resolvedTheme } = useTheme();

  // Layout is pure & cheap (<1ms for typical 1-10 nodes); recompute
  // on every spec change.
  const { nodes: laidOutNodes, edges } = useMemo(
    () => layoutWorkflow(spec),
    [spec],
  );

  // Selection owned here, not in ReactFlow's internal store, so
  // the inspector drawer + node `selected` flag stay in sync.
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);

  // Derived: vanished selection (e.g. after a refresh shifts node
  // ids) falls through to null — no useEffect-based sync needed.
  const selectedSpecNode = useMemo(() => {
    if (selectedNodeId === null) return null;
    return spec.nodes.find((n) => String(n.id) === selectedNodeId) ?? null;
  }, [spec.nodes, selectedNodeId]);

  const effectiveSelectedNodeId: string | null =
    selectedSpecNode === null ? null : selectedNodeId;

  // Escape closes the drawer (document-level so the drawer doesn't
  // need focus first).
  useEffect(() => {
    if (effectiveSelectedNodeId === null) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setSelectedNodeId(null);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [effectiveSelectedNodeId]);

  const nodes = useMemo<Node<WorkflowNodeData>[]>(
    () =>
      // Explicit return type keeps `selected` optional — otherwise
      // TS narrows the ReactFlow NodeType and breaks the onInit
      // callback's compatibility with the ref.
      laidOutNodes.map((n) => ({
        ...n,
        selected: n.id === effectiveSelectedNodeId,
      })),
    [laidOutNodes, effectiveSelectedNodeId],
  );

  const handleNodeClick = useCallback(
    (_event: ReactMouseEvent, node: Node<WorkflowNodeData>) => {
      setSelectedNodeId(node.id);
    },
    [],
  );

  const handlePaneClick = useCallback(() => {
    setSelectedNodeId(null);
  }, []);

  const handleCloseDrawer = useCallback(() => {
    setSelectedNodeId(null);
  }, []);

  if (isDegenerateSpec(spec)) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <div className="rounded border border-dashed bg-muted/20 px-4 py-3 text-center text-xs text-muted-foreground">
          No upstream data captured for this artifact.
        </div>
      </div>
    );
  }

  // Same JSX in both branches — the two branches put the canvas in
  // DIFFERENT React tree positions, so the canvas remounts when
  // the drawer opens and fitView re-runs for the new container
  // width.
  const canvas: ReactElement = (
    <GraphCanvas
      nodes={nodes}
      edges={edges}
      resolvedTheme={resolvedTheme}
      onNodeClick={handleNodeClick}
      onPaneClick={handlePaneClick}
    />
  );

  if (selectedSpecNode === null) {
    return <div className="h-full w-full">{canvas}</div>;
  }

  return (
    <ResizablePanelGroup orientation="horizontal" className="h-full w-full">
      <ResizablePanel defaultSize={70} minSize={40}>
        {canvas}
      </ResizablePanel>
      <ResizableHandle withHandle />
      <ResizablePanel defaultSize={30} minSize={20}>
        <InspectorDrawer node={selectedSpecNode} onClose={handleCloseDrawer} />
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}

// ─── GraphCanvas (inner) ─────────────────────────────────────────────

interface GraphCanvasProps {
  nodes: Node<WorkflowNodeData>[];
  edges: Edge[];
  resolvedTheme: string | undefined;
  onNodeClick: NodeMouseHandler<Node<WorkflowNodeData>>;
  onPaneClick: (event: ReactMouseEvent) => void;
}

/**
 * ReactFlow wrapped in a fade-in shell. Factored out so the
 * `ready` state resets cleanly each time WorkflowGraph remounts
 * it under a different React tree position (no-drawer vs
 * drawer-open). The double-rAF in `handleInit` is what avoids
 * the brief pre-fit flash.
 */
function GraphCanvas({
  nodes,
  edges,
  resolvedTheme,
  onNodeClick,
  onPaneClick,
}: GraphCanvasProps): ReactElement {
  const [ready, setReady] = useState<boolean>(false);

  // Only mount ReactFlow once the container has non-zero dimensions.
  // ResizablePanelGroup may briefly report 0-height before settling,
  // which triggers React Flow warning #004. The ResizeObserver fires
  // synchronously after layout so the delay is imperceptible.
  const containerRef = useRef<HTMLDivElement>(null);
  const [hasDimensions, setHasDimensions] = useState<boolean>(false);
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry?.contentRect ?? { width: 0, height: 0 };
      setHasDimensions(width > 0 && height > 0);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const handleInit = useCallback(
    (instance: ReactFlowInstance<Node<WorkflowNodeData>>) => {
      requestAnimationFrame(() => {
        instance.fitView({ padding: 0.2 });
        requestAnimationFrame(() => setReady(true));
      });
    },
    [],
  );

  return (
    <div
      ref={containerRef}
      className={cn(
        "h-full w-full transition-opacity duration-150",
        ready ? "opacity-100" : "opacity-0",
      )}
    >
      {hasDimensions && <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        defaultEdgeOptions={defaultEdgeOptions}
        colorMode={resolvedTheme === "dark" ? "dark" : "light"}
        onInit={handleInit}
        onNodeClick={onNodeClick}
        onPaneClick={onPaneClick}
        // Read-only — V1 has no graph editing affordances.
        nodesDraggable={false}
        nodesConnectable={false}
        edgesFocusable={false}
        elementsSelectable
        proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Dots} gap={16} size={1} />
        <Controls showInteractive={false} />
      </ReactFlow>}
    </div>
  );
}
