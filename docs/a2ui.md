# A2UI (Generative UI) Architecture

> Audience: Full-stack engineers, frontend developers
> See also: [`outcomes.md`](./outcomes.md), [`artifact.md`](./artifact.md), [`runner-events.md`](./runner-events.md)

Nango supports **A2UI v1.0** (`generative-ui-surface`) via CopilotKit's `render_ui` tool. Rather than embedding large interactive surfaces directly inside chat bubbles, Nango routes completed surfaces to the **Outcomes** panel (`/outcomes`) and supports persisting them as static snapshot **Artifacts** (`type = "a2ui"`).

---

## 1. Design Principles & Boundaries

1. **Chat stays compact**: Chat messages render only a lightweight `A2uiPreviewCard` (`streaming` spinner or one-click link to `/outcomes`). Full surfaces render in `OutcomesPanel` and `ArtifactDetail`.
2. **Independent rendering stack**: `A2uiBlockRenderer` uses CopilotKit's native `standardUI` + `SurfaceView` (backed by `recharts` for `Chart` components) inside a local `GenerativeUIRuntimeContext`. It has **zero dependency on `EChartsRenderer`** and works outside `CopilotKitProvider` (e.g., `/artifacts/[id]` or when the active agent has `generativeUiEnabled = false`).
3. **Server-side provenance on save**: Saving an A2UI outcome (`genui:<surfaceId>`) reconstructs the surface on the server from persisted `entity_run_event` rows rather than trusting a client-posted payload.
4. **Read-only persisted views**: Surfaces in `/outcomes` and `/artifacts` are read-only snapshots (`forwardEvent` returns `handler_failed`).

---

## 2. Configuration & Agent Wiring

- **Admin component allowlist**: `parseGenerativeUiComponents` / `serializeGenerativeUiComponents` (`src/lib/generative-ui/catalog.ts`) filter standard A2UI components. `buildGenerativeUiConfig` (`src/lib/copilot/generative-ui.ts`) builds a `"nango/workspace@1"` catalog passed to `<CopilotKitProvider generativeUI={...}>` in `src/components/layout/RightPanel.tsx`.
- **Per-agent toggle**: `builtin_agent.generative_ui_enabled` (`src/lib/db/schema.ts`, exposed via `BuiltinAgentEditor.tsx` and `/api/builtin-agents`).
- **Prompt priority guidance**: In `src/lib/runner/dispatch/builtin.ts`, when `spec.generativeUiEnabled` is true alongside `generate_echarts_config` or `generate_html_page`, a `## UI & Visualization Tool Priority` block instructs the model to prefer `render_ui` first for structured layouts, cards, tables, tabs, reports, and standard charts.

---

## 3. Runtime Stream, Normalization & Persistence

```text
BuiltInAgent (LLM)
  │  TOOL_CALL_START ("render_ui") + TOOL_CALL_ARGS + TOOL_CALL_END
  ▼
wrapWithRenderUiNormalizer  (src/lib/runner/persisting-agent.ts)
  │  Buffers render_ui args until TOOL_CALL_END;
  │  runs normalizeRenderUiArgsJson() to repair outer-level nesting mistakes
  ▼
CopilotKit GenerativeUIMiddleware
  │  Validates A2UI v1.0 operations against catalog manifest;
  │  emits ACTIVITY_SNAPSHOT / ACTIVITY_DELTA (activityType = "generative-ui-surface")
  │  and TOOL_CALL_RESULT ({ status, applied, rejected })
  ▼
PersistingAgent tee
  ├──► SSE stream to client (A2uiPreviewCard + useA2UiOutcomeTap)
  └──► entity_run_event table (activity_snapshot, activity_delta)
```

- **Why `wrapWithRenderUiNormalizer` exists**: CopilotKit declares `render_ui.operations.items` as `{ type: "object" }`, and some models (e.g. DeepSeek) occasionally emit `components` / `surfaceId` at the outer operation object alongside an empty `updateComponents: { components: [] }`. Because `render_ui` is a middleware tool (`finishReason: "tool-calls"` ends the LLM step without looping `rejected` back to the model), `normalizeRenderUiArgsJson` (`src/lib/generative-ui/surface.ts`) performs narrow, unambiguous structural hoisting before validation. Text messages and all other tool calls pass through unbuffered.

---

## 4. Live Capture & Server Replay

Both paths use the isomorphic helpers in `src/lib/generative-ui/surface.ts` and converge on the same `Outcome` key `genui:<surfaceId>`:

| Path | Source | `outcomeId` | `revision` |
|---|---|---|---|
| **Live tap** (`src/hooks/useA2UiOutcomeTap.ts`) | `agent.subscribe({ onMessagesChanged })` for `generative-ui-surface` messages with `status === "ready"` | `genui:<surfaceId>` | `String(surface.operations.length)` |
| **Replay** (`GET /api/threads/[threadId]/outcomes`) | `entity_run_event` rows (`activity_snapshot` + `activity_delta`), folded via `applySurfaceDelta` and `rebuildA2UiOutcome` | `genui:<surfaceId>` | `String(surface.operations.length)` |

- **Multi-turn updates**: By A2UI protocol, `createSurface` establishes a unique `surfaceId` (with deterministic `messageId = genui:<surfaceId>`), and follow-up turns emit `ACTIVITY_DELTA` on the same `messageId` to append `updateComponents` / `updateDataModel`. Upserting by `genui:<surfaceId>` updates the existing Outcome card in place.

---

## 5. Standalone Rendering (`A2uiBlockRenderer`)

`A2uiBlockRenderer` (`src/components/workspace/blocks/A2uiBlock.tsx`) renders `A2uiBlock` in both `OutcomesPanel` (`size="compact"`, `max-h-[420px]`) and `ArtifactDetail` (`size="large"`, `max-h-[720px]`):

1. Resolves the catalog (`standardUI` for `STANDARD_CATALOG_ID`, or `createGenerativeUI({ id: catalogId, extends: [standardUI], components: {} })` for trimmed catalogs like `"nango/workspace@1"`).
2. Instantiates a local `GenerativeUISurfaceManager(ui)` and ingests `block.surface`.
3. Provides `GenerativeUIRuntimeContext.Provider` with `createGenerativeUIDispatcher` and `theme` synced to `next-themes` (`DARK_THEME` when dark).
4. Renders `<SurfaceView surface={surface} />`.
5. Displays an amber warning banner (including `rejected[0].reason`) if `block.surface.rejected` or `surface.clientRejected` is non-empty.

---

## 6. Artifact Persistence & Re-save (`source_revision`)

- **Type & category**: `"a2ui"` is registered in `ARTIFACT_TYPES` and `SEED_CATEGORIES` (`{ name: "A2UI", types: ["a2ui"] }`) in `src/lib/domain/artifact.ts`. `assembleTree` (`src/lib/artifacts/service.ts`) auto-seeds missing system categories for existing users.
- **Saving (`saveA2uiArtifact` in `src/lib/artifacts/save-artifact.ts`)**:
  - `POST /api/artifacts/save` delegates `genui:*` outcomes to `saveA2uiArtifact`.
  - Queries `entity_run_event` for `activity_snapshot` / `activity_delta` in the thread, folds with `applySurfaceDelta`, and validates with `parseSurfaceContent`.
  - Inserts a workflow-less artifact (`workflowId: null`, `workflowOutputField: null`, `viewMode: "snapshot"`) storing the folded surface in both `config.surface` and `snapshot`, plus `sourceRevision`.
  - `findExistingArtifactIn` intentionally returns workflow-less rows so re-saves (and lost concurrent insert races) update `config.surface`, `snapshot`, `snapshotAt`, and `sourceRevision` in place instead of colliding with `artifact_source_unique_idx`.
- **Staleness & Re-save UX**:
  - `artifact.source_revision` (`0008_artifact_source_revision.sql`) persists the saved `revision`, and replay backfills `Outcome.savedRevision`.
  - `isOutcomeStale` (`src/store/outcome-store.ts`) returns `true` when `savedArtifactId !== null && savedRevision !== null && savedRevision !== revision`.
  - `OutcomeCard` (`src/components/workspace/OutcomeCard.tsx`) switches the green check to a direct **Re-save** button (no dialog) when stale; `useSaveOutcome` updates the existing artifact and shows `"Artifact updated"`.

---

## 7. Key Files

| File | Responsibility |
|---|---|
| `src/lib/generative-ui/surface.ts` | Isomorphic `applySurfaceDelta`, `parseSurfaceContent`, `extractSurfaceTitle`, `normalizeRenderUiArgsJson` |
| `src/lib/generative-ui/catalog.ts` | Standard component list & admin config serialization |
| `src/lib/copilot/generative-ui.ts` | `buildGenerativeUiConfig` for `CopilotKitProvider` |
| `src/lib/runner/persisting-agent.ts` | `wrapWithRenderUiNormalizer` + `GenerativeUIMiddleware` tee |
| `src/components/right-panels/A2uiPreviewCard.tsx` | Compact inline chat card linking to `/outcomes` |
| `src/hooks/useA2UiOutcomeTap.ts` | Live client capture into `outcomeStore` |
| `src/lib/outcomes/replay-rebuilders.ts` | `rebuildA2UiOutcome` for thread history replay |
| `src/components/workspace/blocks/A2uiBlock.tsx` | Standalone `SurfaceView` + `standardUI` renderer |
| `src/lib/artifacts/save-artifact.ts` | `saveA2uiArtifact` snapshot reconstruction & refresh |
| `src/components/main-panels/ArtifactDetail.tsx` | Renders saved `type === "a2ui"` snapshot artifacts |
| `tests/unit/lib/generative-ui/surface.test.ts` | Unit tests for delta folding, replay, and arg repair |
