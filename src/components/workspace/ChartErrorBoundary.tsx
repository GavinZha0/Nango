"use client";

/**
 * ChartErrorBoundary — per-card error containment for the Outcomes panel.
 *
 * `EChartsRenderer` (and other kind-renderers like iframe sandbox)
 * throw synchronously on bad data. Without a boundary one malformed
 * `option` would unmount the entire panel. The boundary scopes the
 * failure to its single card so siblings keep rendering.
 *
 * Reset semantics (see `docs/data-visualization.md` §6.8): the
 * boundary reaches into its own derived state when the parent passes
 * a fresh `resetKey` (= outcomeId here). Re-rendering the same id with
 * a fixed `option` after a failure should naturally recover; passing
 * a different id would also reset (new card identity).
 */

import React, { Component, type ErrorInfo, type ReactNode } from "react";
import { AlertTriangle } from "lucide-react";

interface ChartErrorBoundaryProps {
  /** Identifier whose change triggers a state reset. Pass the
   *  parent outcome's `outcomeId` — re-render with same id (a
   *  successful retry) keeps the boundary's `error` field cleared
   *  on the way through React's reconciliation. */
  resetKey: string;
  children: ReactNode;
}

interface ChartErrorBoundaryState {
  error: Error | null;
}

export class ChartErrorBoundary extends Component<
  ChartErrorBoundaryProps,
  ChartErrorBoundaryState
> {
  public state: ChartErrorBoundaryState = { error: null };

  public static getDerivedStateFromError(error: Error): ChartErrorBoundaryState {
    return { error };
  }

  /**
   * Clear stale errors when the parent rebinds us to a different
   * outcomeId (which usually means "this card is now displaying a
   * brand-new chart, not the failed one"). React calls this AFTER
   * children have started rendering with the new key, so we don't
   * thrash.
   */
  public componentDidUpdate(prev: ChartErrorBoundaryProps): void {
    if (prev.resetKey !== this.props.resetKey && this.state.error !== null) {
      this.setState({ error: null });
    }
  }

  public componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(
      `[ChartErrorBoundary] outcome=${this.props.resetKey} failed:`,
      error,
      info.componentStack,
    );
  }

  public render(): ReactNode {
    const { error } = this.state;
    if (error === null) return this.props.children;
    return (
      <div className="flex h-full min-h-[200px] w-full flex-col items-center justify-center gap-2 rounded-md border border-dashed border-destructive/40 bg-destructive/5 p-4 text-center">
        <AlertTriangle className="h-5 w-5 text-destructive" aria-hidden />
        <p className="text-sm font-medium text-destructive">Chart failed to render</p>
        <p className="max-w-prose truncate text-xs text-muted-foreground" title={error.message}>
          {error.message || "Unknown render error"}
        </p>
      </div>
    );
  }
}
