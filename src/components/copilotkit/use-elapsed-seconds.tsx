"use client";

/**
 * Shared elapsed-time hook for tool-call cards.
 *
 * Extracted from `DelegateToAgentCard` so the wildcard renderer and
 * any future per-tool card can show a consistent "started X ago"
 * indicator that:
 *
 *   - survives the unmount/remount CopilotKit does on
 *     `inProgress → executing → complete` status transitions
 *   - survives re-renders triggered by streaming text narration
 *   - freezes on completion (does not include narration time after
 *     the tool actually returned)
 *
 * The timing cache lives at module scope, keyed by `toolCallId`. Two
 * cards mounted for the same `toolCallId` (theoretically possible if
 * we ever render the same tool in two surfaces) read the same
 * `startedAt`, so the displayed timer agrees.
 */

import { useEffect, useState } from "react";

/** One entry per `toolCallId`. `completedAt` set once on the first
 *  render after `running` flips to false; never reset. */
interface TimingEntry {
  startedAt: number;
  completedAt?: number;
}

const timingByToolCall = new Map<string, TimingEntry>();

function getOrInitTiming(toolCallId: string): TimingEntry {
  const existing = timingByToolCall.get(toolCallId);
  if (existing) return existing;
  const fresh: TimingEntry = { startedAt: Date.now() };
  timingByToolCall.set(toolCallId, fresh);
  return fresh;
}

function markCompleted(toolCallId: string): number {
  const entry = getOrInitTiming(toolCallId);
  if (entry.completedAt === undefined) entry.completedAt = Date.now();
  return entry.completedAt;
}

/**
 * Format elapsed milliseconds as a short human-readable string.
 *
 * Examples:
 *   - 0 → "0s"
 *   - 3000 → "3s"
 *   - 72000 → "1m 12s"
 *   - 60000 → "1m"     (whole minute, omit seconds)
 *   - 3600000 → "60m"  (we intentionally don't go to hours — chat
 *     turns that long indicate a different problem)
 */
function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return s === 0 ? `${m}m` : `${m}m ${s}s`;
}

/**
 * Track elapsed seconds for a tool call.
 *
 * @param toolCallId Stable identifier (`toolCall.id`); used as the
 *                   cache key so unmounts and re-renders don't reset
 *                   the counter.
 * @param running    Whether the tool is still executing. When `false`,
 *                   the elapsed value freezes (the interval stops AND
 *                   the completion timestamp is captured).
 * @returns          Pre-formatted string ready for direct rendering,
 *                   e.g. `"3s"` or `"1m 12s"`.
 */
export function useElapsedSeconds(
  toolCallId: string,
  running: boolean,
): string {
  const timing = getOrInitTiming(toolCallId);
  const { startedAt } = timing;

  // Capture completion timestamp on the first render after `running`
  // flips to false. `useEffect` keeps the render itself pure; the
  // lazy-initialised state below reads any previously persisted
  // completion timestamp on remount.
  useEffect(() => {
    if (!running) markCompleted(toolCallId);
  }, [running, toolCallId]);

  const [seconds, setSeconds] = useState<number>(() => {
    const end = timing.completedAt ?? Date.now();
    return Math.max(0, Math.floor((end - startedAt) / 1000));
  });

  useEffect(() => {
    // Only tick while running — once `completedAt` is set, the value
    // is frozen and no further interval is needed.
    if (!running) return;
    const interval = setInterval(() => {
      setSeconds(Math.max(0, Math.floor((Date.now() - startedAt) / 1000)));
    }, 1000);
    return () => clearInterval(interval);
  }, [running, startedAt]);

  return formatElapsed(seconds);
}
