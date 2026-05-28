"use client";

/**
 * TextBlock — read-only markdown block.
 *
 * V1 uses a tiny safe-markdown subset rather than wiring in
 * Streamdown / Mermaid here — outcomes are not chat replies, the
 * authoring surface for free-form rich text is the future artifact
 * editor. For now we render bold / italic / links / line breaks and
 * call it done.
 *
 * If you need richer markdown later, swap to Streamdown's static
 * mode here without changing the public block schema.
 */

import type { ReactElement } from "react";

import type { TextBlock } from "@/store/outcome-store";

import type { BlockSize } from "./BlockList";

interface Props {
  block: TextBlock;
  /** Accepted for API parity with the other block renderers — V1
   *  text blocks render identically in compact and large. The
   *  outer container's padding already drives the right text size
   *  for each context. */
  size?: BlockSize;
}

export function TextBlockRenderer({ block }: Props): ReactElement {
  // Very small renderer: split paragraphs on blank lines, then within
  // each paragraph honour single newlines as <br>. Bold / italic /
  // links are deferred to a real markdown renderer when actually
  // needed by a producer; today the only writer (web_search status
  // narration) emits plain paragraphs.
  const paragraphs: string[] = block.markdown.split(/\n{2,}/);
  return (
    <div className="text-sm leading-6 text-foreground">
      {paragraphs.map((p, i) => (
        <p key={i} className="whitespace-pre-wrap break-words">
          {p}
        </p>
      ))}
    </div>
  );
}
