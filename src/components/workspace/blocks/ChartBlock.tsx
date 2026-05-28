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
  const heightClass = size === "large" ? "h-[480px]" : "h-[400px]";
  return (
    <div className={`${heightClass} w-full`}>
      <EChartsRenderer option={block.option} />
    </div>
  );
}
