"use client";

/**
 * OutcomesPanel — the body of `/outcomes`.
 *
 * (Renamed from `ArtifactPanel` for clarity — this component is the
 *  outcomes-page card list, not the artifact library. The artifact
 *  library lives at `src/components/left-panels/ArtifactPanel.tsx`
 *  and is unrelated.)
 *
 * Subscribes to `outcomeStore` and renders one `<OutcomeCard>` per
 * outcome. Distinct states (see `docs/data-visualization.md` §6.8):
 *
 *  - `loading`: replay in flight → skeleton list
 *  - `error`  : replay failed → small notice + retry button
 *  - `ready` + empty → "no outcomes yet" placeholder
 *  - `ready` + N    → responsive card grid (default) or enlarged
 *                     view when the user clicks the ⤢ button on a card
 *  - `idle`         : no thread selected yet → empty placeholder
 *
 * Enlarge / minimize (V1, per `docs/artifact-evolution.md` §6 —
 * slimmed): the user clicks ⤢ on any preview card → that card fills
 * the right side and the others collapse to a 160 px filmstrip on
 * the left. Click any filmstrip thumbnail to enlarge a different
 * outcome; click ⤡ (Minimize2) on the enlarged card to return to
 * the grid. State is component-local (`useState`) and deliberately
 * NOT persisted to the URL: outcomes are an ephemeral chat record,
 * so refresh / navigate-away resets to grid view. No keyboard
 * shortcuts — minimize is the visible button, swap is a filmstrip
 * click. The icon set (Maximize2 / Minimize2 from lucide) was
 * chosen over an `X` deliberately: an `X` reads as "delete" or
 * "close window" in user testing.
 *
 * On first mount the panel triggers `loadForThread` for the current
 * `workspaceStore.runtimeThreadId` if (a) the user has one and (b) the
 * store hasn't already loaded it. The subscriber in
 * `WorkspaceProvider` handles thread-switches at runtime; this
 * mount-time hydrate covers the cold path (refresh on `/outcomes`).
 */

import { useEffect, useState, type ReactNode } from "react";
import { LayoutDashboard, RotateCcw } from "lucide-react";

import { useWorkspaceStore } from "@/store/workspace";
import { useOutcomeStore } from "@/store/outcome-store";

import { OutcomeCard } from "./OutcomeCard";

export function OutcomesPanel(): ReactNode {
  const outcomes = useOutcomeStore((s) => s.outcomes);
  const status = useOutcomeStore((s) => s.status);
  const loadForThread = useOutcomeStore((s) => s.loadForThread);
  // runtimeThreadId = the live conversation's id; outcomes are
  // attribution-bound to this. @see docs/chat-flow-audit.md §1.11
  const threadId = useWorkspaceStore((s) => s.runtimeThreadId);

  // Enlarge-mode state. `null` = default grid; otherwise the
  // `outcomeId` of the card that fills the right side. A dangling
  // ID (enlarged card was removed, or thread switched) is harmless:
  // the `outcomes.find()` below returns null and we fall through to
  // the grid view; the next setEnlargedId() overwrites the stale
  // value. We deliberately do NOT proactively reset in an effect
  // (React 19's `react-hooks/set-state-in-effect` flags that pattern).
  const [enlargedId, setEnlargedId] = useState<string | null>(null);

  // Cold-path hydrate: page refresh on `/outcomes` lands here with an
  // empty Zustand store. Pull the current thread's outcomes from the
  // replay endpoint.
  //
  // Retry condition includes `"error"` so a user who first lands
  // during a failed fetch can recover by navigating away and back
  // (without `"error"` the stale error UI persists until they click
  // Retry manually). `"loading"` is excluded so concurrent mounts
  // don't fan out duplicate fetches.
  useEffect(() => {
    if (!threadId) return;
    if ((status === "idle" || status === "error") && outcomes.length === 0) {
      void loadForThread(threadId);
    }
    // `status` and `outcomes.length` intentionally NOT in deps — we
    // only want to fire on mount-with-threadId; subsequent thread
    // changes are driven by the workspace subscriber, and live
    // status changes (idle → loading → ready) are not retry
    // triggers.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId]);

  if (status === "loading") return <PanelSkeleton />;
  if (status === "error") return <PanelError onRetry={() => threadId && loadForThread(threadId)} />;
  if (outcomes.length === 0) return <PanelEmpty />;

  const enlargedOutcome = enlargedId
    ? outcomes.find((o) => o.outcomeId === enlargedId) ?? null
    : null;

  // Enlarged mode: 160 px filmstrip on the left, enlarged card on
  // the right. The filmstrip uses the SAME OutcomeCard component
  // with viewState="thumbnail" — title (up to 2 lines) + optional
  // description, no buttons, click-to-enlarge. The right side uses
  // viewState="enlarged" — full content via BlockList(size="large"),
  // Save/Remove buttons, and a Minimize2 (⤡) button.
  if (enlargedOutcome) {
    return (
      <div className="flex h-full w-full">
        <div className="flex w-[160px] shrink-0 flex-col gap-2 overflow-y-auto border-r p-2">
          {outcomes.map((o) => (
            <OutcomeCard
              key={o.outcomeId}
              outcome={o}
              viewState="thumbnail"
              isCurrent={o.outcomeId === enlargedId}
              onSelect={() => setEnlargedId(o.outcomeId)}
            />
          ))}
        </div>
        <div className="flex-1 overflow-y-auto p-4">
          <OutcomeCard
            outcome={enlargedOutcome}
            viewState="enlarged"
            onMinimize={() => setEnlargedId(null)}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto">
      {/* `items-start` opts out of CSS Grid's default stretch behaviour
          so cards take their content height instead of being stretched
          to the tallest row sibling. Mixed-content rows (a 400px chart
          next to a content-sized card_list) would otherwise leave
          large blank spaces inside whichever card was shorter. */}
      <div className="grid grid-cols-1 items-start gap-4 p-4 xl:grid-cols-2">
        {outcomes.map((o) => (
          <OutcomeCard
            key={o.outcomeId}
            outcome={o}
            viewState="preview"
            onEnlarge={() => setEnlargedId(o.outcomeId)}
          />
        ))}
      </div>
    </div>
  );
}

// loading / empty / error states

function PanelSkeleton(): ReactNode {
  return (
    <div className="grid grid-cols-1 gap-4 p-4 xl:grid-cols-2">
      {[0, 1, 2, 3].map((i) => (
        <div
          key={i}
          className="h-[400px] animate-pulse rounded-xl bg-muted/40"
          aria-hidden
        />
      ))}
    </div>
  );
}

function PanelEmpty(): ReactNode {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center text-muted-foreground">
      <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-primary/10">
        <LayoutDashboard className="h-6 w-6 text-primary" />
      </div>
      <p className="text-sm font-medium">No outcomes in this conversation yet</p>
      <p className="max-w-prose text-xs">
        Ask your agent to chart data from one of your data sources — the chart
        will appear here as a card you can collapse, save, or remove.
      </p>
    </div>
  );
}

function PanelError({ onRetry }: { onRetry: () => void }): ReactNode {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
      <p className="text-sm font-medium text-destructive">Failed to load outcomes</p>
      <button
        type="button"
        onClick={onRetry}
        className="inline-flex items-center gap-1.5 rounded-md border bg-card px-3 py-1.5 text-xs font-medium hover:bg-muted"
      >
        <RotateCcw className="h-3.5 w-3.5" />
        Retry
      </button>
    </div>
  );
}
