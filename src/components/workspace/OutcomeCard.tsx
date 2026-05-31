"use client";

/**
 * OutcomeCard — one card per Outcome on `/outcomes`. Renders in
 * three view states (`preview` / `thumbnail` / `enlarged`); the
 * parent `OutcomesPanel` picks which by choosing the layout.
 * Height is content-sized — each block renderer owns its own
 * height contract. See docs/data-visualization.md and
 * docs/artifact-evolution.md.
 */

import {
  ChevronDown,
  ChevronRight,
  Save,
  Check,
  Trash2,
  Maximize2,
  Minimize2,
} from "lucide-react";
import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";

import { SaveOutcomeDialog } from "@/components/library/SaveOutcomeDialog";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { useOutcomeStore, type Outcome } from "@/store/outcome-store";

import { BlockList } from "./blocks/BlockList";
import { ChartErrorBoundary } from "./ChartErrorBoundary";

export type OutcomeCardViewState = "preview" | "thumbnail" | "enlarged";

interface OutcomeCardProps {
  outcome: Outcome;
  /** Default `"preview"` keeps existing call sites (chat preview, tests)
   *  working without a prop. The enlarged / thumbnail states are only
   *  used by `OutcomesPanel`. */
  viewState?: OutcomeCardViewState;
  /** preview → enlarged. Wired by `OutcomesPanel` when in grid mode. */
  onEnlarge?: () => void;
  /** enlarged → preview (grid). Wired when this card is the enlarged one. */
  onMinimize?: () => void;
  /** thumbnail → enlarged-on-self. Wired when this card is in the filmstrip. */
  onSelect?: () => void;
  /** Outline highlight on the filmstrip thumbnail that represents the
   *  currently-enlarged card. */
  isCurrent?: boolean;
}

export function OutcomeCard({
  outcome,
  viewState = "preview",
  onEnlarge,
  onMinimize,
  onSelect,
  isCurrent = false,
}: OutcomeCardProps): ReactNode {
  const toggleCollapse = useOutcomeStore((s) => s.toggleCollapse);
  const removeOutcome = useOutcomeStore((s) => s.removeOutcome);
  const selectedId = useOutcomeStore((s) => s.selectedId);
  const [saveDialogOpen, setSaveDialogOpen] = useState<boolean>(false);

  const isThumbnail = viewState === "thumbnail";
  const isEnlarged = viewState === "enlarged";
  // Collapse only applies in the grid (preview) state — in enlarged
  // mode the user is here to consume content, and thumbnails are
  // header-only by construction.
  const expanded: boolean = isEnlarged ? true : !outcome.collapsed;
  const isSaved: boolean = outcome.savedArtifactId !== null;
  const isSelected: boolean = selectedId === outcome.outcomeId;

  // Scroll this card into view when the user clicks "View in Outcomes"
  // on the inline chat preview. We only fire on the false → true
  // transition (tracked via ref) so subsequent re-renders while the
  // card is still selected do NOT re-trigger scrolling — the user
  // may have scrolled away deliberately.
  const cardRef = useRef<HTMLDivElement>(null);
  const wasSelectedRef = useRef<boolean>(false);
  useEffect(() => {
    if (isSelected && !wasSelectedRef.current) {
      cardRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
    wasSelectedRef.current = isSelected;
  }, [isSelected]);

  // ── Thumbnail: title-only, whole card is a click target ─────────
  // Title is allowed to wrap up to 2 lines — at 160 px wide a
  // single-line truncate cuts most outcome titles after 4-5 words,
  // which loses too much information when the only purpose of the
  // thumbnail is to identify the outcome. Description stays single-
  // line truncated as a secondary cue.
  if (isThumbnail) {
    return (
      <button
        type="button"
        onClick={onSelect}
        className={cn(
          "group flex w-full flex-col items-stretch overflow-hidden rounded-md border bg-card px-2 py-1.5 text-left transition-colors",
          "hover:bg-muted/40",
          isCurrent && "ring-2 ring-primary",
        )}
        aria-label={`Enlarge outcome: ${outcome.title}`}
        aria-current={isCurrent ? "true" : undefined}
      >
        <span className="line-clamp-2 text-xs font-medium leading-snug">
          {outcome.title}
        </span>
        {outcome.description && (
          <span className="truncate text-[10px] text-muted-foreground">
            {outcome.description}
          </span>
        )}
      </button>
    );
  }

  // ── Preview / Enlarged: full card with header + body ────────────

  // Stop the action-button clicks from bubbling into the
  // CollapsibleTrigger row (which would toggle collapse on every
  // button press).
  const stop = (e: MouseEvent): void => e.stopPropagation();

  return (
    <Collapsible
      open={expanded}
      onOpenChange={() => {
        if (isEnlarged) return; // collapse is disabled in enlarged mode
        toggleCollapse(outcome.outcomeId);
      }}
    >
      <Card
        ref={cardRef}
        className={cn(
          "overflow-hidden transition-shadow",
          // Selected = the user just clicked "View in Outcomes" on this
          // card's preview. Ring fades out naturally once the user
          // clicks another preview (selectedId changes).
          isSelected && "ring-2 ring-primary",
        )}
      >
        <CardHeader className="flex flex-row items-start gap-2 px-3 py-2">
          <CollapsibleTrigger
            // The trigger renders as its own `<button>` (no `asChild`).
            // Children are a chevron `<svg>` plus a `<div>` with the
            // title/description — no nested interactive elements, so
            // we don't need `asChild` to forward semantics to a child.
            disabled={isEnlarged}
            className="flex flex-1 items-start gap-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm min-w-0 disabled:cursor-default"
            aria-label={
              isEnlarged
                ? outcome.title
                : expanded
                  ? "Collapse outcome"
                  : "Expand outcome"
            }
          >
            {/* Chevron hidden in enlarged mode — no collapse there. */}
            {!isEnlarged &&
              (expanded ? (
                <ChevronDown
                  className="h-4 w-4 shrink-0 text-muted-foreground mt-1"
                  aria-hidden
                />
              ) : (
                <ChevronRight
                  className="h-4 w-4 shrink-0 text-muted-foreground mt-1"
                  aria-hidden
                />
              ))}
            <div className="min-w-0 flex-1">
              <CardTitle className="truncate text-sm font-medium leading-7">
                {outcome.title}
              </CardTitle>
              {outcome.description && (
                <CardDescription className="text-xs break-words whitespace-normal">
                  {outcome.description}
                </CardDescription>
              )}
            </div>
          </CollapsibleTrigger>

          {/* Enlarge / Minimize button. Mutually exclusive: preview
              shows ⤢ (Maximize2), enlarged shows ⤡ (Minimize2). The
              icon shape mirrors the action, so the affordance is
              self-evident — an X here would read as "delete" or
              "close window" and was confusing in user testing.
              Thumbnails don't reach this branch. */}
          {isEnlarged ? (
            <button
              type="button"
              onClick={(e) => {
                stop(e);
                onMinimize?.();
              }}
              className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
              title="Minimize"
              aria-label="Minimize outcome"
            >
              <Minimize2 className="h-4 w-4" />
            </button>
          ) : (
            <button
              type="button"
              onClick={(e) => {
                stop(e);
                onEnlarge?.();
              }}
              className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
              title="Enlarge"
              aria-label="Enlarge outcome"
            >
              <Maximize2 className="h-4 w-4" />
            </button>
          )}

          {/* Save state — ✓ if already saved (idempotent in store and on
              server); otherwise active Save button. The button disables
              itself during the round-trip so rapid clicks can't fire a
              second request. */}
          {isSaved ? (
            <span
              className="inline-flex h-7 w-7 items-center justify-center text-green-600"
              title="Saved to Artifact library"
              aria-label="Saved"
            >
              <Check className="h-4 w-4" />
            </span>
          ) : (
            <button
              type="button"
              onClick={(e) => {
                stop(e);
                setSaveDialogOpen(true);
              }}
              className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
              title="Save to Artifact library"
              aria-label="Save to library"
            >
              <Save className="h-4 w-4" />
            </button>
          )}

          {/* Remove — V1 substitute for the future remove_chart tool. */}
          <button
            type="button"
            onClick={(e) => {
              stop(e);
              removeOutcome(outcome.outcomeId);
            }}
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-destructive"
            title="Remove from panel"
            aria-label="Remove outcome"
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </CardHeader>

        <CollapsibleContent>
          <CardContent className="px-3 pb-3 pt-0">
            {/* Body is content-sized — each block owns its own height
                contract. The error boundary catches throws from any
                block renderer (e.g. ECharts mis-configuration) and
                shows a clean placeholder instead of nuking the card.
                `size="large"` in enlarged mode unlocks per-block
                generous-size rendering (taller charts, more list
                rows visible at once). */}
            <ChartErrorBoundary resetKey={outcome.outcomeId}>
              <BlockList
                blocks={outcome.blocks}
                size={isEnlarged ? "large" : "compact"}
              />
            </ChartErrorBoundary>
          </CardContent>
        </CollapsibleContent>
      </Card>
      <SaveOutcomeDialog
        open={saveDialogOpen}
        onOpenChange={setSaveDialogOpen}
        outcome={outcome}
      />
    </Collapsible>
  );
}
