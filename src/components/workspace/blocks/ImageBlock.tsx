"use client";

/**
 * ImageBlock — renderer for agent-generated / tool screenshot images.
 *
 * Supports both URL endpoints (e.g. /api/media/tool-image/...) and data URLs.
 * Displays image responsively with nice rounded border, max height bounds,
 * and optional caption.
 */

import { useState, type ReactElement } from "react";
import { ImageIcon } from "lucide-react";

import type { ImageBlock } from "@/store/outcome-store";
import type { BlockSize } from "./BlockList";
import { cn } from "@/lib/utils";

interface Props {
  block: ImageBlock;
  size?: BlockSize;
}

export function ImageBlockRenderer({
  block,
  size = "compact",
}: Props): ReactElement {
  const [loadError, setLoadError] = useState(false);
  const isLarge = size === "large";

  if (loadError) {
    return (
      <div className="flex h-48 w-full flex-col items-center justify-center rounded-lg border border-dashed border-border bg-muted/20 p-4 text-center text-muted-foreground">
        <ImageIcon className="mb-2 h-8 w-8 opacity-40" />
        <span className="text-xs font-medium">Failed to load image</span>
      </div>
    );
  }

  return (
    <div
      className={cn(
        "flex w-full flex-col items-center justify-center overflow-hidden rounded-lg border border-border bg-muted/10 p-2",
        isLarge ? "min-h-[360px]" : "min-h-[220px]",
      )}
    >
      <div className="relative flex max-h-[600px] w-full items-center justify-center overflow-hidden rounded">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={block.src}
          alt={block.alt ?? "Screenshot image"}
          onError={() => setLoadError(true)}
          className="max-h-[560px] w-auto max-w-full rounded object-contain shadow-sm transition-all"
        />
      </div>
      {block.caption && (
        <p className="mt-2 text-center text-xs text-muted-foreground">
          {block.caption}
        </p>
      )}
    </div>
  );
}
