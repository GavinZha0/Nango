"use client";

/**
 * outcomeStore — transient, thread-scoped panel of agent-produced
 * artifacts, modelled as a list of blocks per outcome.
 *
 * Two surfaces NOT to confuse (see `docs/data-visualization.md` §6.7):
 *  - This store backs `/outcomes` (current chat's transient panel).
 *  - The `artifact` DB table backs the `/artifact` library
 *    (permanent, user-managed). The bridge is the Save button which
 *    calls POST `/api/artifacts` and writes back `savedArtifactId`.
 *
 * BLOCK MODEL (since Phase 2):
 *
 * Every outcome carries a `blocks: OutcomeBlock[]` body composed of
 * visual primitives. New producers (search, chart, future "report"
 * agents) target the same `ReportOutcome` shape — they just emit a
 * different blocks array. The renderer (`BlockList` →
 * `<TextBlock> / <CardListBlock> / <ChartBlock>`) dispatches by
 * `block.kind`, so adding a new producer never touches the outcome
 * UI shell. Editing / composition of saved outcomes happens on the
 * `/artifact` page, NOT here.
 *
 * State lifecycle:
 *  - Frontend tool handler (`render_chart`)             → `addOutcome`
 *  - Server tool renderer side-effect (`web_search`)    → `addOutcome`
 *  - Save button                                         → POST → `markSaved`
 *  - Card collapse click                                 → `toggleCollapse`
 *  - workspaceStore.runtimeThreadId change → `clearForThreadSwitch` + `loadForThread`
 *  - `/outcomes` page mount on cold       → `loadForThread(currentThreadId)`
 *
 * @see docs/data-visualization.md §6.7
 */

import { create } from "zustand";

// blocks

/**
 * Visual primitives a Report can be composed of. Each entry has a
 * dedicated React renderer under `components/workspace/blocks/`.
 *
 * Adding a new block: append a discriminant here + add a
 * `<KindBlock>` component + wire it in `BlockList`. The outcome
 * shell, replay layer, and save/load paths are agnostic.
 */
export type OutcomeBlock = TextBlock | CardListBlock | ChartBlock;

export interface TextBlock {
  kind: "text";
  /** Markdown source. Renderer is responsible for sanitisation. */
  markdown: string;
}

/**
 * Discriminator for the kind of source a {@link CardListItem}
 * represents. Drives type-specific decoration in the renderer
 * (domain icon for web, doc icon for kb, etc.) and is part of the
 * citation contract: the agent emits `[N]` references in chat text
 * that correspond to a card's {@link CardListItem.index}.
 *
 * Optional for backwards compatibility with existing card_list
 * producers that don't yet carry citation semantics; new producers
 * (web_search, future kb_retrieve, etc.) MUST set it.
 *
 * @see docs/artifact-evolution.md §3.6 (citation-driven artifacts)
 */
export type CardListSourceKind = "web" | "kb" | "sql" | "file";

/**
 * One row in a {@link CardListBlock}. Designed as a generic
 * "clickable card with thumbnail" — web search results today;
 * future producers (artifact lists, GitHub repo lists, paper feeds,
 * KB retrieval, SQL rows, file lookups) reuse the same shape.
 *
 * CITATION CONTRACT (since P1g): items emitted by evidence-driven
 * tools (web_search, kb_retrieve, etc.) carry {@link index} +
 * {@link sourceKind}. The agent is then instructed (via the tool's
 * description) to reference these in chat text as `[1]`, `[2]`, …
 * matching the index. The user visually cross-references between
 * `[N]` markers in chat and the numbered cards rendered here.
 * Interactive `[N]` (click → popover / scroll / highlight) is V2;
 * V1 ships static numbered display only.
 */
export interface CardListItem {
  /** 1-based citation number. Producers that don't participate in
   *  the `[N]` citation contract may omit it; renderers fall back to
   *  list position when absent. New citation-aware producers (web_search,
   *  kb_retrieve, etc.) MUST set it monotonically starting at 1.
   *  @see docs/artifact-evolution.md §3.6 */
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

// outcome

/**
 * Outcome kind discriminator. Single value today — the block model
 * makes every outcome a "report" composed of blocks; the union is
 * preserved as a `type` (rather than collapsing to a constant) so
 * future kinds that ARE NOT block lists (e.g. an arbitrary HTML
 * payload) can land without restructuring callers.
 */
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
  /** Null when the handler ran before lazy-capture wrote ABC into
   *  `workspaceStore.runtimeThreadId` (see
   *  docs/threadid-lifecycle.md). The WorkspaceProvider subscriber
   *  back-fills it as soon as the real id arrives. Server replay
   *  always supplies the real id. */
  threadId: string | null;
  /** `entity_run.id` of the producing run. Handler can't see it
   *  client-side; the replay endpoint fills it from
   *  `entity_run_event.run_id`. Stored but not consumed in V1. */
  runId: string | null;
  createdAt: number;

  /** UI-only — NOT persisted to entity_run_event; reset to `false`
   *  on replay. */
  collapsed: boolean;

  /** `null` until user clicks Save; then the `artifact.id` returned
   *  by POST /api/artifacts. */
  savedArtifactId: string | null;
}

/**
 * The only outcome shape today. `blocks` is rendered in order by
 * `BlockList`. Producers compose:
 *
 *   - `render_chart`  → `[{kind:"chart", option, datasetName?}]`
 *   - `web_search`    → `[{kind:"card_list", cards: [...]}]`
 *   - future "report" → e.g. `[text, chart, text, card_list]`
 */
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

  /**
   * Upsert by `outcomeId`. CONTRACT: if an existing outcome has
   * `savedArtifactId` set, the new entry inherits it (overwriting
   * an already-saved outcome does NOT un-save the library copy —
   * see §6.7 overwrite-after-save contract). User-toggled
   * `collapsed` is also preserved across upserts so a regenerate
   * doesn't undo "I collapsed this".
   */
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
  /**
   * Tracks the active `loadForThread` request so concurrent thread
   * switches (rapid clicks) only persist the LATEST result. Earlier
   * fetches that resolve out of order are dropped.
   *
   * Lives inside `create()`'s closure rather than at module scope —
   * in Next.js HMR a module-level `let` can survive a hot reload
   * and leave a stale token behind, leading to dropped legitimate
   * responses in development. Each fresh store instance gets a
   * fresh counter.
   */
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
        // Preserve user-visible UI state (savedArtifactId, collapsed)
        // when a producer overwrites with the same outcomeId. Without
        // `collapsed` carry-over the user's "I collapsed this" is
        // silently undone every time the producer re-emits the same
        // id (see §6.7 overwrite-after-save contract).
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
        // Merge instead of replace: outcomes added locally between the
        // fetch's start and finish (e.g. user types `make a chart`
        // immediately after switching threads, agent fires render_chart,
        // handler calls addOutcome before our fetch returns) would be
        // wiped out by a naive `set({ outcomes: body.outcomes })`.
        // Server's copy wins for any overlapping outcomeId — it carries
        // the canonical runId / threadId, and a local addOutcome over
        // the same id is itself an upsert of the same outcome.
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
