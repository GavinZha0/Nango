"use client";

import { useEffect } from "react";
import { useRouter, useParams } from "next/navigation";

import { ScheduleEditor } from "@/components/main-panels/ScheduleEditor";
import { useSchedulesStore, scheduleActions } from "@/store/schedules";

/**
 * /schedule/[id] — edit existing OR create new (`id === "new"`).
 */
export default function ScheduleEditorPage() {
  const router = useRouter();
  const { id } = useParams<{ id: string }>();
  const isNew = id === "new";

  const loaded = useSchedulesStore((s) => s.loaded);
  // Selector returns the matching row directly so the component
  // re-renders only when *this* row changes, not on every other
  // schedule's mutation.
  const row = useSchedulesStore((s) =>
    isNew ? undefined : s.items.find((it) => it.id === id),
  );

  // Hard-nav (open in new tab) lands here with an empty store —
  // kick off a list refresh so the editor can re-seed once it
  // arrives. The editor remounts via its `key` prop when the row
  // identity changes.
  useEffect(() => {
    if (!isNew && !loaded) void scheduleActions.refresh();
  }, [isNew, loaded]);

  return (
    <ScheduleEditor
      key={row?.id ?? (isNew ? "new" : `pending-${id}`)}
      scheduleId={isNew ? null : id}
      initialRow={row}
      onBack={() => router.push("/schedule")}
      onSaved={() => router.push("/schedule")}
    />
  );
}
