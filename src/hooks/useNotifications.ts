"use client";

import { useEffect } from "react";
import { useNotificationsStore } from "@/store/notifications";
import type { NotificationEntity } from "@/lib/db/schema";

type BroadcastMessage =
  | { kind: "added"; item: NotificationEntity }
  | { kind: "read"; id: string }
  | { kind: "all_read" }
  | { kind: "deleted"; id: string };

const CHANNEL_NAME = "nango.notifications";

let bc: BroadcastChannel | null = null;
function getBroadcastChannel(): BroadcastChannel | null {
  if (typeof BroadcastChannel === "undefined") return null;
  if (bc === null) bc = new BroadcastChannel(CHANNEL_NAME);
  return bc;
}

function broadcast(message: BroadcastMessage): void {
  getBroadcastChannel()?.postMessage(message);
}

export const notificationActions = {
  async markRead(id: string): Promise<void> {
    const prev = useNotificationsStore.getState().items.find((it) => it.id === id);
    if (!prev || prev.readAt !== null) return;
    useNotificationsStore.getState().applyRead(id);
    broadcast({ kind: "read", id });
    try {
      const res = await fetch(`/api/notifications/${id}`, { method: "PATCH" });
      if (!res.ok) throw new Error(`mark-read failed: ${res.status}`);
    } catch (err) {
      console.error("notifications.markRead", err);
      void notificationActions.refresh();
    }
  },

  async markAllRead(): Promise<void> {
    const hadUnread = useNotificationsStore
      .getState()
      .items.some((it) => it.readAt === null);
    if (!hadUnread) return;
    useNotificationsStore.getState().applyAllRead();
    broadcast({ kind: "all_read" });
    try {
      const res = await fetch("/api/notifications", { method: "POST" });
      if (!res.ok) throw new Error(`mark-all-read failed: ${res.status}`);
    } catch (err) {
      console.error("notifications.markAllRead", err);
      void notificationActions.refresh();
    }
  },

  async remove(id: string): Promise<void> {
    useNotificationsStore.getState().applyDelete(id);
    broadcast({ kind: "deleted", id });
    try {
      const res = await fetch(`/api/notifications/${id}`, { method: "DELETE" });
      if (!res.ok && res.status !== 404) {
        throw new Error(`delete failed: ${res.status}`);
      }
    } catch (err) {
      console.error("notifications.remove", err);
      void notificationActions.refresh();
    }
  },

  async refresh(): Promise<void> {
    try {
      const res = await fetch("/api/notifications?limit=200");
      if (!res.ok) return;
      const items = (await res.json()) as NotificationEntity[];
      useNotificationsStore.getState().setItems(items);
    } catch (err) {
      console.error("notifications.refresh", err);
    }
  },
};

export function useStartNotifications(): void {
  const setStreamConnected = useNotificationsStore((s) => s.setStreamConnected);
  const prepend = useNotificationsStore((s) => s.prepend);
  const applyRead = useNotificationsStore((s) => s.applyRead);
  const applyAllRead = useNotificationsStore((s) => s.applyAllRead);
  const applyDelete = useNotificationsStore((s) => s.applyDelete);

  useEffect(() => {
    void notificationActions.refresh();

    const es = new EventSource("/api/runs/stream");
    es.onopen = () => setStreamConnected(true);
    es.onerror = () => setStreamConnected(false);
    es.onmessage = (ev) => {
      try {
        const event = JSON.parse(ev.data) as
          | { kind: "notification"; notification: NotificationEntity }
          | { kind: "run_finalized" };
        if (event.kind === "notification") {
          prepend(event.notification);
          broadcast({ kind: "added", item: event.notification });
        }
      } catch (err) {
        console.error("SSE parse failed", err);
      }
    };

    const ch = getBroadcastChannel();
    const onMessage = (ev: MessageEvent<BroadcastMessage>) => {
      const msg = ev.data;
      if (msg.kind === "added") prepend(msg.item);
      else if (msg.kind === "read") applyRead(msg.id);
      else if (msg.kind === "all_read") applyAllRead();
      else if (msg.kind === "deleted") applyDelete(msg.id);
    };
    ch?.addEventListener("message", onMessage);

    return () => {
      es.close();
      ch?.removeEventListener("message", onMessage);
      setStreamConnected(false);
    };
  }, [setStreamConnected, prepend, applyRead, applyAllRead, applyDelete]);
}
