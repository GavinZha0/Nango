import { describe, it, expect } from "vitest";
import { GenerativeUISurfaceManager } from "@copilotkit/core/generative-ui";
import { STANDARD_CATALOG_ID } from "@copilotkit/shared/generative-ui";
import {
  applySurfaceDelta,
  createHeadlessCatalog,
  parseSurfaceContent,
  deriveSurfaceOutcomeId,
  extractSurfaceTitle,
  normalizeRenderUiArgsJson,
} from "@/lib/generative-ui/surface";
import { rebuildA2UiOutcome } from "@/lib/outcomes/replay-rebuilders";

describe("Generative UI surface folding & validation", () => {
  it("folds /operations/-, /status, /rejected, and /rejected/- deltas immutably", () => {
    const initial: Record<string, unknown> = {
      surfaceId: "sales-summary",
      target: "chat",
      catalogId: STANDARD_CATALOG_ID,
      status: "streaming",
      rejected: [],
      operations: [
        {
          version: "1.0",
          createSurface: {
            surfaceId: "sales-summary",
            catalogId: STANDARD_CATALOG_ID,
          },
        },
      ],
    };

    const afterStep1 = applySurfaceDelta(initial, [
      {
        op: "add",
        path: "/operations/-",
        value: {
          version: "1.0",
          updateComponents: {
            surfaceId: "sales-summary",
            components: [
              { id: "root", component: "Card", child: "title-1" },
              { id: "title-1", component: "Title", text: { "@path": "/heading" } },
            ],
          },
        },
      },
      {
        op: "add",
        path: "/operations/-",
        value: {
          version: "1.0",
          updateDataModel: {
            surfaceId: "sales-summary",
            path: "/",
            value: { heading: "Q3 Revenue" },
          },
        },
      },
      { op: "replace", path: "/status", value: "ready" },
      { op: "add", path: "/rejected/-", value: { index: 99, reason: "ignored" } },
      { op: "replace", path: "/unknown/path", value: "safe-ignore" },
    ]);

    // Original remains untouched
    expect((initial.operations as unknown[]).length).toBe(1);
    expect(initial.status).toBe("streaming");

    const parsed = parseSurfaceContent(afterStep1);
    expect(parsed).not.toBeNull();
    expect(parsed?.status).toBe("ready");
    expect(parsed?.operations).toHaveLength(3);
    expect(parsed?.rejected).toHaveLength(1);

    // Verify replacement of /rejected
    const cleared = applySurfaceDelta(afterStep1, [{ op: "replace", path: "/rejected", value: [] }]);
    const parsedCleared = parseSurfaceContent(cleared);
    expect(parsedCleared?.rejected).toEqual([]);

    // Ingest into vendor GenerativeUISurfaceManager
    const manager = new GenerativeUISurfaceManager(createHeadlessCatalog(STANDARD_CATALOG_ID));
    manager.ingest("thread-1", "agent-1", parsedCleared!);

    const surface = manager.getSurface("thread-1", "sales-summary");
    expect(surface).toBeDefined();
    expect(surface?.failed).toBe(false);
    expect(surface?.model.componentsModel.get("root")?.type).toBe("Card");
    expect(surface?.model.dataModel.get("/heading")).toBe("Q3 Revenue");
  });

  it("returns null for invalid surface payloads", () => {
    expect(parseSurfaceContent(null)).toBeNull();
    expect(parseSurfaceContent({ surfaceId: "x", status: "complete" })).toBeNull();
  });

  it("derives outcomeId and extracts literal Title or falls back to surfaceId", () => {
    expect(deriveSurfaceOutcomeId("sales-summary")).toBe("genui:sales-summary");

    const withTitle = parseSurfaceContent({
      surfaceId: "s1",
      target: "chat",
      catalogId: STANDARD_CATALOG_ID,
      status: "ready",
      rejected: [],
      operations: [
        {
          version: "1.0",
          updateComponents: {
            surfaceId: "s1",
            components: [
              { id: "root", component: "Title", text: "Executive Summary" },
            ],
          },
        },
      ],
    });
    expect(extractSurfaceTitle(withTitle!)).toBe("Executive Summary");

    const withoutLiteralTitle = parseSurfaceContent({
      surfaceId: "s2",
      target: "chat",
      catalogId: STANDARD_CATALOG_ID,
      status: "ready",
      rejected: [],
      operations: [],
    });
    expect(extractSurfaceTitle(withoutLiteralTitle!)).toBe("s2");
  });

  it("rebuilds an A2UI outcome only when status is ready and operations are non-empty", () => {
    const ctx = {
      threadId: "thread-1",
      runId: "run-1",
      entityId: "agent-1",
      ts: new Date("2026-11-21T10:00:00Z"),
      log: { warn: () => {} } as never,
    };

    expect(
      rebuildA2UiOutcome(
        {
          surfaceId: "s-streaming",
          target: "chat",
          catalogId: STANDARD_CATALOG_ID,
          status: "streaming",
          rejected: [],
          operations: [{ version: "1.0", createSurface: { surfaceId: "s-streaming", catalogId: STANDARD_CATALOG_ID } }],
        },
        ctx,
      ),
    ).toBeNull();

    const built = rebuildA2UiOutcome(
      {
        surfaceId: "s-ready",
        target: "chat",
        catalogId: STANDARD_CATALOG_ID,
        status: "ready",
        rejected: [],
        operations: [
          { version: "1.0", createSurface: { surfaceId: "s-ready", catalogId: STANDARD_CATALOG_ID } },
          {
            version: "1.0",
            updateComponents: {
              surfaceId: "s-ready",
              components: [{ id: "root", component: "Title", text: "Revenue Report" }],
            },
          },
        ],
      },
      ctx,
    );

    expect(built).not.toBeNull();
    expect(built?.id).toBe("genui:s-ready");
    expect(built?.outcome.title).toBe("Revenue Report");
    expect(built?.outcome.blocks).toHaveLength(1);
    expect(built?.outcome.blocks[0]?.kind).toBe("a2ui");
  });

  it("ingests nango/workspace@1 surfaces via createHeadlessCatalog without failing createSurface", () => {
    const surfaceDoc = parseSurfaceContent({
      surfaceId: "workspace-card",
      target: "chat",
      catalogId: "nango/workspace@1",
      status: "ready",
      rejected: [],
      operations: [
        {
          version: "1.0",
          createSurface: {
            surfaceId: "workspace-card",
            catalogId: "nango/workspace@1",
          },
        },
        {
          version: "1.0",
          updateComponents: {
            surfaceId: "workspace-card",
            components: [{ id: "root", component: "Title", text: "Trimmed Catalog" }],
          },
        },
      ],
    });
    expect(surfaceDoc).not.toBeNull();

    const manager = new GenerativeUISurfaceManager(createHeadlessCatalog(surfaceDoc!.catalogId));
    manager.ingest("thread-1", undefined, surfaceDoc!);
    const surface = manager.getSurface("thread-1", "workspace-card");
    expect(surface).toBeDefined();
    expect(surface?.failed).toBe(false);
    expect(surface?.model.componentsModel.get("root")?.properties.text).toBe("Trimmed Catalog");
  });

  it("repairs updateComponents when components/surfaceId sit at outer operation level", () => {
    const malformed = JSON.stringify({
      target: "chat",
      operations: [
        {
          version: "1.0",
          surfaceId: "release-checklist-1",
          components: [{ id: "pre-chart", component: "Chart" }],
          updateComponents: {
            surfaceId: "release-checklist-1",
            components: [],
          },
        },
      ],
    });

    const repaired = JSON.parse(normalizeRenderUiArgsJson(malformed)) as {
      operations: Array<Record<string, unknown>>;
    };
    const op = repaired.operations[0]!;
    expect(op.components).toBeUndefined();
    expect(op.surfaceId).toBeUndefined();
    expect(op.updateComponents).toEqual({
      surfaceId: "release-checklist-1",
      components: [{ id: "pre-chart", component: "Chart" }],
    });
  });
});
