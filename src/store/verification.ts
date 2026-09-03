"use client";

import { create } from "zustand";

export type VerificationCategory = "mcp";
export type VerificationVisibility = "private" | "public";

export interface VerificationSuiteRow {
  id: string;
  name: string;
  description: string | null;
  category: VerificationCategory;
  visibility: VerificationVisibility;
  enabled: boolean;
  timeoutSec: number;
  createdBy: string;
  updatedBy: string | null;
  createdAt: string;
  updatedAt: string;
  caseCount: number;
}

export interface VerificationServerRow {
  id: string;
  name: string;
  serverTitle: string | null;
  serverDescription: string | null;
  enabled: boolean;
  visibility: VerificationVisibility;
  verificationVisibility: VerificationVisibility;
  hasOwnSuites: boolean;
  createdBy: string;
  caseCount: number;
}

export interface VerificationCaseRow {
  id: number;
  suiteId: string;
  name: string;
  mcpServerId: string | null;
  toolName: string | null;
  input: Record<string, unknown>;
  assertions: unknown;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

interface VerificationState {
  category: VerificationCategory;
  items: { mcp: VerificationSuiteRow[] };
  loaded: { mcp: boolean };
  loading: boolean;
  error: string | null;

  setCategory: (c: VerificationCategory) => void;
  setItemsFor: (c: VerificationCategory, items: VerificationSuiteRow[]) => void;
  setLoading: (loading: boolean) => void;
  setError: (err: string | null) => void;
  upsert: (item: VerificationSuiteRow) => void;
  remove: (id: string) => void;
  bumpCaseCount: (suiteId: string, delta: number) => void;
}

const EMPTY_PER_CATEGORY = {
  mcp: [] as VerificationSuiteRow[],
};
const NEVER_LOADED = { mcp: false };

export const useVerificationStore = create<VerificationState>()((set) => ({
  category: "mcp",
  items: EMPTY_PER_CATEGORY,
  loaded: NEVER_LOADED,
  loading: false,
  error: null,

  setCategory: (c) => set({ category: c }),
  setItemsFor: (c, items) =>
    set((s) => ({
      items: { ...s.items, [c]: items },
      loaded: { ...s.loaded, [c]: true },
      error: null,
    })),
  setLoading: (loading) => set({ loading }),
  setError: (error) => set({ error }),
  upsert: (item) =>
    set((s) => {
      const bucket = s.items[item.category].slice();
      const idx = bucket.findIndex((it) => it.id === item.id);
      if (idx === -1) bucket.unshift(item);
      else bucket[idx] = item;
      bucket.sort((a, b) => a.name.localeCompare(b.name));
      return { items: { ...s.items, [item.category]: bucket } };
    }),
  remove: (id) =>
    set((s) => ({
      items: {
        mcp: s.items.mcp.filter((it) => it.id !== id),
      },
    })),
  bumpCaseCount: (suiteId, delta) =>
    set((s) => {
      const bumpIn = (
        list: VerificationSuiteRow[],
      ): VerificationSuiteRow[] => {
        const idx = list.findIndex((it) => it.id === suiteId);
        if (idx === -1) return list;
        const next = list.slice();
        const cur = next[idx];
        if (!cur) return list;
        next[idx] = {
          ...cur,
          caseCount: Math.max(0, cur.caseCount + delta),
        };
        return next;
      };
      return {
        items: {
          mcp: bumpIn(s.items.mcp),
        },
      };
    }),
}));

export interface CreateSuiteInput {
  name: string;
  description?: string | null;
  category?: VerificationCategory;
  mcpServerId?: string | null;
  visibility?: VerificationVisibility;
  timeoutSec?: number;
}

export interface PatchSuiteInput {
  name?: string;
  description?: string | null;
  visibility?: VerificationVisibility;
  enabled?: boolean;
  timeoutSec?: number;
}

async function readErrorMessage(res: Response): Promise<string> {
  const body = (await res.json().catch(() => null)) as
    | { message?: string }
    | null;
  return body?.message ?? `${res.status} ${res.statusText}`;
}

export const verificationActions = {
  async refresh(_category?: VerificationCategory): Promise<void> {
    useVerificationStore.getState().setLoading(true);
    try {
      const res = await fetch(`/api/verification-servers`);
      if (!res.ok) throw new Error(await readErrorMessage(res));
      const items = (await res.json()) as VerificationServerRow[];
      useVerificationStore.getState().setItemsFor("mcp", items as unknown as VerificationSuiteRow[]);
    } catch (err) {
      useVerificationStore
        .getState()
        .setError(err instanceof Error ? err.message : String(err));
    } finally {
      useVerificationStore.getState().setLoading(false);
    }
  },

  async create(input: CreateSuiteInput): Promise<VerificationSuiteRow | null> {
    try {
      const res = await fetch("/api/verification-suites", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      if (!res.ok) throw new Error(await readErrorMessage(res));
      const row = (await res.json()) as VerificationSuiteRow;
      useVerificationStore.getState().upsert(row);
      return row;
    } catch (err) {
      useVerificationStore
        .getState()
        .setError(err instanceof Error ? err.message : String(err));
      return null;
    }
  },

  async patch(
    id: string,
    input: PatchSuiteInput,
  ): Promise<VerificationSuiteRow | null> {
    try {
      const res = await fetch(`/api/verification-suites/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      if (!res.ok) throw new Error(await readErrorMessage(res));
      const row = (await res.json()) as VerificationSuiteRow;
      useVerificationStore.getState().upsert(row);
      return row;
    } catch (err) {
      useVerificationStore
        .getState()
        .setError(err instanceof Error ? err.message : String(err));
      return null;
    }
  },

  async remove(id: string): Promise<void> {
    try {
      const res = await fetch(`/api/verification-suites/${id}`, {
        method: "DELETE",
      });
      if (!res.ok && res.status !== 404) {
        throw new Error(await readErrorMessage(res));
      }
      useVerificationStore.getState().remove(id);
    } catch (err) {
      useVerificationStore
        .getState()
        .setError(err instanceof Error ? err.message : String(err));
    }
  },
};
