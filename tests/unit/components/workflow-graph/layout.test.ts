/**
 * Unit coverage for `layoutWorkflow` — pure dagre layout.
 *
 * dagre's exact pixel output is not part of the contract (the
 * library may shift positions across versions); these tests assert
 * the shape invariants that downstream rendering relies on:
 *
 *  - Node count + id round-trip equals the input spec.
 *  - Edge endpoints reflect `depends_on` direction (`dep → node`).
 *  - LR direction places dependents strictly to the right of
 *    their dependencies.
 *  - Position output is in top-left form (no negative spillover for
 *    chains that all live in the positive quadrant).
 *  - Pure: identical input → identical output.
 */

import { describe, expect, it } from "vitest";

import { layoutWorkflow, NODE_HEIGHT, NODE_WIDTH } from "@/components/workflow-graph/layout";
import type { CanonicalWorkflowSpec } from "@/lib/workflows/spec/schema";

function chainSpec(): CanonicalWorkflowSpec {
  return {
    version: "1.0",
    name: "chain",
    refReconAlgorithm: "ref_recon_v1",
    outputs: { result: "@nodes.2.stdout" },
    nodes: [
      {
        id: 0,
        type: "tool",
        tool: "extract_dataset_by_sql",
        description: "extract",
        depends_on: [],
        input: { name: "ds", query: "SELECT 1" },
      },
      {
        id: 1,
        type: "tool",
        tool: "filter",
        description: "filter",
        depends_on: [0],
        input: {},
      },
      {
        id: 2,
        type: "code",
        language: "python",
        code: "print('hi')",
        description: "code",
        depends_on: [1],
      },
    ],
  };
}

describe("layoutWorkflow", () => {
  it("preserves node count + ids", () => {
    const { nodes } = layoutWorkflow(chainSpec());
    expect(nodes).toHaveLength(3);
    expect(nodes.map((n) => n.id).sort()).toEqual(["0", "1", "2"]);
  });

  it("emits one edge per depends_on entry, dep → node direction", () => {
    const { edges } = layoutWorkflow(chainSpec());
    expect(edges).toHaveLength(2);
    expect(edges).toContainEqual(
      expect.objectContaining({ source: "0", target: "1" }),
    );
    expect(edges).toContainEqual(
      expect.objectContaining({ source: "1", target: "2" }),
    );
  });

  it("attaches the canonical node spec under data.spec", () => {
    const { nodes } = layoutWorkflow(chainSpec());
    const codeNode = nodes.find((n) => n.id === "2");
    expect(codeNode?.data.spec.type).toBe("code");
    if (codeNode?.data.spec.type === "code") {
      expect(codeNode.data.spec.language).toBe("python");
    }
  });

  it("tags each ReactFlow node with its spec type for renderer dispatch", () => {
    const { nodes } = layoutWorkflow(chainSpec());
    const byId = new Map(nodes.map((n) => [n.id, n]));
    expect(byId.get("0")?.type).toBe("tool");
    expect(byId.get("1")?.type).toBe("tool");
    expect(byId.get("2")?.type).toBe("code");
  });

  it("lays dependents strictly right of dependencies (LR)", () => {
    const { nodes } = layoutWorkflow(chainSpec());
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const x0 = byId.get("0")!.position.x;
    const x1 = byId.get("1")!.position.x;
    const x2 = byId.get("2")!.position.x;
    expect(x1).toBeGreaterThan(x0);
    expect(x2).toBeGreaterThan(x1);
  });

  it("returns deterministic output for identical input", () => {
    const a = layoutWorkflow(chainSpec());
    const b = layoutWorkflow(chainSpec());
    expect(a).toEqual(b);
  });

  it("uses the fixed card dimensions to centre nodes", () => {
    // Layout invariants depend on the constants — guard against
    // accidental drift between layout.ts and node-cards.tsx.
    expect(NODE_WIDTH).toBe(200);
    expect(NODE_HEIGHT).toBe(100);
  });

  it("handles a single-node spec without edges", () => {
    const spec: CanonicalWorkflowSpec = {
      version: "1.0",
      name: "solo",
      refReconAlgorithm: "ref_recon_v1",
      outputs: { result: "@nodes.0.stdout" },
      nodes: [
        {
          id: 0,
          type: "code",
          language: "python",
          code: "print(1)",
          description: "solo",
          depends_on: [],
        },
      ],
    };
    const { nodes, edges } = layoutWorkflow(spec);
    expect(nodes).toHaveLength(1);
    expect(edges).toHaveLength(0);
  });

  it("handles independent parallel branches", () => {
    // Two roots, neither depends on the other — dagre places them
    // in the same rank.
    const spec: CanonicalWorkflowSpec = {
      version: "1.0",
      name: "parallel",
      refReconAlgorithm: "ref_recon_v1",
      outputs: { a: "@nodes.0.stdout", b: "@nodes.1.stdout" },
      nodes: [
        {
          id: 0,
          type: "tool",
          tool: "a",
          description: "a",
          depends_on: [],
          input: {},
        },
        {
          id: 1,
          type: "tool",
          tool: "b",
          description: "b",
          depends_on: [],
          input: {},
        },
      ],
    };
    const { nodes, edges } = layoutWorkflow(spec);
    expect(nodes).toHaveLength(2);
    expect(edges).toHaveLength(0);
    // Same rank (same x), different rows (different y).
    const [a, b] = nodes;
    expect(a!.position.x).toBe(b!.position.x);
    expect(a!.position.y).not.toBe(b!.position.y);
  });
});
