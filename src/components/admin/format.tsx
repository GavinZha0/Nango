"use client";

/**
 * Tiny presentation helpers shared across the admin run/thread surfaces.
 *
 * Kept dependency-light (only React) so they can live in either client
 * or server components — same trade-off as `src/lib/utils.ts`.
 */

import type { ReactNode } from "react";

/**
 * Unified timestamp formatter for all user-facing time display.
 *
 * Fixed locale `en-US`, no year.
 *
 *   style "datetime"         → "6/13, 10:51 AM"
 *   style "time"             → "10:51 AM"
 *   style "datetimePrecise"  → "6/13, 10:51:03 AM"
 *   style "timePrecise"      → "10:51:03 AM"
 *
 * Pass the value from `useDisplayTimezone()` as `timeZone` to honour
 * the user's profile timezone. Returns "—" for null / unparseable. */
export type TimestampStyle = "datetime" | "time" | "datetimePrecise" | "timePrecise";

export function formatTimestamp(
  iso: string | Date | null | undefined,
  timeZone?: string,
  style: TimestampStyle = "datetime",
): string {
  if (!iso) return "—";
  const d = typeof iso === "string" ? new Date(iso) : iso;
  if (Number.isNaN(d.getTime())) return "—";

  const opts: Intl.DateTimeFormatOptions = {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    ...(timeZone ? { timeZone } : {}),
  };
  if (style === "datetime" || style === "datetimePrecise") {
    opts.month = "numeric";
    opts.day = "numeric";
  }
  if (style === "datetimePrecise" || style === "timePrecise") {
    opts.second = "2-digit";
  }
  return new Intl.DateTimeFormat("en-US", opts).format(d);
}

/** Format a millisecond count as a compact human duration.
 *
 *  - `ms < 1000`        → `123ms`
 *  - `ms < 60_000`      → `1.2s`
 *  - `ms < 3_600_000`   → `5m 12s`
 *  - otherwise          → `2h 14m`
 *
 *  Returns "—" for `null` / `undefined` / negative / non-finite input.
 *  This is the canonical formatter for any pre-computed ms value
 *  (cumulative compute, TTFT, tool-call durations). */
export function formatDurationMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) {
    return "—";
  }
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3_600_000) {
    const m = Math.floor(ms / 60_000);
    const s = Math.floor((ms % 60_000) / 1000);
    return `${m}m ${s}s`;
  }
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return `${h}h ${m}m`;
}

/** Format a `(start, end)` pair as a compact human duration.
 *
 *  Thin wrapper around {@link formatDurationMs} that handles the
 *  string/Date inputs and the "still running" case. Null / unparseable
 *  / inverted ranges render as "—". A still-running row (`end === null`)
 *  is treated as "running now" — we use `Date.now()` as the upper
 *  bound so the cell shows live elapsed time on the next render. */
export function formatDuration(
  start: string | Date | null | undefined,
  end: string | Date | null | undefined,
): string {
  if (!start) return "—";
  const a = (typeof start === "string" ? new Date(start) : start).getTime();
  const b = end
    ? (typeof end === "string" ? new Date(end) : end).getTime()
    : Date.now();
  if (Number.isNaN(a) || Number.isNaN(b) || b < a) return "—";
  return formatDurationMs(b - a);
}

/** Render any value as a monospace, wrap-friendly JSON block. Strings
 *  pass through as-is (so they're not double-quoted); objects pretty-
 *  print with 2-space indent. */
export function JsonBlock({ value }: { value: unknown }): ReactNode {
  if (value === null || value === undefined) {
    return <span className="text-muted-foreground italic">—</span>;
  }
  return (
    <pre className="max-h-[60vh] overflow-auto whitespace-pre-wrap break-words rounded border bg-background px-2 py-1.5 font-mono text-[11px] leading-relaxed">
      {typeof value === "string" ? value : JSON.stringify(value, null, 2)}
    </pre>
  );
}
