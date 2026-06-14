"use client";

/**
 * EventTimeline — append-only event log renderer for
 * `/admin/thread/[id]`. Each row is click-to-expand for the JSON
 * payload; tool-call rows additionally carry a success / failure /
 * warning tone from `computeEventTones` (warning includes
 * orphan-chunk detection — chunks whose toolCallId never produced
 * a result).
 */

import { useMemo, useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { useDisplayTimezone } from "@/hooks/useDisplayTimezone";
import { detectToolResultStatus as detectFromResultString } from "@/lib/copilot/detect-tool-result-status";

import { formatTimestamp, JsonBlock } from "./format";

export interface EventRowData {
  runId: string;
  seq: number;
  type: string;
  payload: unknown;
  ts: string;
}

/** Forensic tone overlaid on the type-derived badge colour:
 *  `success` / `failure` are protocol-level signals (MCP `isError`,
 *  supervisor `ok`); `warning` flags structural anomalies (orphan
 *  chunks, replay-synthetic results). `null` keeps the badge
 *  type-only — we deliberately don't keyword-sniff free-form
 *  content. */
type EventTone = "success" | "failure" | "warning" | null;

/** Detect a tool result's status from `payload.content`. Thin wrapper
 *  around the shared detector in `@/lib/copilot/detect-tool-result-status`;
 *  the admin-specific bit is just unwrapping `payload.content`. */
function detectToolResultStatus(payload: unknown): EventTone {
  const p = payload as { content?: unknown } | null;
  if (!p || typeof p.content !== "string") return null;
  return detectFromResultString(p.content);
}

/** Walk the timeline once and tag each row with its tone. Two passes
 *  so the orphan check has full visibility into which `toolCallId`s
 *  eventually saw a result. The result map is keyed by `seq` (unique
 *  within a run). */
export function computeEventTones(
  events: ReadonlyArray<EventRowData>,
): Map<number, EventTone> {
  const tones = new Map<number, EventTone>();
  const resultedToolCallIds = new Set<string>();
  for (const ev of events) {
    if (ev.type !== "tool_call_result") continue;
    const p = ev.payload as { toolCallId?: unknown } | null;
    if (typeof p?.toolCallId === "string") {
      resultedToolCallIds.add(p.toolCallId);
    }
    tones.set(ev.seq, detectToolResultStatus(ev.payload));
  }
  for (const ev of events) {
    if (ev.type !== "tool_call_chunk") continue;
    const p = ev.payload as { toolCallId?: unknown } | null;
    if (
      typeof p?.toolCallId === "string"
      && !resultedToolCallIds.has(p.toolCallId)
    ) {
      tones.set(ev.seq, "warning");
    }
  }
  return tones;
}

export function EventTimeline({
  events,
}: {
  events: ReadonlyArray<EventRowData>;
}): ReactNode {
  const tones = useMemo(() => computeEventTones(events), [events]);
  return (
    <div>
      {events.map((ev) => (
        <EventRow
          key={`${ev.runId}-${ev.seq}`}
          event={ev}
          tone={tones.get(ev.seq) ?? null}
        />
      ))}
    </div>
  );
}

/** One row in the timeline. Heavy events default to collapsed unless
 *  they carry an `error` signal — surfacing failures by default makes
 *  forensics scan faster. */
function EventRow({
  event,
  tone,
}: {
  event: EventRowData;
  tone: EventTone;
}): ReactNode {
  // Every event row is click-to-expand. `started` was previously
  // excluded as "lightweight", but its payload is the raw AG-UI
  // RUN_STARTED event (threadId / runId / timestamp / …) — admins
  // poking at lifecycle issues need to see it.
  // Errors auto-open on first render so failures stand out without
  // an extra click.
  const [open, setOpen] = useState(event.type === "error");
  const tz = useDisplayTimezone();
  const ts = formatTimestamp(event.ts, tz, "timePrecise");

  // One-line summary captures the most identifying field of each
  // event type so the timeline reads as a transcript without forcing
  // the user to expand every row.
  const summary = ((): string => {
    const p = event.payload as Record<string, unknown> | null;
    if (!p) return "";
    // QUIRK: `message` / `reasoning` rows hold the FULL coalesced text
    // for one segment (between tool boundaries / message-id changes);
    // see schema doc on EntityRunEventTable. Truncate the preview but
    // expose the full text on row expand.
    if (event.type === "message" || event.type === "reasoning") {
      const text = String(p.text ?? "");
      return text.length > 120 ? `${text.slice(0, 120)}…` : text;
    }
    if (event.type === "tool_call_chunk") {
      // Show "name args" so the most identifying parts of the call
      // fit on one line. `args` is the coalesced raw JSON string
      // (PersistingAgent flushes at TOOL_CALL_END), shown verbatim and
      // truncated.
      const name = String(p.toolName ?? "");
      const args = String(p.args ?? "");
      const combined = args.length > 0 ? `${name} ${args}` : name;
      return combined.length > 120 ? `${combined.slice(0, 120)}…` : combined;
    }
    if (event.type === "tool_call_result") {
      const c = String(p.content ?? "");
      return c.length > 120 ? `${c.slice(0, 120)}…` : c;
    }
    if (event.type === "finished") {
      const s = String(p.summary ?? "");
      return s.length > 120 ? `${s.slice(0, 120)}…` : s;
    }
    if (event.type === "error") {
      return String(p.message ?? "");
    }
    if (event.type === "degraded") {
      // `<refName ?? ref> — <reason>`. refName falls back to ref so
      // we still show a useful string when the failing entity has
      // already been deleted (refName captured-at-write-time is null).
      // The full err.message is in the expanded payload — keeping the
      // summary line short keeps the timeline scan-friendly.
      const refName = typeof p.refName === "string" ? p.refName : null;
      const ref = typeof p.ref === "string" ? p.ref : "";
      const reason = String(p.reason ?? "");
      const head = `${refName ?? ref} — ${reason}`;
      return head.length > 120 ? `${head.slice(0, 120)}…` : head;
    }
    return "";
  })();

  return (
    <div className="border-t border-border/50 first:border-t-0 px-3 py-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-start gap-2 text-left"
      >
        <span className="w-4 shrink-0 pt-0.5 text-muted-foreground">
          {open ? (
            <ChevronDown className="h-3 w-3" />
          ) : (
            <ChevronRight className="h-3 w-3" />
          )}
        </span>
        <span className="w-12 shrink-0 font-mono text-[10px] text-muted-foreground">
          #{event.seq}
        </span>
        <span className="w-20 shrink-0 font-mono text-[10px] text-muted-foreground">
          {ts}
        </span>
        <Badge
          variant="outline"
          className={cn(
            "h-5 shrink-0 font-mono text-[10px]",
            // Type-derived tones for the rows that carry real
            // diagnostic weight. `finished` is intentionally NOT
            // tinted — it's just the run-completed marker, and the
            // page header + run-card status badge already convey
            // run success at-a-glance. Tool-call rows are coloured
            // below from `tone`, which is computed once for the
            // whole timeline by `computeEventTones`.
            event.type === "error"
              && "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300",
            event.type === "degraded"
              && "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
            tone === "success"
              && "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
            tone === "failure"
              && "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300",
            tone === "warning"
              && "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
          )}
        >
          {event.type}
        </Badge>
        <span className="min-w-0 flex-1 truncate text-xs text-foreground">
          {summary}
        </span>
      </button>
      {open && (
        <div className="mt-2 pl-[5.25rem]">
          <JsonBlock value={event.payload} />
        </div>
      )}
    </div>
  );
}
