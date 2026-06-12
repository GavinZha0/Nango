# Data Visualization — Outcomes Panel

Current-state reference for the outcomes panel: how chart artifacts
flow from agent tool calls through the persistence layer to the
browser. For the workflow engine that powers artifact refresh, see
[`workflow.md`](./workflow.md).

---

## 1. Architecture

### Detection + rendering pipeline

```
Agent (built-in or backend)
    │  tool_call: generate_echarts_config({ option, ... })
    ▼
PersistingAgent  (universal interception point)
    │  persists tool_call_chunk + tool_call_result to entity_run_event
    ▼
SSE → Browser
    │
    ├─► Outcome Store (Zustand)
    │     • outcomeId = chart_id from tool args
    │     • stores parsed ECharts option + metadata
    │     • thread-scoped; cleared on new chat
    │
    ├─► OutcomesPanel  (/outcomes route)
    │     • collapsible card list
    │     • EChartsRenderer per card
    │     • Save button → artifact + workflow rows
    │
    └─► Chat message renderer
          • replaces inline chart references with preview cards
```

### Core principle

**Tools produce data; the LLM produces charts.** The agent calls
`extract_dataset_by_sql` or `run_code_in_sandbox` for data
acquisition / transformation, then authors the ECharts option JSON
directly via `generate_echarts_config`. The LLM has the context to
choose chart types, colours, and layout — the sandbox does not.

### Two data paths

1. **Simple** — `extract_dataset_by_sql` returns inline rows;
   the agent reads them and authors an ECharts option directly.
2. **Complex** — agent calls `run_code_in_sandbox` for statistical
   transforms (anomaly detection, resampling, etc.), reads the
   sandbox output, then authors the chart.

---

## 2. Key Components

| Component | File | Role |
|---|---|---|
| `generate_echarts_config` | `src/lib/outcomes/runtime-tools.ts` | Server-side tool; validates + persists chart option |
| `OutcomesPanel` | `src/components/workspace/OutcomesPanel.tsx` | Card list UI at `/outcomes` route |
| `OutcomeCard` | `src/components/workspace/OutcomeCard.tsx` | Collapsible card with ECharts renderer |
| `outcome-store` | `src/store/outcome-store.ts` | Zustand store; thread-scoped, keyed by `outcomeId` |
| `useOutcomeTools` | `src/hooks/useOutcomeTools.tsx` | Frontend tool registration for CopilotKit |
| `useSaveOutcome` | `src/hooks/useSaveOutcome.ts` | Save button → `POST /api/artifacts/save` |
| `replay-rebuilders` | `src/lib/outcomes/replay-rebuilders.ts` | Rebuild outcome store from `entity_run_event` on page load |
| `prompt-block` | `src/lib/outcomes/prompt-block.server.ts` | System prompt block describing chart tools to the LLM |
| `schema` | `src/lib/outcomes/schema.ts` | Zod schemas for tool args + ECharts option validation |
| `args-to-content` | `src/lib/outcomes/args-to-content.ts` | Extracts renderable content from tool call arguments |
| Replay API | `src/app/api/threads/[threadId]/outcomes/route.ts` | `GET /api/threads/[id]/outcomes` — event replay |

---

## 3. Data Flow — Save to Artifact

```
User clicks "Save" on OutcomeCard
    │
    ▼
useSaveOutcome → POST /api/artifacts/save
    │  { threadId, outcomeId, name?, parentId? }
    ▼
saveArtifact (src/lib/artifacts/save-artifact.ts)
    │
    ├─ coalesce tool_call_chunk events → ToolInvocation[]
    ├─ buildWorkflowSpecFromRunEvents → LLM-emit spec
    │    • generate_echarts_config → type:"chart" node
    │    • extract_dataset_by_sql → type:"sql" node
    │    • run_code_in_sandbox → type:"code" node
    │    • Strategy Z+ reconstructs @path refs between nodes
    ├─ canonicalize (async, DB-backed) → canonical spec
    ├─ validate → DAG checks, ref reachability
    └─ INSERT workflow + artifact rows (single transaction)
```

### Replay on page load

When the user returns to a thread, outcomes are rebuilt from persisted
events:

```
GET /api/threads/[id]/outcomes
    → query entity_run_event WHERE type IN ('tool_call_chunk', 'tool_call_result')
    → coalesce into ToolInvocation[]
    → filter for chart-producing tools
    → return outcome descriptors

Client: outcome-store.loadForThread(descriptors)
    → repopulate Zustand store
    → OutcomesPanel re-renders
```

---

## 4. ECharts Renderer Constraints

1. **No `dangerouslySetInnerHTML`** — ECharts `option` is data-only
   JSON; no HTML injection surface.
2. **`notMerge: true`** on every `setOption` call — prevents stale
   series from leaking across option updates.
3. **Dispose on unmount** — `echarts.dispose(instance)` in the
   cleanup function to prevent memory leaks.

---

## 5. Backlog

### Not started

- `update_chart` / `remove_chart` / `get_dashboard_state` tools (dashboard manipulation)
- HTML artifact rendering (iframe + postMessage bridge)
- Image artifact rendering
- External agent chart detection (PersistingAgent text-stream scan)
- Plotly HTML iframe path (dual-renderer)

### Deferred to V2

- Artifact library panel (left sidebar, `/artifact` route)
- Save as new version (versioned artifact snapshots)
- Stream-time chart rendering (render while agent is still generating)
- Dashboard persistence (save dashboard layout to DB)
- Chart export (PNG / SVG / PDF)

---

## 6. Related Documents

| Doc | Role |
|---|---|
| [`workflow.md`](./workflow.md) | Workflow engine that powers artifact refresh |
| [`workflow-spec.md`](./workflow-spec.md) | Chart node spec (`type: "chart"`, `inputs.config`, `inputs.dataset`) |
| [`artifact-evolution.md`](./artifact-evolution.md) | Artifact UI engine backlog (HTML, PPT, filters, display model) |
| [`artifact-dashboard-migration.md`](./artifact-dashboard-migration.md) | Artifact tree schema + dashboard composition |
