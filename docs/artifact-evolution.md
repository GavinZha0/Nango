# Artifact System Evolution

Current state and backlog for the artifact subsystem — the **UI
engine** that renders saved data products. For the **data engine**
(workflow DAG, refresh, SQL extraction), see
[`workflow.md`](./workflow.md).

Separate from:
- [`artifact-dashboard-migration.md`](./artifact-dashboard-migration.md) —
  tree schema + dashboard composition (shipped)
- [`data-visualization.md`](./data-visualization.md) — chat-time
  chart generation flow (outcomes panel)

---

## 1. Architecture Principle — Data Engine ↔ UI Engine

The artifact subsystem owns the **UI engine**: chart type, ECharts
option skeleton, HTML config, filters, display mode. The workflow
subsystem owns the **data engine**: DAG, SQL, Python transforms,
refresh, cache.

They meet via two columns on the `artifact` table:
- `workflow_id` — FK to the backing workflow row
- `workflow_output_field` — names a key in `workflow.spec.outputs`

A single workflow can power **many** artifacts with different UI
configurations (1:N relationship). Deleting an artifact does not
delete the workflow; deleting a workflow cascades to artifacts.

---

## 2. Current State

### Shipped

| Capability | Notes |
|---|---|
| Artifact tree + folders | Hierarchical organization, drag-reorder |
| Save-from-outcomes | `POST /api/artifacts/save` captures chat tool chain → workflow + artifact rows |
| Workflow integration | `artifact.workflow_id` FK, execute-on-GET (snapshot mode), refresh via POST |
| Artifact snapshot | `snapshot` JSONB + `snapshot_at` + `view_mode` (snapshot / live); `POST /api/artifacts/[id]/snapshot` |
| Chart rendering (ECharts) | `<EChartsRenderer />` consumes merged option from workflow engine |
| Citation infrastructure | Numbered `[N]` citations in chat text → numbered raw-snippet cards in outcomes panel |
| Workflow graph visualization | Read-only ReactFlow DAG view on artifact detail page |
| Dashboard composition | Dashboard artifact type with tile layout referencing child artifacts |

### Partial

| Capability | Backend | Frontend |
|---|---|---|
| Refresh + visual update | Endpoint works, engine re-runs | No refresh button, no live data merge into chart |
| Admin run forensics | `/api/admin/runs/[id]` reads run history | No admin run detail page |

---

## 3. Backlog

### Unblocked — V1.x

| Item | Effort | Description |
|---|---|---|
| HTML artifact rendering | 2-3 days | iframe + postMessage bridge; theme propagation; auto-resize |
| PPT rendering (Marp) | 4-5 days | Marp-core markdown → slides; deck navigator (arrow keys, page counter, fullscreen) |
| Chart filter UI | 5-7 days | `artifact.config.filters[]` + filter chip bar; filter values flow into `workflow.inputs` at execute time |
| Code artifact emission | 3-4 days | `render_code` tool for deliverable code; fenced-block "Save as artifact" overlay for chat snippets |
| Display model overhaul | ~12 days | 2-column square grid, 3 view states (thumbnail / preview / focus), 4 universal card buttons, keyboard nav, URL state |
| Refresh UI | 2-3 days | Refresh button on artifact page; live data merge into rendered chart |
| Admin run detail page | 3-5 days | Frontend for `/api/admin/runs/[id]` (backend ready) |

### Deferred — V2+

- PPTX export via marp-cli server-side endpoint
- Dashboard-level filter cascade (shared filter UI feeds same workflow across all referencing artifacts)
- Dynamic filter dropdowns (`valuesQuery` — populate options from data)
- Per-user saved filter views
- Streaming partial chart rendering during agent generation
- Chart export (PNG / SVG / PDF)
- Interactive citation pills (`[N]` click → popover / scroll / highlight)
- Pattern 4c: user-triggered "convert this to artifact" extraction

---

## 4. Related Documents

| Doc | Role |
|---|---|
| [`workflow.md`](./workflow.md) | Data engine: workflow DAG, spec format, save/refresh flows |
| [`workflow-spec.md`](./workflow-spec.md) | Normative node shape reference for LLM authoring |
| [`data-visualization.md`](./data-visualization.md) | Chat-time chart generation (outcomes panel design) |
| [`artifact-dashboard-migration.md`](./artifact-dashboard-migration.md) | Tree schema + dashboard composition (shipped) |
| [`data-sources.md`](./data-sources.md) | SQL node's data-source / DuckDB / Parquet contract |
| [`sandbox.md`](./sandbox.md) | Code node's sandbox path and mount contract |
