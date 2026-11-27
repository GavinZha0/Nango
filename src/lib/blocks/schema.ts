import type { GenerativeUISurfaceContent } from "@copilotkit/shared/generative-ui";
import { z } from "zod";

import type { ArtifactType } from "@/lib/domain/artifact";

/** Visual primitives shared by Outcomes (`/outcomes`) and Artifacts (`/artifact/[id]`).
 *  Adding a new block: append the discriminant here + a `<KindBlock>` component under
 *  `src/components/workspace/blocks/` + wire it in `BlockList`. */
export type OutcomeBlock =
  | TextBlock
  | CardListBlock
  | ChartBlock
  | HtmlBlock
  | ImageBlock
  | SlideBlock
  | A2uiBlock;

export interface TextBlock {
  kind: "text";
  markdown: string;
}

export type CardListSourceKind = "web" | "kb" | "sql" | "file";

export interface CardListItem {
  index?: number;
  sourceKind?: CardListSourceKind;
  image?: string;
  title: string;
  url?: string;
  subtitle?: string;
  snippet?: string;
  meta?: string;
  favicon?: string;
}

export interface CardListBlock {
  kind: "card_list";
  cards: CardListItem[];
}

export interface ChartBlock {
  kind: "chart";
  option: Record<string, unknown>;
  datasetName?: string;
}

export interface HtmlBlock {
  kind: "html";
  html: string;
}

export interface A2uiBlock {
  kind: "a2ui";
  surface: GenerativeUISurfaceContent;
}

export interface ImageBlock {
  kind: "image";
  src: string;
  mimeType?: string;
  alt?: string;
  caption?: string;
}

export interface SlideBlock {
  kind: "slide";
  doc: Record<string, unknown>;
  title?: string;
  appliedToolCallIds?: string[];
}

export interface ArtifactBlocksSnapshot {
  blocks: OutcomeBlock[];
}

// ─── Runtime validation (used at trust boundaries for static snapshot writes) ──

const cardListItemSchema = z.object({
  index: z.number().int().positive().optional(),
  sourceKind: z.enum(["web", "kb", "sql", "file"]).optional(),
  image: z.string().optional(),
  title: z.string(),
  url: z.string().optional(),
  subtitle: z.string().optional(),
  snippet: z.string().optional(),
  meta: z.string().optional(),
  favicon: z.string().optional(),
});

export const outcomeBlockSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("text"),
    markdown: z.string(),
  }),
  z.object({
    kind: z.literal("card_list"),
    cards: z.array(cardListItemSchema),
  }),
  z.object({
    kind: z.literal("chart"),
    option: z.record(z.string(), z.unknown()),
    datasetName: z.string().optional(),
  }),
  z.object({
    kind: z.literal("html"),
    html: z.string(),
  }),
  z.object({
    kind: z.literal("image"),
    src: z.string().min(1),
    mimeType: z.string().optional(),
    alt: z.string().optional(),
    caption: z.string().optional(),
  }),
  z.object({
    kind: z.literal("slide"),
    doc: z.record(z.string(), z.unknown()),
    title: z.string().optional(),
    appliedToolCallIds: z.array(z.string()).optional(),
  }),
  z.object({
    kind: z.literal("a2ui"),
    surface: z.record(z.string(), z.unknown()),
  }),
]);

export const artifactBlocksSnapshotSchema = z.object({
  blocks: z.array(outcomeBlockSchema).min(1),
});

/** Check that every block kind in a static snapshot write matches the artifact's declared type. */
export function areBlocksCompatibleWithArtifactType(
  artifactType: ArtifactType | null,
  blocks: ReadonlyArray<{ kind: OutcomeBlock["kind"] }>,
): boolean {
  if (blocks.length === 0) return false;
  switch (artifactType) {
    case "slide":
      return blocks.every((b) => b.kind === "slide");
    case "html":
      return blocks.every((b) => b.kind === "html");
    case "image":
      return blocks.every((b) => b.kind === "image");
    case "a2ui":
      return blocks.every((b) => b.kind === "a2ui");
    case "chart":
      return blocks.every((b) => b.kind === "chart");
    case "report":
    case "code":
      return blocks.every((b) => b.kind === "text" || b.kind === "card_list");
    default:
      return false;
  }
}

/** Derive `ArtifactType` from an outcome's primary block kind. */
export function artifactTypeFromBlocks(
  blocks: ReadonlyArray<OutcomeBlock>,
): ArtifactType {
  const first = blocks[0];
  if (!first) return "report";
  switch (first.kind) {
    case "chart":
      return "chart";
    case "html":
      return "html";
    case "slide":
      return "slide";
    case "image":
      return "image";
    case "a2ui":
      return "a2ui";
    case "text":
    case "card_list":
      return "report";
  }
}

function isChartOption(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  return Array.isArray((value as { series?: unknown }).series);
}

/** Convert an artifact row + resolved workflow data into `OutcomeBlock[]` for `BlockList`. */
export function toArtifactBlocks(
  node: { type: ArtifactType | null; snapshot?: unknown },
  data?: unknown,
): OutcomeBlock[] | null {
  if (node.type === "chart") {
    const option = isChartOption(data)
      ? data
      : isChartOption(node.snapshot)
        ? node.snapshot
        : null;
    return option ? [{ kind: "chart", option }] : null;
  }

  const candidate = node.snapshot ?? data;
  if (
    candidate &&
    typeof candidate === "object" &&
    !Array.isArray(candidate) &&
    Array.isArray((candidate as { blocks?: unknown }).blocks)
  ) {
    const blocks = (candidate as { blocks: unknown[] }).blocks;
    if (blocks.length > 0) {
      return blocks as OutcomeBlock[];
    }
  }

  return null;
}
