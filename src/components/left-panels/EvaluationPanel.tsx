"use client";

/**
 * EvaluationPanel — left-sidebar shell for the (forthcoming)
 * evaluation feature.
 *
 * This is intentionally a UI-only stub:
 *   - Header mirrors `AgentPanel`'s Builtin / External tab strip so the
 *     two panels feel consistent (same tab style, same border, same
 *     active-tab underline / count badge).
 *   - Both tab bodies render an empty-state placeholder. No data
 *     fetching, no store, no actions \u2014 we're just unblocking the
 *     `/evaluation` route so the toolbar entry navigates somewhere
 *     instead of 404-ing.
 *
 * Persistence:
 *   - Active tab is held in plain local state (not localStorage) for
 *     now \u2014 there's nothing meaningful to switch between yet, and a
 *     stored value would make the cleanup step harder once real
 *     content lands. Swap to `useStoredValue` (see AgentPanel) when
 *     the lists actually carry items worth remembering.
 */

import { useState, type ReactNode } from "react";

import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";

/** Two-tab split mirroring `AgentPanel`. Reserved names so the
 *  eventual implementation can drop straight in without renaming. */
type EvaluationPanelTab = "builtin" | "external";

interface TabButtonProps {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
}

/** Copy of `AgentPanel.TabButton` \u2014 kept inline so this stub has zero
 *  cross-panel dependencies. If a third panel ever needs the same
 *  treatment, lift this into `components/ui/`. */
function TabButton({ label, count, active, onClick }: TabButtonProps): ReactNode {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex cursor-pointer items-center gap-1.5 px-3 py-1.5 text-sm font-medium border-b-2 transition-colors",
        active
          ? "border-primary text-foreground"
          : "border-transparent text-muted-foreground hover:text-foreground",
      )}
      aria-pressed={active}
    >
      {label}
      <span
        className={cn(
          "rounded-full px-1.5 py-0.5 text-[10px] leading-none",
          active
            ? "bg-primary/20 text-foreground"
            : "bg-muted text-muted-foreground",
        )}
      >
        {count}
      </span>
    </button>
  );
}

export function EvaluationPanel(): ReactNode {
  const [activeTab, setActiveTab] = useState<EvaluationPanelTab>("builtin");

  // Counts are 0 in the stub; surfaced so the badge layout is correct
  // and the future wiring is a one-line change per tab.
  const builtinCount: number = 0;
  const externalCount: number = 0;

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-stretch border-b bg-muted/40 pr-1.5">
        <TabButton
          label="Builtin"
          count={builtinCount}
          active={activeTab === "builtin"}
          onClick={() => setActiveTab("builtin")}
        />
        <TabButton
          label="External"
          count={externalCount}
          active={activeTab === "external"}
          onClick={() => setActiveTab("external")}
        />
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="px-4 py-3 text-xs text-muted-foreground">
          {activeTab === "builtin"
            ? "No built-in evaluations yet."
            : "No external evaluations yet."}
        </div>
      </ScrollArea>
    </div>
  );
}
