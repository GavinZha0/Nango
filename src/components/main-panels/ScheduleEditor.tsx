"use client";

/**
 * ScheduleEditor — full-area form for creating / editing one schedule.
 */

import {
  startTransition,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { ArrowLeft, Loader2, Save, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { cn } from "@/lib/utils";
import {
  RecentRuns,
  RecentRunsPlaceholder,
} from "@/components/main-panels/RecentRuns";
import { useWorkspaceStore } from "@/store/workspace";
import {
  scheduleActions,
  type ScheduleIntervalUnit,
  type ScheduleResponse,
} from "@/store/schedules";
import {
  computeDisplayName,
  computeSourceLabel,
} from "@/lib/orchestration/display-name";
import type { EntityKind } from "@/lib/backends/types";

// Agent option helpers

interface AgentOption {
  /** Sent to /api/schedules. */
  entityId: string;
  credentialId?: string;
  /** Snapshotted on the schedule row so the scheduler can fire
   *  without round-tripping to entity-catalog. */
  entityKind: EntityKind;
  /** Stored on the schedule for display ("Backend / Foo"). */
  sourceLabel: string;
  /** Shown in the dropdown ("Backend / Foo"). */
  displayName: string;
}

/** Stable identity for the dropdown — `entityId` alone collides
 *  across credentials (Dify reuses "default", agno can reuse names). */
function agentKeyOf(o: AgentOption): string {
  return `${o.credentialId ?? "builtin"}:${o.entityId}`;
}

function useAgentOptions(): AgentOption[] {
  const agents = useWorkspaceStore((s) => s.agents);
  const teams = useWorkspaceStore((s) => s.teams);
  const workflows = useWorkspaceStore((s) => s.workflows);
  const builtinAgents = useWorkspaceStore((s) => s.builtinAgents);

  return useMemo(() => {
    const options: AgentOption[] = [];
    for (const e of [...agents, ...teams, ...workflows]) {
      const sourceLabel = computeSourceLabel({
        source: "backend",
        credentialName: e.credentialName,
      });
      const displayName = computeDisplayName({
        source: "backend",
        credentialName: e.credentialName,
        name: e.name ?? e.id,
      });
      options.push({
        entityId: e.id,
        credentialId: e.credentialId,
        entityKind: e.kind,
        sourceLabel,
        displayName,
      });
    }
    for (const a of builtinAgents) {
      const sourceLabel = computeSourceLabel({ source: "builtin" });
      const displayName = computeDisplayName({
        source: "builtin",
        name: a.name,
      });
      options.push({
        entityId: a.id,
        entityKind: "agent",
        sourceLabel,
        displayName,
      });
    }
    return options.sort((x, y) => x.displayName.localeCompare(y.displayName));
  }, [agents, teams, workflows, builtinAgents]);
}

// Datetime helpers

function getBrowserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/** Convert an ISO instant to the `datetime-local` input format
 *  ("YYYY-MM-DDTHH:mm") in the browser's local tz. */
function isoToLocalInputValue(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  // Adjust for the local tz offset before slicing.
  const offset = d.getTimezoneOffset() * 60_000;
  return new Date(d.getTime() - offset).toISOString().slice(0, 16);
}

/** Convert a datetime-local string back to an ISO UTC instant. */
function localInputValueToIso(value: string): string | null {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

/** Round `now` up to the next exact hour in local time. Used as the
 *  default `startAt` for new schedules. */
function nextRoundHour(): Date {
  const d = new Date();
  d.setMinutes(0, 0, 0);
  d.setHours(d.getHours() + 1);
  return d;
}

// Form state

type TriggerMode = "one_shot" | "recurring";

interface FormState {
  name: string;
  task: string;
  agentKey: string;
  timezone: string;
  startLocal: string; // datetime-local input value
  triggerMode: TriggerMode;
  intervalValue: string; // string for input control
  intervalUnit: ScheduleIntervalUnit;
  endLocal: string;
}

const INTERVAL_UNIT_LABELS: Record<ScheduleIntervalUnit, string> = {
  minute: "minute(s)",
  hour: "hour(s)",
  day: "day(s)",
  week: "week(s)",
  month: "month(s)",
};

function emptyForm(): FormState {
  return {
    name: "",
    task: "",
    agentKey: "",
    timezone: getBrowserTimezone(),
    // Seed with the next round hour (e.g. 14:23 → 15:00).
    startLocal: isoToLocalInputValue(nextRoundHour().toISOString()),
    triggerMode: "one_shot",
    intervalValue: "1",
    intervalUnit: "hour",
    endLocal: "",
  };
}

// `enabled` is intentionally NOT part of the form. The runtime sets
// new schedules to enabled=true (server default in /api/schedules
// POST); flipping enabled later happens via the left-panel
// StatusToggle, matching the inline-toggle convention used by the
// other panels (Agent / Skill / DataSource / SSH). The previous
// "auto re-arm an exhausted one-shot on edit" behaviour is gone —
// re-arming is now an explicit click in the panel after saving the
// new times, which is more discoverable than silent magic.
function formFromExisting(
  row: ScheduleResponse,
  options: AgentOption[],
): FormState {
  const matching = options.find(
    (o) => o.entityId === row.entityId
      && (o.credentialId ?? null) === (row.credentialId ?? null),
  );
  return {
    name: row.name ?? "",
    task: row.task,
    agentKey: matching ? agentKeyOf(matching) : "",
    timezone: row.timezone || getBrowserTimezone(),
    startLocal: isoToLocalInputValue(row.startAt),
    triggerMode: row.intervalValue !== null ? "recurring" : "one_shot",
    intervalValue: row.intervalValue ? String(row.intervalValue) : "1",
    intervalUnit: row.intervalUnit ?? "hour",
    endLocal: isoToLocalInputValue(row.endAt),
  };
}

// Editor

export interface ScheduleEditorProps {
  /** Existing row when editing; null/undefined when creating. */
  scheduleId: string | null;
  initialRow?: ScheduleResponse;
  onBack: () => void;
  onSaved: () => void;
}

export function ScheduleEditor({
  scheduleId,
  initialRow,
  onBack,
  onSaved,
}: ScheduleEditorProps): ReactNode {
  const options = useAgentOptions();
  const isCreating = !scheduleId;

  // The parent page passes `key={row.id}` so the editor remounts on row identity change.
  const [form, setForm] = useState<FormState>(() =>
    initialRow ? formFromExisting(initialRow, options) : emptyForm(),
  );

  const [submitting, setSubmitting] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState<boolean>(false);
  const [deleting, setDeleting] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  // Delete is destructive + irreversible; gate behind an AlertDialog
  // (matches SkillEditor / DataSourceEditor / SshServerEditor). On
  // success we navigate via `onSaved` so the editor pops out to the
  // schedules list, same path as a regular save.
  const handleDeleteConfirm = async (): Promise<void> => {
    if (!scheduleId) return;
    setDeleting(true);
    setError(null);
    try {
      await scheduleActions.remove(scheduleId);
      setDeleteOpen(false);
      startTransition(() => onSaved());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDeleting(false);
    }
  };

  const selected = options.find((o) => agentKeyOf(o) === form.agentKey);

  // One-shot schedules with a past start time are blocked to prevent immediate fires.
  // `nowMs` is captured once via lazy state init to avoid re-render churn.
  const [nowMs] = useState<number>(() => Date.now());
  const startMs = form.startLocal
    ? new Date(form.startLocal).getTime()
    : NaN;
  const startInPast =
    form.triggerMode === "one_shot"
    && Number.isFinite(startMs)
    && startMs < nowMs - 5_000;

  const update = <K extends keyof FormState>(
    key: K,
    value: FormState[K],
  ): void => setForm((f) => ({ ...f, [key]: value }));

  const validate = (): string | null => {
    if (!selected) return "Please pick a target agent.";
    if (!form.task.trim()) return "Task cannot be empty.";
    const startIso = localInputValueToIso(form.startLocal);
    if (!startIso) return "Please pick a start time.";
    if (startInPast) return "Start time must be in the future.";
    if (form.triggerMode === "recurring") {
      const v = Number(form.intervalValue);
      if (!Number.isFinite(v) || v <= 0 || !Number.isInteger(v)) {
        return "Interval must be a positive integer.";
      }
      if (form.endLocal) {
        const endIso = localInputValueToIso(form.endLocal);
        if (!endIso) return "End time is invalid.";
        if (new Date(endIso).getTime() <= new Date(startIso).getTime()) {
          return "End time must be after start time.";
        }
      }
    } else if (form.endLocal) {
      // One-shot doesn't accept endAt; the input shouldn't be visible
      // anyway, but be defensive.
      return "One-shot schedules cannot have an end time.";
    }
    return null;
  };

  const submit = async (): Promise<void> => {
    const err = validate();
    if (err) {
      setError(err);
      return;
    }
    setSubmitting(true);
    setError(null);

    const startIso = localInputValueToIso(form.startLocal)!;
    const endIso =
      form.triggerMode === "recurring" && form.endLocal
        ? localInputValueToIso(form.endLocal)
        : null;

    if (isCreating) {
      const created = await scheduleActions.create({
        entityId: selected!.entityId,
        credentialId: selected!.credentialId,
        entityKind: selected!.entityKind,
        // Persist the full `${group} / ${name}` so the panel shows
        // the same identity the supervisor would surface in its
        // catalog. The narrower `sourceLabel` (group only) is fine
        // for catalog grouping but loses the agent's name on the
        // panel row, which is the more informative read.
        sourceLabel: selected!.displayName,
        task: form.task.trim(),
        startAt: startIso,
        endAt: endIso,
        intervalValue:
          form.triggerMode === "recurring" ? Number(form.intervalValue) : null,
        intervalUnit:
          form.triggerMode === "recurring" ? form.intervalUnit : null,
        timezone: form.timezone || "UTC",
        name: form.name.trim() || undefined,
      });
      setSubmitting(false);
      if (created) {
        startTransition(() => onSaved());
      } else {
        setError("Create failed. Please retry.");
      }
      return;
    }

    await scheduleActions.patch(scheduleId!, {
      task: form.task.trim(),
      startAt: startIso,
      endAt: endIso,
      intervalValue:
        form.triggerMode === "recurring" ? Number(form.intervalValue) : null,
      intervalUnit:
        form.triggerMode === "recurring" ? form.intervalUnit : null,
      timezone: form.timezone || "UTC",
      name: form.name.trim() || null,
    });
    setSubmitting(false);
    startTransition(() => onSaved());
  };

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <header className="flex items-center gap-2 border-b px-4 py-3">
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          onClick={onBack}
          aria-label="Back"
        >
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <h1 className="text-sm font-semibold">
          {isCreating ? "New schedule" : "Edit schedule"}
        </h1>
        <div className="ml-auto flex items-center gap-2">
          <Button
            size="sm"
            onClick={() => void submit()}
            disabled={submitting || startInPast}
            className="h-8 cursor-pointer gap-1.5"
          >
            {submitting ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Save className="h-3.5 w-3.5" />
            )}
            Save
          </Button>
          {!isCreating && (
            <Button
              size="sm"
              className="h-8 shrink-0 cursor-pointer gap-1.5 bg-primary text-destructive hover:bg-primary/80 hover:text-destructive"
              onClick={() => setDeleteOpen(true)}
              disabled={submitting || deleting}
              aria-label="Delete this schedule"
            >
              {deleting ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Trash2 className="h-3.5 w-3.5" />
              )}
              Delete
            </Button>
          )}
        </div>
      </header>

      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete schedule</AlertDialogTitle>
            <AlertDialogDescription>
              Permanently delete <strong>{initialRow?.name ?? initialRow?.sourceLabel ?? "this schedule"}</strong>?
              Future runs will not fire. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                void handleDeleteConfirm();
              }}
              disabled={deleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleting ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Trash2 className="h-3.5 w-3.5" />
              )}
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Body — 40/60 split on `lg+` screens (form on the left, run
          history on the right). The form fields are short labels +
          inputs so 40% is enough; the wider right column gives the
          runs table room for full timestamps + status without
          mid-cell truncation. The form is still centered inside its
          column so long inputs don't stretch awkwardly. On narrower
          screens the right column collapses entirely. */}
      <div className="flex min-h-0 flex-1">
        <ScrollArea className="min-w-0 flex-1 lg:basis-2/5">
        <div className="mx-auto flex w-full max-w-2xl flex-col gap-5 px-6 py-6">
          {error && (
            <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {error}
            </p>
          )}

          {/* Name */}
          <div className="grid grid-cols-[88px_1fr] items-center gap-3">
            <Label htmlFor="schedule-name">Name</Label>
            <Input
              id="schedule-name"
              placeholder="e.g. Morning standup digest"
              value={form.name}
              onChange={(e) => update("name", e.target.value)}
            />
          </div>

          {/* Agent — base-ui Select renders the label via the `items`
              prop; without it, SelectValue falls back to printing the
              raw value (which here is `${credentialId|"builtin"}:${entityId}`,
              not human-readable). */}
          <div className="grid grid-cols-[88px_1fr] items-center gap-3">
            <Label>Agent</Label>
            <Select
              value={form.agentKey}
              items={options.map((o) => ({
                value: agentKeyOf(o),
                label: o.displayName,
              }))}
              onValueChange={(v) => update("agentKey", v ?? "")}
            >
              {/* Default SelectTrigger is `w-fit`; force full width
                  so it lines up with the Input controls above and below. */}
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Pick an agent…" />
              </SelectTrigger>
              <SelectContent>
                {options.map((o) => {
                  const k = agentKeyOf(o);
                  return (
                    <SelectItem key={k} value={k}>
                      {o.displayName}
                    </SelectItem>
                  );
                })}
              </SelectContent>
            </Select>
          </div>

          {/* Task */}
          <div className="grid grid-cols-[88px_1fr] items-start gap-3">
            <Label htmlFor="schedule-task" className="pt-2">
              Task
            </Label>
            <Textarea
              id="schedule-task"
              rows={5}
              placeholder="What should the agent do every fire?"
              value={form.task}
              onChange={(e) => update("task", e.target.value)}
              className="min-h-[7.5rem] resize-y"
            />
          </div>

          {/* Timezone */}
          <div className="grid grid-cols-[88px_1fr] items-center gap-3">
            <Label htmlFor="schedule-tz">Timezone</Label>
            <Input
              id="schedule-tz"
              placeholder="UTC"
              value={form.timezone}
              onChange={(e) => update("timezone", e.target.value)}
            />
          </div>

          {/* Start time. For one-shot we flag a past value with a red
              outline + inline note so the user notices before Save —
              the server enforces the same rule, this is just earlier
              feedback. */}
          <div className="grid grid-cols-[88px_1fr] items-start gap-3">
            <Label htmlFor="schedule-start" className="pt-2">
              Start time
            </Label>
            <div className="flex flex-col gap-1">
              <Input
                id="schedule-start"
                type="datetime-local"
                value={form.startLocal}
                onChange={(e) => update("startLocal", e.target.value)}
                aria-invalid={startInPast || undefined}
                className={cn(
                  startInPast
                    && "border-destructive focus-visible:border-destructive focus-visible:ring-destructive/40",
                )}
              />
              {startInPast && (
                <p className="text-[11px] text-destructive">
                  Start time must be in the future for a one-shot schedule.
                </p>
              )}
            </div>
          </div>

          {/* Trigger mode — segmented control */}
          <div className="grid grid-cols-[88px_1fr] items-center gap-3">
            <Label>Trigger</Label>
            <div className="inline-flex rounded-md border p-0.5 text-xs">
              {(
                [
                  ["one_shot", "One-shot"],
                  ["recurring", "Recurring"],
                ] as const
              ).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => update("triggerMode", value)}
                  className={cn(
                    "rounded px-3 py-1 transition-colors",
                    form.triggerMode === value
                      ? "bg-foreground text-background"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          {/* Recurring controls */}
          {form.triggerMode === "recurring" && (
            <>
              <div className="grid grid-cols-[88px_1fr] items-center gap-3">
                <Label htmlFor="schedule-iv">Every</Label>
                <div className="flex items-center gap-2">
                  <Input
                    id="schedule-iv"
                    type="number"
                    min={1}
                    step={1}
                    className="w-24"
                    value={form.intervalValue}
                    onChange={(e) =>
                      update("intervalValue", e.target.value)
                    }
                  />
                  <Select
                    value={form.intervalUnit}
                    items={(
                      Object.keys(
                        INTERVAL_UNIT_LABELS,
                      ) as ScheduleIntervalUnit[]
                    ).map((u) => ({
                      value: u,
                      label: INTERVAL_UNIT_LABELS[u],
                    }))}
                    onValueChange={(v) =>
                      update(
                        "intervalUnit",
                        (v as ScheduleIntervalUnit) ?? "hour",
                      )
                    }
                  >
                    <SelectTrigger className="w-40">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {(
                        Object.keys(INTERVAL_UNIT_LABELS) as ScheduleIntervalUnit[]
                      ).map((u) => (
                        <SelectItem key={u} value={u}>
                          {INTERVAL_UNIT_LABELS[u]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div className="grid grid-cols-[88px_1fr] items-center gap-3">
                <Label htmlFor="schedule-end">End time</Label>
                <Input
                  id="schedule-end"
                  type="datetime-local"
                  value={form.endLocal}
                  onChange={(e) => update("endLocal", e.target.value)}
                  placeholder="(optional)"
                />
              </div>
            </>
          )}

        </div>
        </ScrollArea>

        {/* Right column — only visible on `lg+`. `aside` to signal it
            as supplementary to the main form. */}
        <aside className="hidden min-w-0 flex-1 lg:flex lg:basis-3/5 lg:flex-col lg:border-l">
          {isCreating || !scheduleId ? (
            <RecentRunsPlaceholder />
          ) : (
            <RecentRuns scheduleId={scheduleId} />
          )}
        </aside>
      </div>
    </div>
  );
}
