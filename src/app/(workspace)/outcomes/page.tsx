"use client";

/**
 * /outcomes — main-panel route for the transient, thread-scoped Outcomes panel.
 * Persisted artifacts live under `/artifact`.
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
