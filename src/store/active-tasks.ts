"use client";

import { create } from "zustand";

export interface ActiveTask {
  id: string;
  kind: "agent" | "verification" | "evaluation" | "web_auto";
  name: string;
  status: "running" | "succeeded" | "failed";
  startedAt: string | Date; // Serialized ISO timestamp string or Date object
  totalCount?: number;
  completedCount?: number;
}

interface ActiveTasksState {
  activeTasks: ActiveTask[];
  loaded: boolean;

  setTasks: (tasks: ActiveTask[]) => void;
  addTask: (task: ActiveTask) => void;
  updateProgress: (
    id: string,
    completedCount: number,
    totalCount?: number
  ) => void;
  setTerminalState: (id: string, status: "succeeded" | "failed") => void;
  removeTask: (id: string) => void;
}

export const useActiveTasksStore = create<ActiveTasksState>()((set) => ({
  activeTasks: [],
  loaded: false,

  setTasks: (tasks) => set({ activeTasks: tasks, loaded: true }),

  addTask: (task) =>
    set((s) => {
      // Avoid duplicate entries
      if (s.activeTasks.some((t) => t.id === task.id)) return s;
      return { activeTasks: [...s.activeTasks, task] };
    }),

  updateProgress: (id, completedCount, totalCount) =>
    set((s) => ({
      activeTasks: s.activeTasks.map((t) =>
        t.id === id
          ? {
              ...t,
              completedCount,
              totalCount: totalCount !== undefined ? totalCount : t.totalCount,
            }
          : t
      ),
    })),

  setTerminalState: (id, status) => {
    set((s) => ({
      activeTasks: s.activeTasks.map((t) =>
        t.id === id ? { ...t, status } : t
      ),
    }));

    // Automatically fade out from the active list after 1 minute
    setTimeout(() => {
      useActiveTasksStore.getState().removeTask(id);
    }, 60000);
  },

  removeTask: (id) =>
    set((s) => ({
      activeTasks: s.activeTasks.filter((t) => t.id !== id),
    })),
}));
