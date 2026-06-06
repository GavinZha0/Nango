/**
 * Unit tests for the pure helpers exposed by `useArtifactTree`.
 *
 * The hook itself wraps SWR + fetch and is exercised by the M2 smoke
 * (the panel renders the tree end-to-end). Here we only cover the
 * tree-walk helpers that are pure data transforms.
 */

import { describe, it, expect, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { indexById, pathOf } = await import("@/hooks/useArtifactTree");
import type { ArtifactNode } from "@/hooks/useArtifactTree";

function leaf(id: string, parentId: string | null, name: string): ArtifactNode {
  return {
    id,
    parentId,
    kind: "artifact",
    type: "chart",
    name,
    description: null,
    config: null,
    visibility: "private",
    displayOrder: 0,
    createdBy: "u1",
    createdAt: new Date(0),
    updatedAt: new Date(0),
    sourceThreadId: null,
    sourceOutcomeId: null,
    workflowId: null,
    workflowOutputField: null,
    children: [],
  };
}

function folder(
  id: string,
  parentId: string | null,
  name: string,
  children: ArtifactNode[] = [],
): ArtifactNode {
  return {
    ...leaf(id, parentId, name),
    kind: "folder",
    type: null,
    children,
  };
}

describe("indexById", () => {
  it("returns an empty map for an empty input", () => {
    expect(indexById([]).size).toBe(0);
  });

  it("flattens nested nodes by id", () => {
    const tree: ArtifactNode[] = [
      folder("root", null, "Charts", [
        leaf("l1", "root", "C1"),
        folder("sub", "root", "Q4", [leaf("l2", "sub", "C2")]),
      ]),
    ];
    const idx = indexById(tree);
    expect(idx.size).toBe(4);
    expect(idx.get("root")?.name).toBe("Charts");
    expect(idx.get("sub")?.name).toBe("Q4");
    expect(idx.get("l1")?.name).toBe("C1");
    expect(idx.get("l2")?.name).toBe("C2");
  });
});

describe("pathOf", () => {
  it("returns empty array for unknown node", () => {
    const tree: ArtifactNode[] = [folder("a", null, "A")];
    expect(pathOf(indexById(tree), "missing")).toEqual([]);
  });

  it("returns a single-element path for a root", () => {
    const tree: ArtifactNode[] = [folder("a", null, "A")];
    const path = pathOf(indexById(tree), "a");
    expect(path.map((n) => n.id)).toEqual(["a"]);
  });

  it("returns root → … → target order for deep nodes", () => {
    const tree: ArtifactNode[] = [
      folder("root", null, "Charts", [
        folder("sub", "root", "Q4", [leaf("leaf", "sub", "C")]),
      ]),
    ];
    const path = pathOf(indexById(tree), "leaf");
    expect(path.map((n) => n.id)).toEqual(["root", "sub", "leaf"]);
  });

  it("stops at the first orphaned parent", () => {
    // sub claims a parent that doesn't exist in the index — common
    // when the tree is built from a filtered subset.
    const tree: ArtifactNode[] = [folder("sub", "ghost", "S", [leaf("leaf", "sub", "L")])];
    const path = pathOf(indexById(tree), "leaf");
    expect(path.map((n) => n.id)).toEqual(["sub", "leaf"]);
  });
});
