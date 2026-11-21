import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  GENERATIVE_UI_ACTIVITY_TYPE,
  STANDARD_CATALOG_ID,
} from "@copilotkit/shared/generative-ui";

import { saveArtifact, type SaveArtifactInput, type SaveArtifactDeps } from "@/lib/artifacts/save-artifact";
import { ArtifactTable, WorkflowTable } from "@/lib/db/schema";
import type { EntityRunEventEntity } from "@/lib/db/schema";

const mockInsertedArtifacts: Array<Record<string, unknown>> = [];
const mockInsertedWorkflows: Array<Record<string, unknown>> = [];
const mockArtifactUpdates: Array<Record<string, unknown>> = [];
let mockExistingArtifact: Record<string, unknown> | null = null;
let mockEvents: EntityRunEventEntity[] = [];
/** When set, the next ArtifactTable insert throws this instead of inserting. */
let mockArtifactInsertError: (() => unknown) | null = null;

// Mock the DB and transaction
vi.mock("@/lib/db", () => {
  const createQueryMock = () => {
    const builder: Record<string, unknown> = {};
    builder.from = vi.fn().mockReturnValue(builder);
    builder.innerJoin = vi.fn().mockReturnValue(builder);
    builder.where = vi.fn().mockReturnValue(builder);
    builder.orderBy = vi.fn().mockImplementation(() => mockEvents);
    builder.limit = vi.fn().mockImplementation(() => (mockExistingArtifact ? [mockExistingArtifact] : []));
    builder.then = (resolve: (val: unknown) => unknown) => {
      if (mockExistingArtifact) {
        return Promise.resolve([mockExistingArtifact]).then(resolve);
      }
      return Promise.resolve(mockEvents).then(resolve);
    };
    return builder;
  };

  const insertMock = vi.fn((table) => ({
    values: vi.fn((vals) => {
      if (table === WorkflowTable) {
        const row = { id: `wf-${mockInsertedWorkflows.length + 1}`, ...vals };
        mockInsertedWorkflows.push(row);
        return {
          returning: vi.fn().mockResolvedValue([row]),
        };
      }
      if (table === ArtifactTable) {
        if (mockArtifactInsertError) {
          const makeErr = mockArtifactInsertError;
          mockArtifactInsertError = null;
          return { returning: vi.fn().mockRejectedValue(makeErr()) };
        }
        const row = { id: `art-${mockInsertedArtifacts.length + 1}`, ...vals };
        mockInsertedArtifacts.push(row);
        return {
          returning: vi.fn().mockResolvedValue([row]),
        };
      }
      return {
        returning: vi.fn().mockResolvedValue([{ id: "lineage-1" }]),
      };
    }),
  }));

  const txMock = {
    select: vi.fn(() => createQueryMock()),
    insert: insertMock,
  };

  return {
    db: {
      select: vi.fn(() => createQueryMock()),
      insert: insertMock,
      transaction: vi.fn(async (cb) => cb(txMock)),
      update: vi.fn((table) => {
        const chain = {
          set: vi.fn((vals: Record<string, unknown>) => {
            if (table === ArtifactTable) mockArtifactUpdates.push(vals);
            return chain;
          }),
          where: vi.fn().mockResolvedValue(undefined),
        };
        return chain;
      }),
    },
  };
});

// Mock executeWorkflow so tests stay isolated
vi.mock("@/lib/artifacts/execute-workflow", () => ({
  executeWorkflow: vi.fn().mockResolvedValue(null),
}));

describe("saveArtifact — Outcomes save unit tests", () => {
  const ownerId = "user-1";
  const threadId = "thread-1";

  const mockDeps: SaveArtifactDeps = {
    getToolMetadata: async (toolName: string) => {
      if (toolName.includes("screenshot") || toolName.includes("browser") || toolName.includes("image")) {
        return {
          source: "mcp:3a23e0b4-0e72-4b0e-a1f8-41da4933ebec",
          input_schema: { type: "object", properties: { filename: { type: "string" } } },
        };
      }
      return {
        source: "builtin",
        input_schema: { type: "object", additionalProperties: true },
      };
    },
    resolveAgentId: async () => null,
    resolveDataSourceId: async () => null,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockInsertedArtifacts.length = 0;
    mockInsertedWorkflows.length = 0;
    mockArtifactUpdates.length = 0;
    mockExistingArtifact = null;
    mockEvents = [];
    mockArtifactInsertError = null;
  });

  it("should save Image Outcome with Base64 data, solidifying initial snapshot", async () => {
    const outcomeId = "shot-1";
    const toolCallId = "call-1";
    const base64Data = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

    mockEvents = [
      {
        id: 1,
        runId: "run-1",
        seq: 0,
        type: "tool_call_chunk",
        payload: {
          toolCallId,
          toolName: "browser_take_screenshot",
          args: JSON.stringify({ shot_id: outcomeId }),
        },
        createdAt: new Date(),
      },
      {
        id: 2,
        runId: "run-1",
        seq: 1,
        type: "tool_call_result",
        payload: {
          toolCallId,
          content: JSON.stringify({
            content: [
              {
                type: "image",
                data: base64Data,
                mimeType: "image/png",
              },
            ],
          }),
        },
        createdAt: new Date(),
      },
    ] as unknown as EntityRunEventEntity[];

    const input: SaveArtifactInput = {
      ownerId,
      threadId,
      outcomeId,
      name: "Dashboard Screenshot Base64",
    };

    const result = await saveArtifact(input, mockDeps);

    expect(result.reused).toBe(false);
    expect(result.artifactId).toBeDefined();
    expect(mockInsertedArtifacts.length).toBe(1);

    const saved = mockInsertedArtifacts[0];
    expect(saved.type).toBe("image");
    expect(saved.viewMode).toBe("snapshot");
    expect(saved.snapshotAt).toBeDefined();
    expect(saved.snapshot).toEqual({
      src: `data:image/png;base64,${base64Data}`,
      url: `data:image/png;base64,${base64Data}`,
      mimeType: "image/png",
    });
  });

  it("should save Image Outcome with Playwright Markdown filename, constructing streaming URL snapshot", async () => {
    const outcomeId = "shot-2";
    const toolCallId = "call-2";
    const filename = "githubhome.png";

    mockEvents = [
      {
        id: 1,
        runId: "run-2",
        seq: 0,
        type: "tool_call_chunk",
        payload: {
          toolCallId,
          toolName: "browser_take_screenshot",
          args: JSON.stringify({ filename, shot_id: outcomeId }),
        },
        createdAt: new Date(),
      },
      {
        id: 2,
        runId: "run-2",
        seq: 1,
        type: "tool_call_result",
        payload: {
          toolCallId,
          content: JSON.stringify({
            content: [
              {
                type: "text",
                text: `### Result\n- [Screenshot of viewport](./${filename})\n### Ran Playwright code\nawait page.screenshot({ path: './${filename}' });`,
              },
            ],
          }),
        },
        createdAt: new Date(),
      },
    ] as unknown as EntityRunEventEntity[];

    const input: SaveArtifactInput = {
      ownerId,
      threadId,
      outcomeId,
      name: "GitHub Homepage Screenshot",
    };

    const result = await saveArtifact(input, mockDeps);

    expect(result.reused).toBe(false);
    expect(mockInsertedArtifacts.length).toBe(1);

    const saved = mockInsertedArtifacts[0];
    expect(saved.type).toBe("image");
    expect(saved.viewMode).toBe("snapshot");
    expect(saved.snapshotAt).toBeDefined();
    expect(saved.snapshot).toEqual({
      url: `/api/media/playwright-files?file=${encodeURIComponent(filename)}`,
      src: `/api/media/playwright-files?file=${encodeURIComponent(filename)}`,
      filename,
      mimeType: "image/png",
    });
  });

  it("should save Chart Outcome with ECharts options, solidifying chart snapshot", async () => {
    const outcomeId = "chart-123";
    const toolCallId = "call-3";
    const chartOption = {
      title: { text: "Monthly Revenue" },
      xAxis: { type: "category", data: ["Jan", "Feb", "Mar"] },
      yAxis: { type: "value" },
      series: [{ data: [150, 230, 224], type: "line" }],
    };

    mockEvents = [
      {
        id: 1,
        runId: "run-3",
        seq: 0,
        type: "tool_call_chunk",
        payload: {
          toolCallId,
          toolName: "generate_echarts_config",
          args: JSON.stringify({ chart_id: outcomeId, option: chartOption }),
        },
        createdAt: new Date(),
      },
      {
        id: 2,
        runId: "run-3",
        seq: 1,
        type: "tool_call_result",
        payload: {
          toolCallId,
          content: JSON.stringify({ option: chartOption }),
        },
        createdAt: new Date(),
      },
    ] as unknown as EntityRunEventEntity[];

    const input: SaveArtifactInput = {
      ownerId,
      threadId,
      outcomeId,
      name: "Monthly Revenue Chart",
    };

    const result = await saveArtifact(input, mockDeps);

    expect(result.reused).toBe(false);
    expect(mockInsertedArtifacts.length).toBe(1);

    const saved = mockInsertedArtifacts[0];
    expect(saved.type).toBe("chart");
    expect(saved.viewMode).toBe("snapshot");
    expect(saved.snapshotAt).toBeDefined();
    expect(saved.snapshot).toEqual(chartOption);
  });

  it("should save HTML Outcome with generated html string, solidifying html snapshot", async () => {
    const outcomeId = "html-456";
    const toolCallId = "call-4";
    const htmlContent = "<!DOCTYPE html><html><body><h1>Analytics Report</h1></body></html>";

    mockEvents = [
      {
        id: 1,
        runId: "run-4",
        seq: 0,
        type: "tool_call_chunk",
        payload: {
          toolCallId,
          toolName: "generate_html_page",
          args: JSON.stringify({ page_id: outcomeId, html: htmlContent }),
        },
        createdAt: new Date(),
      },
      {
        id: 2,
        runId: "run-4",
        seq: 1,
        type: "tool_call_result",
        payload: {
          toolCallId,
          content: JSON.stringify({ html: htmlContent }),
        },
        createdAt: new Date(),
      },
    ] as unknown as EntityRunEventEntity[];

    const input: SaveArtifactInput = {
      ownerId,
      threadId,
      outcomeId,
      name: "Analytics Page",
    };

    const result = await saveArtifact(input, mockDeps);

    expect(result.reused).toBe(false);
    expect(mockInsertedArtifacts.length).toBe(1);

    const saved = mockInsertedArtifacts[0];
    expect(saved.type).toBe("html");
    expect(saved.viewMode).toBe("snapshot");
    expect(saved.snapshotAt).toBeDefined();
    expect(saved.snapshot).toBe(htmlContent);
  });

  it("should successfully save a generate_bento_slides outcome as slide type with snapshot", async () => {
    const outcomeId = "demo-slides";
    const toolCallId = "call-slides-1";
    const slideDoc = {
      format: "bento/slides",
      slides: [{ id: "s1", elements: [{ type: "text", content: "Slide 1" }] }],
    };

    mockEvents = [
      {
        id: 1,
        runId: "run-5",
        seq: 0,
        type: "tool_call_chunk",
        payload: {
          toolCallId,
          toolName: "generate_bento_slides",
          args: JSON.stringify({
            outcome_id: outcomeId,
            title: "Pitch Deck",
            doc: slideDoc,
          }),
        },
        createdAt: new Date(),
      },
      {
        id: 2,
        runId: "run-5",
        seq: 1,
        type: "tool_call_result",
        payload: {
          toolCallId,
          content: JSON.stringify({ ok: true, outcome_id: outcomeId, title: "Pitch Deck", doc: slideDoc }),
        },
        createdAt: new Date(),
      },
    ] as unknown as EntityRunEventEntity[];

    const input: SaveArtifactInput = {
      ownerId,
      threadId,
      outcomeId,
      name: "Pitch Deck",
    };

    const result = await saveArtifact(input, mockDeps);

    expect(result.reused).toBe(false);
    expect(mockInsertedArtifacts.length).toBe(1);

    const saved = mockInsertedArtifacts[0];
    expect(saved.type).toBe("slide");
    expect(saved.viewMode).toBe("snapshot");
    expect(saved.snapshotAt).toBeDefined();
    expect(saved.snapshot).toEqual({ ...slideDoc, title: "Pitch Deck" });
  });

  it("should merge slides from multi-chunk append calls when saving slide artifact", async () => {
    const outcomeId = "multi-chunk-deck";
    const toolCallId1 = "call-slide-chunk-1";
    const toolCallId2 = "call-slide-chunk-2";

    const slideDocPart1 = {
      format: "bento/slides",
      title: "Complete Deck",
      slides: [{ id: "slide-1", content: "Part 1" }],
    };
    const slideDocPart2 = {
      format: "bento/slides",
      slides: [{ id: "slide-2", content: "Part 2" }],
    };

    mockEvents = [
      {
        id: 1,
        runId: "run-6",
        seq: 0,
        type: "tool_call_chunk",
        payload: {
          toolCallId: toolCallId1,
          toolName: "generate_bento_slides",
          args: JSON.stringify({
            outcome_id: outcomeId,
            title: "Complete Deck",
            doc: slideDocPart1,
          }),
        },
        createdAt: new Date(),
      },
      {
        id: 2,
        runId: "run-6",
        seq: 1,
        type: "tool_call_result",
        payload: {
          toolCallId: toolCallId1,
          content: JSON.stringify({ ok: true, outcome_id: outcomeId, title: "Complete Deck", doc: slideDocPart1 }),
        },
        createdAt: new Date(),
      },
      {
        id: 3,
        runId: "run-6",
        seq: 2,
        type: "tool_call_chunk",
        payload: {
          toolCallId: toolCallId2,
          toolName: "edit_bento_slides",
          args: JSON.stringify({
            outcome_id: outcomeId,
            action: "insert",
            slides: slideDocPart2.slides,
          }),
        },
        createdAt: new Date(),
      },
      {
        id: 4,
        runId: "run-6",
        seq: 3,
        type: "tool_call_result",
        payload: {
          toolCallId: toolCallId2,
          content: JSON.stringify({ ok: true, outcome_id: outcomeId, action: "insert", slides: slideDocPart2.slides }),
        },
        createdAt: new Date(),
      },
    ] as unknown as EntityRunEventEntity[];

    const input: SaveArtifactInput = {
      ownerId,
      threadId,
      outcomeId,
      name: "Complete Deck",
    };

    const result = await saveArtifact(input, mockDeps);

    expect(result.reused).toBe(false);
    expect(mockInsertedArtifacts.length).toBe(1);

    const saved = mockInsertedArtifacts[0];
    expect(saved.type).toBe("slide");
    const snapshot = saved.snapshot as { slides: Array<Record<string, unknown>> };
    expect(snapshot.slides).toHaveLength(2);
    expect(snapshot.slides[0]?.id).toBe("slide-1");
    expect(snapshot.slides[1]?.id).toBe("slide-2");
  });

  it("should preserve slide snapshot when an edit has changed: false (unmatched targets)", async () => {
    const outcomeId = "unchanged-edit-deck";
    const slideDoc = {
      format: "bento/slides",
      title: "Stable Deck",
      slides: [{ id: "s1", content: "Original 1" }, { id: "s2", content: "Original 2" }],
    };

    mockEvents = [
      {
        id: 1,
        runId: "run-unchanged",
        seq: 0,
        type: "tool_call_chunk",
        payload: {
          toolCallId: "call-init",
          toolName: "generate_bento_slides",
          args: JSON.stringify({ outcome_id: outcomeId, title: "Stable Deck", doc: slideDoc }),
        },
        createdAt: new Date(),
      },
      {
        id: 2,
        runId: "run-unchanged",
        seq: 1,
        type: "tool_call_result",
        payload: {
          toolCallId: "call-init",
          content: JSON.stringify({ ok: true, outcome_id: outcomeId, title: "Stable Deck", doc: slideDoc }),
        },
        createdAt: new Date(),
      },
      {
        id: 3,
        runId: "run-unchanged",
        seq: 2,
        type: "tool_call_chunk",
        payload: {
          toolCallId: "call-del-ghost",
          toolName: "edit_bento_slides",
          args: JSON.stringify({
            outcome_id: outcomeId,
            action: "delete",
            target_slide_ids: ["non-existent-id"],
          }),
        },
        createdAt: new Date(),
      },
      {
        id: 4,
        runId: "run-unchanged",
        seq: 3,
        type: "tool_call_result",
        payload: {
          toolCallId: "call-del-ghost",
          content: JSON.stringify({ ok: true, outcome_id: outcomeId, action: "delete", target_slide_ids: ["non-existent-id"] }),
        },
        createdAt: new Date(),
      },
    ] as unknown as EntityRunEventEntity[];

    const result = await saveArtifact({ ownerId, threadId, outcomeId }, mockDeps);
    expect(result.reused).toBe(false);
    expect(mockInsertedArtifacts.length).toBe(1);

    const saved = mockInsertedArtifacts[0];
    const snapshot = saved.snapshot as { slides: Array<Record<string, unknown>> };
    expect(snapshot.slides).toHaveLength(2);
    expect(snapshot.slides[0]?.id).toBe("s1");
    expect(snapshot.slides[1]?.id).toBe("s2");
  });

  it("should reconstruct full sequence in total order across insert, replace, and delete", async () => {
    const outcomeId = "complex-chain-deck";
    const initDoc = {
      format: "bento/slides",
      title: "Chain Deck",
      slides: [{ id: "s1", title: "Slide 1" }, { id: "s2", title: "Slide 2" }],
    };

    mockEvents = [
      {
        id: 1,
        runId: "run-chain",
        seq: 0,
        type: "tool_call_chunk",
        payload: {
          toolCallId: "c-1",
          toolName: "generate_bento_slides",
          args: JSON.stringify({ outcome_id: outcomeId, title: "Chain Deck", doc: initDoc }),
        },
        createdAt: new Date("2026-09-01T10:00:00Z"),
      },
      {
        id: 2,
        runId: "run-chain",
        seq: 1,
        type: "tool_call_result",
        payload: {
          toolCallId: "c-1",
          content: JSON.stringify({ ok: true, outcome_id: outcomeId, title: "Chain Deck", doc: initDoc }),
        },
        createdAt: new Date("2026-09-01T10:00:01Z"),
      },
      // Insert s3 after s1 -> [s1, s3, s2]
      {
        id: 3,
        runId: "run-chain",
        seq: 2,
        type: "tool_call_chunk",
        payload: {
          toolCallId: "c-2",
          toolName: "edit_bento_slides",
          args: JSON.stringify({
            outcome_id: outcomeId,
            action: "insert",
            target_slide_ids: ["s1"],
            slides: [{ id: "s3", title: "Slide 3 Middle" }],
          }),
        },
        createdAt: new Date("2026-09-01T10:00:02Z"),
      },
      {
        id: 4,
        runId: "run-chain",
        seq: 3,
        type: "tool_call_result",
        payload: {
          toolCallId: "c-2",
          // Full result matching what buildEditBentoSlidesTool.execute() returns:
          // includes target_slide_ids and slides so save-artifact can replay from result.
          content: JSON.stringify({
            ok: true,
            outcome_id: outcomeId,
            action: "insert",
            target_slide_ids: ["s1"],
            slides: [{ id: "s3", title: "Slide 3 Middle" }],
          }),
        },
        createdAt: new Date("2026-09-01T10:00:03Z"),
      },
      // Replace s2 with updated title -> [s1, s3, s2_updated]
      {
        id: 5,
        runId: "run-chain",
        seq: 4,
        type: "tool_call_chunk",
        payload: {
          toolCallId: "c-3",
          toolName: "edit_bento_slides",
          args: JSON.stringify({
            outcome_id: outcomeId,
            action: "replace",
            target_slide_ids: ["s2"],
            slides: [{ title: "Slide 2 Replaced" }],
          }),
        },
        createdAt: new Date("2026-09-01T10:00:04Z"),
      },
      {
        id: 6,
        runId: "run-chain",
        seq: 5,
        type: "tool_call_result",
        payload: {
          toolCallId: "c-3",
          // Full result: slides has id locked to the target ("s2") by the server tool.
          content: JSON.stringify({
            ok: true,
            outcome_id: outcomeId,
            action: "replace",
            target_slide_ids: ["s2"],
            slides: [{ id: "s2", title: "Slide 2 Replaced" }],
          }),
        },
        createdAt: new Date("2026-09-01T10:00:05Z"),
      },
      // Delete s1 -> [s3, s2_updated]
      {
        id: 7,
        runId: "run-chain",
        seq: 6,
        type: "tool_call_chunk",
        payload: {
          toolCallId: "c-4",
          toolName: "edit_bento_slides",
          args: JSON.stringify({
            outcome_id: outcomeId,
            action: "delete",
            target_slide_ids: ["s1"],
          }),
        },
        createdAt: new Date("2026-09-01T10:00:06Z"),
      },
      {
        id: 8,
        runId: "run-chain",
        seq: 7,
        type: "tool_call_result",
        payload: {
          toolCallId: "c-4",
          // Full result: delete includes target_slide_ids so replay knows which to remove.
          content: JSON.stringify({
            ok: true,
            outcome_id: outcomeId,
            action: "delete",
            target_slide_ids: ["s1"],
          }),
        },
        createdAt: new Date("2026-09-01T10:00:07Z"),
      },
    ] as unknown as EntityRunEventEntity[];

    const result = await saveArtifact({ ownerId, threadId, outcomeId }, mockDeps);
    expect(result.reused).toBe(false);
    expect(mockInsertedArtifacts.length).toBe(1);

    const saved = mockInsertedArtifacts[0];
    const snapshot = saved.snapshot as { slides: Array<{ id: string; title?: string }> };
    expect(snapshot.slides).toHaveLength(2);
    expect(snapshot.slides[0]?.id).toBe("s3");
    expect(snapshot.slides[0]?.title).toBe("Slide 3 Middle");
    expect(snapshot.slides[1]?.id).toBe("s2");
    expect(snapshot.slides[1]?.title).toBe("Slide 2 Replaced");
  });

  it("should be idempotent when saving the same outcome twice", async () => {
    mockExistingArtifact = {
      id: "existing-art-99",
      workflowId: "existing-wf-99",
      workflowOutputField: "data",
    };

    const input: SaveArtifactInput = {
      ownerId,
      threadId,
      outcomeId: "already-saved-outcome",
    };

    const result = await saveArtifact(input, mockDeps);

    expect(result.reused).toBe(true);
    expect(result.artifactId).toBe("existing-art-99");
    expect(result.workflowId).toBe("existing-wf-99");
    expect(mockInsertedArtifacts.length).toBe(0);
  });

  describe("A2UI (genui:) outcomes", () => {
    const surfaceId = "sales-summary";
    const outcomeId = `genui:${surfaceId}`;
    const messageId = `surface-msg-${surfaceId}`;

    // Shape matches the `{ eventType, payload }` projection selected by
    // `saveA2uiArtifact`.
    const surfaceEvents = (headings: string[]): EntityRunEventEntity[] =>
      [
        {
          eventType: "activity_snapshot",
          payload: {
            messageId,
            activityType: GENERATIVE_UI_ACTIVITY_TYPE,
            content: {
              surfaceId,
              target: "chat",
              catalogId: STANDARD_CATALOG_ID,
              status: "streaming",
              rejected: [],
              operations: [
                {
                  version: "1.0",
                  createSurface: { surfaceId, catalogId: STANDARD_CATALOG_ID },
                },
              ],
            },
          },
        },
        ...headings.map((heading) => ({
          eventType: "activity_delta",
          payload: {
            messageId,
            activityType: GENERATIVE_UI_ACTIVITY_TYPE,
            patch: [
              {
                op: "add",
                path: "/operations/-",
                value: {
                  version: "1.0",
                  updateDataModel: { surfaceId, path: "/heading", value: heading },
                },
              },
              { op: "replace", path: "/status", value: "ready" },
            ],
          },
        })),
      ] as unknown as EntityRunEventEntity[];

    it("inserts a workflow-less a2ui artifact on first save", async () => {
      mockEvents = surfaceEvents(["Q3"]);

      const result = await saveArtifact({ ownerId, threadId, outcomeId }, mockDeps);

      expect(result).toEqual({
        artifactId: "art-1",
        workflowId: null,
        workflowOutputField: null,
        reused: false,
      });
      expect(mockInsertedArtifacts).toHaveLength(1);
      const saved = mockInsertedArtifacts[0]!;
      expect(saved.type).toBe("a2ui");
      expect(saved.workflowId).toBeNull();
      expect((saved.snapshot as { operations: unknown[] }).operations).toHaveLength(2);
    });

    it("refreshes the existing workflow-less row instead of re-inserting", async () => {
      // Regression: a NULL-workflow row used to be reported as "not found",
      // sending re-saves into the (source_thread_id, source_outcome_id)
      // unique index.
      mockExistingArtifact = {
        id: "existing-a2ui-1",
        workflowId: null,
        workflowOutputField: null,
      };
      mockEvents = surfaceEvents(["Q3", "Q4"]);

      const result = await saveArtifact({ ownerId, threadId, outcomeId }, mockDeps);

      expect(result).toEqual({
        artifactId: "existing-a2ui-1",
        workflowId: null,
        workflowOutputField: null,
        reused: true,
      });
      expect(mockInsertedArtifacts).toHaveLength(0);
      expect(mockArtifactUpdates).toHaveLength(1);
      const update = mockArtifactUpdates[0]!;
      const snapshot = update.snapshot as { operations: unknown[] };
      expect(snapshot.operations).toHaveLength(3);
      expect((update.config as { surface: unknown }).surface).toEqual(snapshot);
    });

    it("folds a lost insert race into the refresh path", async () => {
      mockEvents = surfaceEvents(["Q3"]);
      mockArtifactInsertError = () => {
        // The concurrent winner becomes visible to the re-query.
        mockExistingArtifact = { id: "winner-a2ui", workflowId: null, workflowOutputField: null };
        return Object.assign(new Error("duplicate key"), { code: "23505" });
      };

      const result = await saveArtifact({ ownerId, threadId, outcomeId }, mockDeps);

      expect(result.artifactId).toBe("winner-a2ui");
      expect(result.reused).toBe(true);
      expect(mockArtifactUpdates).toHaveLength(1);
    });
  });
});
