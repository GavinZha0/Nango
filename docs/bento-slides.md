# Bento Presentation Slides Subsystem

> **Audience**: Full-stack engineers, AI agent pipeline developers  
> **See also**: [`docs/outcomes.md`](./outcomes.md), [`docs/orchestrator.md`](./orchestrator.md), [`docs/architecture.md`](./architecture.md)

This document is the authoritative technical design and specification for the **Bento Presentation Slides** subsystem in Nango. It describes the design philosophy, runtime architecture, tool contracts, state machine, incremental partial editing (`insert`, `replace`, `delete`), out-of-order buffering, deterministic replay, catalog bundling, and safety guardrails.

---

## 1. Overview & Motivation

### 1.1 What are Bento Slides?
Bento Presentation Slides are structured, visual, 16:9 (`1280x720`) slide decks rendered inside the ephemeral **Outcomes panel** (`/outcomes`) and chat message threads. Each slide adopts a modern "Bento grid" visual design language—modular cards containing headers, markdown bullet points, data metric callouts, and lightweight visual elements.

### 1.2 The Problem: Generation Fatigue in Large Decks
When LLMs generate presentation decks:
- Generating a complete 15-25 slide deck in a single tool call frequently exhausts output token quotas, causes generation truncation, or leads to hallucinations and structural degradation in late slides.
- Re-generating the *entire* presentation JSON just to fix a typo, add an appendix, or replace a market data table wastes significant tokens, adds latency (20-60s), and unpredictably modifies slides the user was satisfied with.

### 1.3 The Solution: Two-Tool State Machine
The Bento Slides subsystem decomposes presentation authoring into a deterministic two-tool lifecycle:
1. **Creation**: `generate_bento_slides` initializes the base deck structure, global theme, and primary slides.
2. **Incremental Partial Editing**: `edit_bento_slides` performs fine-grained delta operations (`insert`, `replace`, `delete`) without modifying unaffected slides or regenerating the deck.

---

## 2. Core Architecture & Pure Reducer Pattern

```
                       ┌───────────────────────────────┐
                       │          LLM Agent            │
                       └──────────────┬────────────────┘
                                      │ tool calls
                   ┌──────────────────┴──────────────────┐
                   ▼                                     ▼
        generate_bento_slides                     edit_bento_slides
       (initialize base deck)                 (insert / replace / delete)
                   │                                     │
                   └──────────────────┬──────────────────┘
                                      ▼
                        entity_run_event (PostgreSQL)
               (createdAt ASC, seq ASC, ts ASC Total Order)
                                      │
            ┌─────────────────────────┼─────────────────────────┐
            ▼                         ▼                         ▼
   Chat / Outcome Store        Thread Replay           Artifact Saver
   (useOutcomeStore.ts)     (replay-rebuilders.ts)    (save-artifact.ts)
            │                         │                         │
            └─────────────────────────┼─────────────────────────┘
                                      ▼
                         applySlideEdit(baseDoc, edit)
                            Pure Reducer Function
                        (src/lib/outcomes/merge-slides.ts)
                                      ▼
                         { doc: NextDoc, changed: boolean }
```

### 2.1 The Single Source of Truth: `applySlideEdit`
To eliminate calculation drift across the codebase, all three state consumers—the client Zustand store (`useOutcomeStore.ts`), thread reload reconstructor (`replay-rebuilders.ts`), and server-side artifact persister (`save-artifact.ts`)—delegate slide mutations to the exact same pure reducer:

```typescript
export interface SlideEditResult {
  readonly doc: Record<string, unknown>;
  readonly changed: boolean;
}

export function applySlideEdit(
  baseDoc: Record<string, unknown>,
  edit: {
    action: "delete" | "replace" | "insert";
    target_slide_ids?: string[];
    slides?: Array<Record<string, unknown>>;
  },
): SlideEditResult
```

### 2.2 Invariant Guarantees
1. **Purity**: Given `(baseDoc, edit)`, the reducer always returns identical results with zero side-effects.
2. **Referential Stability on No-Op**: If an edit targets non-existent slides, deletes nothing, or inserts an empty list, the reducer returns `{ doc: baseDoc, changed: false }`, preserving strict object identity (`result.doc === baseDoc`).
3. **Single-Track Evolution**: Legacy `append` flags on `generate_bento_slides` are completely retired. All additions, replacements, and deletions flow exclusively through `edit_bento_slides`.

---

## 3. Tool Contracts & Slide ID Immutability

### 3.1 `generate_bento_slides`
- **Purpose**: Creates or completely overwrites a slide deck outcome.
- **Parameters**:
  - `outcome_id` (`string`, required): Unique deck identifier (auto-normalized to kebab-case slug).
  - `title` (`string`, required): Deck presentation title.
  - `description` (`string`, optional): Deck summary.
  - `doc` (`object`, required): Document containing `format: "bento/slides"`, `version: 1`, `size: { width: 1280, height: 720 }`, and `slides: Slide[]`.
- **Risk Classification**: `{ riskLevel: "low", sideEffects: "none", readOnlyHint: true, headlessAllowed: true }`.

### 3.2 `edit_bento_slides`
- **Purpose**: Incremental delta editing of an existing deck.
- **Parameters**:
  - `outcome_id` (`string`, required): Target deck identifier.
  - `action` (`"delete" | "replace" | "insert"`, required): The delta action to execute.
  - `target_slide_ids` (`string[]`, optional): Target slide IDs for deletion/replacement, or the anchor slide ID for insertion.
  - `slides` (`object[]`, optional): Array of new slide definitions (required for `insert` and `replace`).
- **Risk Classification**: Default `{ riskLevel: "low", sideEffects: "write", headlessAllowed: true }`. Escapes dynamically to `{ riskLevel: "high", sideEffects: "destructive", requiresApproval: true }` when `action === "delete"`.

### 3.3 Slide ID Immutability Contract
A primary failure mode in LLM presentation editing is **ID drift** (e.g. LLM generates a slide with ID `market-analysis`, but system renames it to `market-analysis-p1`, causing subsequent replace/delete operations to miss).

The Bento subsystem strictly enforces:
- **No Silent Renaming**: The system NEVER appends `-p{idx}` or timestamp hashes to slide IDs.
- **Strict Validation**: Every slide in `generate` or `insert` must possess an explicit, non-empty string `id`. Missing or duplicate IDs in a single batch fail fast with structured errors (`SLIDE_MISSING_ID` or `DUPLICATE_SLIDE_ID`), prompting the LLM to correct its call.
- **Target ID Preservation on Replace**: On `action: "replace"`, the system guarantees that the new slide retains the exact `target_slide_id` it replaced, even if the LLM provided a hallucinated ID in its payload.

---

## 4. Delta Operations: Insert, Replace, Delete

### 4.1 Insert (`action: "insert"`)
Inserts one or more new slides into the deck relative to an anchor.

| `target_slide_ids` | Placement Behavior |
| :--- | :--- |
| Omitted or `[]` | Appends new slides to the **end** of the deck. |
| `["0"]` | Prepends new slides at the **beginning** of the deck (index 0). |
| `["<slide_id>"]` | Inserts new slides immediately **after** the specified anchor slide. |
| Anchor not found | Defensively falls back to appending at the end of the deck. |

```typescript
// Example: Insert an appendix after slide "summary"
await edit_bento_slides({
  outcome_id: "quarterly-report",
  action: "insert",
  target_slide_ids: ["summary"],
  slides: [
    {
      id: "appendix-a",
      title: "Appendix A: Methodology",
      elements: [{ type: "markdown", content: "Details..." }]
    }
  ]
});
```

### 4.2 Replace (`action: "replace"`)
Replaces existing slides with updated content while preserving positioning and immutable IDs.
- **1-to-1 Mapping**: `target_slide_ids.length` must strictly match `slides.length`. If counts differ, fails fast with `REPLACE_COUNT_MISMATCH`.
- **Target Uniqueness**: `target_slide_ids` must not contain duplicate IDs (`DUPLICATE_TARGET_SLIDE_ID`).
- **Non-existent Targets**: If target slide IDs are not found in the deck, the operation is a safe no-op (`changed: false`).

```typescript
// Example: Update the content of slide "market-outlook"
await edit_bento_slides({
  outcome_id: "quarterly-report",
  action: "replace",
  target_slide_ids: ["market-outlook"],
  slides: [
    {
      title: "Updated 2026 Market Outlook",
      elements: [{ type: "metrics", value: "$4.2B", label: "TAM" }]
    }
  ]
});
```

### 4.3 Delete (`action: "delete"`)
Removes one or more slides from the presentation.
- `target_slide_ids` specifies all IDs to remove.
- `slides` parameter must NOT be provided (rejected with `UNEXPECTED_SLIDES`).
- **Empty Deck Protection**: Attempting to delete all slides is rejected by the reducer guard (`changed: false`) to prevent corrupting the presentation into an unusable zero-slide state.
- **High-Risk Escalation**: Deletions automatically require user approval in the chat UI before execution.

---

## 5. State Machine & Out-of-Order Buffering

In an asynchronous streaming environment, tool execution chunks and SSE updates can occasionally be processed out of order. For example:
- An LLM emits `edit_bento_slides` before the client finishes processing `generate_bento_slides`.
- Edit B (replacing slide `s2`) arrives before Edit A (which inserts slide `s2`).

### 5.1 The `pendingSlideEdits` Buffer
To prevent dropping valid edits or failing unrecoverably, `useOutcomeStore` maintains a thread-isolated pending buffer:

```typescript
interface OutcomeStoreState {
  outcomes: Outcome[];
  // Keyed by outcomeId -> array of buffered unapplied edits
  pendingSlideEdits: Record<string, PendingSlideEdit[]>;
  ...
}
```

### 5.2 Multi-Pass Flush (`flushPendingEdits`)
Whenever an outcome deck is created or an edit successfully applies, the store triggers a multi-pass flush loop:
1. Iterates through the buffered edits for that `outcomeId`.
2. Tests each edit against the current document using `applySlideEdit`.
3. If an edit produces `changed: true`:
   - The document is updated.
   - The edit's `toolCallId` is appended to `appliedToolCallIds`.
   - The edit is removed from the pending buffer.
   - A `hasChanges` flag triggers another iteration (resolving chained dependencies).
4. Unresolvable edits (e.g. referencing an ID that genuinely does not exist) remain safely in the buffer and **never** stamp `appliedToolCallIds`.

---

## 6. Deterministic Total Order & Replay

To ensure thread reloads (`GET /api/threads/[id]/outcomes`) and artifact saving (`saveArtifact`) produce identical decks without race conditions, SQL queries enforce strict three-tier total ordering:

```sql
ORDER BY
  entity_run.created_at ASC,
  entity_run_event.seq ASC,
  entity_run_event.ts ASC
```

### 6.1 Replay Rebuilder
`replay-rebuilders.ts` sequentially feeds events to the reducer:
- `rebuildBentoSlidesOutcome`: Handles `generate_bento_slides` events. Subsequent calls with the same `outcome_id` overwrite the deck; duplicate `toolCallId` events are idempotent.
- `rebuildBentoSlideEditOutcome`: Handles `edit_bento_slides` events. Valid edits update the block and record the `toolCallId`. No-ops (`changed: false`) do not mutate the block.

---

## 7. Catalog Bundling Architecture

### 7.1 Single-Toggle UX vs. Independent Schemas
Per product design guidelines, the user-facing Agent Editor (`BuiltinAgentEditor.tsx`) should display a clean, single checkbox toggle ("Bento presentation slides") rather than confusing users with separate generation and editing checkboxes.

However, workflow graph builders and API tool catalog discovery (`GET /api/tools`) require full parameter schemas for both tools.

### 7.2 The `bundled` Descriptor Pattern
In `src/lib/builtin-tools/catalog.ts`:
1. `BuiltinToolEntry` defines an optional `bundled?: readonly BuiltinToolDescriptor[]` field.
2. `generate_bento_slides` registers as the primary entry in `BUILTIN_TOOLS`, bundling `edit_bento_slides` under its `bundled` property with complete JSON schema:
   ```typescript
   export const BUILTIN_TOOLS: readonly BuiltinToolEntry[] = [
     {
       name: "generate_bento_slides",
       displayName: "Bento presentation slides",
       description: "Generate and incrementally edit Bento presentation slide decks...",
       category: "outcomes",
       input_schema: { ...generateSchema },
       bundled: [
         {
           name: "edit_bento_slides",
           displayName: "edit_bento_slides",
           description: "Incrementally edit Bento presentation slide decks...",
           category: "outcomes",
           input_schema: { ...editSchema },
         }
       ],
       build: () => [buildGenerateBentoSlidesTool(), buildEditBentoSlidesTool()],
     }
   ];
   ```
3. **Consumers**:
   - `listBuiltinToolDescriptors()`: Returns only `BUILTIN_TOOLS`, rendering one toggle in the Agent Editor.
   - `listWorkflowToolDescriptors()`: Flattens `BUILTIN_TOOLS`, all `bundled` companion tools, and `WORKFLOW_AMBIENT_TOOLS` for complete discovery.
   - `WORKFLOW_AMBIENT_TOOLS`: Remains strictly isolated for truly ambient tools (`get_current_datetime`, `extract_dataset_by_sql`), preventing dangerous auto-mounting of editing capabilities.

### 7.3 Workflow DAG Node Synthesis Defense
Slide artifacts are saved as static snapshot artifacts (`viewMode: "snapshot"`). In `src/lib/workflows/build-from-events.ts`, `edit_bento_slides` is filtered out of `dataInvocations` so it is never synthesized into a spurious workflow DAG node.

---

## 8. Safety Guardrails & Delete Approval Flow

Presentation deletion is a destructive operation. The Bento subsystem integrates with Nango's safety pipeline:

### 8.1 Parameter-Level Risk Escalation
In `src/lib/agent-pipeline/risk-registry.ts`:
```typescript
if (toolName === "edit_bento_slides") {
  const action = extractAction(args);
  if (action === "delete") {
    riskLevel = "high";
    sideEffects = "destructive";
    reason = "Deleting slides from presentation";
  }
}
```
When `riskLevel === "high"`, the runner's tool approval middleware pauses execution and creates an approval request for the user.

### 8.2 Approval UI in `SlidesPreviewCard.tsx`
When awaiting approval:
- **Delete Actions**: Render a distinct destructive error shell (`variant="error"`), red `Trash2` icon, and explicit badges highlighting targeted slide IDs:  
  `Delete slides: [slide-2, slide-5]`
- **Insert / Replace**: Render standard presentation icon with action tag and allow seamless progress.
- **Complete**: Renders a single-line compact card with title, action badge (`(deleted s2)`, `(replaced)`, `(inserted)`), and a direct link to view the deck in the Outcomes panel.

---

## 9. Verification & Test Suite

The subsystem is validated by comprehensive unit test suites covering 100% of edge cases:

| Test File | Focus Areas |
| :--- | :--- |
| `tests/unit/lib/outcomes/merge-slides.test.ts` | Reducer operations, partial matches, empty deck guard, `changed` boolean signal, referential stability. |
| `tests/unit/lib/outcomes/runtime-tools.test.ts` | String/empty/null ID validation, intra-batch duplicate rejection, replace ID retention, JSON array parsing defense. |
| `tests/unit/store/outcome-store.test.ts` | Multi-pass out-of-order buffering, dependency chaining, unmatched edit persistence, idempotency. |
| `tests/unit/lib/outcomes/replay-rebuilders.test.ts` | Deterministic event stream reconstruction, duplicate tool call idempotency. |
| `tests/unit/lib/artifacts/save-artifact.test.ts` | Total order replay (`generate -> insert -> replace -> delete`), snapshot extraction, unchanged edit tolerance. |
| `tests/unit/lib/builtin-tools/catalog.test.ts` | Single-toggle editor projection, bundled tool expansion, ambient isolation. |
| `tests/unit/lib/agent-pipeline/risk-registry.test.ts` | Static risk levels, dynamic delete escalation to high risk/destructive. |
