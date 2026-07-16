"use client";

/**
 * evaluation-cases store — cases belonging to one suite at a time.
 *
 * Keyed by suiteId so navigating between suites is free. Mirrors the
 * verification-cases store pattern.
 */

import { create } from "zustand";

import { useEvaluationStore, type EvalCaseRow } from "@/store/evaluation";

// Re-export EvalCaseRow so consumers can import from one place.
export type { EvalCaseRow };

// Store

interface EvalCasesState {
  bySuite: Record<string, EvalCaseRow[]>;
  loadingFor: Set<string>;
  errorFor: Record<string, string | null>;

  setItemsFor: (suiteId: string, items: EvalCaseRow[]) => void;
  upsert: (item: EvalCaseRow) => void;
  remove: (suiteId: string, caseId: number) => void;
  setLoading: (suiteId: string, loading: boolean) => void;
  setError: (suiteId: string, error: string | null) => void;
}

export const useEvalCasesStore = create<EvalCasesState>()((set) => ({
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

// Actions

export interface CreateCaseInput {
  name: string;
  turns?: Array<{ userMessage: string }>;
  criteria?: Record<string, unknown>;
}

export interface PatchCaseInput {
  name?: string;
  suiteId?: string;
  turns?: Array<{ userMessage: string }>;
  criteria?: Record<string, unknown>;
  enabled?: boolean;
}

async function readError(res: Response): Promise<string> {
  const body = (await res.json().catch(() => null)) as
    | { message?: string }
    | null;
  return body?.message ?? `${res.status} ${res.statusText}`;
}

export const evalCaseActions = {
  async refresh(suiteId: string): Promise<void> {
    useEvalCasesStore.getState().setLoading(suiteId, true);
    try {
      const res = await fetch(`/api/eval-suites/${suiteId}/cases`);
      if (!res.ok) throw new Error(await readError(res));
      const items = (await res.json()) as EvalCaseRow[];
      useEvalCasesStore.getState().setItemsFor(suiteId, items);
    } catch (err) {
      useEvalCasesStore
        .getState()
        .setError(suiteId, err instanceof Error ? err.message : String(err));
    } finally {
      useEvalCasesStore.getState().setLoading(suiteId, false);
    }
  },

  async create(
    suiteId: string,
    input: CreateCaseInput,
  ): Promise<EvalCaseRow | null> {
    try {
      const res = await fetch(`/api/eval-suites/${suiteId}/cases`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      if (!res.ok) throw new Error(await readError(res));
      const row = (await res.json()) as EvalCaseRow;
      useEvalCasesStore.getState().upsert(row);
      useEvaluationStore.getState().bumpCaseCount(suiteId, +1);
      return row;
    } catch (err) {
      useEvalCasesStore
        .getState()
        .setError(suiteId, err instanceof Error ? err.message : String(err));
      return null;
    }
  },

  async patch(
    caseRow: Pick<EvalCaseRow, "id" | "suiteId">,
    patch: PatchCaseInput,
  ): Promise<EvalCaseRow | null> {
    try {
      const res = await fetch(`/api/eval-cases/${caseRow.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!res.ok) throw new Error(await readError(res));
      const row = (await res.json()) as EvalCaseRow;
      if (row.suiteId !== caseRow.suiteId) {
        useEvalCasesStore.getState().remove(caseRow.suiteId, caseRow.id);
        useEvalCasesStore.getState().upsert(row);
        useEvaluationStore.getState().bumpCaseCount(caseRow.suiteId, -1);
        useEvaluationStore.getState().bumpCaseCount(row.suiteId, +1);
      } else {
        useEvalCasesStore.getState().upsert(row);
      }
      return row;
    } catch (err) {
      useEvalCasesStore
        .getState()
        .setError(
          caseRow.suiteId,
          err instanceof Error ? err.message : String(err),
        );
      return null;
    }
  },

  async remove(
    caseRow: Pick<EvalCaseRow, "id" | "suiteId">,
  ): Promise<void> {
    try {
      const res = await fetch(`/api/eval-cases/${caseRow.id}`, {
        method: "DELETE",
      });
      if (!res.ok && res.status !== 404) {
        throw new Error(await readError(res));
      }
      useEvalCasesStore.getState().remove(caseRow.suiteId, caseRow.id);
      useEvaluationStore.getState().bumpCaseCount(caseRow.suiteId, -1);
    } catch (err) {
      useEvalCasesStore
        .getState()
        .setError(
          caseRow.suiteId,
          err instanceof Error ? err.message : String(err),
        );
      throw err;
    }
  },
};
