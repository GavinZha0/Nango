import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

import { saveArtifact, type SaveArtifactInput, type SaveArtifactDeps } from "@/lib/artifacts/save-artifact";
import { ArtifactTable, WorkflowTable } from "@/lib/db/schema";
import type { EntityRunEventEntity } from "@/lib/db/schema";

const mockInsertedArtifacts: Array<Record<string, unknown>> = [];
const mockInsertedWorkflows: Array<Record<string, unknown>> = [];
let mockExistingArtifact: Record<string, unknown> | null = null;
let mockEvents: EntityRunEventEntity[] = [];

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

  const txMock = {
    select: vi.fn(() => createQueryMock()),
    insert: vi.fn((table) => ({
      values: vi.fn((vals) => {
        if (table === WorkflowTable) {
          const row = { id: `wf-${mockInsertedWorkflows.length + 1}`, ...vals };
          mockInsertedWorkflows.push(row);
          return {
            returning: vi.fn().mockResolvedValue([row]),
          };
        }
        if (table === ArtifactTable) {
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
    })),
  };

  return {
    db: {
      select: vi.fn(() => createQueryMock()),
      transaction: vi.fn(async (cb) => cb(txMock)),
      update: vi.fn(() => ({
        set: vi.fn().mockReturnThis(),
        where: vi.fn().mockResolvedValue(undefined),
      })),
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
    mockExistingArtifact = null;
    mockEvents = [];
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
});
