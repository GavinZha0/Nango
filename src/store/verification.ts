"use client";

import { create } from "zustand";

export type VerificationVisibility = "private" | "public";

export interface ToolPrefixRule {
  mode: "none" | "add" | "remove";
  prefix: string;
}

export interface VerificationSuiteRow {
  id: string;
  name: string;
  description: string | null;
  groupId: string | null;
  groupName?: string | null;
  /** NULL when the bound MCP server row was deleted (detached suite). */
  mcpServerId: string | null;
  /** Denormalized display name captured at creation. */
  mcpServerName: string | null;
  serverGroup?: string | null;
  serverName?: string | null;
  toolPrefixRule: ToolPrefixRule | null;
  visibility: VerificationVisibility;
  variables?: Record<string, unknown>;
  enabled: boolean;
  timeoutSec: number;
  createdBy: string;
  updatedBy: string | null;
  createdAt: string;
  updatedAt: string;
  caseCount: number;
}

export interface VerificationGroupRow {
  id: string;
  name: string;
  suiteCount: number;
  createdAt: string;
  updatedAt: string;
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
  items: VerificationSuiteRow[];
  groups: VerificationGroupRow[];
  loaded: boolean;
  loading: boolean;
  error: string | null;

  setItems: (items: VerificationSuiteRow[]) => void;
  setGroups: (groups: VerificationGroupRow[]) => void;
  setLoading: (loading: boolean) => void;
  setError: (err: string | null) => void;
  upsert: (item: VerificationSuiteRow) => void;
  remove: (id: string) => void;
  bumpCaseCount: (suiteId: string, delta: number) => void;
  renameGroupInStore: (groupId: string, name: string) => void;
}

export const useVerificationStore = create<VerificationState>()((set) => ({
  items: [],
  groups: [],
  loaded: false,
  loading: false,
  error: null,

  setItems: (items) => set({ items, loaded: true, error: null }),
  setGroups: (groups) => set({ groups }),
  setLoading: (loading) => set({ loading }),
  setError: (error) => set({ error }),
  upsert: (item) =>
    set((s) => {
      const next = s.items.slice();
      const idx = next.findIndex((it) => it.id === item.id);
      if (idx === -1) next.unshift(item);
      else next[idx] = item;
      next.sort((a, b) => a.name.localeCompare(b.name));
      return { items: next };
    }),
  remove: (id) =>
    set((s) => ({
      items: s.items.filter((it) => it.id !== id),
    })),
  bumpCaseCount: (suiteId, delta) =>
    set((s) => {
      const idx = s.items.findIndex((it) => it.id === suiteId);
      if (idx === -1) return s;
      const next = s.items.slice();
      const cur = next[idx];
      if (!cur) return s;
      next[idx] = {
        ...cur,
        caseCount: Math.max(0, cur.caseCount + delta),
      };
      return { items: next };
    }),
  renameGroupInStore: (groupId, name) =>
    set((s) => ({
      groups: s.groups.map((g) => (g.id === groupId ? { ...g, name } : g)),
      items: s.items.map((suite) =>
        suite.groupId === groupId ? { ...suite, groupName: name } : suite,
      ),
    })),
}));

export interface CreateSuiteInput {
  name: string;
  description?: string | null;
  groupId?: string | null;
  groupName?: string | null;
  mcpServerId?: string | null;
  toolPrefixRule?: ToolPrefixRule | null;
  variables?: Record<string, unknown>;
  visibility?: VerificationVisibility;
  timeoutSec?: number;
}

export interface PatchSuiteInput {
  name?: string;
  description?: string | null;
  groupId?: string | null;
  groupName?: string | null;
  mcpServerId?: string | null;
  toolPrefixRule?: ToolPrefixRule | null;
  variables?: Record<string, unknown>;
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
  async refresh(_unused?: unknown): Promise<void> {
    useVerificationStore.getState().setLoading(true);
    try {
      const [groupsRes, suitesRes] = await Promise.all([
        fetch("/api/verification-groups"),
        fetch("/api/verification-suites"),
      ]);
      if (!groupsRes.ok) throw new Error(await readErrorMessage(groupsRes));
      if (!suitesRes.ok) throw new Error(await readErrorMessage(suitesRes));
      const groups = (await groupsRes.json()) as VerificationGroupRow[];
      const suites = (await suitesRes.json()) as VerificationSuiteRow[];
      useVerificationStore.setState({
        groups,
        items: suites,
        loaded: true,
        error: null,
      });
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
      void this.refresh();
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
      void this.refresh();
    } catch (err) {
      useVerificationStore
        .getState()
        .setError(err instanceof Error ? err.message : String(err));
    }
  },

  async renameGroup(groupId: string, name: string): Promise<boolean> {
    try {
      const res = await fetch(`/api/verification-groups/${groupId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      if (!res.ok) throw new Error(await readErrorMessage(res));
      useVerificationStore.getState().renameGroupInStore(groupId, name);
      return true;
    } catch (err) {
      useVerificationStore
        .getState()
        .setError(err instanceof Error ? err.message : String(err));
      return false;
    }
  },
};
