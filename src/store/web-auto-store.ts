import { create } from "zustand";

export interface WebAutoSuiteRow {
  id: string;
  parentId: string | null;
  name: string;
  description: string | null;
  variables: Record<string, unknown>;
  enabled: boolean;
  visibility: "private" | "public";
  timeoutSec: number;
  evaluatorAgentId: string | null;
  mcpServerId: string | null;
  createdBy: string;
  updatedBy: string | null;
  createdAt: string;
  updatedAt: string;
  caseCount: number;
}

export interface WebAutoCaseRow {
  id: number;
  suiteId: string;
  name: string;
  description: string | null;
  scriptContent: string | null;
  assertions: unknown;
  enabled: boolean;
  createdBy: string;
  updatedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WebAutoTarget {
  id: string;
  name: string;
  suites: WebAutoSuiteRow[];
}
export type WebAutoGroup = WebAutoTarget;

interface WebAutoStore {
  suites: WebAutoSuiteRow[];
  loaded: boolean;
  loading: boolean;
  error: string | null;
  expandedGroups: Record<string, boolean>;
  selectedCaseId: number | null;

  setSuites: (suites: WebAutoSuiteRow[]) => void;
  setLoading: (loading: boolean) => void;
  setError: (err: string | null) => void;
  setSelectedCaseId: (id: number | null) => void;
  upsert: (suite: WebAutoSuiteRow) => void;
  remove: (id: string) => void;
  toggleGroup: (id: string) => void;
  bumpCaseCount: (suiteId: string, delta: number) => void;
}

export const useWebAutoStore = create<WebAutoStore>((set, _get) => ({
  suites: [],
  loaded: false,
  loading: false,
  error: null,
  expandedGroups: {},
  selectedCaseId: null,

  setSuites: (suites) => set({ suites, loaded: true, error: null }),
  setLoading: (loading) => set({ loading }),
  setError: (error) => set({ error }),
  setSelectedCaseId: (id) => set({ selectedCaseId: id }),
  
  upsert: (suite) =>
    set((state) => {
      const idx = state.suites.findIndex((it) => it.id === suite.id);
      const newSuites = [...state.suites];
      if (idx === -1) {
        newSuites.push(suite);
      } else {
        newSuites[idx] = suite;
      }
      // Sort alphabetically by name
      newSuites.sort((a, b) => a.name.localeCompare(b.name));
      return { suites: newSuites };
    }),
    
  remove: (id) =>
    set((state) => {
      const newSuites = state.suites.filter((s) => s.id !== id && s.parentId !== id);
      return { suites: newSuites };
    }),

  toggleGroup: (id) =>
    set((state) => ({
      expandedGroups: {
        ...state.expandedGroups,
        [id]: !state.expandedGroups[id],
      },
    })),

  bumpCaseCount: (suiteId, delta) =>
    set((state) => {
      const idx = state.suites.findIndex((s) => s.id === suiteId);
      if (idx === -1) return state;
      const newSuites = [...state.suites];
      const suite = newSuites[idx];
      newSuites[idx] = { ...suite, caseCount: Math.max(0, suite.caseCount + delta) };
      return { suites: newSuites };
    }),
}));

// Derived selector to build the 2-level tree alphabetically sorted
export function useWebAutoTree(): WebAutoGroup[] {
  const suites = useWebAutoStore((s) => s.suites);
  
  // suites are already sorted by name due to GET route and upsert sort.
  const groups: Record<string, WebAutoGroup> = {};
  
  // 1. First pass: Collect all parent nodes
  for (const s of suites) {
    if (s.parentId === null) {
      groups[s.id] = {
        id: s.id,
        name: s.name,
        suites: [], // will populate in second pass
      };
    }
  }
  
  // 2. Second pass: Place children into their parent's suites array
  for (const s of suites) {
    if (s.parentId !== null && groups[s.parentId]) {
      groups[s.parentId].suites.push(s);
    }
  }

  // Object.values returns values, we need to sort groups by name.
  // The children inside groups are already sorted because we iterate over `suites` which is sorted.
  const groupArray = Object.values(groups);
  groupArray.sort((a, b) => a.name.localeCompare(b.name));
  
  return groupArray;
}
