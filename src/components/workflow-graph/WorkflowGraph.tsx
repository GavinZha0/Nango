"use client";

/**
 * WorkflowGraph — read-only node-graph visualization of a saved
 * workflow `spec` (`CanonicalWorkflowSpec`). Renders on the artifact
 * detail page below the chart, in a vertically-resizable bottom
 * panel.
 *
 * V1 stages (W1.8.x):
 *   - W1.8.1: placeholder (text-only node list).
 *   - W1.8.2 (current state): dagre LR auto-layout + ReactFlow
 *     renderer with default node style + dotted background +
 *     controls (zoom in/out/fit/lock). Connection handles are
 *     hidden via CSS — V1 is read-only, users can't draw edges.
 *   - W1.8.3: custom card-style node renderers by type
 *     (tool / agent / code / sql) — 200×100, icon + title + 2 lines.
 *   - W1.8.4 (current state): click-to-inspect drawer (nested
 *     horizontal resizable panel showing the full per-node spec).
 *     Selection state is controlled here so React Flow stays
 *     pure-presentational; pane clicks deselect; Escape closes.
 *
 * Degenerate-spec handling:
 *   The save pipeline (W1.5) writes a single no-op tool node when
 *   no upstream data tools were captured. We detect that shape and
 *   render an empty-state hint instead of a one-node graph that
 *   confuses more than it helps.
 *
 * @see docs/workflow-architecture.md §17 (D27, D28, D35, D36) for
 *      spec shapes; src/lib/workflows/spec/schema.ts for types.
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
import {
  AgentNodeCard,
  CodeNodeCard,
  SqlNodeCard,
  ToolNodeCard,
} from "./node-cards";

/**
 * Per-type renderers registered with ReactFlow. Keys must match
 * the `type` string assigned in `layout.ts` (= `spec.type`).
 *
 * Module-scope constant so ReactFlow doesn't get a new identity
 * on every render — React Flow recommends a stable reference to
 * avoid an internal re-mount warning.
 */
const nodeTypes: NodeTypes = {
  tool: ToolNodeCard,
  agent: AgentNodeCard,
  code: CodeNodeCard,
  sql: SqlNodeCard,
};

/**
 * Edge defaults applied to every connection in the graph.
 *
 * `markerEnd` is the critical bit: without it, ReactFlow renders
 * plain line segments and the only data-flow direction cue the
 * user gets is "left → right (because dagre laid it that way)".
 * That's brittle — collapsed branches or future non-LR layouts
 * lose the signal entirely. A closed-arrow end-marker makes the
 * direction explicit on every edge, matching the W1.8 reference
 * design.
 *
 * Module-scope so React Flow doesn't see a new object identity
 * on every render (matches the `nodeTypes` rationale).
 */
const defaultEdgeOptions: DefaultEdgeOptions = {
  // `default` = bezier curve, matches the reference design.
  type: "default",
  markerEnd: {
    type: MarkerType.ArrowClosed,
    // Width / height tuned so the arrow head reads cleanly at
    // typical zoom (1.0×) without dominating the line.
    width: 16,
    height: 16,
  },
};

export interface WorkflowGraphProps {
  spec: CanonicalWorkflowSpec;
}

/**
 * True when the spec is the W1.5 placeholder shape — exactly one
 * node, of type "tool", whose `tool` field is "noop". The save
 * pipeline emits this when an artifact had no captured upstream
 * tool calls (e.g. random-data scaffold) so the workflow row's
 * NOT-NULL `spec` invariant holds without lying about provenance.
 */
function isDegenerateSpec(spec: CanonicalWorkflowSpec): boolean {
  if (spec.nodes.length !== 1) return false;
  const only = spec.nodes[0]!;
  return only.type === "tool" && only.tool === "noop";
}

export function WorkflowGraph({ spec }: WorkflowGraphProps): ReactElement {
  const { resolvedTheme } = useTheme();

  // Layout is pure & cheap (<1ms for typical 1-10 node specs); we
  // recompute on every spec reference change which only happens
  // on artifact load / refresh, not on user interaction.
  const { nodes: laidOutNodes, edges } = useMemo(
    () => layoutWorkflow(spec),
    [spec],
  );

  // Selection state owned here, not by ReactFlow. We sync it onto
  // the rendered nodes via the `selected` flag so the card shell
  // styles update without ReactFlow's internal selection store
  // taking over.
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);

  // Derived: resolve the canonical node behind the current
  // selection in one pass. If the user's selectedNodeId no longer
  // exists in `spec.nodes` (e.g. the artifact got refreshed and
  // node ids shifted), treat the selection as cleared — no
  // useEffect-based sync required. The combination of "find by
  // id" + "fall through to null" elegantly handles the spec-
  // change case as derived state.
  const selectedSpecNode = useMemo(() => {
    if (selectedNodeId === null) return null;
    return spec.nodes.find((n) => String(n.id) === selectedNodeId) ?? null;
  }, [spec.nodes, selectedNodeId]);

  // Effective id matches selectedSpecNode (null when stale or
  // never set). Used to drive ReactFlow's per-node `selected`
  // flag — never references a vanished node id.
  const effectiveSelectedNodeId: string | null =
    selectedSpecNode === null ? null : selectedNodeId;

  // Escape closes the drawer. Listen on document so the user
  // doesn't need to focus the drawer first; the effect re-binds
  // only when the active selection changes (it's a no-op when
  // nothing is selected, so we still attach to surface a
  // consistent dev-friendly invariant).
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
      // Explicit return type widens `selected` back to optional —
      // without it, TS infers an array element with required
      // `selected: boolean`, which then narrows the ReactFlow
      // NodeType inferred from the `nodes` prop and breaks the
      // `onInit` callback's type compatibility with our
      // `ReactFlowInstance` ref.
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

  // Build the GraphCanvas element once per render — it's the same
  // element regardless of drawer state. Its lifecycle (mount /
  // unmount) is governed by which branch of the if/else below
  // selects it, since the two branches put it in DIFFERENT
  // positions of the React tree.
  const canvas: ReactElement = (
    <GraphCanvas
      nodes={nodes}
      edges={edges}
      resolvedTheme={resolvedTheme}
      onNodeClick={handleNodeClick}
      onPaneClick={handlePaneClick}
    />
  );

  // No selection → single-pane graph. The outer `<div>` gives
  // ReactFlow an immediate, deterministic 100%-width parent. This
  // is the fast path most users see most of the time.
  if (selectedSpecNode === null) {
    return <div className="h-full w-full">{canvas}</div>;
  }

  // Selection present → horizontal split. The GraphCanvas remounts
  // under the new ResizablePanel parent because the React tree
  // position changed; its internal `ready` state resets, fitView
  // re-runs from `onInit`, and the canvas fades back in once the
  // viewport is correctly centred for the new (70%) container
  // width. Drawer width is NOT persisted across sessions —
  // selection is a transient state.
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
  // ReactFlow's `onPaneClick` prop type is inline-anonymous on
  // the component; mirror it here. The mouse event is fired by
  // the canvas background (not by any node), so the handler
  // doesn't care about a node argument.
  onPaneClick: (event: ReactMouseEvent) => void;
}

/**
 * ReactFlow wrapped in a fade-in shell.
 *
 * The component's `ready` state is initially `false`, which forces
 * the wrapper to `opacity-0`. The sequence is:
 *
 *   1. ReactFlow mounts (still invisible)
 *   2. `onInit` fires with the imperative instance
 *   3. `requestAnimationFrame` defers the next step to after the
 *      browser's layout phase, so the parent (whether a bare
 *      `<div>` or a `react-resizable-panels` Panel) has its
 *      final width
 *   4. `instance.fitView({ padding: 0.2 })` centres + sizes the
 *      viewport
 *   5. A SECOND `requestAnimationFrame` flips `ready` to true on
 *      the frame AFTER the fit transform commits — without this
 *      second frame, React could commit the opacity change in
 *      the same frame as the transform, and we'd see the
 *      pre-fit positions briefly
 *   6. Opacity transitions 0 → 1 over `duration-150`
 *
 * The state-resets-on-remount property is the whole point of
 * factoring this into a separate component. WorkflowGraph itself
 * stays mounted across drawer toggles; but the React tree
 * position of the GraphCanvas element differs between the no-
 * drawer (`<div>`) and drawer-open (`<ResizablePanel>`) render
 * branches, so React reconciles them as distinct mounts and the
 * fade-in re-runs cleanly each time.
 */
function GraphCanvas({
  nodes,
  edges,
  resolvedTheme,
  onNodeClick,
  onPaneClick,
}: GraphCanvasProps): ReactElement {
  const [ready, setReady] = useState<boolean>(false);

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
      className={cn(
        "h-full w-full transition-opacity duration-150",
        ready ? "opacity-100" : "opacity-0",
      )}
    >
      <ReactFlow
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
      </ReactFlow>
    </div>
  );
}
