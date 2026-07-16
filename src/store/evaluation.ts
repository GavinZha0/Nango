"use client";

/**
 * Client-side store + actions for Evaluation suites.
 *
 * The left panel shows agents (derived from suites' agent_id), each
 * navigable to an editor page that lists suites + cases. This store
 * caches the suite list keyed by agent so tab-switching is free.
 *
 * Run history is NOT cached here — fetched on-demand by the editor.
 */

import { create } from "zustand";

import type { EvalCriteria } from "@/lib/evaluation/types";

// API row shapes — match what the eval-suites API returns.

export interface EvalSuiteRow {
  id: string;
  agentId: string;
  agentSource: string;
  credentialId: string | null;
  evaluatorAgentId: string | null;
  name: string;
  description: string | null;
  dimensionIds: string[];
  enabled: boolean;
  visibility: "private" | "public";
  createdBy: string;
  updatedBy: string | null;
  createdAt: string;
  updatedAt: string;
  caseCount: number;
}

export interface EvalCaseRow {
  id: number;
  suiteId: string;
  name: string;
  turns: Array<{ userMessage: string }>;
  criteria: EvalCriteria;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  createdBy?: string;
}

/** Left-panel row — one per agent that has eval suites. */
export interface EvalAgentItem {
  agentId: string;
  agentSource: string;
  credentialId: string | null;
  suiteCount: number;
  caseCount: number;
  /** Display fields resolved client-side from the agent catalog. */
  agentName?: string;
  agentIcon?: string;
}

// Store

interface EvaluationState {
  /** Agent list for the left panel. */
  agents: EvalAgentItem[];
  agentsLoaded: boolean;
  /** Suite cache keyed by "agentId:agentSource". */
  suitesByAgent: Record<string, EvalSuiteRow[]>;
  suitesLoaded: Record<string, boolean>;
  loading: boolean;
  error: string | null;

  setAgents: (agents: EvalAgentItem[]) => void;
  setSuitesFor: (key: string, suites: EvalSuiteRow[]) => void;
  setLoading: (loading: boolean) => void;
  setError: (err: string | null) => void;
  upsertSuite: (item: EvalSuiteRow) => void;
  removeSuite: (id: string) => void;
  bumpCaseCount: (suiteId: string, delta: number) => void;
}

function agentKey(agentId: string, agentSource: string): string {
  return `${agentId}:${agentSource}`;
}

export const useEvaluationStore = create<EvaluationState>()((set) => ({
  agents: [],
  agentsLoaded: false,
  suitesByAgent: {},
  suitesLoaded: {},
  loading: false,
  error: null,

  setAgents: (agents) => set({ agents, agentsLoaded: true, error: null }),
  setSuitesFor: (key, suites) =>
    set((s) => ({
      suitesByAgent: { ...s.suitesByAgent, [key]: suites },
      suitesLoaded: { ...s.suitesLoaded, [key]: true },
      error: null,
    })),
  setLoading: (loading) => set({ loading }),
  setError: (error) => set({ error }),
  upsertSuite: (item) =>
    set((s) => {
      const key = agentKey(item.agentId, item.agentSource);
      const bucket = (s.suitesByAgent[key] ?? []).slice();
      const idx = bucket.findIndex((it) => it.id === item.id);
      if (idx === -1) bucket.unshift(item);
      else bucket[idx] = item;
      bucket.sort((a, b) => a.name.localeCompare(b.name));
      return { suitesByAgent: { ...s.suitesByAgent, [key]: bucket } };
    }),
  removeSuite: (id) =>
    set((s) => {
      const next: Record<string, EvalSuiteRow[]> = {};
      for (const [key, list] of Object.entries(s.suitesByAgent)) {
        next[key] = list.filter((it) => it.id !== id);
      }
      return { suitesByAgent: next };
    }),
  bumpCaseCount: (suiteId, delta) =>
    set((s) => {
      const next: Record<string, EvalSuiteRow[]> = {};
      for (const [key, list] of Object.entries(s.suitesByAgent)) {
        next[key] = list.map((it) =>
          it.id === suiteId
            ? { ...it, caseCount: Math.max(0, it.caseCount + delta) }
            : it,
        );
      }
      return { suitesByAgent: next };
    }),
}));

// Actions

export interface CreateSuiteInput {
  agentId: string;
  agentSource?: string;
  credentialId?: string | null;
  evaluatorAgentId?: string | null;
  name: string;
  description?: string | null;
  dimensionIds?: string[];
}

export interface PatchSuiteInput {
  name?: string;
  description?: string | null;
  evaluatorAgentId?: string | null;
  dimensionIds?: string[];
  enabled?: boolean;
  visibility?: "private" | "public";
}

async function readErrorMessage(res: Response): Promise<string> {
  const body = (await res.json().catch(() => null)) as
    | { message?: string }
    | null;
  return body?.message ?? `${res.status} ${res.statusText}`;
}

export { agentKey };

export const evalActions = {
  async refreshAgents(): Promise<void> {
    useEvaluationStore.getState().setLoading(true);
    try {
      const res = await fetch("/api/eval-suites/agents");
      if (!res.ok) throw new Error(await readErrorMessage(res));
      const agents = (await res.json()) as EvalAgentItem[];
      useEvaluationStore.getState().setAgents(agents);
    } catch (err) {
      useEvaluationStore
        .getState()
        .setError(err instanceof Error ? err.message : String(err));
    } finally {
      useEvaluationStore.getState().setLoading(false);
    }
  },

  async refreshSuites(agentId: string, agentSource: string = "builtin"): Promise<void> {
    const key = agentKey(agentId, agentSource);
    useEvaluationStore.getState().setLoading(true);
    try {
      const res = await fetch(
        `/api/eval-suites?agentId=${encodeURIComponent(agentId)}&agentSource=${encodeURIComponent(agentSource)}`,
      );
      if (!res.ok) throw new Error(await readErrorMessage(res));
      const suites = (await res.json()) as EvalSuiteRow[];
      useEvaluationStore.getState().setSuitesFor(key, suites);
    } catch (err) {
      useEvaluationStore
        .getState()
        .setError(err instanceof Error ? err.message : String(err));
    } finally {
      useEvaluationStore.getState().setLoading(false);
    }
  },

  async create(input: CreateSuiteInput): Promise<EvalSuiteRow | null> {
    try {
      const res = await fetch("/api/eval-suites", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      if (!res.ok) throw new Error(await readErrorMessage(res));
      const row = (await res.json()) as EvalSuiteRow;
      useEvaluationStore.getState().upsertSuite(row);
      return row;
    } catch (err) {
      useEvaluationStore
        .getState()
        .setError(err instanceof Error ? err.message : String(err));
      return null;
    }
  },

  async patch(id: string, input: PatchSuiteInput): Promise<EvalSuiteRow | null> {
    try {
      const res = await fetch(`/api/eval-suites/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      if (!res.ok) throw new Error(await readErrorMessage(res));
      const row = (await res.json()) as EvalSuiteRow;
      useEvaluationStore.getState().upsertSuite(row);
      return row;
    } catch (err) {
      useEvaluationStore
        .getState()
        .setError(err instanceof Error ? err.message : String(err));
      return null;
    }
  },

  async remove(id: string): Promise<void> {
    try {
      const res = await fetch(`/api/eval-suites/${id}`, { method: "DELETE" });
      if (!res.ok && res.status !== 404) {
        throw new Error(await readErrorMessage(res));
      }
      useEvaluationStore.getState().removeSuite(id);
    } catch (err) {
      useEvaluationStore
        .getState()
        .setError(err instanceof Error ? err.message : String(err));
      throw err;
    }
  },

  async ensureDraftSuite(agentId: string, agentSource: string = "builtin", credentialId?: string): Promise<string | null> {
    const key = agentKey(agentId, agentSource);
    const store = useEvaluationStore.getState();
    if (!store.suitesLoaded[key]) {
      await this.refreshSuites(agentId, agentSource);
    }
    
    // Check again after refresh
    const suites = useEvaluationStore.getState().suitesByAgent[key] ?? [];
    const draftsSuite = suites.find(s => s.name === "Drafts");
    
    if (draftsSuite) {
      return draftsSuite.id;
    }
    
    // Create it
    const newSuite = await this.create({
      agentId,
      agentSource,
      credentialId: credentialId ?? null,
      name: "Drafts",
      dimensionIds: [],
      description: "Auto-generated suite for capturing conversational feedback.",
    });
    
    return newSuite?.id ?? null;
  },
};
