# D39 chart-as-node — implementation log

Records what shipped for the D39 chart refactor, in commit order,
plus the delta between the prescriptive `workflow-spec.md` form and
the code that actually landed. Future readers: this is the bridge
between "what the design doc says" and "what the codebase does".

The architectural decisions (D39.A through D39.E) and their
rationale live in `workflow-architecture.md` §2 (search "Chart
refactor"). The prescriptive end-state spec lives in
`workflow-spec.md`. This file is implementation-side companion.

## 1. Phase → commit map

| Phase | Commit | Scope |
|---|---|---|
| 0 | `cc40bef` | Frontend `render_chart` retired; server tool `generate_echarts_config` ships (D39.E). |
| 1.0 | `7df5a75` | snake_case rename across the workflow spec contract (`input → inputs`, `timeoutSeconds → timeout_seconds`, `data_source_name`, `agent_id`, `row_count`, `exit_code`, etc.). Engine-side TS interfaces stay camelCase. |
| 1.1 | `3cdf05f` | Chart node end-to-end: Zod schema + canonicalize + validate + `executeChartNode` + engine dispatch entry. Phases 1.2 (executor) and 1.3 (dispatch table) folded in. |
| 1.4 | `ccdc8f5` | `build-from-events` rebuilds chart nodes from captured `generate_echarts_config` invocations. Strategy Z+ extended with an array-output index. D39.C not-refreshable fallback when no match. Renderer derived from `generate_<lib>_config` tool-name suffix. |
| 1.4-A | `fe353e3` | SQL node executor projects the tool's `preview` field onto a `rows` output (and `rowCount → row_count`). Save pipeline now produces validating `@nodes.X.rows` refs end-to-end. |
| 1.5 | `849b594` | `ArtifactDetail` renders chart artifacts from `bundle.data` (the merged ECharts option) via `<EChartsRenderer>`. Plumbs `data` / `executedAt` through the layout chain. |
| 1.6 | `259b2fb` | "Refresh" pill on chart artifacts. POSTs to `/api/artifacts/[id]/refresh` and overwrites the SWR cache without a follow-up GET. |
| 5 / D39.D | `1317656` | `artifact.content` column dropped. PATCH route, service, and `ArtifactDetail` legacy-blocks fallback all removed in lockstep. Migration `0004_drop_artifact_content_column.sql`. |

Total: 10 commits, ~6000 line diff (much of which is the drizzle
snapshot for the column drop), zero test regressions
(1281 → 1326 across the chart-add + SQL-rows phases).

## 2. Shipped vs prescriptive — open deltas

`workflow-spec.md` describes the eventual D39 end-state where
**every** node type follows the "8 universal top-level fields +
everything else under `inputs`" rule. Phase 1.0–5 implemented
the chart-as-node goal but did NOT restructure the other node
types into that flat shape. The deltas are listed below.

| Node type | Spec says | Code today | Tracking |
|---|---|---|---|
| `chart` | `inputs: { renderer, config, dataset? }` | Same. ✅ | — |
| `tool` | `inputs: { name, arguments }` (OpenAI-aligned) | Top-level `tool: string` + `inputs: Record<…>`. | Out of D39 scope. |
| `agent` | `inputs: { name, task, context? }` (flat) | Top-level `agent: string` + `inputs: Record<…>` + LLM-emit `output_schema`. | Out of D39 scope; D39 conclusion explicitly supersedes D30 but the executor still expects D30 shape. |
| `code` | `inputs: { language, code_text|code_file, datasets?, params? }` (XOR `code_text` / `code_file`) | Top-level `language` + `code: string` + optional `inputs`. No `code_file` path. | Out of D39 scope. |
| `sql` | `inputs: { data_source_id, sql_text, dataset_id? }` + runtime outputs `{ dataset_id, total_rows, returned_rows, rows, row_schema }` + inline-vs-cached engine policy | Top-level `data_source_name`, `query`, optional `name`. Runtime outputs `{ name, row_count, rows }`. Fixed 100-row preview. | Out of D39 scope. SQL `rows` (Phase 1.4-A) is the only piece needed for chart refresh; the full restructure is its own follow-up. |

The chart node is the **first** node type to follow the
prescriptive shape end-to-end. Adding html / report support
later involves the same pattern (server tool rename → chart-like
assembler branch → optional dataset ref → engine merge) plus a
type-specific renderer in the artifact page.

## 3. Schema migration journal

| Migration | Effect |
|---|---|
| `0003_per_node_schema_version` (pre-D39, in `aa857b1`) | Adds `node.schema_version` discriminator. |
| `0004_drop_artifact_content_column` (this refactor, `1317656`) | `ALTER TABLE artifact DROP COLUMN content;` |

Per the project owner's prior note ("existing data is test data,
no migration required"), 0004 is a destructive cut with no data
migration step. Production deployments that have NOT run a fresh
seed should NOT skip prior 0003 migrations; nothing here changes
the chain semantics.

## 4. Verification

Every commit went green on:

- `pnpm check-types`
- `pnpm lint`
- `pnpm comments:check:all`
- `pnpm test` (1326 unit tests pass on the final tip)

No E2E suite changes were required — the artifact bundle endpoint
contract is unchanged (`{ node, workflow?, data?, fromCache?,
executedAt? }`), only the wire content of `data` shifted.

## 5. Operational notes

- **L2 cache is not wired.** `bundle.fromCache` is hard-coded
  `false` everywhere. Refresh always re-executes the workflow.
  This is fine for single-node setups (the typical Nango runtime
  profile); add L2 only if a profiling pass shows it matters.
- **SQL preview cap is 100 rows.** The chart refresh path reads
  the SQL node's top-100 `rows` field. Tuning happens via
  `SQL_WORKFLOW_PREVIEW_ROWS` in `nodes/sql-node.ts`. Switching
  to the prescriptive inline-vs-cached policy
  (`sql.inline_max_rows` / `sql.inline_max_bytes_mb`) is its own
  task.
- **Refresh is synchronous + foreground.** The user clicks
  Refresh → POST blocks until the workflow finishes → SWR updates.
  No background reconciliation. Scheduled refresh (the
  `entityKind='workflow'` dispatch path in the scheduler) is
  scaffolded but not wired.
