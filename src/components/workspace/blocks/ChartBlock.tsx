"use client";

/**
 * ChartBlock — ECharts wrapper.
 *
 * Owns its height locally so the outer card body can stay
 * content-sized. ECharts canvas resolves `height: 100%` against a
 * definite parent — `min-h` alone would render 0px tall (see the
 * historical note in OutcomeCard).
 *
 *   - compact: 400px (outcome panel default)
 *   - large  : 480px (artifact detail — matches the height the
 *              legacy non-block ArtifactBody used for chart rows)
 */

import type { ReactElement } from "react";

import type { ChartBlock } from "@/store/outcome-store";

import { EChartsRenderer } from "../EChartsRenderer";
import type { BlockSize } from "./BlockList";

interface Props {
  block: ChartBlock;
  size?: BlockSize;
}

export function ChartBlockRenderer({ block, size = "compact" }: Props): ReactElement {
  const isLarge = size === "large";
  const heightClass = isLarge ? "flex-1 h-full min-h-[480px]" : "h-[400px]";
  return (
    <div className={`${heightClass} w-full flex flex-col`}>
      <EChartsRenderer option={block.option} />
    </div>
  );
}
