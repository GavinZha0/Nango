import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  buildArtifactBundle,
  type BundleDeps,
} from "@/lib/artifacts/bundle";
import type {
  ArtifactEntity,
  WorkflowEntity,
} from "@/lib/db/schema";
import type { CanonicalWorkflowSpec } from "@/lib/workflows";

// ─── Fixtures ─────────────────────────────────────────────────────────

const OWNER = "user-1";
const ARTIFACT_ID = "art-1";
const WORKFLOW_ID = "wf-1";

function artifactRow(
  overrides: Partial<ArtifactEntity> = {},
): ArtifactEntity {
  return {
    id: ARTIFACT_ID,
    parentId: null,
    kind: "artifact",
    type: "chart",
    name: "Q4",
    description: null,
    config: null,
    sourceThreadId: null,
    sourceOutcomeId: null,
    visibility: "private",
    displayOrder: 0,
    workflowId: WORKFLOW_ID,
    workflowOutputField: "data",
    createdBy: OWNER,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as ArtifactEntity;
}

function workflowRow(
  spec: CanonicalWorkflowSpec,
): WorkflowEntity {
  return {
    id: WORKFLOW_ID,
    name: "demo",
    description: null,
    spec,
    visibility: "private",
    createdBy: OWNER,
    updatedBy: OWNER,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as WorkflowEntity;
}

function sampleSpec(): CanonicalWorkflowSpec {
  return {
    name: "demo",
    nodes: [
      {
        type: "tool",
        schema_version: "1",
        id: 0,
        description: "n",
        depends_on: [],        inputs: {
          name: "x",
          arguments: {},
        },
      },
    ],
    outputs: { data: "@nodes.0.x" },
  };
}

interface ExecutorCall {
  forceFresh?: boolean;
  outputField: string;
}

function makeDeps(
  artifact: ArtifactEntity,
  spec: CanonicalWorkflowSpec,
  executorReturn: Awaited<ReturnType<BundleDeps["executeWorkflow"]>>,
): BundleDeps & { executorCalls: ExecutorCall[] } {
  const executorCalls: ExecutorCall[] = [];
  return {
    getArtifact: async () => artifact,
    getWorkflow: async () => workflowRow(spec),
    executeWorkflow: async (args) => {
      executorCalls.push({
        forceFresh: args.forceFresh,
        outputField: args.outputField,
      });
      return executorReturn;
    },
    executorCalls,
  };
}

// ─── forceFresh propagation ───────────────────────────────────────────

describe("buildArtifactBundle — forceFresh option", () => {
  it("omits `forceFresh` from executor args when option is not set (GET path)", async () => {
    const deps = makeDeps(artifactRow(), sampleSpec(), null);
    await buildArtifactBundle(ARTIFACT_ID, OWNER, deps);
    expect(deps.executorCalls).toHaveLength(1);
    expect(deps.executorCalls[0]!.forceFresh).toBeUndefined();
  });

  it("omits `forceFresh` when option is explicitly false (no-op flag)", async () => {
    const deps = makeDeps(artifactRow(), sampleSpec(), null);
    await buildArtifactBundle(ARTIFACT_ID, OWNER, deps, { forceFresh: false });
    expect(deps.executorCalls[0]!.forceFresh).toBeUndefined();
  });

  it("passes `forceFresh: true` to the executor (refresh path)", async () => {
    const deps = makeDeps(artifactRow(), sampleSpec(), null);
    await buildArtifactBundle(ARTIFACT_ID, OWNER, deps, { forceFresh: true });
    expect(deps.executorCalls[0]!.forceFresh).toBe(true);
  });

  it("returns the refreshed data when executor produces it", async () => {
    const executedAt = new Date("2026-05-26T10:00:00Z");
    const deps = makeDeps(artifactRow(), sampleSpec(), {
      data: { rows: [1, 2, 3] },
      fromCache: false,
      executedAt,
    });
    const bundle = await buildArtifactBundle(
      ARTIFACT_ID,
      OWNER,
      deps,
      { forceFresh: true },
    );
    expect(bundle.data).toEqual({ rows: [1, 2, 3] });
    expect(bundle.fromCache).toBe(false);
    expect(bundle.executedAt).toBe(executedAt.toISOString());
  });

  it("does NOT invoke the executor when artifact has no workflow (refresh = no-op)", async () => {
    const deps = makeDeps(
      artifactRow({ workflowId: null, workflowOutputField: null }),
      sampleSpec(),
      null,
    );
    const bundle = await buildArtifactBundle(
      ARTIFACT_ID,
      OWNER,
      deps,
      { forceFresh: true },
    );
    expect(deps.executorCalls).toEqual([]);
    expect(bundle.workflow).toBeUndefined();
  });

  it("preserves the bundle's other fields when forceFresh: true", async () => {
    const deps = makeDeps(
      artifactRow({ workflowOutputField: "data" }),
      sampleSpec(),
      null,
    );
    const bundle = await buildArtifactBundle(
      ARTIFACT_ID,
      OWNER,
      deps,
      { forceFresh: true },
    );
    expect(bundle.node.id).toBe(ARTIFACT_ID);
    expect(bundle.workflow).toBeDefined();
    expect(bundle.workflow!.outputField).toBe("data");
  });
});
