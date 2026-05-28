/**
 * Pure dagre layout helper — converts a canonical workflow spec
 * into ReactFlow's `(nodes, edges)` shape with absolute positions
 * computed by dagre.
 *
 * Pure on purpose: no DOM, no React. Safe to call during render
 * inside `useMemo`, and trivial to unit-test (no JSDOM needed).
 *
 * Direction is fixed left-to-right (`rankdir: "LR"`) — workflows
 * read like a sentence: source data on the left, derivatives on
 * the right, terminal output rightmost.
 *
 * Layout constants:
 *
 *   NODE_WIDTH  — 240px, fixed.
 *   NODE_HEIGHT — 100px, fixed (per W1.8 design decision).
 *   NODESEP     — 40px gap between sibling nodes within a rank.
 *   RANKSEP     — 80px gap between successive ranks (long enough
 *                 that bezier edges have room to curve without
 *                 hugging neighbouring cards).
 *
 * dagre returns center-of-box coordinates; ReactFlow expects
 * top-left, so we translate by `-w/2, -h/2`.
 */

import dagre from "@dagrejs/dagre";
import type { Edge, Node } from "@xyflow/react";

import type { CanonicalWorkflowSpec } from "@/lib/workflows/spec/schema";

/** Fixed card dimensions — keep in sync with `node-cards.tsx`.
 *
 * All dimensions are CSS pixels at zoom = 1.0 (which `WorkflowGraph`
 * pins as the upper bound via `fitViewOptions.maxZoom: 1`), so the
 * "card size" matches what the user actually sees on first paint.
 *
 * 200 × 100 was tuned against real workflows (3-5 nodes per graph):
 * the title row fits a ~24-char tool name (e.g.
 * `extract_dataset_by_sql`) without `…`, and the two summary lines
 * give about 28-30 chars at 9px-mono. Sibling branches still pack
 * tightly under the chosen dagre `nodesep`.
 */
export const NODE_WIDTH = 200;
export const NODE_HEIGHT = 100;

const NODESEP = 28;
const RANKSEP = 64;

/**
 * Data payload attached to each ReactFlow node. The full canonical
 * node is kept around so custom node renderers can switch on
 * `node.type` and read `tool / agent / language / input / outputs`
 * without re-indexing the spec.
 */
export interface WorkflowNodeData extends Record<string, unknown> {
  spec: CanonicalWorkflowSpec["nodes"][number];
}

/** Output of `layoutWorkflow` — drop straight into `<ReactFlow>`. */
export interface LaidOutGraph {
  nodes: Node<WorkflowNodeData>[];
  edges: Edge[];
}

/**
 * Compute positioned ReactFlow nodes + edges from a canonical
 * workflow spec.
 *
 * Edge semantics: `node.depends_on: [X, Y]` means "this node
 * depends on X and Y", so the rendered edges flow `X → this` and
 * `Y → this`. dagre treats `setEdge(src, dst)` as a directed edge,
 * which matches.
 *
 * V1 renders no edge labels — ref payloads (which key of `X` this
 * node consumes) live in the inspector drawer (W1.8.4) instead.
 */
export function layoutWorkflow(spec: CanonicalWorkflowSpec): LaidOutGraph {
  const g = new dagre.graphlib.Graph();
  g.setGraph({
    rankdir: "LR",
    nodesep: NODESEP,
    ranksep: RANKSEP,
    marginx: 16,
    marginy: 16,
  });
  g.setDefaultEdgeLabel(() => ({}));

  for (const n of spec.nodes) {
    g.setNode(String(n.id), { width: NODE_WIDTH, height: NODE_HEIGHT });
  }

  const edges: Edge[] = [];
  for (const n of spec.nodes) {
    for (const dep of n.depends_on) {
      g.setEdge(String(dep), String(n.id));
      edges.push({
        id: `e-${dep}-${n.id}`,
        source: String(dep),
        target: String(n.id),
        // `default` = bezier curve. Matches the reference design.
        type: "default",
      });
    }
  }

  dagre.layout(g);

  const nodes: Node<WorkflowNodeData>[] = spec.nodes.map((n) => {
    const pos = g.node(String(n.id));
    return {
      id: String(n.id),
      // dagre gives center → translate to top-left for ReactFlow.
      position: {
        x: pos.x - NODE_WIDTH / 2,
        y: pos.y - NODE_HEIGHT / 2,
      },
      data: { spec: n },
      // `type` matches the key registered in `WorkflowGraph`'s
      // `nodeTypes` prop — one renderer per D27/D35 bucket.
      type: n.type,
    };
  });

  return { nodes, edges };
}
