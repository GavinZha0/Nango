"use client";

/**
 * verification-cases store — cases belonging to ONE suite at a time.
 *
 * The store is keyed by `suiteId` so navigating between suites doesn't
 * cause a fetch storm: the previous suite's case list stays cached
 * until something invalidates it (delete, etc.). Memory pressure is
 * negligible — a suite is at most a few dozen cases of a few KB each.
 *
 * Run-time per-case verdicts live OUTSIDE this store:
 *   - live: `useVerificationRunStream(runId).caseResults` (Map keyed by case id)
 *   - history: the response of `GET /api/verification-runs/[id]`
 * Keeping verdicts separate from definitions is intentional — the
 * definition is mutable (PATCH bumps `updatedAt`), the verdict is
 * frozen against an immutable snapshot of the input. Mixing them
 * would silently invalidate history view mode.
 */

import { create } from "zustand";

import type { AssertionSpec } from "@/lib/verification/types";
import { verificationActions } from "@/store/verification";

// API row shape — matches what `GET /api/verification-suites/[id]/cases`
// returns. Server-side it's `VerificationCaseTable.$inferSelect`; we
// declare the projection here so the client doesn't pull a server-only
// module just to read the type.

export interface VerificationCaseRow {
  /** `bigint identity` in DB; JSON-safe ≪ 2^53. */
  id: number;
  suiteId: string;
  name: string;
  mcpServerId?: string | null;
  toolName?: string | null;
  workflowId?: string | null;
  input: Record<string, unknown>;
  assertions: AssertionSpec[];
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

// --- Store -----------------------------------------------------------------

interface CasesState {
  /** Cache: suiteId → cases. Bucket missing = never loaded. */
  bySuite: Record<string, VerificationCaseRow[]>;
  /** Inflight loads (per suite). UI uses this to gate the spinner. */
  loadingFor: Set<string>;
  /** Last error per suite, for inline rendering. */
  errorFor: Record<string, string | null>;

  setItemsFor: (suiteId: string, items: VerificationCaseRow[]) => void;
  upsert: (item: VerificationCaseRow) => void;
  remove: (suiteId: string, caseId: number) => void;
  setLoading: (suiteId: string, loading: boolean) => void;
  setError: (suiteId: string, error: string | null) => void;
}

export const useCasesStore = create<CasesState>()((set) => ({
  bySuite: {},
  loadingFor: new Set<string>(),
  errorFor: {},

  setItemsFor: (suiteId, items) =>
    set((s) => ({
      bySuite: { ...s.bySuite, [suiteId]: items },
      errorFor: { ...s.errorFor, [suiteId]: null },
    })),
  upsert: (item) =>
    set((s) => {
      const bucket = (s.bySuite[item.suiteId] ?? []).slice();
      const idx = bucket.findIndex((it) => it.id === item.id);
      if (idx === -1) bucket.push(item);
      else bucket[idx] = item;
      bucket.sort((a, b) => a.name.localeCompare(b.name));
      return { bySuite: { ...s.bySuite, [item.suiteId]: bucket } };
    }),
  remove: (suiteId, caseId) =>
    set((s) => {
      const bucket = s.bySuite[suiteId];
      if (!bucket) return s;
      return {
        bySuite: {
          ...s.bySuite,
          [suiteId]: bucket.filter((it) => it.id !== caseId),
        },
      };
    }),
  setLoading: (suiteId, loading) =>
    set((s) => {
      const next = new Set(s.loadingFor);
      if (loading) next.add(suiteId);
      else next.delete(suiteId);
      return { loadingFor: next };
    }),
  setError: (suiteId, error) =>
    set((s) => ({ errorFor: { ...s.errorFor, [suiteId]: error } })),
}));

// --- Actions ----------------------------------------------------------------

export interface CreateMcpCaseInput {
  name: string;
  mcpServerId: string;
  toolName: string;
  input?: Record<string, unknown>;
  assertions?: AssertionSpec[];
}

export interface PatchCaseInput {
  name?: string;
  input?: Record<string, unknown>;
  assertions?: AssertionSpec[];
  enabled?: boolean;
}

async function readError(res: Response): Promise<string> {
  const body = (await res.json().catch(() => null)) as
    | { message?: string }
    | null;
  return body?.message ?? `${res.status} ${res.statusText}`;
}

export const caseActions = {
  async refresh(suiteId: string): Promise<void> {
    useCasesStore.getState().setLoading(suiteId, true);
    try {
      const res = await fetch(`/api/verification-suites/${suiteId}/cases`);
      if (!res.ok) throw new Error(await readError(res));
      const items = (await res.json()) as VerificationCaseRow[];
      useCasesStore.getState().setItemsFor(suiteId, items);
    } catch (err) {
      useCasesStore
        .getState()
        .setError(suiteId, err instanceof Error ? err.message : String(err));
    } finally {
      useCasesStore.getState().setLoading(suiteId, false);
    }
  },

  async refreshForServer(serverId: string): Promise<void> {
    try {
      const res = await fetch(`/api/verification-servers/${serverId}/cases`);
      if (!res.ok) throw new Error(await readError(res));
      const items = (await res.json()) as VerificationCaseRow[];

      // Group by suiteId
      const groups: Record<string, VerificationCaseRow[]> = {};
      for (const it of items) {
        if (!groups[it.suiteId]) groups[it.suiteId] = [];
        groups[it.suiteId].push(it);
      }

      // Update store buckets
      for (const [suiteId, cs] of Object.entries(groups)) {
        useCasesStore.getState().setItemsFor(suiteId, cs);
      }
    } catch (err) {
      console.error("Failed to refresh cases for server", serverId, err);
    }
  },

  async create(
    input: CreateMcpCaseInput,
  ): Promise<VerificationCaseRow | null> {
    try {
      const res = await fetch(
        `/api/verification-cases`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(input),
        },
      );
      if (!res.ok) throw new Error(await readError(res));
      const row = (await res.json()) as VerificationCaseRow;
      useCasesStore.getState().upsert(row);
      // Refresh left panel to ensure any newly populated server shows up
      void verificationActions.refresh("mcp");
      return row;
    } catch (err) {
      console.error("Failed to create case", err);
      return null;
    }
  },

  async patch(
    caseRow: Pick<VerificationCaseRow, "id" | "suiteId">,
    patch: PatchCaseInput,
  ): Promise<VerificationCaseRow | null> {
    try {
      const res = await fetch(`/api/verification-cases/${caseRow.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!res.ok) throw new Error(await readError(res));
      const row = (await res.json()) as VerificationCaseRow;
      useCasesStore.getState().upsert(row);
      return row;
    } catch (err) {
      useCasesStore
        .getState()
        .setError(
          caseRow.suiteId,
          err instanceof Error ? err.message : String(err),
        );
      return null;
    }
  },

  async remove(
    caseRow: Pick<VerificationCaseRow, "id" | "suiteId">,
  ): Promise<void> {
    try {
      const res = await fetch(`/api/verification-cases/${caseRow.id}`, {
        method: "DELETE",
      });
      if (!res.ok && res.status !== 404) {
        throw new Error(await readError(res));
      }
      useCasesStore.getState().remove(caseRow.suiteId, caseRow.id);
      // Refresh left panel to ensure the count badge is in sync or server is removed if empty
      void verificationActions.refresh("mcp");
    } catch (err) {
      useCasesStore
        .getState()
        .setError(
          caseRow.suiteId,
          err instanceof Error ? err.message : String(err),
        );
    }
  },
};
