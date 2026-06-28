"use client";

/**
 * outcomeStore — transient, thread-scoped panel of agent-produced
 * artifacts. Backs `/outcomes`; the `artifact` DB table backs
 * `/artifact`. Save button bridges the two via POST /api/artifacts
 * (writes `savedArtifactId` back into the in-memory outcome).
 *
 * See docs/data-visualization.md.
 */

import { create } from "zustand";

// blocks

/** Visual primitives a Report can be composed of. Each entry has a
 *  dedicated renderer under `components/workspace/blocks/`. Adding a
 *  new block: append the discriminant + a `<KindBlock>` component +
 *  wire it in `BlockList`. */
export type OutcomeBlock = TextBlock | CardListBlock | ChartBlock | HtmlBlock;

export interface TextBlock {
  kind: "text";
  /** Markdown source. Renderer is responsible for sanitisation. */
  markdown: string;
}

/** Source-kind discriminator for citation-aware card-list rows
 *  (drives icon chrome and is paired with {@link CardListItem.index}
 *  in the `[N]` chat citation contract). New citation-aware
 *  producers MUST set it; legacy card lists may omit. See
 *  docs/artifact-evolution.md. */
export type CardListSourceKind = "web" | "kb" | "sql" | "file";

/** Generic "clickable card with thumbnail" — web-search results
 *  today, also suitable for kb retrieval, sql rows, file lookups. */
export interface CardListItem {
  /** 1-based citation number. Producers that don't participate in
   *  the `[N]` citation contract may omit it; renderers fall back to
   *  list position when absent. New citation-aware producers (web_search,
   *  kb_retrieve, etc.) MUST set it monotonically starting at 1.
   *  See docs/artifact-evolution.md. */
  index?: number;
  /** What kind of evidence this card represents. Drives card chrome
   *  (domain favicon for web, doc icon for kb, table-row icon for
   *  sql, file thumbnail for file). Omit for generic non-citation
   *  card lists. */
  sourceKind?: CardListSourceKind;
  /** Hero / thumbnail URL. Renderer falls back to {@link favicon} +
   *  letter avatar when absent. Broken images are dropped silently. */
  image?: string;
  /** Primary heading. Required even when image is present — alt text
   *  for accessibility and a fallback when image fails. */
  title: string;
  /** When provided, the entire card becomes clickable (opens in a
   *  new tab). When absent, the card is a presentation block. */
  url?: string;
  /** Secondary line under the title — typically domain or category. */
  subtitle?: string;
  /** Multi-line excerpt; renderer clamps the visible portion.
   *  CITATION INVARIANT: when {@link sourceKind} is set, this MUST be
   *  the raw upstream snippet (search engine summary, KB passage,
   *  SQL row value) — NOT a re-paraphrased LLM gloss. Provenance is
   *  the whole point of the block-side display. */
  snippet?: string;
  /** Trailing small text under snippet — typically a date or score. */
  meta?: string;
  /** Site icon URL. Used as a small overlay on the image or as the
   *  main visual when {@link image} is absent. */
  favicon?: string;
}

export interface CardListBlock {
  kind: "card_list";
  cards: CardListItem[];
}

export interface ChartBlock {
  kind: "chart";
  /** Full ECharts option JSON (≤ 64 KB; enforced at the handler). */
  option: Record<string, unknown>;
  /** Optional `extract_dataset_by_sql` cache key for traceability. */
  datasetName?: string;
}

export interface HtmlBlock {
  kind: "html";
  /** Complete HTML page source (≤ 512 KB; enforced at the handler).
   *  Rendered inside a sandboxed iframe via `srcdoc`. */
  html: string;
}

// outcome

/** Single value today; kept as a union so future non-block-list
 *  outcome kinds can land without restructuring callers. */
export type OutcomeKind = "report";

interface BaseOutcome {
  /** Stable id chosen by the producer. For server tools this is the
   *  `toolCallId` so client-side `addOutcome` and server-side replay
   *  converge on the same row via `addOutcome`'s upsert semantics. */
  outcomeId: string;
  kind: OutcomeKind;
  title: string;
  description?: string;

  agentId: string;
  /** Null until lazy-capture writes the real id; the
   *  WorkspaceProvider subscriber back-fills via `bindPendingThreadId`.
   *  Server replay always supplies the real id. See
   *  docs/threadid-lifecycle.md. */
  threadId: string | null;
  /** `entity_run.id` from the producing run. Filled by replay; client-
   *  side handlers leave it null. Stored but not yet consumed. */
  runId: string | null;
  createdAt: number;

  /** UI-only — NOT persisted to entity_run_event; reset to `false`
   *  on replay. */
  collapsed: boolean;

  /** `null` until user clicks Save; then the `artifact.id` returned
   *  by POST /api/artifacts. */
  savedArtifactId: string | null;
}

/** The only outcome shape today. `blocks` renders in order via
 *  `BlockList`. Producers like `generate_echarts_config` emit a
 *  single-element `[chart]`; `web_search` emits `[card_list]`;
 *  future composite reports can emit any ordered mix. */
export interface ReportOutcome extends BaseOutcome {
  kind: "report";
  blocks: OutcomeBlock[];
}

export type Outcome = ReportOutcome;

export type OutcomeStatus = "idle" | "loading" | "ready" | "error";

interface OutcomeState {
  /** Outcomes belonging to the CURRENT thread. Cleared on thread switch. */
  outcomes: Outcome[];
  /** Card the user clicked into (preview cards → select on navigate). */
  selectedId: string | null;
  /** "loading" while replay is in flight; UI shows skeleton. */
  status: OutcomeStatus;

  /** Upsert by `outcomeId`. Preserves `savedArtifactId` and
   *  user-toggled `collapsed` across upserts so a regenerate
   *  doesn't unsave the library copy or undo a collapse. */
  addOutcome: (outcome: Outcome) => void;
  removeOutcome: (outcomeId: string) => void;
  toggleCollapse: (outcomeId: string) => void;
  select: (outcomeId: string | null) => void;
  markSaved: (outcomeId: string, savedArtifactId: string) => void;

  /** Called by the workspaceStore threadId subscriber. */
  clearForThreadSwitch: () => void;
  /** Hydrate from /api/threads/[id]/outcomes. */
  loadForThread: (threadId: string) => Promise<void>;
  /** Replace `null` threadId on any in-memory outcomes with the now-
   *  known real id. Called by the WorkspaceProvider subscriber on
   *  the first null → uuid transition for this session. */
  bindPendingThreadId: (threadId: string) => void;
}

// store

export const useOutcomeStore = create<OutcomeState>((set, get) => {
  // Token guard: only the LATEST loadForThread result is persisted;
  // earlier rapid-switch fetches that resolve out of order are
  // dropped. Lives in the closure (not module scope) so HMR can't
  // leave a stale token behind in dev.
  let activeLoadToken: number = 0;

  return {
    outcomes: [],
    selectedId: null,
    status: "idle",

    addOutcome: (outcome) =>
      set((state) => {
        const idx: number = state.outcomes.findIndex(
          (o) => o.outcomeId === outcome.outcomeId,
        );
        if (idx === -1) return { outcomes: [...state.outcomes, outcome] };
        // Carry savedArtifactId + collapsed across re-emits so a
        // producer regenerate doesn't unsave or expand the card.
        const prior: Outcome = state.outcomes[idx];
        const merged: Outcome = {
          ...outcome,
          savedArtifactId: prior.savedArtifactId ?? outcome.savedArtifactId,
          collapsed: prior.collapsed,
        };
        const next: Outcome[] = state.outcomes.slice();
        next[idx] = merged;
        return { outcomes: next };
      }),

    removeOutcome: (outcomeId) =>
      set((state) => ({
        outcomes: state.outcomes.filter((o) => o.outcomeId !== outcomeId),
        selectedId: state.selectedId === outcomeId ? null : state.selectedId,
      })),

    toggleCollapse: (outcomeId) =>
      set((state) => ({
        outcomes: state.outcomes.map((o) =>
          o.outcomeId === outcomeId ? { ...o, collapsed: !o.collapsed } : o,
        ),
      })),

    select: (outcomeId) => set({ selectedId: outcomeId }),

    markSaved: (outcomeId, savedArtifactId) =>
      set((state) => ({
        outcomes: state.outcomes.map((o) =>
          o.outcomeId === outcomeId ? { ...o, savedArtifactId } : o,
        ),
      })),

    clearForThreadSwitch: () =>
      set({ outcomes: [], selectedId: null, status: "idle" }),

    bindPendingThreadId: (threadId) =>
      set((state) => ({
        outcomes: state.outcomes.map((o) =>
          o.threadId === null ? { ...o, threadId } : o,
        ),
      })),

    loadForThread: async (threadId) => {
      activeLoadToken += 1;
      const myToken: number = activeLoadToken;
      set({ status: "loading" });
      try {
        const res: Response = await fetch(
          `/api/threads/${encodeURIComponent(threadId)}/outcomes`,
        );
        if (!res.ok) throw new Error(`replay failed: ${res.status}`);
        const body: { outcomes: Outcome[] } = await res.json();
        // Drop late responses for older thread switches.
        if (myToken !== activeLoadToken) return;
        // Merge instead of replace so local outcomes added during
        // the fetch survive. Server wins on any overlapping id —
        // it carries the canonical runId / threadId.
        set((state) => {
          const serverIds: Set<string> = new Set(
            body.outcomes.map((o) => o.outcomeId),
          );
          const localOnly: Outcome[] = state.outcomes.filter(
            (o) => !serverIds.has(o.outcomeId),
          );
          return {
            outcomes: [...body.outcomes, ...localOnly],
            status: "ready",
          };
        });
      } catch (err) {
        if (myToken !== activeLoadToken) return;
        set({ status: "error" });
        // ArtifactPanel surfaces "Failed to load — Retry".
        console.error("[outcomeStore] loadForThread failed:", err);
      }
      // suppress unused warning when get is not used in some paths
      void get;
    },
  };
});
