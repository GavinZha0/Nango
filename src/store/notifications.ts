"use client";

/**
 * Client-side notification store + SSE / cross-tab plumbing.
 */

import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";

import type { NotificationEntity } from "@/lib/db/schema";

interface NotificationsState {
  items: NotificationEntity[];
  loaded: boolean;
  isStreamConnected: boolean;

  setItems: (items: NotificationEntity[]) => void;
  prepend: (item: NotificationEntity) => void;
  applyRead: (id: string) => void;
  applyAllRead: () => void;
  applyScheduleRead: () => void;
  applyDelete: (id: string) => void;
  setStreamConnected: (connected: boolean) => void;
}

export const useNotificationsStore = create<NotificationsState>()((set) => ({
  items: [],
  loaded: false,
  isStreamConnected: false,

  setItems: (items) => set({ items, loaded: true }),
  prepend: (item) =>
    set((s) => {
      // QUIRK: dedupe by id — SSE may race the GET, BroadcastChannel
      // may re-emit. Keep the earliest insertion.
      if (s.items.some((it) => it.id === item.id)) return s;
      return { items: [item, ...s.items] };
    }),
  applyRead: (id) =>
    set((s) => ({
      items: s.items.map((it) =>
        it.id === id && it.readAt === null
          ? { ...it, readAt: new Date() }
          : it,
      ),
    })),
  applyAllRead: () =>
    set((s) => {
      const now = new Date();
      return {
        items: s.items.map((it) =>
          it.readAt === null ? { ...it, readAt: now } : it,
        ),
      };
    }),
  applyScheduleRead: () =>
    set((s) => {
      const now = new Date();
      return {
        items: s.items.map((it) =>
          it.initiator === "schedule" && it.readAt === null
            ? { ...it, readAt: now }
            : it,
        ),
      };
    }),
  applyDelete: (id) =>
    set((s) => ({ items: s.items.filter((it) => it.id !== id) })),
  setStreamConnected: (connected) => set({ isStreamConnected: connected }),
}));

/** True when the notification should appear in the bell dropdown
 *  (non-schedule items only). Schedule notifications are surfaced
 *  via the schedule panel's status dot instead. */
function isBellVisible(it: NotificationEntity): boolean {
  return it.initiator !== "schedule";
}

/** Selector helpers. */

/** Hook returning bell-visible items with shallow equality so the
 *  component doesn't re-render when the filtered array is unchanged. */
export function useBellItems(): NotificationEntity[] {
  return useNotificationsStore(
    useShallow((s: NotificationsState) => s.items.filter(isBellVisible)),
  );
}

export const selectUnreadCount = (s: NotificationsState): number =>
  s.items.filter(isBellVisible).reduce((n, it) => n + (it.readAt === null ? 1 : 0), 0);

/** Schedule-only: true when at least one enabled schedule's last
 *  run produced a failure notification (drives the amber dot on the
 *  schedule toolbar icon). */
export const selectHasScheduleFailure = (s: NotificationsState): boolean =>
  s.items.some(
    (it) =>
      it.initiator === "schedule"
      && it.readAt === null
      && it.kind === "run_failed",
  );

/** Schedule-only: true when at least one unread schedule notification
 *  exists (drives the green/amber dot visibility). */
export const selectHasUnreadSchedule = (s: NotificationsState): boolean =>
  s.items.some((it) => it.initiator === "schedule" && it.readAt === null);
