"use client";

import { useEffect } from "react";
import { useNotificationsStore } from "@/store/notifications";
import { useActiveTasksStore } from "@/store/active-tasks";
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

  async markScheduleRead(): Promise<void> {
    const hadUnread = useNotificationsStore
      .getState()
      .items.some((it) => it.initiator === "schedule" && it.readAt === null);
    if (!hadUnread) return;
    useNotificationsStore.getState().applyScheduleRead();
    try {
      const res = await fetch("/api/notifications?initiator=schedule", { method: "POST" });
      if (!res.ok) throw new Error(`mark-schedule-read failed: ${res.status}`);
    } catch (err) {
      console.error("notifications.markScheduleRead", err);
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

    // 初始化拉取活跃后台任务
    const setTasks = useActiveTasksStore.getState().setTasks;
    fetch("/api/runs/active")
      .then((res) => (res.ok ? res.json() : { activeTasks: [] }))
      .then((data) => {
        if (data.activeTasks) setTasks(data.activeTasks);
      })
      .catch((err) => console.error("Failed to fetch active tasks", err));

    const es = new EventSource("/api/runs/stream");
    es.onopen = () => setStreamConnected(true);
    es.onerror = () => setStreamConnected(false);
    es.onmessage = (ev) => {
      try {
        const event = JSON.parse(ev.data);
        if (event.kind === "notification") {
          prepend(event.notification);
          broadcast({ kind: "added", item: event.notification });
        } else if (event.kind === "run_started") {
          useActiveTasksStore.getState().addTask({
            id: event.runId,
            kind: "agent",
            name: event.entityId,
            status: "running",
            startedAt: event.startedAt,
          });
        } else if (event.kind === "run_finalized") {
          useActiveTasksStore.getState().setTerminalState(event.runId, event.status);
        } else if (event.kind === "verification") {
          const { frame } = event;
          if (frame.kind === "run_started") {
            useActiveTasksStore.getState().addTask({
              id: frame.runId,
              kind: "verification",
              name: frame.suiteName || "Verification",
              status: "running",
              startedAt: new Date(),
              totalCount: frame.totalCount,
              completedCount: 0,
            });
          } else if (frame.kind === "case_finished") {
            const task = useActiveTasksStore.getState().activeTasks.find((t) => t.id === frame.runId);
            if (task) {
              useActiveTasksStore.getState().updateProgress(frame.runId, (task.completedCount ?? 0) + 1);
            }
          } else if (frame.kind === "run_finished") {
            useActiveTasksStore.getState().setTerminalState(
              frame.runId,
              frame.status === "passed" ? "succeeded" : "failed"
            );
          }
        } else if (event.kind === "evaluation") {
          const { frame } = event;
          if (frame.kind === "run_started") {
            useActiveTasksStore.getState().addTask({
              id: frame.runId,
              kind: "evaluation",
              name: frame.suiteName || "Evaluation",
              status: "running",
              startedAt: new Date(),
              totalCount: frame.totalCount,
              completedCount: 0,
            });
          } else if (frame.kind === "case_completed") {
            const task = useActiveTasksStore.getState().activeTasks.find((t) => t.id === frame.runId);
            if (task) {
              useActiveTasksStore.getState().updateProgress(frame.runId, (task.completedCount ?? 0) + 1);
            }
          } else if (frame.kind === "run_finished") {
            useActiveTasksStore.getState().setTerminalState(
              frame.runId,
              frame.status === "passed" ? "succeeded" : "failed"
            );
          }
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
