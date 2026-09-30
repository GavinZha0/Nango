import { describe, expect, it } from "vitest";

import {
  saveSnapshot,
  updateWorkflowInputValues,
} from "@/lib/artifacts/save-snapshot";
import type { BundleDeps } from "@/lib/artifacts/bundle";
import type { db } from "@/lib/db";
import type { ArtifactEntity, WorkflowEntity } from "@/lib/db/schema";
import type { CanonicalWorkflowSpec } from "@/lib/workflows";

const OWNER = "user-1";
const OTHER_USER = "user-2";
const ARTIFACT_ID = "art-1";
const WORKFLOW_ID = "wf-1";

interface SpecWithProperties extends CanonicalWorkflowSpec {
  input_schema?: {
    type: "object";
    properties?: Record<string, { type?: string; default?: unknown; value?: unknown }>;
  };
}

function sampleSpec(): SpecWithProperties {
  return {
    name: "test-workflow",
    input_schema: {
      type: "object",
      properties: {
        region: { type: "string", default: "all" },
      },
    },
    nodes: [
      {
        type: "tool",
        schema_version: "1",
        id: 0,
        description: "tool",
        depends_on: [],
        inputs: { source: "builtin", name: "t", arguments: {} },
      },
    ],
    outputs: { data: "@nodes.0.result" },
  };
}

describe("saveSnapshot — verified snapshot preservation & config integrity", () => {
  it("persists directSnapshot for chart without polluting config with doc", async () => {
    const recorded = { update: null as { snapshot?: unknown; config?: unknown } | null };
    let executeCalls = 0;

    const mockDb = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => [
              {
                type: "chart",
                createdBy: OWNER,
                config: { theme: "dark" },
                workflowId: WORKFLOW_ID,
              },
            ],
          }),
        }),
      }),
      update: () => ({
        set: (payload: { snapshot?: unknown; config?: unknown }) => {
          recorded.update = payload;
          return {
            where: async () => {},
          };
        },
      }),
    };

    const bundleDeps: BundleDeps = {
      getArtifact: async () => ({
        id: ARTIFACT_ID,
        parentId: null,
        kind: "artifact",
        type: "chart",
        name: "Chart",
        description: null,
        config: { theme: "dark" },
        sourceThreadId: null,
        sourceOutcomeId: null,
        visibility: "private",
        displayOrder: 0,
        workflowId: WORKFLOW_ID,
        workflowOutputField: "data",
        viewMode: "live",
        snapshot: { option: { series: [{ type: "bar" }] } },
        snapshotAt: new Date(),
        createdBy: OWNER,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as ArtifactEntity),
      getWorkflow: async () => ({
        id: WORKFLOW_ID,
        name: "wf",
        description: null,
        spec: sampleSpec(),
        visibility: "private",
        createdBy: OWNER,
        updatedBy: OWNER,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as WorkflowEntity),
      executeWorkflow: async () => {
        executeCalls++;
        return {
          data: { shouldNotBeCalled: true },
          fromCache: false,
          executedAt: new Date(),
        };
      },
    };

    const chartSnapshot = { option: { series: [{ type: "bar" }] } };
    const bundle = await saveSnapshot(
      ARTIFACT_ID,
      OWNER,
      undefined,
      chartSnapshot,
      { db: mockDb as unknown as typeof db, bundleDeps },
    );

    // Verified: directSnapshot is saved
    expect(recorded.update).not.toBeNull();
    expect(recorded.update?.snapshot).toEqual(chartSnapshot);
    // Verified: config is NOT polluted with doc for non-slide artifacts
    expect(recorded.update?.config).toBeUndefined();
    // Verified: workflow is NOT re-executed
    expect(executeCalls).toBe(0);
    // Bundle returns the verified snapshot
    expect(bundle.data).toEqual(chartSnapshot);
    expect(bundle.fromSnapshot).toBe(true);
  });

  it("updates config.doc for slide artifacts when directSnapshot is provided", async () => {
    const recorded = { update: null as { snapshot?: unknown; config?: unknown } | null };

    const mockDb = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => [
              {
                type: "slide",
                createdBy: OWNER,
                config: { theme: "light" },
                workflowId: null,
              },
            ],
          }),
        }),
      }),
      update: () => ({
        set: (payload: { snapshot?: unknown; config?: unknown }) => {
          recorded.update = payload;
          return {
            where: async () => {},
          };
        },
      }),
    };

    const bundleDeps: BundleDeps = {
      getArtifact: async () => ({
        id: ARTIFACT_ID,
        parentId: null,
        kind: "artifact",
        type: "slide",
        name: "Presentation",
        description: null,
        config: { theme: "light", doc: { slides: [{ title: "S1" }] } },
        sourceThreadId: null,
        sourceOutcomeId: null,
        visibility: "private",
        displayOrder: 0,
        workflowId: null,
        workflowOutputField: null,
        viewMode: "snapshot",
        snapshot: { slides: [{ title: "S1" }] },
        snapshotAt: new Date(),
        createdBy: OWNER,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as ArtifactEntity),
      getWorkflow: async () => null,
      executeWorkflow: async () => null,
    };

    const slideDoc = { slides: [{ title: "S1" }] };
    const bundle = await saveSnapshot(
      ARTIFACT_ID,
      OWNER,
      undefined,
      slideDoc,
      { db: mockDb as unknown as typeof db, bundleDeps },
    );

    expect(recorded.update).not.toBeNull();
    expect(recorded.update?.snapshot).toEqual(slideDoc);
    // Slide config correctly retains/updates doc
    expect(recorded.update?.config).toEqual({
      theme: "light",
      doc: slideDoc,
    });
    expect(bundle.data).toEqual(slideDoc);
  });

  it("updates workflow input values when inputValues provided with directSnapshot", async () => {
    const recorded = { spec: null as SpecWithProperties | null };

    const spec = sampleSpec();
    const mockDb = {
      select: () => ({
        from: (_table: unknown) => ({
          where: () => ({
            limit: async () => {
              // Return artifact or workflow spec based on table
              return [
                {
                  type: "chart",
                  createdBy: OWNER,
                  config: {},
                  workflowId: WORKFLOW_ID,
                  spec,
                },
              ];
            },
          }),
        }),
      }),
      update: (_table: unknown) => ({
        set: (payload: Record<string, unknown>) => {
          if (payload.spec) {
            recorded.spec = payload.spec as SpecWithProperties;
          }
          return {
            where: async () => {},
          };
        },
      }),
    };

    const bundleDeps: BundleDeps = {
      getArtifact: async () => ({
        id: ARTIFACT_ID,
        parentId: null,
        kind: "artifact",
        type: "chart",
        name: "Chart",
        description: null,
        config: {},
        sourceThreadId: null,
        sourceOutcomeId: null,
        visibility: "private",
        displayOrder: 0,
        workflowId: WORKFLOW_ID,
        workflowOutputField: "data",
        viewMode: "snapshot",
        snapshot: { data: 123 },
        snapshotAt: new Date(),
        createdBy: OWNER,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as ArtifactEntity),
      getWorkflow: async () => ({
        id: WORKFLOW_ID,
        name: "wf",
        description: null,
        spec,
        visibility: "private",
        createdBy: OWNER,
        updatedBy: OWNER,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as WorkflowEntity),
      executeWorkflow: async () => null,
    };

    await saveSnapshot(
      ARTIFACT_ID,
      OWNER,
      { region: "west" },
      { data: 123 },
      { db: mockDb as unknown as typeof db, bundleDeps },
    );

    expect(recorded.spec).not.toBeNull();
    const schema = recorded.spec?.input_schema;
    expect(schema?.properties?.region?.value).toBe("west");
  });

  it("throws ApiError(404) when artifact is not found", async () => {
    const mockDb = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => [],
          }),
        }),
      }),
    };

    await expect(
      saveSnapshot(ARTIFACT_ID, OWNER, undefined, undefined, {
        db: mockDb as unknown as typeof db,
      }),
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
      status: 404,
    });
  });

  it("throws ApiError(403) when called by non-owner", async () => {
    const mockDb = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => [
              {
                type: "chart",
                createdBy: OTHER_USER,
                config: {},
                workflowId: null,
              },
            ],
          }),
        }),
      }),
    };

    await expect(
      saveSnapshot(ARTIFACT_ID, OWNER, undefined, undefined, {
        db: mockDb as unknown as typeof db,
      }),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      status: 403,
    });
  });

  it("updateWorkflowInputValues tracks updatedKeys and ignoredKeys and updates DB accordingly", async () => {
    const recorded = { spec: null as SpecWithProperties | null };
    const spec = sampleSpec(); // has property: region

    const mockDb = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => [{ spec }],
          }),
        }),
      }),
      update: () => ({
        set: (payload: Record<string, unknown>) => {
          recorded.spec = payload.spec as SpecWithProperties;
          return {
            where: async () => {},
          };
        },
      }),
    };

    const res = await updateWorkflowInputValues(
      WORKFLOW_ID,
      { region: "east", undefinedField: "value123" },
      mockDb as unknown as typeof db,
    );

    // region is valid, undefinedField is ignored
    expect(res.updatedKeys).toEqual(["region"]);
    expect(res.ignoredKeys).toEqual(["undefinedField"]);

    // DB updated only with defined property
    expect(recorded.spec).not.toBeNull();
    const props = recorded.spec?.input_schema?.properties;
    expect(props?.region?.value).toBe("east");
    expect(props?.undefinedField).toBeUndefined();
  });

  it("surfaces ignoredInputKeys on returned bundle when invalid keys are passed to saveSnapshot", async () => {
    const spec = sampleSpec();
    const mockDb = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => [
              {
                type: "chart",
                createdBy: OWNER,
                config: {},
                workflowId: WORKFLOW_ID,
                spec,
              },
            ],
          }),
        }),
      }),
      update: () => ({
        set: () => ({
          where: async () => {},
        }),
      }),
    };

    const bundleDeps: BundleDeps = {
      getArtifact: async () => ({
        id: ARTIFACT_ID,
        type: "chart",
        createdBy: OWNER,
        config: {},
        workflowId: WORKFLOW_ID,
        workflowOutputField: "data",
        viewMode: "snapshot",
        snapshot: { x: 1 },
        snapshotAt: new Date(),
      } as unknown as ArtifactEntity),
      getWorkflow: async () => ({
        id: WORKFLOW_ID,
        spec,
      } as unknown as WorkflowEntity),
      executeWorkflow: async () => null,
    };

    const bundle = await saveSnapshot(
      ARTIFACT_ID,
      OWNER,
      { region: "north", nonExistentKey: "foo" },
      { x: 1 },
      { db: mockDb as unknown as typeof db, bundleDeps },
    );

    expect(bundle.ignoredInputKeys).toEqual(["nonExistentKey"]);
  });
});
