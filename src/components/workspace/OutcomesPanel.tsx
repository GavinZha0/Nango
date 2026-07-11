"use client";

/**
 * OutcomesPanel — body of `/outcomes`. Renders `<OutcomeCard>` per
 * outcome with grid / enlarged layouts. Cold-path hydrate fetches
 * the current thread's outcomes on mount; the WorkspaceProvider
 * subscriber handles live thread switches. Enlarge state is
 * component-local and deliberately NOT URL-persisted — outcomes
 * are ephemeral. See docs/data-visualization.md.
 */

import { useEffect, useState, type ReactNode } from "react";
import { Sprout, RotateCcw } from "lucide-react";

import { useWorkspaceStore } from "@/store/workspace";
import { useOutcomeStore } from "@/store/outcome-store";

import { OutcomeCard } from "./OutcomeCard";

export function OutcomesPanel(): ReactNode {
  const outcomes = useOutcomeStore((s) => s.outcomes);
  const status = useOutcomeStore((s) => s.status);
  const loadForThread = useOutcomeStore((s) => s.loadForThread);
  // runtimeThreadId = the live conversation's id; outcomes are
  // attribution-bound to this. See docs/chat-flow-audit.md.
  const threadId = useWorkspaceStore((s) => s.runtimeThreadId);

  // Enlarge state — `null` = grid. Dangling ids are harmless because
  // `outcomes.find()` falls through to grid view; we don't proactively
  // reset (React 19 flags `set-state-in-effect`).
  const [enlargedId, setEnlargedId] = useState<string | null>(null);

  // Cold-path hydrate (refresh on /outcomes). Mount-only on threadId
  // — runtime thread switches go through the workspace subscriber.
  useEffect(() => {
    if (!threadId) return;
    if ((status === "idle" || status === "error") && outcomes.length === 0) {
      void loadForThread(threadId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId]);

  if (status === "loading") return <PanelSkeleton />;
  if (status === "error") return <PanelError onRetry={() => threadId && loadForThread(threadId)} />;
  if (outcomes.length === 0) return <PanelEmpty />;

  const enlargedOutcome = enlargedId
    ? outcomes.find((o) => o.outcomeId === enlargedId) ?? null
    : null;

  // Enlarged mode: 160px filmstrip + enlarged card. Same OutcomeCard
  // reused with `viewState="thumbnail"` / `"enlarged"`.
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
        <div className="flex-grow flex flex-col p-4 h-full overflow-hidden">
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
        <Sprout className="h-6 w-6 text-primary" />
      </div>
      <p className="text-sm font-medium">No outcomes in this conversation yet</p>
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
