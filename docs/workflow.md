# Workflow — V1 Reference

> **Status**: canonical reference for what `src/lib/workflows/` and
> `src/lib/artifacts/` actually do today. For the long-form design
> discussion + decision history (D17–D38), see the legacy
> [`workflow-architecture.md`](./workflow-architecture.md) (~6 k lines,
> kept as design archive). New questions land here.

---

## 0. Overview

A **workflow** is a saved, deterministic-replayable description of the
data work an agent did in chat. The save flow captures the tool /
agent / code / SQL invocations that produced an artifact, freezes them
into a typed DAG (`workflow.spec` JSONB), and writes one row to the
`workflow` table. Re-running that DAG against the live data sources
later is what the `/api/artifacts/[id]/refresh` endpoint does. The
artifact's visual snapshot (`artifact.content.blocks`) stays
side-by-side with the workflow so the user always sees something even
when a refresh fails.

If you only read one section, read **§7** — that's where the unresolved
chart data flow question lives, and it gates every other refresh-side
roadmap item.

---

## 1. Positioning

### 1.1 Two-pillar product model

Nango is two engines that share infrastructure:

| Pillar | What it does | Where the code lives |
|---|---|---|
| **Data engine** | "Agents that produce data" — workflow DAGs, data sources, sandbox, SQL extraction. Outputs are typed values. | `src/lib/workflows/`, `src/lib/data-sources/`, `src/lib/sandbox/` |
| **UI engine** | "Agents that produce UI" — chat tools, charts, outcome rendering, artifact pages. Outputs are renderable views. | `src/components/workspace/`, `src/hooks/useOutcomeTools.tsx`, `src/lib/outcomes/` |

A workflow lives entirely on the **data engine** side. UI rendering of
its result is a separate concern handled by the artifact layer —
that's the architectural fork §7 is about.

### 1.2 What a workflow is (and isn't)

Is:
- A captured tool chain from one or more chat turns
- A DAG of typed nodes (`tool` / `agent` / `code` / `sql`)
- Replayable: same inputs → same outputs (modulo external state)
- 1:1 with an artifact at save time (one workflow row per saved
  artifact, populated from the chat trace)

Isn't:
- An LLM-authored DSL the user edits directly. The LLM never types a
  full workflow spec from scratch; it captures and modifies, never
  composes
- A general computation engine. V1 supports four node types and a
  flat-input/output ref system (`@nodes.X.field` / `@inputs.X` /
  `@workflow.outputs.X`)
- A separate scheduler tier. Workflow refresh shares `entity_run` +
  the existing runner, no new dispatch infra

### 1.3 Concept map

```
artifact (one row in `artifact` table)
   ├── content.blocks      ← visual snapshot at save time (chart option, etc.)
   ├── workflowId          ← FK to the backing workflow (if any)
   └── workflowOutputField ← which spec.outputs key holds the artifact's data

workflow (one row in `workflow` table)
   ├── spec                ← canonical JSON DAG: { nodes[], outputs{} }
   ├── name / description
   └── visibility (private | public)

entity_run (one row per execution attempt)
   ├── entityKind = "workflow", entitySource = "builtin"
   ├── entityId = workflow.id
   ├── parent_run_id (for agent sub-runs spawned by an agent node — W2)
   └── status / startedAt / finishedAt / errorMessage

entity_run_event (timeline of one run)
   └── type ∈ { started, finished, error,
                workflow_node_attempt_started,
                workflow_node_attempt_failed,
                workflow_node_completed }
```

### 1.4 Workflow ≡ Agent (peer model)

Workflows and agents are **peer entities** at the runner level. Both
are dispatched by `runner.start({ entityKind, entityId, ... })`. The
runner doesn't care whether the entity is a chat agent or a workflow
— it just creates an `entity_run` row, persists events, and waits
for terminal status. This is why workflow refresh and chat dispatch
can share `entity_run` without a separate `workflow_run` table (D24).

---

## 2. Architecture

### 2.1 Layered view

```
┌─────────────────────────────────────────────────────────────────┐
│  HTTP layer — Next.js routes                                    │
│    POST /api/artifacts/save     POST /api/artifacts/[id]/refresh│
│    GET  /api/artifacts/[id]     PATCH /api/artifacts/[id]       │
└──────────────────────────────────┬──────────────────────────────┘
                                   ↓
┌─────────────────────────────────────────────────────────────────┐
│  Artifact orchestration  (src/lib/artifacts/)                   │
│    save-artifact.ts      ← coalesce + build-from-events + write │
│    bundle.ts             ← GET / refresh shared assembly        │
│    execute-workflow.ts   ← engine adapter; D4a recorder + W2    │
│    refresh-artifact.ts   ← thin wrapper that sets forceFresh    │
│    workflow-run-recorder ← entity_run + event persistence (D4a) │
└──────────────────────────────────┬──────────────────────────────┘
                                   ↓
┌─────────────────────────────────────────────────────────────────┐
│  Workflow engine  (src/lib/workflows/engine/)                   │
│    inProcessWorkflowEngine    ← DAG executor                    │
│    cache.ts                   ← per-node L1 (defined, not wired)│
│    execution-context.ts       ← @path ref resolution            │
└──────────────────────────────────┬──────────────────────────────┘
                                   ↓
┌─────────────────────────────────────────────────────────────────┐
│  Engine dependencies  (DI — engine never imports these)         │
│    runAgent       → runner.start (W2, refresh path only)        │
│    runCode        → sandbox adapter (subprocess / local-docker) │
│    getTool        → user tool catalog (builtin-tools/...)       │
│    emitEvent      → recorder.emit or noop (D4a)                 │
└─────────────────────────────────────────────────────────────────┘
```

### 2.2 Save flow

```
chat (CopilotKit)
   │   user clicks Save on a chart in /outcomes
   ↓
POST /api/artifacts/save
   │   { outcomeId, threadId, name, parentId, ... }
   ↓
save-artifact.ts (src/lib/artifacts/)
   │
   ├── 1. fetch the relevant `entity_run_event` rows for threadId
   │      filtered to the source outcome (W1.6.1)
   │
   ├── 2. coalesceToolCalls → ToolInvocation[]
   │      assembles streaming chunks back into whole tool calls
   │
   ├── 3. buildFromEvents(invocations, artifactCreatingCallId)
   │      → { spec, strippedFrontendConfig, lineageReport }
   │      • strips the frontend tool (render_chart) — only the data
   │        chain becomes nodes
   │      • drops failed (ok:false) invocations
   │      • assigns numeric node ids (D29)
   │      • Strategy Z+ walks args for @path refs into upstream node
   │        outputs (D33)
   │
   ├── 4. canonicalize(spec, deps) → CanonicalWorkflowSpec
   │      resolves agent display names to UUIDs (D27),
   │      fills DEFAULT_AGENT_OUTPUT_SCHEMA (D30) /
   │      DEFAULT_SQL_NODE_OUTPUTS / DEFAULT_CODE_NODE_OUTPUTS
   │
   ├── 5. validate(canonical) — last-mile cross-ref checks
   │
   └── 6. ONE DB transaction:
          • INSERT workflow row (with `spec`)
          • INSERT artifact row (with `content` = blocks +
            workflowId / workflowOutputField)
          • INSERT entity_run_event "artifact_saved" lineage record
```

### 2.3 Refresh flow (GET + POST)

```
GET  /api/artifacts/[id]            POST /api/artifacts/[id]/refresh
   │                                       │
   ↓                                       ↓
buildArtifactBundle(id, ownerId,        buildArtifactBundle(id, ownerId,
  deps, { /* no forceFresh */ })          deps, { forceFresh: true })
   │                                       │
   ↓                                       ↓
1. load artifact + workflow rows        ↑ same shared assembly ↑
2. pick outputField from spec.outputs
3. executeWorkflow({                       │
     workflowId, spec, outputField,        │
     ownerId, workflowName,                │
     forceFresh: ?  })                     │
       │                                   │
       │  forceFresh=true ⇒ ALSO:          │
       │   • startRecording → entity_run   │
       │     row with parent_run_id=null,  │
       │     status=running                │
       │   • emitEvent ← recorder.emit     │
       │     (writes entity_run_event)     │
       │   • runAgent ← W2 real dispatch   │
       │     via runner.start              │
       │                                   │
       │  forceFresh=false ⇒               │
       │   • emitEvent ← noopEmitEvent     │
       │   • runAgent ← stubRunAgent       │
       │     (agent nodes fail loud)       │
       │                                   │
       ↓                                   │
4. inProcessWorkflowEngine.execute(...)    │
5. result.output[outputField] → data       │
6. bundle = { node, workflow, data }       │
                                           │
                                           ↓
                                     respond { node, workflow,
                                                data?, executedAt? }
```

### 2.4 Why the engine ↔ runner DI seam (D17)

If `workflows/engine/` directly imported `runner/`, we'd have a cycle:

- `runner/runner.ts` needs to know about workflows (a workflow IS a
  dispatch target with `entityKind: "workflow"`)
- `workflows/engine/in-process.ts` needs to dispatch agent nodes via
  the runner

The DI cut: engine declares an interface (`WorkflowEngineDependencies`
with `runAgent`, `runCode`, `getTool`, `emitEvent`, `cache?`), and the
artifact-side adapter (`execute-workflow.ts`) provides concrete
implementations. The engine module stays runner-blind.

This is also why `execute-workflow.ts` lives under `src/lib/artifacts/`
— it knows about both engine internals and runner internals, which a
"pure engine" module shouldn't.

### 2.5 File responsibility table

| File | Owns |
|---|---|
| `src/lib/workflows/spec/schema.ts` | Zod types for LLM-emit + canonical spec; 4 node types; `@path` ref grammar |
| `src/lib/workflows/spec/canonicalize.ts` | LLM-emit → canonical (agent name → UUID, defaults) |
| `src/lib/workflows/spec/validate.ts` | Post-canonicalize cross-ref checks (refs resolve, output refs valid, etc.) |
| `src/lib/workflows/spec/refs.ts` | `@path` parser + resolver |
| `src/lib/workflows/spec/hash.ts` | Stable JSON hash (cache key primitives) |
| `src/lib/workflows/engine/in-process.ts` | DAG executor, lifecycle events |
| `src/lib/workflows/engine/execution-context.ts` | Per-run state (node outputs, ref resolution) |
| `src/lib/workflows/engine/cache.ts` | L1 LRU class + key derivation (not yet wired) |
| `src/lib/workflows/engine/scheduler.ts` | Topological order, parallelism control |
| `src/lib/workflows/nodes/tool-node.ts` | Tool invocation (ref-resolved input → tool.execute → JSON output) |
| `src/lib/workflows/nodes/agent-node.ts` | Agent invocation via `deps.runAgent` |
| `src/lib/workflows/nodes/code-node.ts` | Python sandbox via `deps.runCode` (D35) |
| `src/lib/workflows/nodes/sql-node.ts` | `extract_dataset_by_sql` wrapper, parquet cache key (D36) |
| `src/lib/workflows/nodes/with-retries.ts` | Per-node retry loop (D20), emits attempt events |
| `src/lib/workflows/nodes/schema-validator.ts` | JSON Schema runtime validation |
| `src/lib/workflows/build-from-events.ts` | Chat-event → spec build pipeline (Strategy Z+ ref reconstruction) |
| `src/lib/artifacts/save-artifact.ts` | Save endpoint orchestrator |
| `src/lib/artifacts/bundle.ts` | GET / refresh shared bundle assembly |
| `src/lib/artifacts/execute-workflow.ts` | Engine adapter: catalog → deps, recorder, runAgent bridge |
| `src/lib/artifacts/refresh-artifact.ts` | Thin wrapper: `buildArtifactBundle(..., { forceFresh: true })` |
| `src/lib/artifacts/workflow-run-recorder.ts` | D4a entity_run + event persistence for refresh runs |
| `src/lib/artifacts/coalesce-tool-calls.ts` | Streamed `tool_call_chunk` → whole `ToolInvocation` |

---

## 3. Data model

### 3.1 `workflow` table

```sql
workflow (
  id            uuid PK,
  name          text   NOT NULL,
  description   text,
  spec          jsonb  NOT NULL,             -- canonical DAG
  visibility    text   NOT NULL DEFAULT 'private',
  created_by    uuid   → user.id ON DELETE SET NULL,
  updated_by    uuid   → user.id ON DELETE SET NULL,
  created_at    timestamp DEFAULT now(),
  updated_at    timestamp DEFAULT now()
)
```

Indexes:
- `workflow_created_by_idx` — "my workflows" listing
- `workflow_visibility_idx` (partial WHERE visibility='public') — tenant-wide shared
- `workflow_spec_gin_idx` (GIN with `jsonb_path_ops`) — reverse dependency queries: "which workflows reference data source X / MCP tool Y / agent Z?" (D26)

### 3.2 Relationships

```
        ┌──────────┐         ┌──────────┐         ┌────────────┐
        │ artifact │ ───────→│ workflow │         │ entity_run │
        │          │ FK SET  │          │         │            │
        │ kind=    │  NULL   │ spec=DAG │         │ entityKind=│
        │ "chart"  │         │          │         │  "workflow"│
        │ content= │         │          │         │ entityId=  │
        │  {blocks}│         │          │         │  workflow  │
        │workflowId│         │          │         │  .id       │
        └──────────┘         └──────────┘         └────────────┘
                                                        │
                                          one row per   │
                                          refresh exec  │
                                          (forceFresh)  ↓
                                                  ┌──────────────────┐
                                                  │entity_run_event[]│
                                                  │workflow_node_*   │
                                                  └──────────────────┘
```

**FK behaviour**:
- `artifact.workflow_id` → `workflow.id` `ON DELETE SET NULL` — deleting a workflow leaves the artifact with its content snapshot but no replay path
- `entity_run.entity_id` is **not** a FK (polymorphic across agent / team / workflow targets; D24) — deleting a workflow leaves orphaned run history rows. Read-only forensics; no integrity risk

### 3.3 `entity_run_event` types for workflows

Five of the eleven `EntityRunEventType` enum values are used by
workflow runs:

| Type | When | Payload |
|---|---|---|
| `started` | run begins (after entity_run row INSERT) | engine `workflow_started` event |
| `finished` | engine returned success | engine `workflow_completed` (output) |
| `error` | engine threw WorkflowError | engine `workflow_failed` (errorCode, message) |
| `workflow_node_attempt_started` | each node attempt begins | nodeId, attempt # |
| `workflow_node_attempt_failed` | node attempt threw before retry exhausted | nodeId, attempt #, errorCode, message |
| `workflow_node_completed` | node finished (success or cache hit) | nodeId, attempt #, durationMs, cached?, outputs |

Chat path uses the other types (`message`, `reasoning`,
`tool_call_chunk`, `tool_call_result`, `degraded`).

---

## 4. Spec format

### 4.1 LLM-emit vs canonical

Two shapes for the same spec, both Zod-validated:

| Shape | When | Notes |
|---|---|---|
| **LLM-emit** | What `build-from-events.ts` produces and what (future) `modify_workflow` accepts. Agents are addressed by `agent` display name (`"data_analyst"`). Output schemas may be omitted; canonicalize fills them. |
| **Canonical** | What lives in `workflow.spec` on disk and what the engine consumes. Agent UUIDs resolved (`agentId: "<uuid>"`), default output schemas materialized, dataset slugs filled (`name: "<slug>"` for SQL nodes), output bucket tags present. |

The save pipeline is always **LLM-emit → canonicalize → validate →
persist canonical**. The engine never sees LLM-emit shape; the modify
flow always reads / writes LLM-emit and re-canonicalizes on save.

### 4.2 Node types

V1 ships **four** node types, each its own Zod variant:

```ts
NodeTypeSchema = z.enum(["tool", "agent", "code", "sql"]);
```

#### 4.2.1 Tool node

A built-in or MCP server-side tool. Examples: `web_search`,
`run_ssh_command`, `get_skill`. NOT `extract_dataset_by_sql`
(promoted to `sql` node in D36), NOT `run_code_in_sandbox`
(promoted to `code` in D35), NOT `render_chart` (frontend, never a
node — see §7).

```jsonc
{
  "id": 0,
  "type": "tool",
  "tool": "web_search",
  "description": "Find recent regulatory updates",
  "input": { "query": "EU AI Act 2025" },
  "depends_on": [],
  "outputs": ["results"],
  "output_schema": { "type": "object", "properties": { ... } },
  "retries": { "max": 2, "backoff": "exponential", "baseMs": 500 },
  "timeoutSeconds": 30
}
```

#### 4.2.2 Agent node

A built-in agent invocation. Save pipeline always emits the D30
default `{ text: string }` output schema; runner returns plain text
(`summary`), `execute-workflow.ts` wraps as `{ text: summary }` on
the refresh path.

```jsonc
{
  "id": 1,
  "type": "agent",
  "agent": "data_analyst",          // LLM-emit: display name
  "agentId": "<uuid>",              // canonical: resolved by canonicalize
  "input": { "text": "Summarise the search results in 200 words" },
  "depends_on": [0],
  "output_schema": { /* DEFAULT_AGENT_OUTPUT_SCHEMA: {text: string} */ }
}
```

#### 4.2.3 Code node (D35)

Python script in the sandbox. Default outputs are
`{ stdout, stderr, exitCode, durationMs }`. Custom `output_schema`
allowed (D35.B); engine parses JSON from stdout when supplied.

```jsonc
{
  "id": 2,
  "type": "code",
  "language": "python",
  "code": "import pandas as pd, json\nrows = pd.read_parquet('./data/sales/data.parquet')...",
  "depends_on": [1],
  "input": {
    "datasets": ["@nodes.1.name"],  // ref to upstream SQL node's dataset name
    "env": {}                       // V1.x reserved
  },
  "outputs": ["stdout", "stderr", "exitCode", "durationMs"],
  "timeoutSeconds": 30
}
```

#### 4.2.4 SQL node (D36)

A `data_source` + SQL pair that materialises a Parquet snapshot.
Outputs are `{ name, rowCount }`; downstream code nodes reference
`@nodes.<id>.name` to mount the dataset under `./data/<name>/` in
the sandbox cwd (D38).

```jsonc
{
  "id": 0,
  "type": "sql",
  "dataSourceName": "prod_pg_readonly",
  "query": "SELECT customer_id, sum(amount) AS total FROM orders GROUP BY 1",
  "name": "customer_totals_2026",   // LLM-emit optional; canonicalize derives if omitted
  "depends_on": [],
  "outputs": ["name", "rowCount"]
}
```

### 4.3 `@path` reference grammar

References live in node `input` values (and `spec.outputs`):

| Sigil | Resolves to | Example |
|---|---|---|
| `@nodes.<id>.<field>` | upstream node's output field | `"@nodes.0.name"` → SQL node 0's dataset slug |
| `@inputs.<key>` | workflow-level input parameter | `"@inputs.region"` (V1.x reserved; not user-facing yet) |
| `@workflow.outputs.<key>` | workflow's declared output | for `spec.outputs` declarations only |

Resolution is **strictly typed at validate time** (the engine asserts
the upstream node declares a matching `output` key) and **lazily
resolved at execute time** (`execution-context.ts:resolveRefs`).

`spec.outputs` is a flat `Record<string, "@path">` declared at the
top level:

```jsonc
{
  "outputs": {
    "result": "@nodes.2.stdout",
    "rowCount": "@nodes.0.rowCount"
  }
}
```

`artifact.workflow_output_field` picks **one** key from this map to
be the artifact's primary data. The other keys are forensic / future-
use.

---

## 5. Key flows

### 5.1 Save-as-workflow (chat → spec → DB)

Entry: `POST /api/artifacts/save` with `{ outcomeId, threadId, name,
parentId, ... }`.

Steps (all in `save-artifact.ts`):

1. **Load context** — query `entity_run_event` rows for the source
   thread, filtered to the run that produced this outcome
2. **Coalesce** — `coalesceToolCalls(events)` stitches streaming
   `tool_call_chunk` rows into complete `ToolInvocation { callId,
   toolName, input, output, ok }` records
3. **Build spec** — `buildFromEvents(invocations,
   artifactCreatingCallId)`:
   - Strip the artifact-creating frontend tool (e.g. `render_chart`).
     Its input becomes `strippedFrontendConfig` and goes into
     `artifact.content.blocks` directly. **This is where chart option
     leaves the workflow path — see §7.**
   - Filter envelope-failed (`ok: false`) invocations
   - Assign numeric ids (D29)
   - Walk each invocation's args via Strategy Z+ (D33) to find values
     that match an upstream invocation's output → emit a `@path` ref;
     untouched literals stay literal
4. **Canonicalize** — `canonicalize(spec, deps)`:
   - Resolve `agent` display names → `agentId` UUIDs (via
     `BuiltinAgentCatalog`)
   - Fill `output_schema` from registries (D19 source 1):
     `DEFAULT_AGENT_OUTPUT_SCHEMA` for agents, tool registry's
     declared schema for tool nodes, default field lists for code /
     sql nodes
5. **Validate** — `validate(canonical)` ensures refs resolve and
   declared outputs are reachable from `spec.outputs`
6. **Persist** — one DB transaction:
   - INSERT `workflow` row
   - INSERT `artifact` row (with `content.blocks` from
     `strippedFrontendConfig` + `workflowId` + `workflowOutputField`)
   - INSERT an `entity_run_event` row tagging the save (lineage)

### 5.2 Load + execute (GET artifact page)

Entry: `GET /api/artifacts/[id]`.

```
1. buildArtifactBundle(id, ownerId, productionDeps)
2. getArtifact → ArtifactEntity (owns-by check)
3. if (folder OR no workflowId) return { node } and stop
4. getWorkflow → WorkflowEntity
5. pick outputField (from artifact.workflowOutputField, fallback first key)
6. executeWorkflow({ workflowId, spec, outputField, ownerId,
                     workflowName }) — NO forceFresh
     → engine.execute() with stubRunAgent + noopEmitEvent
     → result.output[outputField] = "data"
7. return { node, workflow, data, fromCache: false, executedAt }
```

GET runs the workflow but **persists nothing** to `entity_run` (D4a
Strategy B). The bundle is returned to the client; the frontend
today reads `node.content.blocks` and ignores `data` (see §7).

### 5.3 Refresh (POST refresh) — D4a + W2 active

Entry: `POST /api/artifacts/[id]/refresh` (no body).

```
1. refreshArtifact(id, ownerId)
2. buildArtifactBundle(... , { forceFresh: true })
3. executeWorkflow({ ..., forceFresh: true, workflowName })
4. startRecording({ workflowId, workflowName, ownerId })
     → INSERT entity_run (status=running, initiator=user,
        entityKind=workflow, entitySource=builtin,
        inputTask=`Refresh workflow: ${name}`)
     → recorder.runId = entity_run.id
5. wire engine deps:
     emitEvent  ← recorder.emit (writes entity_run_event rows)
     runAgent   ← buildRealRunAgent(ownerId)  (W2: runner.start dispatch)
     runId      ← recorder.runId
6. engine.execute({ runId, spec, ... })
     for each agent node:
       runner.start({ entityId, mode: sync, parentRunId: runId,
                      initiator: user, ownerId, ... })
       → agent sub-run gets its OWN entity_run row, parent_run_id
         pointing at the workflow run
7. if success: recorder.succeed() → UPDATE entity_run SET status=succeeded
   if WorkflowError or throw: recorder.fail(err) → status=failed,
     errorMessage=err.message
8. respond { node, workflow, data?, executedAt? }
```

Today's known gap: **the frontend reads `node.content.blocks` (saved
snapshot) and never consumes `bundle.data` (fresh execution result)**.
See §7.

### 5.4 Modify via agent (designed, not built)

The W1 plan calls for a `modify_workflow` MCP tool the right-panel
chatbot uses to edit a saved spec. The user says "change the date
range to last 30 days"; the agent reads the spec via `get_workflow`,
emits a patched LLM-emit version, and the server re-canonicalizes
and writes it back.

Status: tools designed (§10 of `workflow-architecture.md`), not
implemented. No code in `src/lib/workflows/` references it. Lives in
the V1.x backlog.

---

## 6. API surface

| Endpoint | Method | Purpose | Status |
|---|---|---|---|
| `/api/artifacts` | `POST` | Create a folder | ✅ |
| `/api/artifacts/tree` | `GET` | Tree view for the artifact panel | ✅ |
| `/api/artifacts/save` | `POST` | Save-as-workflow (the canonical creation path; §5.1) | ✅ |
| `/api/artifacts/[id]` | `GET` | Render-ready bundle (§5.2) | ✅ |
| `/api/artifacts/[id]` | `PATCH` | Rename / move / change content config | ✅ |
| `/api/artifacts/[id]` | `DELETE` | Hard delete (workflow row stays, FK→NULL) | ✅ |
| `/api/artifacts/[id]/refresh` | `POST` | Force-fresh re-execute (§5.3) | ✅ backend only |
| `/api/admin/runs/[id]` | `GET` | Run detail + event timeline (chat + workflow) | ✅ |
| ~~`/api/workflows`~~ | — | Direct workflow CRUD | 🚫 deliberately not exposed (D24) |

No standalone workflow editor endpoints. Workflows are accessed only
through their owning artifact.

---

## 7. Open architecture question — chart data flow

This is the unresolved blocker for the V1.x "Refresh button + data
binding" epic. The decision shape:

### 7.1 Current state, precisely

```
chat (LLM)
   │   LLM calls render_chart({ optionJson, title, datasetName? })
   │   render_chart is a FRONTEND tool — useCopilotAction handler
   │   runs in the browser, NEVER reaches the server
   │
   ↓
save dialog → POST /api/artifacts/save
                          │
                          ↓
                build-from-events.ts
                          │   strips render_chart from the chain
                          │   (it's a frontend tool — see step 3 of §5.1)
                          ↓
                workflow.spec  →  contains SQL / code / agent / tool nodes
                                  ONLY. NO chart node. NO option.
                artifact.content.blocks  =  the chart option, end-to-end
                                  (including the data points it shows)
```

Therefore:
- The saved chart is a **complete static snapshot**. The data points
  are baked into `series[].data` inside the saved ECharts option.
- The workflow can re-execute its data nodes, producing fresh
  `bundle.data` — but **nothing in the system knows how to merge
  fresh data into the saved chart option**.
- `<ArtifactDetail>` reads `node.content.blocks` only. `bundle.data`
  is fetched, returned over the wire, and discarded by the renderer.

This is intentional V1 design (the "frontend tool divorce" — UI
generation is the UI engine's job, the data engine produces values).
It works perfectly for what was built. It just doesn't admit a
"refresh and see updated data" flow without a design choice.

### 7.2 Three routes

#### Route A — `render_chart` as a workflow node

Promote `render_chart` from a frontend tool to a first-class workflow
node type. Chart generation becomes deterministic + replayable on
the server.

| Aspect | Detail |
|---|---|
| Spec changes | New `type: "chart"` node variant. `input` includes upstream dataset refs + chart kind / encoding. `output` is the ECharts option JSON. |
| LLM contract | `render_chart` tool description changes: LLM no longer emits final data, only a **chart template** + dataset binding |
| Save pipeline | `build-from-events.ts` keeps the (now-server) render_chart in the spec instead of stripping it |
| Refresh | engine.execute returns fresh option in `bundle.data`; renderer reads `data` instead of `content.blocks` |
| Existing artifacts | All pre-A saved artifacts have no chart node → can't refresh visually. Either degrade gracefully (show snapshot, hide refresh button) or migrate via re-save |
| Cost estimate | 4-5 days |
| Pros | Cleanest model. Server-side determinism. Migration-friendly: new artifacts work fully, old ones degrade gracefully |
| Cons | Forces LLM to learn a new chart-generation contract. ECharts option building moves server-side, which may need ECharts in Node bundle (it's already there for the preview path) |

#### Route B — Template + data binding

Keep `render_chart` as a frontend tool but change its contract: the
emitted ECharts option is a **template** with placeholder refs at
the data slots; the renderer resolves placeholders against
`bundle.data` at draw time.

| Aspect | Detail |
|---|---|
| Spec changes | None — chart still leaves the workflow at save time |
| LLM contract | render_chart emits `series[].data = { $ref: "@workflow.outputs.rows" }` (or similar sentinel) instead of literal arrays. Saved option = template. Tool description teaches the convention |
| Renderer | Pre-render pass walks `option`, replaces `$ref` with values from `bundle.data` |
| Save pipeline | Unchanged — `content.blocks` holds the template |
| Refresh | bundle.data carries fresh rows; renderer re-merges → new chart |
| Existing artifacts | Saved with literal data, no placeholders → can't refresh. Either re-save or accept they're frozen |
| Cost estimate | 3-4 days |
| Pros | Workflow spec stays purely "data engine". Smaller delta in `save-artifact.ts`. Doesn't move ECharts work to server |
| Cons | LLM has to learn placeholder convention reliably (drift risk). Renderer becomes more complex (ref walker). `$ref` sentinel design needs review for nested arrays / non-trivial encodings |

#### Route C — Limit refresh semantics

Accept that the saved chart is a static snapshot. Replace the
"refresh button" idea with a "regenerate via chat" affordance —
clicking it opens chat with a pre-filled prompt that re-invokes
the chart-producing agent.

| Aspect | Detail |
|---|---|
| Spec changes | None |
| LLM contract | None |
| Save pipeline | Unchanged |
| Refresh button | Becomes a "Regenerate in chat" link; clicking it doesn't call the refresh endpoint at all |
| Existing artifacts | Fully compatible |
| Cost estimate | 1-2 days |
| Pros | Honest about the V1 architecture; no migrations; zero LLM contract change |
| Cons | UX regression — user has to context-switch into chat instead of one-click. The W2 / D4a infrastructure we just built has no user-facing trigger |

### 7.3 Cross-cutting consequences

Any choice that puts a refresh button on the artifact page brings
these along:

- **`/admin/run` UI value** — D4a writes entity_run rows on every
  refresh. If refresh is never user-facing (Route C), D4a sees no
  traffic and the admin run UI is largely empty
- **W2 (agent dispatch on refresh)** — only matters if (a) workflows
  with agent nodes are common and (b) the user wants to refresh
  them. Route C effectively skips W2's user-visible value
- **`forceFresh` and L2 cache** — currently a no-op. Routes A / B
  would actually make `forceFresh: true` mean something; Route C
  removes the need
- **Schedule integration** — scheduled refresh (cron-like) requires
  Routes A or B to be meaningful

### 7.4 V1.x decision marker

**Status: undecided.** This page records the three routes verbatim
so the choice can be made deliberately. The next decision should
write down:

1. Which route, and why
2. Migration plan for existing saved artifacts
3. Whether D4a / W2 stay as built or get rewired to match
4. Tracking ID (the next available D-number — D39 at time of
   writing)

Until then, every "refresh-adjacent" todo item depends on this:
refresh button, chart data binding, L2 cache, scheduled refresh,
`/admin/run` UI traffic.

---

## 8. Implementation status

### 8.1 Shipped ✅

| Capability | Where | Commit(s) |
|---|---|---|
| `workflow` table + indexes (incl. GIN) | `src/lib/db/schema.ts` | W1.1a / W1.1b |
| Spec schema (Zod) — 4 node types, canonical / LLM-emit split | `src/lib/workflows/spec/` | W1.2 |
| @path ref system + canonicalize + validate | same | W1.2 / W1.3 |
| In-process DAG engine (deps DI, retries, event emission) | `src/lib/workflows/engine/` | W1.4.1–W1.4.7 |
| L1 per-node cache class | `src/lib/workflows/engine/cache.ts` | W1.4.7 (class exists, **not wired**) |
| build-from-events (Strategy Z+) | `src/lib/workflows/build-from-events.ts` | W1.5.A / W1.5.B |
| save-artifact orchestrator | `src/lib/artifacts/save-artifact.ts` | W1.6.1 |
| `GET /api/artifacts/[id]` bundle | `src/lib/artifacts/bundle.ts` | W1.6.2 |
| `PATCH /api/artifacts/[id]` config | same | W1.6.3 |
| `POST /api/artifacts/[id]/refresh` (with `forceFresh: true`) | `src/lib/artifacts/refresh-artifact.ts` | W1.6.4 |
| `POST /api/artifacts/save` endpoint | `src/app/api/artifacts/save/route.ts` | W1.6.5 |
| Real executor (replaces W1.6.x stub) | `src/lib/artifacts/execute-workflow.ts` | W1.7.1 |
| OUTPUT_REF_UNRESOLVED fix on artifact open | engine | W1.7.3 |
| Block-model rendering on artifact page | `src/components/main-panels/ArtifactDetail.tsx` | W1.7.4 |
| Strategy Z+ array recursion + sandbox envelope fix | build-from-events | W1.7.5–W1.7.6 |
| Code node (D35) | `src/lib/workflows/nodes/code-node.ts` | W1.7.10 |
| SQL node (D36) | `src/lib/workflows/nodes/sql-node.ts` | W1.7.12 |
| Workflow graph visualization (artifact page) | `src/components/workflow-graph/` | W1.8.1–W1.8.4 |
| **D4a** entity_run + event persistence on refresh | `src/lib/artifacts/workflow-run-recorder.ts` | `5ef5e14` |
| **W2** agent dispatch via runner.start (refresh path) | `src/lib/artifacts/execute-workflow.ts:buildRealRunAgent` | `fabe151` |

### 8.2 Partial ⚠️

| Capability | Backend | Frontend |
|---|---|---|
| Refresh + visual update | ✅ endpoint works, engine re-runs, D4a records | ❌ no refresh button, no data merge into chart |
| Admin run forensics | ✅ `/api/admin/runs/[id]` reads everything D4a wrote | ❌ no `/admin/run` UI (D4b — backend ready, frontend missing) |
| Capability degradation log | ✅ `degraded` event type exists | ⚠️ no UI surface yet |

### 8.3 Designed, not built ❌

| Item | Reference |
|---|---|
| `modify_workflow` agent tool — chat-driven workflow edit | `workflow-architecture.md` §10.2 |
| `get_workflow` agent tool — read current spec | same |
| L2 workflow-output cache — makes `forceFresh: true` actually do something | `lib/artifacts/execute-workflow.ts` file header |
| Scheduled refresh (cron-style "refresh this artifact weekly") | `schedule` table exists, no `entity_kind="workflow"` dispatch path |
| Workflow visibility = `"public"` sharing UX | flag exists in schema; no UI |
| Workflow execution timeout (top-level) | `ExecutionConfig` field exists in spec, engine respects it; UI for tuning missing |

### 8.4 V1 out of scope 🚫

- LLM-from-scratch authored workflows (the LLM only captures + modifies)
- Multi-tenant workflow marketplaces / forking
- Workflow versioning / history (`updatedAt` is the only checkpoint)
- Streaming workflow output to the artifact page during execution
  (SSE events for refresh runs — possible later if D4b lands)
- Cross-thread workflow reuse from chat (the LLM can't currently
  "invoke this saved workflow as a tool")

---

## 9. Related documents

| Document | What it covers | Status |
|---|---|---|
| [`workflow-architecture.md`](./workflow-architecture.md) | Long-form design discussion, D17–D38 decision history, alternate-approach rejections | Archive — read this when you need to know **why** a design choice was made; read the present doc when you need to know **what** is built |
| [`data-visualization.md`](./data-visualization.md) | Chart-specific UI design (outcomes panel, OutcomeCard, BlockList, frontend tools) | Active |
| [`artifact-evolution.md`](./artifact-evolution.md) | Artifact library V2 plans (focus mode, multi-type artifacts, etc.) | Active for V2 planning; §6 became the basis for the V1 enlarge / minimize feature |
| [`architecture.md`](./architecture.md) | Whole-product architecture (frontend, backends, runner kernel) | Active |
| [`data-sources.md`](./data-sources.md) | Parquet cache, slot semantics, extract_dataset_by_sql | Active |
| [`sandbox.md`](./sandbox.md) | D35 / D38 sandbox path contract, subprocess vs local-docker | Active |
| [`runner-events.md`](./runner-events.md) | AG-UI ↔ EntityRunEventType mapping, coalescing rules | Active |
| [`orchestrator.md`](./orchestrator.md) | Runner kernel design (chat dispatch, supervisor delegation, schedules) | Active |
| [`AGENTS.md`](../AGENTS.md) | Project-wide rules (cache invariants, runtime boundary, RBAC, etc.) | Active |
