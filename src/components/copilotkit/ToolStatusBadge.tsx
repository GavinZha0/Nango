"use client";

/**
 * Shared status badge for tool-call cards.
 *
 * Four states, picked by the caller after combining CopilotKit's
 * `status` prop with a parsed result via {@link deriveBadgeStatus}:
 *   - `running` — amber, pulsing dot, "Running" label
 *   - `done`    — emerald, static dot, "Done" label
 *   - `warning` — yellow, static dot, "Warning" label (used by the
 *                 history-replay synthetic-result path; protocol /
 *                 system-layer anomalies, NOT business failures)
 *   - `error`   — red, static dot, "Error" label
 *
 * `running` (amber) and `warning` (yellow) use related but distinct
 * hues; in practice the pulsing dot vs. static dot is the main
 * disambiguator, with the slightly cooler yellow signalling "look at
 * this but it's not running".
 *
 * The visual is intentionally low-key (12 px badge, small rounded
 * pill, no shadow) so it doesn't compete with the surrounding chat
 * text. Per-tool cards that need a stronger visual identity (e.g.
 * the purple supervisor `DelegateToAgentCard`) layer their own
 * accent on the card container and reuse this badge unchanged.
 */

import type { ReactElement } from "react";

import { cn } from "@/lib/utils";
import type { ToolResultStatus } from "@/lib/copilot/detect-tool-result-status";

export type BadgeStatus = "running" | "done" | "warning" | "error";

/**
 * Combine CopilotKit's per-tool-call lifecycle status with the
 * detected result status into a single badge state.
 *
 *   - while the tool is still executing (`inProgress` or `executing`,
 *     for frontend tools), the badge is always `running` regardless
 *     of what the eventual result will say
 *   - on `complete`:
 *       - `failure` → `error`
 *       - `warning` → `warning`
 *       - `success` or `null` → `done`
 *
 * Note: a result with no recognised flag (`null`) maps to `done`, not
 * `error`. The reasoning is that we can't infer failure from
 * absence — many successful tools simply don't carry a flag. This
 * matches the admin event-timeline behaviour in `EventTimeline`.
 */
export function deriveBadgeStatus(
  ckStatus: "inProgress" | "executing" | "complete",
  detected: ToolResultStatus,
): BadgeStatus {
  if (ckStatus !== "complete") return "running";
  if (detected === "failure") return "error";
  if (detected === "warning") return "warning";
  return "done";
}

/** Visual config per badge state. Pure data — no DOM here. */
const BADGE_CONFIG: Record<
  BadgeStatus,
  { label: string; dotClass: string; pillClass: string; pulse: boolean }
> = {
  running: {
    label: "Running",
    dotClass: "bg-amber-500",
    pillClass: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
    pulse: true,
  },
  done: {
    label: "Done",
    dotClass: "bg-emerald-500",
    pillClass: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
    pulse: false,
  },
  warning: {
    label: "Warning",
    dotClass: "bg-yellow-500",
    pillClass: "bg-yellow-500/15 text-yellow-700 dark:text-yellow-300",
    pulse: false,
  },
  error: {
    label: "Error",
    dotClass: "bg-red-500",
    pillClass: "bg-red-500/15 text-red-700 dark:text-red-300",
    pulse: false,
  },
};

export function ToolStatusBadge({
  status,
  className,
}: {
  status: BadgeStatus;
  className?: string;
}): ReactElement {
  const cfg = BADGE_CONFIG[status];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium",
        cfg.pillClass,
        className,
      )}
    >
      <span
        aria-hidden
        className={cn(
          "h-1.5 w-1.5 rounded-full",
          cfg.dotClass,
          cfg.pulse && "animate-pulse",
        )}
      />
      {cfg.label}
    </span>
  );
}
