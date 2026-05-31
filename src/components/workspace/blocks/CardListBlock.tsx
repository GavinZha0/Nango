"use client";

/**
 * CardListBlock — generic "thumbnail + title + url" list (visual
 * primitive, not a search-results component). Two UX invariants:
 *
 *  1. Bounded scroll, no pagination. Compact mode caps height at
 *     400px (matches the chart card) and scrolls internally; large
 *     mode lets the host page own the scroll surface.
 *  2. Broken-image silent drop: `onError` falls back to favicon
 *     → letter-avatar so cards never disappear.
 *
 * See docs/artifact-evolution.md.
 */

import { ExternalLink } from "lucide-react";
import { useState, type ReactElement, type SyntheticEvent } from "react";

import { cn } from "@/lib/utils";
import type { CardListBlock, CardListItem } from "@/store/outcome-store";

import type { BlockSize } from "./BlockList";

interface Props {
  block: CardListBlock;
  size?: BlockSize;
}

export function CardListBlockRenderer({
  block,
  size = "compact",
}: Props): ReactElement {
  const total: number = block.cards.length;
  // Large mode = no internal scroll (host page provides its own).
  // Compact mode = bounded scroll matching the chart card height.
  const isLarge = size === "large";

  if (total === 0) {
    return (
      <p className="px-2 text-xs text-muted-foreground">No results.</p>
    );
  }

  return (
    <div
      className={cn(
        "flex flex-col",
        isLarge ? "gap-3" : "max-h-[400px] gap-2 overflow-y-auto pr-1",
      )}
    >
      {block.cards.map((card, i) => (
        // Fallback display number = list position when the producer
        // didn't set `card.index`. Citation-aware producers
        // (web_search, etc.) always populate `index`; this fallback
        // is only relevant for generic non-citation card_list uses.
        <CardItem
          key={i}
          card={card}
          size={size}
          displayIndex={card.index ?? i + 1}
        />
      ))}
    </div>
  );
}

// One row

function CardItem({
  card,
  size,
  displayIndex,
}: {
  card: CardListItem;
  size: BlockSize;
  /** 1-based number rendered as the `[N]` badge before the title.
   *  Drives the visual cross-reference between `[N]` markers in
   *  agent chat text and the corresponding source card. See
   *  docs/artifact-evolution.md for the citation contract. */
  displayIndex: number;
}): ReactElement {
  // Image fallback chain: image → favicon → letter avatar.
  // Local state lets us swap to fallback on `<img>`'s onError without
  // re-rendering siblings.
  const [imageBroken, setImageBroken] = useState<boolean>(false);
  const [faviconBroken, setFaviconBroken] = useState<boolean>(false);

  const showImage: boolean = !!card.image && !imageBroken;
  const showFavicon: boolean = !showImage && !!card.favicon && !faviconBroken;
  const isLarge = size === "large";

  const Container: "a" | "div" = card.url ? "a" : "div";
  const containerProps =
    card.url
      ? {
          href: card.url,
          target: "_blank" as const,
          rel: "noopener noreferrer" as const,
        }
      : {};

  return (
    <Container
      {...containerProps}
      className={cn(
        // Two-column flex (thumbnail | text), thumbnail anchored to
        // the top via items-start so it lines up with the title row
        // regardless of snippet length. See the file header for the
        // history of the alternate float layout (rejected: BFC rules
        // make line-clamp incompatible with wrap-around-float).
        "group/card flex items-start rounded-lg border border-border bg-card transition-colors",
        isLarge ? "gap-4 p-4" : "gap-3 p-2.5",
        card.url && "cursor-pointer hover:border-border hover:bg-muted/40",
      )}
    >
      {/* Thumbnail column — square; compact 64px / large 96px.
          Size-N wins over flex stretch on Tailwind v4 with an
          explicit dimension. Favicon fallback scales proportionally
          to keep the inset visual ratio. */}
      <div
        className={cn(
          "flex shrink-0 items-center justify-center overflow-hidden rounded-md bg-muted",
          isLarge ? "size-24" : "size-16",
        )}
      >
        {showImage && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={card.image}
            alt={card.title}
            loading="lazy"
            className="size-full object-cover"
            onError={onImgError(setImageBroken)}
          />
        )}
        {showFavicon && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={card.favicon}
            alt=""
            loading="lazy"
            className={cn(
              "object-contain",
              isLarge ? "size-12" : "size-8",
            )}
            onError={onImgError(setFaviconBroken)}
          />
        )}
        {!showImage && !showFavicon && (
          <span
            className={cn(
              "font-medium text-muted-foreground",
              isLarge ? "text-lg" : "text-sm",
            )}
          >
            {card.title.slice(0, 1).toUpperCase()}
          </span>
        )}
      </div>

      {/* `min-w-0` is load-bearing — flex children otherwise refuse to truncate. */}
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex items-center gap-1.5">
          {/* Citation badge `[N]` — paired with the agent's [N]
              markers in chat narration so the user can visually
              cross-reference each claim with its source. Tabular
              numerals keep alignment tidy when N grows past 9. */}
          <span
            className={cn(
              "shrink-0 rounded font-mono font-semibold tabular-nums text-muted-foreground",
              isLarge
                ? "min-w-7 px-1.5 py-0.5 text-xs"
                : "min-w-6 px-1 py-0.5 text-[10px]",
              "bg-muted/60",
            )}
            aria-label={`Source ${displayIndex}`}
          >
            [{displayIndex}]
          </span>
          <span
            className={cn(
              "truncate font-medium leading-tight",
              isLarge ? "text-base" : "text-sm",
            )}
          >
            {card.title}
          </span>
          {card.url && (
            <ExternalLink
              className={cn(
                "shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover/card:opacity-100",
                isLarge ? "size-4" : "size-3",
              )}
              aria-hidden
            />
          )}
        </div>
        {(card.subtitle || card.meta) && (
          <p
            className={cn(
              "truncate text-muted-foreground",
              isLarge ? "text-xs" : "text-[11px]",
            )}
          >
            {card.subtitle}
            {card.subtitle && card.meta && (
              <span className="mx-1 opacity-50">·</span>
            )}
            {card.meta}
          </p>
        )}
        {card.snippet && (
          // Compact: line-clamp-3 caps each card at ~100px so the
          // outcome panel reads as a tidy list.
          // Large: no clamp — the artifact page has room for the
          // full snippet, and the user intentionally drilled in to
          // read all citations.
          <p
            className={cn(
              "leading-relaxed text-muted-foreground",
              isLarge ? "text-sm" : "line-clamp-3 text-xs",
            )}
          >
            {card.snippet}
          </p>
        )}
      </div>
    </Container>
  );
}

/** Curried error handler so each <img> drives its own broken flag.
 *  Returns a fresh function reference per render — fine for a leaf
 *  component, but worth noting if this list ever grows huge enough
 *  that referential stability matters (it won't; topK ≤ 10). */
function onImgError(
  setBroken: (b: boolean) => void,
): (e: SyntheticEvent<HTMLImageElement>) => void {
  return () => setBroken(true);
}
