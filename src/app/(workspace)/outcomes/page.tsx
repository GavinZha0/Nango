"use client";

/**
 * /outcomes — main-panel route for the transient Outcomes panel.
 *
 * See `docs/data-visualization.md` This page is intentionally
 * trivial: it lazy-loads `OutcomesPanel`, which subscribes to
 * `outcomeStore` and renders the card list (grid or focus view).
 * The bulk of the bundle (echarts core, ~350 KB gzipped) only loads
 * when the user actually navigates here.
 *
 * NOT to be confused with `/artifact` — that route is reserved for
 * the future V2 Artifact library (CRUD over the `artifact` DB
 * table). `/outcomes` is thread-scoped, ephemeral, in-memory; it
 * back-fills from `entity_run_event` history on thread switch.
 */

import dynamic from "next/dynamic";
import type { ReactNode } from "react";

const OutcomesPanel = dynamic(
  () =>
    import("@/components/workspace/OutcomesPanel").then((m) => m.OutcomesPanel),
  {
    ssr: false,
    loading: () => (
      <div className="grid grid-cols-1 gap-4 p-4 xl:grid-cols-2">
        {[0, 1].map((i) => (
          <div
            key={i}
            className="h-[400px] animate-pulse rounded-xl bg-muted/40"
            aria-hidden
          />
        ))}
      </div>
    ),
  },
);

export default function OutcomesPage(): ReactNode {
  return (
    <div className="h-full w-full">
      <OutcomesPanel />
    </div>
  );
}
