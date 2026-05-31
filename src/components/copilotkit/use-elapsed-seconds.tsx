"use client";

/**
 * Shared elapsed-time hook for tool-call cards. The timing cache
 * is module-scope keyed by `toolCallId`, so the displayed timer
 * survives CopilotKit's mount churn on status transitions and
 * freezes on completion (post-tool narration doesn't count).
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

/** Format elapsed seconds as `Ns` / `Nm Ss` / `Nm`. No hours unit —
 *  chat turns long enough to need one are a different problem. */
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
