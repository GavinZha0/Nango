import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  buildArtifactBundle,
  type ArtifactBundle,
  type BundleDeps,
} from "@/lib/artifacts/bundle";
import { updateArtifactWithDeps } from "@/lib/artifacts/update-artifact";
import type {
  ArtifactEntity,
  WorkflowEntity,
} from "@/lib/db/schema";
import type { CanonicalWorkflowSpec } from "@/lib/workflows";

// ─── Fixtures ─────────────────────────────────────────────────────────

const OWNER = "user-1";
const ARTIFACT_ID = "art-1";

function artifactRow(
  overrides: Partial<ArtifactEntity> = {},
): ArtifactEntity {
  return {
    id: ARTIFACT_ID,
    parentId: null,
    kind: "artifact",
    type: "chart",
    name: "Q4 Orders",
    description: null,
    content: { type: "bar" },
    config: null,
    sourceThreadId: null,
    sourceOutcomeId: null,
    visibility: "private",
    displayOrder: 0,
    workflowId: null,
    workflowOutputField: null,
    createdBy: OWNER,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  } as ArtifactEntity;
}

function makeDeps(
  artifactBeforeUpdate: ArtifactEntity,
  artifactAfterUpdate: ArtifactEntity,
): BundleDeps & {
  performUpdateCalls: Array<{
    id: string;
    patch: unknown;
    ownerId: string;
  }>;
  performUpdate: (
    id: string,
    patch: unknown,
    ownerId: string,
  ) => Promise<void>;
} {
  let current = artifactBeforeUpdate;
  const performUpdateCalls: Array<{
    id: string;
    patch: unknown;
    ownerId: string;
  }> = [];
  return {
    getArtifact: async () => current,
    getWorkflow: async () => null as unknown as WorkflowEntity | null,
    executeWorkflow: async () => null,
    performUpdateCalls,
    performUpdate: async (id, patch, ownerId) => {
      performUpdateCalls.push({ id, patch, ownerId });
      current = artifactAfterUpdate;
    },
  };
}

async function callUpdate(
  patch: Parameters<typeof updateArtifactWithDeps>[1],
  before: ArtifactEntity,
  after: ArtifactEntity,
): Promise<{ bundle: ArtifactBundle; deps: ReturnType<typeof makeDeps> }> {
  const deps = makeDeps(before, after);
  const bundle = await updateArtifactWithDeps(
    ARTIFACT_ID,
    patch,
    OWNER,
    deps.performUpdate,
    deps,
  );
  return { bundle, deps };
}

// ─── Basic flow ───────────────────────────────────────────────────────

describe("updateArtifact — write-then-bundle", () => {
  it("calls performUpdate with the patch then re-loads the bundle", async () => {
    const before = artifactRow();
    const after = artifactRow({ name: "Renamed" });
    const { bundle, deps } = await callUpdate(
      { name: "Renamed" },
      before,
      after,
    );
    expect(deps.performUpdateCalls).toEqual([
      { id: ARTIFACT_ID, patch: { name: "Renamed" }, ownerId: OWNER },
    ]);
    expect(bundle.node.name).toBe("Renamed");
  });

  it("returns a bundle with the updated `content` field", async () => {
    const before = artifactRow({ content: { type: "bar" } });
    const after = artifactRow({ content: { type: "line", color: "blue" } });
    const { bundle } = await callUpdate(
      { content: { type: "line", color: "blue" } },
      before,
      after,
    );
    expect(bundle.node.content).toEqual({ type: "line", color: "blue" });
  });

  it("returns a bundle with workflow metadata when artifact is workflow-backed", async () => {
    const workflowId = "wf-1";
    const before = artifactRow({
      workflowId,
      workflowOutputField: "data",
    });
    const after = artifactRow({
      workflowId,
      workflowOutputField: "data",
      content: { type: "line" },
    });
    const deps = makeDeps(before, after);
    deps.getWorkflow = async () =>
      ({
        id: workflowId,
        name: "wf",
        description: null,
        spec: {
          version: "1.0",
          name: "demo",
          refReconAlgorithm: "ref_recon_v1",
          nodes: [
            {
              type: "tool",
              id: 0,
              description: "n",
              depends_on: [],
              tool: "x",
              input: {},
            },
          ],
          outputs: { data: "@nodes.0.x" },
        } as CanonicalWorkflowSpec,
        visibility: "private",
        createdBy: OWNER,
        updatedBy: OWNER,
        createdAt: new Date(),
        updatedAt: new Date(),
      }) as WorkflowEntity;
    const bundle = await updateArtifactWithDeps(
      ARTIFACT_ID,
      { content: { type: "line" } },
      OWNER,
      deps.performUpdate,
      deps,
    );
    expect(bundle.workflow).toBeDefined();
    expect(bundle.workflow!.id).toBe(workflowId);
    expect(bundle.workflow!.outputField).toBe("data");
  });

  it("propagates errors from performUpdate without calling the bundle loader", async () => {
    const before = artifactRow();
    const after = artifactRow();
    const deps = makeDeps(before, after);
    let getArtifactCalled = false;
    deps.getArtifact = async () => {
      getArtifactCalled = true;
      return after;
    };
    deps.performUpdate = async () => {
      throw new Error("update failed");
    };
    await expect(
      updateArtifactWithDeps(
        ARTIFACT_ID,
        { name: "x" },
        OWNER,
        deps.performUpdate,
        deps,
      ),
    ).rejects.toThrow(/update failed/);
    expect(getArtifactCalled).toBe(false);
  });
});

// ─── Sanity: imports stay aligned ─────────────────────────────────────

describe("updateArtifact — module-shape sanity", () => {
  it("exports the helper bundle assembler reference", () => {
    // buildArtifactBundle should be the same function the test path
    // exercises via updateArtifactWithDeps. (Catches accidental
    // re-export drift.)
    expect(typeof buildArtifactBundle).toBe("function");
  });
});
