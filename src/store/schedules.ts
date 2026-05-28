"use client";

/**
 * Client-side store + actions for the user's recurring schedules.
 */

import { create } from "zustand";

export type ScheduleIntervalUnit =
  | "minute"
  | "hour"
  | "day"
  | "week"
  | "month";

export interface ScheduleResponse {
  id: string;
  name: string | null;
  entityId: string;
  credentialId: string | null;
  sourceLabel: string;
  task: string;
  /** Required first-fire instant. */
  startAt: string;
  /** Optional cap; null = no end. */
  endAt: string | null;
  /** Pair: both null (one-shot) OR both set. */
  intervalValue: number | null;
  intervalUnit: ScheduleIntervalUnit | null;
  timezone: string;
  enabled: boolean;
  lastTriggeredAt: string | null;
  lastError: string | null;
  nextRunAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface SchedulesState {
  items: ScheduleResponse[];
  loaded: boolean;
  loading: boolean;
  error: string | null;

  setItems: (items: ScheduleResponse[]) => void;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
  upsert: (item: ScheduleResponse) => void;
  remove: (id: string) => void;
}

export const useSchedulesStore = create<SchedulesState>()((set) => ({
  items: [],
  loaded: false,
  loading: false,
  error: null,

  setItems: (items) => set({ items, loaded: true, error: null }),
  setLoading: (loading) => set({ loading }),
  setError: (error) => set({ error }),
  upsert: (item) =>
    set((s) => {
      const idx = s.items.findIndex((it) => it.id === item.id);
      if (idx === -1) return { items: [item, ...s.items] };
      const next = s.items.slice();
      next[idx] = item;
      return { items: next };
    }),
  remove: (id) => set((s) => ({ items: s.items.filter((it) => it.id !== id) })),
}));

export interface CreateScheduleInput {
  entityId: string;
  credentialId?: string;
  /** SECURITY: snapshotted on the row so the scheduler fires without
   *  round-tripping to entity-catalog. Always "agent" for builtin. */
  entityKind: import("@/lib/backends/types").EntityKind;
  sourceLabel: string;
  task: string;
  startAt: string;
  endAt?: string | null;
  intervalValue?: number | null;
  intervalUnit?: ScheduleIntervalUnit | null;
  timezone: string;
  name?: string;
  enabled?: boolean;
}

export interface PatchScheduleInput {
  task?: string;
  startAt?: string;
  endAt?: string | null;
  intervalValue?: number | null;
  intervalUnit?: ScheduleIntervalUnit | null;
  timezone?: string;
  name?: string | null;
  enabled?: boolean;
}

/** Mutation helpers — round-trip API + update store. CONTRACT: errors
 *  are surfaced via the store's `error` field for inline rendering. */
export const scheduleActions = {
  async refresh(): Promise<void> {
    useSchedulesStore.getState().setLoading(true);
    try {
      const res = await fetch("/api/schedules");
      if (!res.ok) throw new Error(`fetch failed: ${res.status}`);
      const items = (await res.json()) as ScheduleResponse[];
      useSchedulesStore.getState().setItems(items);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      useSchedulesStore.getState().setError(msg);
    } finally {
      useSchedulesStore.getState().setLoading(false);
    }
  },

  async create(input: CreateScheduleInput): Promise<ScheduleResponse | null> {
    try {
      const res = await fetch("/api/schedules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(
          (body && body.message) || `create failed: ${res.status}`,
        );
      }
      const row = (await res.json()) as ScheduleResponse;
      useSchedulesStore.getState().upsert(row);
      return row;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      useSchedulesStore.getState().setError(msg);
      return null;
    }
  },

  async patch(id: string, input: PatchScheduleInput): Promise<void> {
    try {
      const res = await fetch(`/api/schedules/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(
          (body && body.message) || `patch failed: ${res.status}`,
        );
      }
      const row = (await res.json()) as ScheduleResponse;
      useSchedulesStore.getState().upsert(row);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      useSchedulesStore.getState().setError(msg);
    }
  },

  async remove(id: string): Promise<void> {
    try {
      const res = await fetch(`/api/schedules/${id}`, { method: "DELETE" });
      if (!res.ok && res.status !== 404) {
        throw new Error(`delete failed: ${res.status}`);
      }
      useSchedulesStore.getState().remove(id);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      useSchedulesStore.getState().setError(msg);
    }
  },

  async triggerNow(id: string): Promise<void> {
    try {
      const res = await fetch(`/api/schedules/${id}/trigger`, {
        method: "POST",
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(
          (body && body.message) || `trigger failed: ${res.status}`,
        );
      }
      // Refresh the whole list (~10 rows max — cheap) since the
      // server updated lastTriggeredAt / lastError.
      await scheduleActions.refresh();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      useSchedulesStore.getState().setError(msg);
    }
  },
};
