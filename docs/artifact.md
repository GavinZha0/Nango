# Artifact System Architecture

Current state and backlog for the artifact subsystem — the **UI engine** that renders saved data products. For the **data engine** (workflow DAG, refresh, SQL extraction), see [`workflow.md`](./workflow.md).

Related documents:
- [`data-visualization.md`](./data-visualization.md) — chat-time chart generation flow (outcomes panel)

---

## 1. Architecture Principle — Data Engine ↔ UI Engine

The artifact subsystem owns the **UI engine**: chart type, ECharts option skeleton, HTML config, filters, display mode. The workflow subsystem owns the **data engine**: DAG, SQL, Python transforms, refresh, cache.

They meet via two columns on the `artifact` table:
- `workflow_id` — FK to the backing workflow row
- `workflow_output_field` — names a key in `workflow.spec.outputs`

A single workflow can power **many** artifacts with different UI configurations (1:N relationship). Deleting an artifact does not delete the workflow; deleting a workflow cascades to artifacts.

---

## 2. Current State

The following core capabilities have been fully designed and implemented:
- **Chatbot to Outcomes**: Chat tool chain generates outcomes.
- **Save to Artifact**: Outcomes can be persisted as artifacts.
- **Workflow Generation & Display**: Artifacts successfully generate and display backing workflows.
- **Chart Rendering (ECharts)**: `<EChartsRenderer />` consumes merged options from the workflow engine.

---

## 3. Backlog & Next Steps

The final major missing steps for the artifact subsystem are:

| Priority | Capability | Description |
|---|---|---|
| 1 | **Artifact & Workflow Editing** | Capabilities to edit the generated artifacts and their backing workflows. |
| 2 | **Dashboard Construction** | Composing multiple artifacts into a presentable dashboard layout. |
| 3 | **HTML Artifact Rendering** | iframe + postMessage bridge; theme propagation; auto-resize. |
| 4 | **PPT Rendering (Marp)** | Marp-core markdown → slides; deck navigator (arrow keys, page counter, fullscreen). |

---

## 4. Related Documents

| Doc | Role |
|---|---|
| [`workflow.md`](./workflow.md) | Data engine: workflow DAG, spec format, save/refresh flows |
| [`workflow-spec.md`](./workflow-spec.md) | Normative node shape reference for LLM authoring |
| [`data-visualization.md`](./data-visualization.md) | Chat-time chart generation (outcomes panel design) |
| [`data-sources.md`](./data-sources.md) | SQL node's data-source / DuckDB / Parquet contract |
| [`sandbox.md`](./sandbox.md) | Code node's sandbox path and mount contract |
