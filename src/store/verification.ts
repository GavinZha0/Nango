"use client";

/**
 * Client-side store + actions for Verification suites.
 *
 * Single source of truth for the left `VerificationPanel` and the
 * center `VerificationSuiteEditor`. Suites are partitioned into two
 * disjoint sets by `category` ("mcp" | "workflow") — the panel shows
 * one set at a time, controlled by the top-of-panel tab.
 *
 * Run history (`verification_run` / `verification_case_result`) is
 * NOT cached here — those rows are fetched on-demand by the editor's
 * RecentRunsBanner via `/api/verification-suites/[id]/runs` because
 * they are large, paginated, and grow with usage. Keeping them out
 * of the suite store prevents memory creep.
 *
 * Real-time updates flow through SSE (`/api/runs/stream` topic
 * `verification_run`) — see the editor; the store does NOT subscribe
 * because suite metadata never changes mid-run.
 */

import { create } from "zustand";

import type { VerificationSuiteCategory } from "@/lib/verification/types";

/** Alias kept local to the client store; the DB column is a free-form
 *  text + CHECK, so we don't pull a shared type just for two values. */
export type VerificationCategory = VerificationSuiteCategory;
export type VerificationVisibility = "private" | "public";

// API row shapes — match what `/api/verification-suites` and
// `/api/verification-suites/[id]/cases` actually return today.

export interface VerificationSuiteRow {
  id: string;
  name: string;
  description: string | null;
  category: VerificationCategory;
  visibility: VerificationVisibility;
  enabled: boolean;
  /** Suite-wide timeout in SECONDS (matches DB column `timeout_sec`). */
  timeoutSec: number;
  createdBy: string;
  updatedBy: string | null;
  createdAt: string;
  updatedAt: string;
  /** Number of cases under this suite, derived server-side via a
   *  correlated COUNT in GET /api/verification-suites and on the
   *  single-row endpoints. Drives the left-panel count badge. */
  caseCount: number;
}

export interface VerificationCaseRow {
  /** bigint identity in DB; JSON-encoded as a number (safe ≪ 2^53). */
  id: number;
  suiteId: string;
  name: string;
  mcpServerId: string | null;
  toolName: string | null;
  workflowId: string | null;
  input: Record<string, unknown>;
  /** Opaque to the store — typed at the editor seam via `AssertionSpec[]`. */
  assertions: unknown;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

// Store

interface VerificationState {
  /** Current category tab. Drives which set of suites is materialised. */
  category: VerificationCategory;
  /** Cache per category — switching tabs is free if both have been loaded. */
  items: Record<VerificationCategory, VerificationSuiteRow[]>;
  loaded: Record<VerificationCategory, boolean>;
  loading: boolean;
  error: string | null;

  setCategory: (c: VerificationCategory) => void;
  setItemsFor: (c: VerificationCategory, items: VerificationSuiteRow[]) => void;
  setLoading: (loading: boolean) => void;
  setError: (err: string | null) => void;
  upsert: (item: VerificationSuiteRow) => void;
  remove: (id: string) => void;
  /** Adjust the `caseCount` of a suite by `delta` (signed). Used by
   *  `caseActions.create/remove` so the panel badge stays in sync
   *  without re-fetching the full suite list. Silently no-ops if the
   *  suite isn't loaded in either bucket. */
  bumpCaseCount: (suiteId: string, delta: number) => void;
}

const EMPTY_PER_CATEGORY = {
  mcp: [] as VerificationSuiteRow[],
  workflow: [] as VerificationSuiteRow[],
};
const NEVER_LOADED = { mcp: false, workflow: false };

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
      // Keep alphabetical (matches server `ORDER BY name`).
      bucket.sort((a, b) => a.name.localeCompare(b.name));
      return { items: { ...s.items, [item.category]: bucket } };
    }),
  remove: (id) =>
    set((s) => ({
      items: {
        mcp: s.items.mcp.filter((it) => it.id !== id),
        workflow: s.items.workflow.filter((it) => it.id !== id),
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
        // Clamp to zero — guards against under-counting if a stale
        // delete fires twice (UI optimistic + server eventual).
        next[idx] = {
          ...cur,
          caseCount: Math.max(0, cur.caseCount + delta),
        };
        return next;
      };
      return {
        items: {
          mcp: bumpIn(s.items.mcp),
          workflow: bumpIn(s.items.workflow),
        },
      };
    }),
}));

// Actions

export interface CreateSuiteInput {
  name: string;
  description?: string | null;
  category: VerificationCategory;
  visibility?: VerificationVisibility;
  /** Seconds; backend default = 300 if omitted. */
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
  /** Refresh the current category. Idempotent; safe to call repeatedly. */
  async refresh(category?: VerificationCategory): Promise<void> {
    const cat = category ?? useVerificationStore.getState().category;
    useVerificationStore.getState().setLoading(true);
    try {
      const res = await fetch(`/api/verification-suites?category=${cat}`);
      if (!res.ok) throw new Error(await readErrorMessage(res));
      const items = (await res.json()) as VerificationSuiteRow[];
      useVerificationStore.getState().setItemsFor(cat, items);
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
