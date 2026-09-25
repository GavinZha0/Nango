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
import { applySlideEdit } from "@/lib/outcomes/merge-slides";
import { normalizeOutcomeId } from "@/lib/outcomes/schema";

// blocks

/** Visual primitives a Report can be composed of. Each entry has a
 *  dedicated renderer under `components/workspace/blocks/`. Adding a
 *  new block: append the discriminant + a `<KindBlock>` component +
 *  wire it in `BlockList`. */
export type OutcomeBlock = TextBlock | CardListBlock | ChartBlock | HtmlBlock | ImageBlock | SlideBlock;

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

export interface ImageBlock {
  kind: "image";
  /** URL (e.g. /api/media/tool-image/xxx) or data:image/...;base64,... */
  src: string;
  mimeType?: string;
  alt?: string;
  caption?: string;
}

export interface SlideBlock {
  kind: "slide";
  /** Complete Bento slides JSON document. Rendered via Bento HTML template in sandboxed iframe. */
  doc: Record<string, unknown>;
  /** Optional title to fall back to when doc.title is omitted */
  title?: string;
  /** Track all toolCallIds applied to this slide deck to ensure idempotent incremental appending */
  appliedToolCallIds?: string[];
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

export interface UpsertSlideOutcomeInput {
  outcomeId: string;
  title: string;
  description?: string;
  doc: Record<string, unknown>;
  toolCallId: string;
  agentId: string;
  threadId: string | null;
  runId: string | null;
}

export interface ApplySlideEditOutcomeInput {
  outcomeId: string;
  action: "delete" | "replace" | "insert";
  target_slide_ids?: string[];
  slides?: Array<Record<string, unknown>>;
  toolCallId: string;
}

interface OutcomeState {
  /** Outcomes belonging to the CURRENT thread. Cleared on thread switch. */
  outcomes: Outcome[];
  /** Card the user clicked into (preview cards → select on navigate). */
  selectedId: string | null;
  /** "loading" while replay is in flight; UI shows skeleton. */
  status: OutcomeStatus;
  /** Thread-scoped buffer of slide edits waiting for the deck to initialize or dependent slides to appear */
  pendingSlideEdits: Record<string, ApplySlideEditOutcomeInput[]>;

  /** Upsert by `outcomeId`. Preserves `savedArtifactId` and
   *  user-toggled `collapsed` across upserts so a regenerate
   *  doesn't unsave the library copy or undo a collapse. */
  addOutcome: (outcome: Outcome) => void;
  /** Specialized upsert for Bento Slides supporting idempotent generation/overwriting
   *  without module-level state. */
  upsertSlideOutcome: (input: UpsertSlideOutcomeInput) => void;
  /** Incremental edit (delete, replace, insert) applied to existing Bento Slides. */
  applySlideEditOutcome: (input: ApplySlideEditOutcomeInput) => void;
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

/**
 * Pure helper to flush pending slide edits against a slide deck doc.
 * Uses a multi-pass approach so that an earlier edit can unblock a dependent later edit.
 */
function flushPendingEdits(
  baseDoc: Record<string, unknown>,
  appliedIds: string[],
  pending: ApplySlideEditOutcomeInput[],
): {
  doc: Record<string, unknown>;
  appliedIds: string[];
  remainingPending: ApplySlideEditOutcomeInput[];
} {
  let doc = baseDoc;
  const nextApplied = [...appliedIds];
  let unapplied = [...pending];
  let madeProgress = true;

  while (madeProgress && unapplied.length > 0) {
    madeProgress = false;
    const nextUnapplied: ApplySlideEditOutcomeInput[] = [];

    for (const edit of unapplied) {
      if (nextApplied.includes(edit.toolCallId)) {
        continue;
      }
      const res = applySlideEdit(doc, {
        action: edit.action,
        target_slide_ids: edit.target_slide_ids,
        slides: edit.slides,
      });

      if (res.changed) {
        doc = res.doc;
        nextApplied.push(edit.toolCallId);
        madeProgress = true;
      } else {
        nextUnapplied.push(edit);
      }
    }

    unapplied = nextUnapplied;
  }

  return {
    doc,
    appliedIds: nextApplied,
    remainingPending: unapplied,
  };
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
    pendingSlideEdits: {},

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

    upsertSlideOutcome: (input) =>
      set((state) => {
        const normId = normalizeOutcomeId(input.outcomeId);
        const idx = state.outcomes.findIndex(
          (o) => normalizeOutcomeId(o.outcomeId) === normId,
        );

        const prior = idx !== -1 ? state.outcomes[idx] : undefined;
        const priorSlideBlock = prior?.blocks.find(
          (b): b is SlideBlock => b.kind === "slide",
        );

        // CONTRACT: Idempotency check — if this toolCallId was already applied to the deck,
        // short-circuit return to prevent duplicate resets during remounts or StrictMode.
        if (priorSlideBlock?.appliedToolCallIds?.includes(input.toolCallId)) {
          return state;
        }

        // Flush any pending edits that arrived before generate_bento_slides
        const pendingForThis = state.pendingSlideEdits[normId] ?? [];
        const flushed = flushPendingEdits(
          input.doc,
          [input.toolCallId],
          pendingForThis,
        );

        const nextPending = { ...state.pendingSlideEdits };
        if (flushed.remainingPending.length > 0) {
          nextPending[normId] = flushed.remainingPending;
        } else {
          delete nextPending[normId];
        }

        const nextTitle = input.title || prior?.title || "Bento Presentation";
        const nextDescription = input.description ?? prior?.description;

        const updatedSlideBlock: SlideBlock = {
          kind: "slide",
          doc: flushed.doc,
          title: nextTitle,
          appliedToolCallIds: flushed.appliedIds,
        };

        if (!prior) {
          const outcome: Outcome = {
            outcomeId: input.outcomeId,
            kind: "report",
            title: nextTitle,
            description: nextDescription,
            blocks: [updatedSlideBlock],
            agentId: input.agentId,
            threadId: input.threadId,
            runId: input.runId,
            createdAt: Date.now(),
            collapsed: false,
            savedArtifactId: null,
          };
          return {
            outcomes: [...state.outcomes, outcome],
            pendingSlideEdits: nextPending,
          };
        }

        const merged: Outcome = {
          ...prior,
          title: nextTitle,
          description: nextDescription,
          blocks: [updatedSlideBlock],
        };

        const nextOutcomes = state.outcomes.slice();
        nextOutcomes[idx] = merged;
        return {
          outcomes: nextOutcomes,
          pendingSlideEdits: nextPending,
        };
      }),

    applySlideEditOutcome: (input) =>
      set((state) => {
        const normId = normalizeOutcomeId(input.outcomeId);
        const idx = state.outcomes.findIndex(
          (o) => normalizeOutcomeId(o.outcomeId) === normId,
        );

        // 1. If deck does not exist yet, buffer in pendingSlideEdits
        if (idx === -1) {
          const existingPending = state.pendingSlideEdits[normId] ?? [];
          if (existingPending.some((p) => p.toolCallId === input.toolCallId)) {
            return state;
          }
          return {
            pendingSlideEdits: {
              ...state.pendingSlideEdits,
              [normId]: [...existingPending, input],
            },
          };
        }

        const prior = state.outcomes[idx]!;
        const priorSlideBlock = prior.blocks.find(
          (b): b is SlideBlock => b.kind === "slide",
        );
        if (!priorSlideBlock || !priorSlideBlock.doc) {
          const existingPending = state.pendingSlideEdits[normId] ?? [];
          if (existingPending.some((p) => p.toolCallId === input.toolCallId)) {
            return state;
          }
          return {
            pendingSlideEdits: {
              ...state.pendingSlideEdits,
              [normId]: [...existingPending, input],
            },
          };
        }

        // CONTRACT: Idempotency check with appliedToolCallIds
        if (priorSlideBlock.appliedToolCallIds?.includes(input.toolCallId)) {
          return state;
        }

        // 2. Try applying directly
        const editRes = applySlideEdit(priorSlideBlock.doc, {
          action: input.action,
          target_slide_ids: input.target_slide_ids,
          slides: input.slides,
        });

        // 3. If not changed (e.g. out-of-order target not created yet), buffer into pending
        if (!editRes.changed) {
          const existingPending = state.pendingSlideEdits[normId] ?? [];
          if (existingPending.some((p) => p.toolCallId === input.toolCallId)) {
            return state;
          }
          return {
            pendingSlideEdits: {
              ...state.pendingSlideEdits,
              [normId]: [...existingPending, input],
            },
          };
        }

        // 4. Edit succeeded! Now flush any other pending edits waiting for this state
        const initialApplied = [
          ...(priorSlideBlock.appliedToolCallIds ?? []),
          input.toolCallId,
        ];
        const pendingForThis = state.pendingSlideEdits[normId] ?? [];
        const flushed = flushPendingEdits(
          editRes.doc,
          initialApplied,
          pendingForThis,
        );

        const nextPending = { ...state.pendingSlideEdits };
        if (flushed.remainingPending.length > 0) {
          nextPending[normId] = flushed.remainingPending;
        } else {
          delete nextPending[normId];
        }

        const merged: Outcome = {
          ...prior,
          blocks: prior.blocks.map((b) =>
            b.kind === "slide"
              ? {
                  ...b,
                  doc: flushed.doc,
                  appliedToolCallIds: flushed.appliedIds,
                }
              : b,
          ),
        };

        const nextOutcomes = state.outcomes.slice();
        nextOutcomes[idx] = merged;
        return {
          outcomes: nextOutcomes,
          pendingSlideEdits: nextPending,
        };
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
      set({ outcomes: [], selectedId: null, status: "idle", pendingSlideEdits: {} }),

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
