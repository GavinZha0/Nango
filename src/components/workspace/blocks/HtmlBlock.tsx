"use client";

/**
 * HtmlBlock — sandboxed iframe renderer for agent-generated HTML pages.
 *
 * Renders the full HTML string via `srcdoc` inside a sandboxed iframe.
 * `sandbox="allow-scripts"` lets inline JS run (animations,
 * data visualisations, etc.) while blocking same-origin access,
 * form submission, popups, and top-level navigation.
 *
 *   - compact: 400px (outcome panel default)
 *   - large  : 480px (artifact detail — matches chart block sizing)
 */

import type { ReactElement } from "react";

import type { HtmlBlock } from "@/store/outcome-store";

import type { BlockSize } from "./BlockList";

interface Props {
  block: HtmlBlock;
  size?: BlockSize;
}

export function HtmlBlockRenderer({ block, size = "compact" }: Props): ReactElement {
  const isLarge = size === "large";
  const heightClass = isLarge ? "flex-1 h-full min-h-[480px]" : "h-[400px]";
  return (
    <div className={`${heightClass} w-full flex flex-col`}>
      <iframe
        srcDoc={block.html}
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        title="Generated HTML page"
        className="h-full w-full rounded border border-border bg-white flex-1"
      />
    </div>
  );
}
