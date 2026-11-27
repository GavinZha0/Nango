import { describe, expect, it } from "vitest";

import {
  areBlocksCompatibleWithArtifactType,
  artifactBlocksSnapshotSchema,
  artifactTypeFromBlocks,
  toArtifactBlocks,
} from "@/lib/blocks/schema";

describe("blocks schema & toArtifactBlocks", () => {
  it("converts chart workflow data or snapshot into a ChartBlock", () => {
    const option = { series: [{ type: "bar", data: [1, 2, 3] }] };
    expect(toArtifactBlocks({ type: "chart", snapshot: null }, option)).toEqual([
      { kind: "chart", option },
    ]);
    expect(toArtifactBlocks({ type: "chart", snapshot: option }, undefined)).toEqual([
      { kind: "chart", option },
    ]);
    expect(toArtifactBlocks({ type: "chart", snapshot: null }, { notAChart: true })).toBeNull();
  });

  it("extracts blocks from static artifact snapshot", () => {
    const htmlBlocks = [{ kind: "html" as const, html: "<h1>Hello</h1>" }];
    expect(
      toArtifactBlocks({ type: "html", snapshot: { blocks: htmlBlocks } }),
    ).toEqual(htmlBlocks);

    const reportBlocks = [
      { kind: "card_list" as const, cards: [{ title: "Result 1", url: "https://example.com" }] },
    ];
    expect(
      toArtifactBlocks({ type: "report", snapshot: { blocks: reportBlocks } }),
    ).toEqual(reportBlocks);

    expect(toArtifactBlocks({ type: "html", snapshot: { blocks: [] } })).toBeNull();
    expect(toArtifactBlocks({ type: "html", snapshot: "raw-html" })).toBeNull();
  });

  it("validates static snapshot payloads and checks artifact type compatibility", () => {
    const slidePayload = {
      blocks: [{ kind: "slide", doc: { format: "bento/slides", slides: [] }, title: "Deck" }],
    };
    const parsed = artifactBlocksSnapshotSchema.safeParse(slidePayload);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(areBlocksCompatibleWithArtifactType("slide", parsed.data.blocks)).toBe(true);
      expect(areBlocksCompatibleWithArtifactType("html", parsed.data.blocks)).toBe(false);
    }

    expect(artifactBlocksSnapshotSchema.safeParse({ blocks: [] }).success).toBe(false);
    expect(artifactBlocksSnapshotSchema.safeParse({ notBlocks: true }).success).toBe(false);
  });

  it("derives ArtifactType from blocks", () => {
    expect(artifactTypeFromBlocks([{ kind: "chart", option: {} }])).toBe("chart");
    expect(artifactTypeFromBlocks([{ kind: "html", html: "<p/>" }])).toBe("html");
    expect(artifactTypeFromBlocks([{ kind: "slide", doc: {} }])).toBe("slide");
    expect(artifactTypeFromBlocks([{ kind: "image", src: "data:image/png;base64,AA==" }])).toBe("image");
    expect(artifactTypeFromBlocks([{ kind: "card_list", cards: [] }])).toBe("report");
    expect(artifactTypeFromBlocks([{ kind: "text", markdown: "hi" }])).toBe("report");
  });
});
