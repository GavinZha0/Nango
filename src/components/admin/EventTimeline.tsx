"use client";

/**
 * EventTimeline — append-only event log renderer.
 *
 * Every event row is click-to-expand to reveal its structured JSON
 * payload — that includes lifecycle rows (`started`) so the admin
 * can verify the upstream AG-UI event shape we persisted. Some
 * rows additionally have a one-line summary in the title row
 * (assistant text preview, tool name, etc.).
 *
 * Tool-call rows pick up an additional success/failure/warning tone
 * computed once for the whole timeline by `computeEventTones`:
 *   - `tool_call_result` rows are classified by the embedded
 *     `payload.content` string (see {@link detectToolResultStatus}).
 *   - `tool_call_chunk` rows whose `toolCallId` never produced a
 *     matching result get tagged "warning" — flags upstream tools
 *     that were invoked but never returned (timeout, agent died,
 *     backend skipped).
 *
 * Rendered inside the `/admin/thread/[id]` right column.
 */

import { useMemo, useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { detectToolResultStatus as detectFromResultString } from "@/lib/copilot/detect-tool-result-status";

import { JsonBlock } from "./format";

export interface EventRowData {
  runId: string;
  seq: number;
  type: string;
  payload: unknown;
  ts: string;
}

/** Forensic tone overlaid on top of the type-derived badge colour.
 *  - `success` / `failure`: the row carries a protocol-level
 *    success/failure signal (MCP `isError`, supervisor `ok`).
 *  - `warning`: a structural anomaly — currently used to flag
 *    `tool_call_chunk` rows whose `toolCallId` never produced a
 *    matching `tool_call_result` (the upstream tool was invoked
 *    but never produced output: timeout, agent died, or backend
 *    explicitly skipped the result).
 *  Returning `null` keeps the badge type-only — we deliberately do
 *  NOT keyword-sniff "error" / "exception" out of free-form
 *  content; that's a misreport waiting to happen. */
type EventTone = "success" | "failure" | "warning" | null;

/** Detect the success/failure/warning protocol field embedded in a
 *  `tool_call_result.payload.content` string.
 *
 *  Thin wrapper around the shared detector in
 *  `@/lib/copilot/detect-tool-result-status` — the only admin-specific
 *  bit is unwrapping `payload.content` (event rows carry the result
 *  as a string nested inside the payload object). The string-parsing
 *  + flag-recognition itself is identical to what the chat tool-call
 *  cards use, so admin and chat surfaces agree on classification.
 *
 *  `warning` is now also a possible classification for a
 *  `tool_call_result` row: history-replay synthetic results
 *  (`event-reconstruction.ts`) tag themselves with
 *  `{ isError: true, severity: "warning" }`. The existing orphan-chunk
 *  branch below still tags rows whose chunk never saw a result; both
 *  paths flow into the same `EventTone` "warning" bucket. */
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
  const ts = new Date(event.ts).toLocaleTimeString();

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
