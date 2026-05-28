"use client";

/**
 * Client-side notification store + SSE / cross-tab plumbing.
 */

import { create } from "zustand";

import type { NotificationEntity } from "@/lib/db/schema";

interface NotificationsState {
  items: NotificationEntity[];
  loaded: boolean;
  isStreamConnected: boolean;

  setItems: (items: NotificationEntity[]) => void;
  prepend: (item: NotificationEntity) => void;
  applyRead: (id: string) => void;
  applyAllRead: () => void;
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
  applyDelete: (id) =>
    set((s) => ({ items: s.items.filter((it) => it.id !== id) })),
  setStreamConnected: (connected) => set({ isStreamConnected: connected }),
}));

/** Selector helpers. */
export const selectUnreadCount = (s: NotificationsState): number =>
  s.items.reduce((n, it) => n + (it.readAt === null ? 1 : 0), 0);
