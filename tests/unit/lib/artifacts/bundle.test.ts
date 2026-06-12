import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { buildArtifactBundle, type BundleDeps } from "@/lib/artifacts/bundle";
import { ApiError } from "@/lib/http/route-handlers";
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
    name: "Q4 Orders",
    description: null,
    content: { type: "bar", data: "@nodes.0.dataset" },
    config: null,
    sourceThreadId: "thread-1",
    sourceOutcomeId: "call-1",
    visibility: "private",
    displayOrder: 0,
    workflowId: WORKFLOW_ID,
    workflowOutputField: "data",
    createdBy: OWNER,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  } as ArtifactEntity;
}

function workflowRow(
  overrides: Partial<WorkflowEntity> = {},
): WorkflowEntity {
  return {
    id: WORKFLOW_ID,
    name: "Workflow from chart_renderer",
    description: null,
    spec: sampleSpec(),
    visibility: "private",
    createdBy: OWNER,
    updatedBy: OWNER,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
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
          name: "extract_dataset_by_sql",
          arguments: { sql: "select 1" },
        },
      },
    ],
    outputs: { data: "@nodes.0.dataset" },
  };
}

function buildDeps(
  overrides: Partial<BundleDeps> = {},
): BundleDeps & {
  artifactCalls: Array<{ id: string; ownerId: string }>;
  workflowCalls: Array<{ id: string }>;
  executeCalls: Array<{ workflowId: string; outputField: string; ownerId: string }>;
} {
  const artifactCalls: Array<{ id: string; ownerId: string }> = [];
  const workflowCalls: Array<{ id: string }> = [];
  const executeCalls: Array<{
    workflowId: string;
    outputField: string;
    ownerId: string;
  }> = [];
  return {
    getArtifact: async (id, ownerId) => {
      artifactCalls.push({ id, ownerId });
      return artifactRow();
    },
    getWorkflow: async (id) => {
      workflowCalls.push({ id });
      return workflowRow();
    },
    executeWorkflow: async (args) => {
      executeCalls.push({
        workflowId: args.workflowId,
        outputField: args.outputField,
        ownerId: args.ownerId,
      });
      return null;
    },
    ...overrides,
    artifactCalls,
    workflowCalls,
    executeCalls,
  };
}

// ─── Not-found / access ────────────────────────────────────────────────

describe("buildArtifactBundle — not-found / access", () => {
  it("throws ApiError(404) when artifact loader returns null", async () => {
    const deps = buildDeps({
      getArtifact: async () => null,
    });
    await expect(
      buildArtifactBundle("missing", OWNER, deps),
    ).rejects.toBeInstanceOf(ApiError);
    await expect(
      buildArtifactBundle("missing", OWNER, deps),
    ).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
  });

  it("forwards the supplied ownerId to the artifact loader", async () => {
    const deps = buildDeps();
    await buildArtifactBundle(ARTIFACT_ID, OWNER, deps);
    expect(deps.artifactCalls).toEqual([
      { id: ARTIFACT_ID, ownerId: OWNER },
    ]);
  });
});

// ─── Folder kind ───────────────────────────────────────────────────────

describe("buildArtifactBundle — folder kind", () => {
  it("returns { node } only; never loads a workflow", async () => {
    const deps = buildDeps({
      getArtifact: async () =>
        artifactRow({ kind: "folder", type: null, workflowId: null }),
    });
    const bundle = await buildArtifactBundle(ARTIFACT_ID, OWNER, deps);
    expect(bundle.node.kind).toBe("folder");
    expect(bundle.workflow).toBeUndefined();
    expect(bundle.data).toBeUndefined();
    expect(deps.workflowCalls).toEqual([]);
    expect(deps.executeCalls).toEqual([]);
  });
});

// ─── Standalone artifact (no workflow) ─────────────────────────────────

describe("buildArtifactBundle — standalone artifact", () => {
  it("returns { node } only when workflowId is null", async () => {
    const deps = buildDeps({
      getArtifact: async () =>
        artifactRow({ workflowId: null, workflowOutputField: null }),
    });
    const bundle = await buildArtifactBundle(ARTIFACT_ID, OWNER, deps);
    expect(bundle.node.workflowId).toBeNull();
    expect(bundle.workflow).toBeUndefined();
    expect(bundle.data).toBeUndefined();
    expect(deps.workflowCalls).toEqual([]);
    expect(deps.executeCalls).toEqual([]);
  });
});

// ─── Workflow-backed artifact ──────────────────────────────────────────

describe("buildArtifactBundle — workflow-backed artifact", () => {
  it("loads the workflow and assembles a bundle with workflow metadata", async () => {
    const deps = buildDeps();
    const bundle = await buildArtifactBundle(ARTIFACT_ID, OWNER, deps);
    expect(bundle.node.id).toBe(ARTIFACT_ID);
    expect(bundle.workflow).toBeDefined();
    expect(bundle.workflow!.id).toBe(WORKFLOW_ID);
    expect(bundle.workflow!.name).toBe("Workflow from chart_renderer");
    expect(bundle.workflow!.outputField).toBe("data");
    expect(deps.workflowCalls).toEqual([{ id: WORKFLOW_ID }]);
  });

  it("falls back to `{ node }` when the workflow row is missing (defensive)", async () => {
    // Set-null FK should normally clear `workflowId`, but a race
    // could leave a dangling reference. Don't crash — surface as
    // "no workflow".
    const deps = buildDeps({
      getWorkflow: async () => null,
    });
    const bundle = await buildArtifactBundle(ARTIFACT_ID, OWNER, deps);
    expect(bundle.workflow).toBeUndefined();
    expect(bundle.data).toBeUndefined();
  });

  it("populates `data` / `fromCache` / `executedAt` when executor returns a resolution", async () => {
    const executedAt = new Date("2026-05-24T10:00:00Z");
    const deps = buildDeps({
      executeWorkflow: async () => ({
        data: { rows: [{ id: 1 }, { id: 2 }] },
        fromCache: true,
        executedAt,
      }),
    });
    const bundle = await buildArtifactBundle(ARTIFACT_ID, OWNER, deps);
    expect(bundle.data).toEqual({ rows: [{ id: 1 }, { id: 2 }] });
    expect(bundle.fromCache).toBe(true);
    expect(bundle.executedAt).toBe(executedAt.toISOString());
  });

  it("omits `data` / `fromCache` / `executedAt` when executor returns null (W1.6.2 stub)", async () => {
    const deps = buildDeps({
      executeWorkflow: async () => null,
    });
    const bundle = await buildArtifactBundle(ARTIFACT_ID, OWNER, deps);
    expect(bundle.workflow).toBeDefined(); // workflow metadata still present
    expect(bundle.data).toBeUndefined();
    expect(bundle.fromCache).toBeUndefined();
    expect(bundle.executedAt).toBeUndefined();
  });

  it("passes the canonical spec + outputField + ownerId to the executor", async () => {
    const deps = buildDeps();
    await buildArtifactBundle(ARTIFACT_ID, OWNER, deps);
    expect(deps.executeCalls).toEqual([
      {
        workflowId: WORKFLOW_ID,
        outputField: "data",
        ownerId: OWNER,
      },
    ]);
  });

  it("falls back to the first spec.outputs key when artifact.workflowOutputField is null", async () => {
    // Defensive: a workflow-backed artifact that somehow has a null
    // outputField (legacy / migration artifact). Use the first
    // outputs key from the spec.
    const deps = buildDeps({
      getArtifact: async () => artifactRow({ workflowOutputField: null }),
    });
    await buildArtifactBundle(ARTIFACT_ID, OWNER, deps);
    expect(deps.executeCalls).toHaveLength(1);
    expect(deps.executeCalls[0]!.outputField).toBe("data");
  });

  it("returns workflow metadata with empty outputField when spec.outputs is empty (defensive)", async () => {
    // Shouldn't happen post-validate, but don't crash if a spec
    // sneaks in with no outputs.
    const emptySpec: CanonicalWorkflowSpec = {
      ...sampleSpec(),
      outputs: {},
    };
    const deps = buildDeps({
      getArtifact: async () => artifactRow({ workflowOutputField: null }),
      getWorkflow: async () => workflowRow({ spec: emptySpec }),
    });
    const bundle = await buildArtifactBundle(ARTIFACT_ID, OWNER, deps);
    expect(bundle.workflow).toBeDefined();
    expect(bundle.workflow!.outputField).toBe("");
    expect(deps.executeCalls).toEqual([]); // no execute when no outputField
  });
});

// ─── Shape consistency ────────────────────────────────────────────────

describe("buildArtifactBundle — bundle shape consistency", () => {
  it("`node` field is always present regardless of branch", async () => {
    const cases: Array<() => BundleDeps> = [
      () =>
        buildDeps({
          getArtifact: async () =>
            artifactRow({ kind: "folder", type: null, workflowId: null }),
        }),
      () =>
        buildDeps({
          getArtifact: async () => artifactRow({ workflowId: null }),
        }),
      () => buildDeps(),
      () =>
        buildDeps({
          executeWorkflow: async () => ({
            data: {},
            fromCache: false,
            executedAt: new Date(),
          }),
        }),
    ];
    for (const factory of cases) {
      const bundle = await buildArtifactBundle(
        ARTIFACT_ID,
        OWNER,
        factory(),
      );
      expect(bundle.node).toBeDefined();
      expect(bundle.node.id).toBe(ARTIFACT_ID);
    }
  });
});
