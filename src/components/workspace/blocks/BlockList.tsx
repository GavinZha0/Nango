"use client";

/**
 * BlockList — dispatch one block to its renderer per discriminant.
 *
 * Lives at the `OutcomeCard` body slot AND at the artifact detail
 * body slot. The `size` prop lets the same block schema render in
 * two visual densities:
 *
 *   - "compact" (default): outcome panel — tight, fixed-height
 *     cards, line-clamped snippets, "Show N more" for long lists.
 *   - "large"           : artifact detail page — bigger thumbnails,
 *     full snippets (no clamp), all cards expanded, taller charts.
 *
 * Every block kind has its own file under `./` and forwards the
 * `size` prop. Unknown kinds intentionally throw — the
 * `ChartErrorBoundary` in the parent catches and renders a
 * placeholder, so a partial deployment of a future block kind
 * doesn't silently no-op.
 */

import type { ReactElement } from "react";

import type { OutcomeBlock } from "@/store/outcome-store";

import { CardListBlockRenderer } from "./CardListBlock";
import { ChartBlockRenderer } from "./ChartBlock";
import { HtmlBlockRenderer } from "./HtmlBlock";
import { TextBlockRenderer } from "./TextBlock";

export type BlockSize = "compact" | "large";

interface BlockListProps {
  blocks: OutcomeBlock[];
  /** Visual density of nested blocks. Defaults to "compact" (the
   *  outcome panel's tight grid layout); artifact detail and other
   *  full-width consumers pass "large" for generous typography. */
  size?: BlockSize;
}

export function BlockList({ blocks, size = "compact" }: BlockListProps): ReactElement {
  // `space-y-3` between blocks; padding lives on the outer OutcomeCard
  // body. Inner blocks render edge-to-edge so a single block (e.g. a
  // chart) doesn't get an awkward extra inset.
  const isLarge = size === "large";
  return (
    <div className={`space-y-3 ${isLarge ? "flex-grow flex flex-col min-h-0" : ""}`}>
      {blocks.map((b, i) => (
        <BlockSwitch key={i} block={b} size={size} />
      ))}
    </div>
  );
}

function BlockSwitch({
  block,
  size,
}: {
  block: OutcomeBlock;
  size: BlockSize;
}): ReactElement {
  switch (block.kind) {
    case "text":
      return <TextBlockRenderer block={block} size={size} />;
    case "card_list":
      return <CardListBlockRenderer block={block} size={size} />;
    case "chart":
      return <ChartBlockRenderer block={block} size={size} />;
    case "html":
      return <HtmlBlockRenderer block={block} size={size} />;
    default: {
      // exhaustiveness check — TS will error here if a new block
      // kind is added to the union without a branch above.
      const _exhaustive: never = block;
      throw new Error(
        `Unknown block kind: ${String((_exhaustive as OutcomeBlock).kind)}`,
      );
    }
  }
}
