"use client";

/**
 * SlideBlock — sandboxed iframe renderer for Bento slide deck presentations.
 *
 * Assembles the full Bento presentation HTML document via `assembleBentoHtml`
 * and renders it inside an isolated iframe with `sandbox="allow-scripts"`.
 *
 *   - compact: 420px (outcomes panel card default)
 *   - large  : 540px+ (artifact detail view)
 */

import { useMemo, type ReactElement, type RefObject } from "react";
import type { SlideBlock } from "@/lib/blocks/schema";
import { assembleBentoHtml } from "@/lib/bento/template";
import type { BlockSize } from "./BlockList";

interface Props {
  block: SlideBlock;
  size?: BlockSize;
  mode?: "preview" | "edit";
  iframeRef?: RefObject<HTMLIFrameElement | null>;
}

export function SlideBlockRenderer({
  block,
  size = "compact",
  mode = "preview",
  iframeRef,
}: Props): ReactElement {
  const isLarge = size === "large";
  const heightClass = isLarge ? "flex-1 h-full min-h-[540px]" : "h-[420px]";

  const html = useMemo(() => {
    try {
      return assembleBentoHtml(block.doc, {
        fallbackTitle: block.title,
        mode,
      });
    } catch (err) {
      console.error("[SlideBlockRenderer] Failed to assemble Bento HTML:", err);
      return `<!DOCTYPE html><html><body style="font-family:sans-serif;padding:2rem;color:#e11d48;background:#18181b;">Failed to assemble presentation slides.</body></html>`;
    }
  }, [block.doc, block.title, mode]);

  return (
    <div className={`${heightClass} w-full flex flex-col min-w-0`}>
      <iframe
        ref={iframeRef}
        srcDoc={html}
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        title={block.title ?? "Bento Slides Presentation"}
        className="h-full w-full rounded border border-border bg-slate-950 flex-1"
      />
    </div>
  );
}
