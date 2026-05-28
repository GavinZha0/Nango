# Artifact System Evolution — Research & Design Notes

Pre-implementation design for the next wave of Nango's artifact
subsystem. The artifact tree + dashboard composition (M1/M2) is
already landed; this doc covers the **renderer layer + display model
+ workflow integration** that turns artifacts from one-shot chat
outputs into persistent, interactive data products.

> **Pivots during design** — this doc went through one major
> architectural pivot (the `artifact_data_binding` → workflow ref
> shift). See §11 for the full revision history.

Status: **design resolved; ready for implementation pending review of
two reference OSS workflow projects**.
The phased rollout in §7 is the agreed build order. See §8 for the
resolved decision log.

Separate from:
- `docs/artifact-dashboard-migration.md` — tree schema + dashboard
  composition, already implemented (M1/M2)
- `docs/data-visualization.md` — chat-time chart generation flow
- **`docs/workflow-architecture.md` — the Workflow subsystem that
  owns all data binding semantics for chart artifacts**

This doc covers: **what happens to an artifact after it's saved**
(rendering, display, citation, code, PPT, HTML — all the artifact-
specific UX). For data binding / refresh / filter, see the workflow doc.

> **Data engine ↔ UI engine separation.** This doc covers the UI
> engine (artifact). The companion `workflow-architecture.md` covers
> the backend data engine. See `workflow-architecture.md` §3.0 for
> the explicit architectural statement: workflow holds the DAG and
> produces datasets / scalars; artifact holds the UI configuration
> (chart type, ECharts skeleton, HTML config, etc.) and consumes
> data from the workflow at view time. They meet via the `artifact.workflow_id`
> + `workflow_output_field` columns (D28 retired `workflow_output_node`
> — `workflow_output_field` names a key in `workflow.spec.outputs`,
> the top-level outputs map).
> A single workflow can power **many** artifacts with different UI
> configurations (1:N, see `workflow-architecture.md` §12.1 and
> §5.1.1 below).

---

## 1. Context

### 1.1 What Nango has today

The current artifact subsystem (per `docs/artifact-dashboard-migration.md`
+ code inspection):

| Layer | Status |
|---|---|
| Artifact tree (folder + leaf, self-FK, system categories) | ✅ Landed (M1) |
| Dashboard tree + composition (M2M + react-grid-layout) | 🚧 In progress (M2) |
| Chat-time chart generation (`render_chart` outcome) | ✅ Works (ECharts) |
| Save chart → artifact row | ✅ Works |
| 7 artifact types declared | ✅ `code` / `chart` / `dashboard` / `image` / `html` / `ppt` / `report` |
| HTML renderer | ⚠️ Basic — `<iframe sandbox="allow-scripts">` only; no postMessage bridge |
| Code renderer | ✅ Works (Mermaid + plain pre) |
| Image renderer | ✅ Works |
| **Chart renderer** | ❌ `PlaceholderCard` — no actual ECharts in artifact view |
| **PPT renderer** | ❌ `PlaceholderCard` |
| **Report renderer** | ❌ `PlaceholderCard` |
| **Filter UI on charts** | ❌ Does not exist |
| **Independent data refresh** | ❌ Does not exist — saved chart is frozen at agent generation time |

The user-visible gap: **once you save a chart, it's a dead screenshot**.
You can't change time range, you can't slice by region, you can't see
new data without re-running the agent. Compared to even basic BI
tools (Superset, Metabase, Grafana), this is a step back.

### 1.2 What we want (the 5 user-asked questions)

1. **HTML page artifacts** — how to render properly (currently minimal)
2. **PPT artifacts** — how to render at all (currently placeholder)
3. **PPT pagination** — how to navigate slide-by-slide
4. **Chart filters** — how to let users slice the chart after the agent has left
5. **Charts that work without the agent** — auto-refresh data, persistent live data products

These five questions split cleanly into **three workstreams**:

- **Workstream A: HTML rendering polish** (Q1)
- **Workstream B: Presentation format** (Q2, Q3)
- **Workstream C: Interactive data products** (Q4, Q5) ⭐ — the strategic one

Workstream C is the largest in scope and the biggest product unlock.

### 1.3 What's out of scope here

- Code interpreter / sandbox execution beyond what we have (already
  covered in `run_code_in_sandbox`)
- Real-time collaboration on artifacts (multi-user editing)
- Versioning / iteration history (Anthropic Artifacts has this; defer)
- Inline edit suggestions (OpenAI Canvas pattern; defer)
- Block-based artifact composition inside an artifact (Notion-style
  nested blocks; defer)
- Generative UI streaming JSX (Vercel v0 / RSC pattern; defer — JSON
  streaming is enough for our chart use case)

---

## 2. Industry Reference Scan

We surveyed industry-leading artifact / canvas / generative-UI systems
+ BI tools. Below is the comparative scan with attribution and
relevance verdict.

### 2.1 Chat artifact / canvas systems

| System | Approach | Sandboxing | Streaming | Relevance |
|---|---|---|---|---|
| **Anthropic Artifacts** | XML tags emitted in stream (`<artifact>`); per-type render (HTML/SVG/React/Mermaid) | `sandbox="allow-scripts allow-popups"` + postMessage | XML streamed chunk by chunk | **High** — our pattern is the same; adopt postMessage bridge |
| **OpenAI Canvas** | Side-by-side panel, in-place edit + inline suggestions | iframe sandbox | partial code streams | Medium — interaction model is different (side panel vs our right-panel chat) |
| **Vercel v0** | RSC streaming of JSX directly; shadcn/ui components | N/A (server-rendered) | RSC stream | Low — solves "stream generative UI", not "saved interactive artifact" |
| **LobeChat (OSS)** | Renderer registry per type; iframe + postMessage for HTML | sandbox="allow-scripts" | partial JSON accumulation | High — direct reference for renderer pattern |
| **Open WebUI (OSS)** | Minimal — HTML + Mermaid + code | sandbox="allow-scripts" | basic | Low — too minimal |
| **AssistantUI** | Block model: message → block → tool result; plugin renderers | N/A | partial result accumulation | Medium — block model converges with ours |
| **CopilotKit / AG-UI** (our stack) | ToolCall streaming via JSON | N/A | partial JSON via ChunkBuffer | **High** — already our protocol; don't reinvent |

**Key takeaways**:
- Industry has **converged on `iframe sandbox="allow-scripts"` (no `allow-same-origin`) + postMessage bridge** for HTML artifacts. Our half-done implementation needs the bridge.
- **Renderer-registry-by-type** is the dominant pattern. We already have it (`ArtifactRenderer` switch); just need to fill in the placeholders.
- **RSC streaming generative UI** (Vercel v0) is impressive but is for **live generation**, not for **persisted interactive products**. Different problem.

### 2.2 Presentation in browser

| Library | Format | Maintenance | Bundle | Pagination | Export |
|---|---|---|---|---|---|
| **Marp** | **Markdown-driven** (Marp directives, `---` slide separator) | Active (marp-team org, monorepo) | `@marp-team/marp-core` ~80 KB | Built-in `paginate: true` | `marp-cli` → PPTX / PDF |
| **Reveal.js** | HTML `<section>` markup | Active (v5 2024) | ~100 KB core, ~200 KB with plugins | Built-in `Reveal.next()` API | PDF via print stylesheet; no PPTX |
| **Slidev** | Markdown + Vue components | Active (antfu) | Heavy, Vue-based | Built-in | Various |
| **Spectacle** | React-native deck library | Active (Formidable) | Medium | Component-based | Limited |
| **pptxjs / pptx-to-html** | Parse `.pptx` binary | Mixed | Medium | Limited | Display only |

**Winner: Marp.** Reasons:

1. **Agent-friendly emission** — agents write **Markdown**, our existing
   strongest output. No need to teach the agent HTML section markup
   (Reveal) or Vue (Slidev).
2. **Lightweight bundle** — Marp Core is ~80 KB. We don't drag in Vue.
3. **Front-matter directives** — `theme: gaia`, `paginate: true`,
   `size: 16:9` declaratively configure the deck.
4. **Slide separator is just `---`** — a Markdown native.
5. **PPTX export** is real (`marp-cli`), so users can download to
   PowerPoint if they need to.
6. **Doesn't require us to make agents output structured slide JSON**
   — flat Markdown blob is the canonical store.

Reveal.js is a fine alternative but requires HTML markup, which adds
friction for agent emission. Slidev brings Vue into a React app,
non-starter.

Reference: https://marp.app/, https://github.com/marp-team/marp-core

### 2.3 Chart filtering

| Approach | Where filter lives | Re-render mechanism | Suitability for Nango |
|---|---|---|---|
| **ECharts built-in** (`dataZoom`, `brush`, `legend`) | Inside chart config | `setOption()` patch | ✅ **Use for in-chart drill** (date range slider, brush select) |
| **Vega-Lite `selection` + `param`** | Inside spec | Vega runtime reactive eval | ❌ We're not on Vega — switching costs huge |
| **Plotly built-in** (dropdown menus, range slider) | Inside layout | Plotly events | ❌ Not on Plotly |
| **Tremor-style filter UI** | **Outside chart**, in a separate filter bar | Re-execute query, patch series | ✅ **Use for our cross-data filters** |
| **Apache Superset "Native Filters"** | Dashboard level | Cross-filter cascade | Inspiration for V2 dashboard filters |
| **Grafana template variables** | Dashboard level | Variable interpolation into query | Inspiration for V2 dashboard variables |

**Recommendation: Hybrid model.**

- **ECharts native controls** (`dataZoom`, `brush`, `legend.selected`) for **in-chart interactions** — zoom into time range, select brush, toggle series. These work on already-loaded data.
- **Tremor-like filter chip bar** above the chart for **data filters** — region dropdown, year range, etc. These cause the **underlying query to re-execute** with new parameters.

We declaratively store filter definitions in `artifact.config` (JSON); the chart renderer reads them and produces the filter UI + binds them to the query.

### 2.4 Independent data refresh / reactive bindings

This is the **biggest architectural decision** in this doc.

| System | Query abstraction | Refresh modes | Caching | Filter cascade |
|---|---|---|---|---|
| **Grafana** | Named datasource + parameterised query; `$variable` interpolation | on-load, every N seconds, on-variable-change | Per-query cache, configurable TTL | Dashboard variables propagate to all queries |
| **Apache Superset** | Saved queries (datasets + metrics); SQL Lab | on-load, scheduled, on-filter-change | Redis cache with TTL | Native Filters cross-filter dashboard |
| **Retool** | Named REST/SQL/GraphQL queries; `{{ query.data }}` binding | on-load, on-interval, on-event, manual | Implicit memo | Implicit via bindings |
| **Streamlit** | Implicit (Python script re-runs on widget change) | Reactive (any widget change) | `@st.cache_data` decorator | Implicit via execution order |
| **Observable** | Reactive cells, dependency DAG auto-tracked | Reactive + `invalidation` promise | Implicit | Implicit via DAG |
| **Hex** | Reactive notebook cells | Reactive | Implicit | Implicit |

**Pattern convergence**: Every serious system has these three concepts:

1. **Named query** — SQL/REST template parameterised by variables; not embedded in the chart spec
2. **Refresh policy** — explicit, with at least three modes (on-load, on-schedule, on-input-change)
3. **Filter parameters** — declared list, bound to query variables, surfaced as UI

This trio is the **target architecture for Nango**. We already have the building blocks:

- **Named query** — we already have `data_source` table + `extract_dataset_by_sql` tool. We need to **persist the query** alongside the artifact, not just consume it at chat time.
- **Refresh policy** — we already have `schedule` table + in-process `setTimeout` scheduler. We just need to **bind a schedule to an artifact's refresh action**.
- **Filter parameters** — net new. JSON list in `artifact.config`.

Reference: https://grafana.com/docs/grafana/latest/dashboards/variables/, https://superset.apache.org/docs/configuration/cache/, https://retool.com/products/queries

### 2.5 Chat → Artifact separation mechanism (foundational decision)

Before settling on artifact **types**, we have to settle the more
foundational question: **how does content flow from agent to artifact?**
This is the architectural axis that determines whether a system feels
predictable, surprising, expensive, or fragile.

#### Five patterns observed in industry

| # | Pattern | Mechanism | Used by |
|---|---|---|---|
| 1 | **Tool binding** (structured) | LLM emits structured tool call → frontend renderer consumes args | **Nango current**, CopilotKit/AG-UI, ChatGPT functions, Cursor, Hex, Devin |
| 2 | **Inline tag / fenced block** | LLM writes markers in text (`<artifact>...`, ` ```mermaid `); client parses stream | **Anthropic Artifacts**, Claude/ChatGPT code blocks, LobeChat, Open WebUI |
| 3 | **Generative UI / RSC stream** | LLM generates JSX; server compiles; browser streams | **Vercel v0**, Vercel AI SDK `streamUI` |
| 4 | **Post-hoc LLM extraction** | LLM produces freeform text; secondary LLM analyses + extracts | Rare for primary path. **Variant 4c** (user-triggered "convert this to...") used by OpenAI Canvas, Notion AI |
| 5 | **Structured whole-response** | Entire reply is JSON; text + artifacts as fields | CrewAI, AutoGen programmatic outputs |

#### Trade-off matrix

| Dimension | 1: Tool | 2: Inline tag | 3: RSC | 4: Post-hoc | 5: JSON |
|---|---|---|---|---|---|
| LLM autonomy | low | medium | high | high | low |
| Schema rigor | high | medium | n/a | low | high |
| Streaming UX | excellent | excellent | excellent | **poor** | poor |
| Cost per turn | normal | normal | normal | **2× LLM** | normal |
| Provenance | clear | clear | weak (frozen) | weak | clear |
| Type safety | yes | no | no | no | yes |
| Pre-design cost | **high** | medium | low | low | high |
| Re-renderable later | yes | yes | **no** | yes | yes |

#### Why pattern 4 (LLM post-extraction) is NOT the primary path

The intuition "let a second LLM read the response and extract
artifacts" is appealing because it removes the "must pre-define
tools" cost of pattern 1. But it doesn't survive scrutiny:

- **2× LLM cost on every chat turn** — significant economics impact
- **Latency** — must complete agent response + complete extraction
  before user sees the block
- **Streaming UX breaks** — can't show partial artifact during agent
  emission
- **Provenance ambiguity** — which sentence of original text became
  this artifact? Hard to surface
- **Accuracy** — extraction LLM hallucinates structure ~5-10% of
  the time even on good models
- **Industry signal** — no major chat product uses pattern 4 as
  primary path despite being technically possible for years

Pattern 4 IS valuable in three specific contexts (V2+ candidates):

| Variant | When | Cost profile |
|---|---|---|
| **4a — async post-extract** | Retroactive extraction from historical chats (no tool call in old messages) | Cost only when triggered |
| **4b — parallel extract** | Research only; no commercial product does this | High; rare |
| **4c — user-triggered** | "Convert this to a chart / table / report" button on selected text | On-demand, user-paid |

OpenAI Canvas and Notion AI both implement 4c as a "convert this"
right-click action. This is **a viable V2 enhancement for Nango** but
not the primary mechanism.

#### Why patterns 3 (RSC) and 5 (JSON) are rejected for our use case

**Pattern 3 (RSC stream)**: produces **frozen JSX** that can't be
re-rendered later with new data, can't be filter-bound, can't be
edited. Vercel v0 is "draft your UI", not "save your interactive
product". Different problem space. Fails the "data binding +
refresh" goal of §3.4 immediately.

**Pattern 5 (whole-response JSON)**: sacrifices conversational
naturalness for predictability. Modern chat products universally
avoid it. Useful inside agent framework programmatic outputs
(CrewAI, AutoGen) but never in user-facing chat.

#### Nango's chosen strategy: hybrid 1 + 2, with 4c as future enhancement

| Layer | Pattern | What it handles |
|---|---|---|
| **Primary** | Pattern 1 (tool binding) | High-value structured outputs: `render_chart`, `web_search`, image generation, dashboard, `extract_dataset_by_sql` |
| **Secondary** | Pattern 2 (fenced code blocks) | Lightweight inline content: ` ```mermaid `, ` ```sql `, ` ```chart-spec `, generic code (already supported) |
| **Future enhancement** | Pattern 4c (user-triggered post-extract) | Right-click selected text → "Extract as chart / table / report" (V2+) |

This split mirrors:
- **ChatGPT** — function calling for DALL-E / Code Interpreter / web
  search; fenced blocks for code
- **Claude / Anthropic Artifacts** — `<artifact>` for substantial
  content; fenced blocks for code; no tool-bound rendering
- **Cursor / Devin** — explicit tools for write/replace/diff; fenced
  blocks for code samples

The convergence isn't coincidence. **Hybrid 1+2** is what works in
production.

#### Provenance principle (cross-pattern invariant)

Across all patterns Nango uses, **the block must preserve evidence,
not replace it with interpretation**. This is the single most
important invariant for trust:

| Flow | Block holds | Chat holds |
|---|---|---|
| Web search → block | source URLs + snippets | LLM synthesis with `[N]` citations |
| KB retrieval → block | retrieved passages + doc refs | LLM synthesis with `[N]` citations |
| SQL query → block | raw rows | LLM analysis |
| Multi-modal upload (future) → block | extracted structure (tables, entities) | LLM interpretation |

A block that holds another LLM summary instead of evidence collapses
back into "the chat" and loses its reason to exist. See §3.6 for
the citation-driven implementation pattern that makes this work.

---

## 3. Technical Building Blocks

### 3.1 HTML sandbox + postMessage bridge

**iframe sandbox tokens** (https://developer.mozilla.org/en-US/docs/Web/HTML/Element/iframe#sandbox):

| Token | What it allows | For our HTML artifacts? |
|---|---|---|
| `allow-scripts` | JavaScript execution | ✅ Required for interactivity |
| `allow-same-origin` | Access to parent origin storage/cookies | ❌ **NEVER** combine with `allow-scripts` (sandbox escape) |
| `allow-forms` | Form submission | Optional — only if HTML has forms |
| `allow-popups` | `window.open()` | Optional — handy for external links |
| `allow-modals` | `alert()`, `confirm()` | Safe enough; consider allowing |
| `allow-downloads` | `<a download>` | Optional |
| `allow-top-navigation` | Navigate parent frame | ❌ Dangerous, never allow |

**Current Nango HTML renderer**: `sandbox="allow-scripts"`. ✅ Correct baseline.

**What's missing — the postMessage bridge**:

```
┌─────────────────────────────────────────────────┐
│ Host (Nango artifact panel)                     │
│                                                  │
│  iframe ref + message listener                   │
│      │                                           │
│      │ window.addEventListener("message", …)    │
│      ▼                                           │
│   [iframe sandbox="allow-scripts"]              │
│      │                                           │
│      │ srcDoc=<HTML + injected bridge script>   │
│      ▼                                           │
│  ResizeObserver in iframe →                     │
│    window.parent.postMessage({type:"resize"…})  │
└─────────────────────────────────────────────────┘
```

Three message types the bridge supports:

| Direction | Type | Purpose |
|---|---|---|
| iframe → host | `resize` (height) | Auto-resize iframe to content height |
| iframe → host | `navigate` (url) | User clicked external link; host opens in new tab (since `allow-popups` may or may not be set) |
| host → iframe | `theme` (light/dark) | Propagate Nango theme into artifact |

**Implementation detail**: the bridge script is injected by us **just before `</body>`** in the HTML the agent emitted. Agents don't need to know about it.

```ts
function injectBridge(html: string): string {
  const bridge = `<script>(function(){
    const send = (m) => window.parent?.postMessage(m, "*");
    new ResizeObserver(() => send({type:"resize", height: document.documentElement.scrollHeight})).observe(document.body);
    document.addEventListener("click", e => {
      const a = e.target.closest("a[href]");
      if (a && a.target !== "_self") { e.preventDefault(); send({type:"navigate", url: a.href}); }
    });
    window.addEventListener("message", e => {
      if (e.data?.type === "theme") document.documentElement.dataset.theme = e.data.theme;
    });
    send({type:"resize", height: document.documentElement.scrollHeight});
  })();</script>`;
  return html.includes("</body>") ? html.replace("</body>", bridge + "</body>") : html + bridge;
}
```

**Defensive note**: injecting a script into `srcDoc` content is safe because the iframe is sandboxed without `allow-same-origin` — the bridge can only postMessage out, can't access cookies or parent DOM.

### 3.2 PPT rendering — Marp deep dive

**Format**: a single Markdown blob with front-matter directives + `---` slide separators:

```markdown
---
theme: default
paginate: true
size: 16:9
---

# Project Status

Q4 2025 review

---

## Highlights

- Memory subsystem design landed
- Artifact subsystem evolution in flight

---

## Next Steps

1. P1a: data binding
2. P1b: HTML bridge
3. P1c: Marp renderer
```

**Render pipeline**:

```
┌──────────────────────────────┐
│ artifact.content (string)    │   raw Markdown
└──────────────────────────────┘
              │
              ▼
┌──────────────────────────────┐
│ @marp-team/marp-core         │   Marp.render(markdown)
└──────────────────────────────┘
              │
              ▼
┌──────────────────────────────┐
│ { html, css, comments }      │   one big HTML string + CSS
└──────────────────────────────┘
              │
              ▼
┌──────────────────────────────┐
│ split on <section> elements  │   each <section> = one slide
└──────────────────────────────┘
              │
              ▼
┌──────────────────────────────┐
│ React deck navigator         │   show one slide at a time
│  ◀ [3 / 12] ▶  [⛶ fullscreen]│
└──────────────────────────────┘
```

**Navigator UX**:
- Arrow keys (`←` / `→`) for prev/next
- Page counter `3 / 12`
- Fullscreen button (`requestFullscreen` API)
- Optional: thumbnail strip / "go to slide N" jump
- Print stylesheet for "Print all slides" (every section visible)

**Stored shape** — flat Markdown, no per-slide table. The slide split
is a render-time operation on the markup. Simpler schema, simpler
agent emission (the agent just writes a Markdown string).

**Export to PPTX**: `marp-cli` can convert Markdown → PPTX server-side.
This is a "Download as PPTX" button. Defer to V2 (not P1 critical) but
it's a documented escape hatch.

Reference: https://marpit.marp.app/markdown, https://github.com/marp-team/marp-core

### 3.3 Chart filter architecture

Two layers, kept distinct:

**Layer A — ECharts native (in-chart interactions)**

Already supported by ECharts; no new code on our side. Just enable in
the option:

```ts
option = {
  dataZoom: [{ type: 'slider', xAxisIndex: 0 }],  // bottom time slider
  brush: { toolbox: ['rect', 'polygon', 'clear'] },  // brush select
  legend: { selectedMode: 'multiple' },  // toggle series on/off
  toolbox: { feature: { dataZoom: {}, restore: {}, saveAsImage: {} } },
}
```

These act on the **already-loaded data**. No backend round-trip.

**Layer B — Filter chip bar (data filters that re-execute query)**

This is **our new code**. A horizontal bar above the chart, declarative:

```
┌─────────────────────────────────────────────────────────────────┐
│ [Region: US ▼] [Year: 2020-2024 ━━●━━] [Metric: Revenue ▼] [↻] │
└─────────────────────────────────────────────────────────────────┘
│                                                                 │
│              ┌─────────────────────────────┐                    │
│              │      ECharts visualization  │                    │
│              └─────────────────────────────┘                    │
```

**Filter definitions** stored in `artifact.config.filters[]`:

```jsonc
{
  "filters": [
    {
      "name": "region",                  // bound to query var $region
      "label": "Region",
      "type": "dropdown",
      "config": {
        "values": ["US", "EU", "APAC"],  // static or dynamic (from query)
        "defaultValue": "US"
      }
    },
    {
      "name": "year",
      "label": "Year",
      "type": "range",
      "config": { "min": 2000, "max": 2024, "defaultValue": [2020, 2024] }
    },
    {
      "name": "metric",
      "label": "Metric",
      "type": "dropdown",
      "config": { "values": ["revenue", "profit", "units"], "defaultValue": "revenue" }
    }
  ]
}
```

Filter `type` enum (V1): `dropdown`, `multi-select`, `range`,
`date-range`, `text`. Extensible.

When user changes a filter, the chart's bound query re-executes with
the new param value. See §3.4 for the query layer.

**Where filter VALUES live** — only in React component state, NOT
persisted on the artifact row. Two users opening the same chart see
their own filter state. (Future: per-user "saved view" feature could
persist filter state per (user, artifact).)

### 3.4 Data binding architecture — REFERENCES WORKFLOW SUBSYSTEM

> **Superseded section.** Data binding for chart artifacts is now
> handled by the first-class **Workflow subsystem**. See
> `docs/workflow-architecture.md` for the full design.

**Current model** (updated):

```
┌────────────────────────────────────────────────────────────────┐
│ Chart Artifact                                                  │
│                                                                 │
│  artifact.content      = ECharts option SKELETON                │
│  artifact.config       = render config + filters[]              │
│  artifact.workflow_id           ──┐                             │
│  artifact.workflow_output_field ──┴─→ references workflow row   │
│                                      (D28 — workflow_output_node retired) │
└────────────────────────────────────────────────────────────────┘
                              │
                              │ FK
                              ▼
┌────────────────────────────────────────────────────────────────┐
│ workflow (first-class table; see workflow-architecture.md §4)   │
│                                                                 │
│  workflow.spec = DAG JSON (fetch + transform + ...)             │
│  Execution:    workflow engine runs spec, returns outputs       │
│  Refresh:      re-execute workflow + invalidate cache           │
│  Filter binds: chart filter values → workflow.inputs            │
└────────────────────────────────────────────────────────────────┘
```

**Why we moved to workflow**:

| Need | Old (`artifact_data_binding`) | New (workflow ref) |
|---|---|---|
| Single SQL fetch | ✅ Direct | ✅ Workflow with 1 node |
| SQL + Python transform | Required 2nd schema field | Standard 2-node workflow |
| Multi-source merge (3 SQL → 1 join) | Not expressible | DAG with 3 parallel fetch + 1 transform |
| Reuse data across charts | V2 special table | Multiple charts ref same workflow_id |
| Workflow editor / debug | None | Embedded "Data lineage" view in artifact details (§3.7) + chatbot-driven modify |
| Independent testing | Tied to chart | Run workflow standalone |
| Agent invocability | Roundabout | Direct: workflow can be agent tool |

**Refresh policies, cache, scheduler integration** — all now lives in
workflow doc. Briefly:

- Refresh = re-execute workflow (cache keyed by spec hash + input hash)
- Schedule = `schedule.kind = 'workflow_trigger'` with workflow_id +
  inputs payload (see workflow doc §11)
- Filter values → workflow.inputs at execute-time

**The strategic unlock is the same**: chart is independent of agent
because it points to a re-runnable workflow. The mechanism is just
more powerful (DAG-capable, reusable, agent-invocable).

#### 3.4.1 The `/api/data/resolve` endpoint (chart ↔ workflow bridge)

A single chart-facing endpoint owns the resolution path. Chart
artifacts call it on mount, on user-triggered refresh, and on filter
change. The endpoint is **artifact-shaped** (request keyed by
`artifactId`) and internally delegates to the workflow execution
machinery — it is **not** a thin proxy over `/api/workflows/:id/execute`.

**Endpoint contract**:

```
POST /api/data/resolve

request:
{
  "artifactId": "<uuid>",            // required
  "paramValues": {                   // optional; filter values from chart UI
    "<filter_name>": <value>,        // keyed by FilterDefinition.name (§5.2)
    ...
  },
  "bypassCache": false               // optional; user-clicked Refresh → true
}

response (200):
{
  "data": <workflow_output_value>,   // shape depends on the bound node output
  "meta": {
    "workflowId": "<uuid>",
    "outputNode": "<node_id>",
    "outputField": "<field_name>",
    "cacheHit": true | false,
    "executedAt": "<iso8601>",
    "executionMs": 1234,
    "stale": false                   // true if served stale on workflow failure
  }
}

response (409 — workflow link broken):
{
  "code": "WORKFLOW_UNBOUND",        // artifact.workflow_id is NULL
  "message": "Chart has no backing workflow"
}

response (404):
{
  "code": "WORKFLOW_MISSING",        // artifact.workflow_id was SET NULL
                                     // by ON DELETE; chart data is now static
  "message": "Backing workflow was deleted"
}

response (403):
{ "code": "FORBIDDEN", "message": "..." }   // user can't read artifact or workflow
```

**Server flow** (single call site, lives in `app/api/data/resolve/route.ts`):

```
1. withSession → resolves caller
2. Load artifact row → 404 if missing, 403 if not readable
3. If artifact.workflow_id IS NULL → 409 WORKFLOW_UNBOUND
4. Load workflow row → 404 WORKFLOW_MISSING if SET NULL'd or hard-deleted
5. Permission check: caller can read workflow (workflow doc §13)
6. Map paramValues → workflow.inputs via workflow.input_schema
   - Unknown keys: silently dropped (forward-compat)
   - Missing required inputs: 400 with details
   - Type coercion per input_schema
7. Compute cache key = hash(workflow.spec) + hash(resolved_inputs)
8. If !bypassCache && cache hit: return cached value (cacheHit=true)
9. Execute workflow synchronously (via workflow engine; see workflow doc §7)
10. Extract outputs[output_node][output_field] → 500 if node didn't produce it
11. Write to cache; return value (cacheHit=false)
```

**Why a chart-facing endpoint and not direct `/api/workflows/:id/execute` calls**:

| Concern | Direct execute | `/api/data/resolve` |
|---|---|---|
| Browser needs workflow_id | ❌ extra round-trip to fetch artifact | ✅ server resolves it |
| Browser must know `output_node` + `output_field` | ❌ leaks workflow internals | ✅ stays server-side |
| Filter → inputs mapping | ❌ duplicated in every chart | ✅ centralized |
| Cache key composition | ❌ exposed to client | ✅ opaque to client |
| Permission check seam | Workflow-only | Artifact AND workflow |
| Future: pre-aggregation / down-sampling at server | Hard to add | Natural extension point |

The endpoint is the **only** path the chart renderer uses for data —
no fallback to direct workflow execute from the browser. This keeps
the workflow-internal schema (`output_node` / `output_field` / cache
key composition) entirely server-side.

**Frontend usage pattern** (chart renderer):

```ts
// On mount, on filter change, on Refresh click:
const { data, meta } = await fetch('/api/data/resolve', {
  method: 'POST',
  body: JSON.stringify({
    artifactId,
    paramValues: currentFilterValues,
    bypassCache: userClickedRefresh,
  }),
}).then(r => r.json());

// Merge into ECharts option:
const option = mergeData(artifact.content.option, data);
chart.setOption(option);
```

**Streaming variant** (V2): for long-running workflows (multi-stage
Python transforms), a future `/api/data/resolve-stream` SSE endpoint
can emit `progress` events as nodes complete. V1 is purely
request/response with 60s timeout (matches workflow sync execute).

### 3.5 Streaming partial artifacts (V2)

Not P1. Documented for completeness.

Two industry patterns:

- **Vercel AI SDK `streamObject`** — schema-validated partial JSON
  streaming with Zod; great for streaming a chart spec progressively
  ("first the axes appear, then the bars fill in")
- **AG-UI ToolCall streaming** — our existing protocol; we already get
  partial JSON via CopilotKit's ChunkBuffer

We can defer "live partial chart rendering during agent generation"
to V2 — V1's "wait for full tool call → render" is fine and matches
current chat UX.

### 3.6 Citation-driven artifacts (source block + inline `[N]` citations)

When a tool returns a list of **evidence items** (web search results,
KB passages, retrieved SQL rows, file lookups), and the chat needs to
reference them, the industry-converged pattern is **numbered
citations**.

This pattern is the concrete implementation of the provenance
principle from §2.5: block carries evidence, chat carries
interpretation linked by `[N]` references.

#### The Perplexity model (canonical example)

```
┌─ Chat ──────────────────────────┐    ┌─ Block (Sources) ──────────────┐
│ Based on recent reports [1][2], │    │ [1] news.example.com           │
│ the market grew 15% in Q4.      │◀──▶│     Title · 2024-10-15         │
│ Early analyst reactions [3]     │    │     Raw snippet text...        │
│ have been positive [2][4]...    │    │     ↗ Open                     │
│                                 │    │                                │
│                                 │    │ [2] techreview.com             │
│                                 │    │     ...                        │
│                                 │    │ [3] ...                        │
│                                 │    │ [4] ...                        │
└─────────────────────────────────┘    └────────────────────────────────┘
```

#### Why this pattern wins

| Property | Mechanism |
|---|---|
| Block is non-redundant | Block carries evidence (URL, date, snippet); chat carries narrative — different jobs |
| Verifiability | Every claim links to a numbered source the user can open |
| Reusable across domains | Web / KB / SQL / file lookup all share the same `[N]` UX |
| LLM-friendly | Modern LLMs reliably emit `[N]` when system prompt asks |
| User-intuitive | Familiar from academic citation, Wikipedia, news |
| Streaming-friendly | `[N]` markers stream inline as text; block already populated before chat synthesis starts |

#### Schema: `CitationBlockContent`

A single shape, reused across all evidence-driven block types:

```ts
interface CitationBlockContent {
  query: string;                    // what was searched / retrieved
  source_kind: 'web' | 'kb' | 'sql' | 'file' | string;
  sources: Array<{
    id: string;                     // stable id (used as `[N]` mapping key + scroll target)
    index: number;                  // the N in `[N]` (1-based for display)
    title: string;
    url?: string;                   // for web / external KB
    domain?: string;                // derived from URL (display + trust signal)
    publishedAt?: string;           // ISO-8601 (web search, doc)
    snippet: string;                // RAW source text — do NOT replace with LLM gloss
    refinedLabel?: string;          // optional V2: short LLM label
                                    // (Pattern 4 applied per-source, snippet preserved)
    // domain-specific decoration:
    sqlRowIndex?: number;           // for source_kind='sql'
    docPath?: string;               // for source_kind='kb' or 'file'
  }>;
}
```

#### System prompt convention

Agents using a citation-block-emitting tool must be instructed:

> "When using results from the <tool> tool, cite specific items inline
> using `[N]` syntax (matching the `index` field of each source in the
> tool result). Do not paraphrase a source without citing it. Multiple
> citations per claim use `[1][2]` form."

This works reliably with GPT-4/5 class, Claude 3.5+, and most modern
OSS models. We've verified with our own testing patterns: failure
rate <2%, mostly missing-citation (not wrong-citation).

#### Frontend implementation — V1 (static) vs V2 (interactive)

**V1 minimal scope** — static numbered display, no `[N]` click
interaction. With typical search returning ≤ 5-10 sources, users
visually cross-reference between the `[N]` in chat text and the
numbered cards in the outcomes block. No engineering for clicks,
popovers, or panel coordination.

| Element | V1 behaviour | V2 behaviour |
|---|---|---|
| `[N]` markers in chat | Plain markdown text rendered as-is (`[1]`, `[2]`, ...) | Clickable pill |
| Hover `[N]` | None | Tooltip with source title + domain + date |
| Click `[N]` | None | Inline popover with snippet + Open URL button |
| Block source card | Shows raw snippet + numbered badge `[1]`, `[2]`, ... + "Open" button if `url` present | Same |
| Consecutive `[2][3][4]` | Plain text | Optional grouped pill `[2-4]` |
| Domain favicon / kind icon | Visible on card | Same |

**V1 implementation**: just the card-side numbering + the system
prompt convention that tells the LLM to use `[N]`. No
`<CitationPills>` component, no chat-side parser, no scroll-to /
highlight bridge.

**V2 implementation** (if/when telemetry says users want it):
add `<CitationPills>` parsing in chat + inline popover on click.
**Skip** the auto-scroll panel coordination (option B from the
P1g discussion) — too many edge cases for marginal value.

#### Reusable across evidence-driven flows

The same `CardListItem` shape (with `index` + `sourceKind`) + `[N]`
text convention extends to every other "block of evidence + chat
narrative" case:

| Flow | sourceKind | What's reusable in V1 |
|---|---|---|
| Web search | `'web'` | Numbered cards, raw snippets, Open URL |
| KB document retrieval | `'kb'` | Numbered cards, passage snippets, "View doc" button |
| SQL query rows | `'sql'` | Numbered rows, raw values |
| File lookup (multi-modal) | `'file'` | Numbered files, thumbnails |
| Code search | `'code'` | Numbered repo:path:line snippets |

**Building this in V1 = every future evidence-driven artifact gets**:
- LLM citation discipline (one system prompt convention)
- Numbered source-card rendering (with type-specific decoration)
- Provenance: raw source content preserved, never LLM gloss

V2 interactive enhancements (clickable pills, popovers, scroll) are
deferred uniformly — they'd benefit all evidence-driven flows
together when added later.

This V1 minimum is **the highest-leverage UX building block in V1**
because every future tool that returns evidence inherits the
correct architecture for free.

### 3.7 Data lineage view (workflow visualization embedded)

> **NEW section (D11, D14, D15).** The workflow subsystem
> (`workflow-architecture.md`) does NOT ship a standalone
> `/workflow/<id>` page in V1. Instead, workflow DAGs are
> **embedded** into the artifact details page as a "Data lineage"
> tab/drawer. This section owns the lineage UX; the workflow doc
> §9 is a one-paragraph stub pointing here.

For artifacts whose `workflow_id` is set (chart, html-with-data,
report-with-data, dataset, dashboard tile, …), the artifact details
page surfaces a **Data lineage** tab/drawer showing the workflow
DAG that produced this artifact's data. The view is **read-only** —
modifications go through the unified chatbot via `modify_workflow`
(see `workflow-architecture.md` §10.2) or `modify_artifact_display`
(§10.3).

#### 3.7.1 UX shape

A right-side tab (or bottom drawer; UX team picks at implementation
time) within the artifact details page:

```
┌─ Artifact details (chart) ──────────────────────────────────┐
│ [Preview]   [Filters]   [Data lineage]   [Runs]   [Share]  │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  ┌─ fetch ────┐  ┌─ analyze ──┐  ┌─ out ──┐                 │
│  │ SQL        │─▶│ Python     │─▶│ output │                 │
│  │ ✓ 230 ms   │  │ ✓ 1.4 s    │  │        │                 │
│  └────────────┘  └────────────┘  └────────┘                 │
│                                                              │
│  Click a node → side panel with last-run input/output       │
│  (drawn from ref-token lineage; see workflow-architecture   │
│  §7.10).                                                     │
└──────────────────────────────────────────────────────────────┘
```

#### 3.7.2 Layout algorithm

Read-only column-by-topo-level DAG, **~100 LoC borrowed from OMA's
`layoutTasks` algorithm** (`open-multi-agent/src/dashboard/layout-tasks.ts`).
The same layout powers the run history view at `/run/[runId]` — one
implementation, two surfaces.

#### 3.7.3 Per-node display

Each node tile renders:

- Tool name (e.g. `extract_dataset_by_sql`, `run_code_in_sandbox`,
  agent display name)
- Description (the LLM-emitted `description` field; D7 in
  `workflow-architecture.md` §5.0)
- Last-run status (✓ success / ✗ failed / ◷ running / ◌ skipped)
- Duration (last completed run; ms / s)
- Type indicator badge (tool / agent / control-flow)

#### 3.7.4 No edit affordances

Per D11 (`workflow-architecture.md` §9 stub), the view has **no
edit affordances**:

- No drag-create
- No edge rewire
- No inline form for node config
- No delete-node menu

To change anything, the user opens the unified chatbot from
anywhere in the app and says "add a date filter to this chart" /
"change this to monthly aggregation" / "drop the Python step" —
the agent calls `modify_workflow` or `modify_artifact_display` and
the change persists. The lineage view re-renders on next paint.

#### 3.7.5 Click-through to run drill-down

Clicking a node opens a side panel showing the most recent run's
input and output for that node. The side panel is the same shape
as `/admin/run/[id]`'s per-node forensics, just with owner
permission gating instead of admin gating.

Data flows: the panel reads `entity_run_event` rows for the node
plus the `entity_run.refTable` (`workflow-architecture.md` §7.10)
for lineage drill-down — "where did this value come from?".

A "View full run history" link in the panel navigates to
`/run/[runId]` (owner-accessible, no `/admin` prefix). That page
renders the same lineage view plus the timeline of every node's
events for the selected run.

#### 3.7.6 Cross-references

- `workflow-architecture.md` §3.0 — data engine ↔ UI engine
  separation (the architectural foundation for this view)
- `workflow-architecture.md` §3.7 — workflows subsystem layout +
  Dependency Injection pattern (D17); explains why
  `modify_artifact_display` lives under `src/lib/artifacts/`
  while `modify_workflow` lives under `src/lib/workflows/`
- `workflow-architecture.md` §9 — the stub redirecting here
- `workflow-architecture.md` §10.2 — `modify_workflow` tool (how
  modifications happen)
- `workflow-architecture.md` §10.3 — `modify_artifact_display`
  tool (UI-only modifications)
- `workflow-architecture.md` §7.10 — ref tokens powering per-node
  drill-down

**Implementation locality recap (Correction 1)**:

- The visualization data comes from `workflow.spec` via
  `GET /api/workflows/:id`.
- Modifications to the chart (chart type, axes, colors, ECharts
  option) go through `modify_artifact_display` — defined in
  `src/lib/artifacts/runtime-tools.ts`, **NOT**
  `src/lib/workflows/runtime-tools.ts`. The tool patches
  `artifact.content` (see §5.1).
- Modifications to the underlying data pipeline (add filter,
  change SQL, change aggregation) go through `modify_workflow`
   — defined in `src/lib/workflows/runtime-tools.ts`. The tool
  rewrites `workflow.spec`.
- The two tools are conceptually paired but live in separate
  subsystems per their data-locality.

---

## 4. Recommendations — answering the 5 user questions

### 4.1 Q1: HTML artifact display

**Adopt**: iframe + postMessage bridge.

| Component | Decision |
|---|---|
| Sandbox | `sandbox="allow-scripts allow-popups allow-modals"` (no `allow-same-origin`) |
| Bridge | postMessage injection (auto-resize, theme, navigate) |
| Theme | Send Nango theme to iframe via host → iframe message on theme change |
| Style isolation | iframe is naturally CSS-isolated; no leakage in/out |
| Loading state | Spinner overlay until first `resize` message arrives |
| Error handling | If iframe `error` event fires, show fallback |

**Effort**: 2-3 days. Mostly the bridge script + ResizeObserver +
React iframe ref management.

### 4.2 Q2 + Q3: PPT artifact display + pagination

**Adopt**: Marp Core + custom deck navigator.

| Component | Decision |
|---|---|
| Storage | `artifact.content` = single Markdown string |
| Render lib | `@marp-team/marp-core` (Marp.render) |
| Slide split | After render, split HTML on `<section>` elements |
| Navigator | Custom React component: keyboard nav, page counter, fullscreen, optional thumbnail strip |
| Print | Marp's default print CSS works; emit on `?print=1` query string |
| PPTX export | V2 — server-side `marp-cli` |
| Front-matter | Pass through; theme/paginate/size respected |

**Effort**: 4-5 days. Marp integration is small; navigator UI takes
most of the time.

### 4.3 Q4: Chart filter UI

**Adopt**: declarative `filters[]` in `artifact.config` + filter chip
bar component + ECharts `dataZoom` for in-chart drill.

| Component | Decision |
|---|---|
| Filter spec | `artifact.config.filters[]` — JSON, see §3.3 |
| Filter UI | Custom React filter bar; reuse existing UI primitives (shadcn `Select`, `Slider`, `DatePicker`) |
| Filter state | React state only, not persisted on artifact |
| In-chart drill | ECharts `dataZoom`, `brush`, `legend` (configured in option) |
| Re-execute trigger | onChange → invalidate cache key → refetch via data binding |
| Loading state | Skeleton overlay during refetch |

**Effort**: 5-7 days. Filter bar is straightforward; trickiest is
binding filter values into the query parameter shape.

### 4.4 Q5: Charts independent of agent (auto-refresh) — VIA WORKFLOW

**Adopt**: Chart artifact references a workflow; refresh re-executes
the workflow. See `docs/workflow-architecture.md` for the full design.

| Component | Decision |
|---|---|
| Persistence | `artifact.workflow_id` + `workflow_output_field` (FK to `workflow` table; D28 retired `workflow_output_node`) |
| Data fetch | Workflow's DAG handles fetch (SQL via `extract_dataset_by_sql` node, MCP, inline, Python transforms) |
| Refresh mechanism | Re-execute workflow; cache keyed by `hash(spec) + hash(input_values)` |
| Schedule integration | `schedule.kind='workflow_trigger'` (not `artifact_refresh`) |
| Cache | Workflow execution cache (see workflow doc §7.4) |
| Filter binding | Chart filter values → workflow.inputs at execute-time |
| ECharts data injection | Server resolves workflow output → merges into `option.dataset.source` |

**Effort**: Now part of workflow subsystem build (see §7 Phased
Rollout). Pure chart-side work (~1 week for FK columns + render
integration) plus workflow subsystem build (separate phase).

### 4.5 Case study: Web Search artifact (citation-driven, template for KB)

This wasn't in the original 5 questions but emerged as a critical
foundational application of §3.6's citation-driven pattern. The current
`web_search` flow has a UX redundancy that we should fix in P1, and
the fix establishes the reusable citation infrastructure that
benefits **every future evidence-driven artifact** — most importantly
KB document retrieval (`docs/kb-architecture.md`).

#### Current problem

The existing web_search flow:
1. Tool returns search engine results (already summarised by engine)
2. Frontend renders block with the engine summary text
3. The same results are passed back to the LLM
4. The LLM re-summarises and outputs to chat

The user sees **two summaries** (block + chat), with no clear
relationship. The block reads like "another version of what the chat
said" — it loses its reason to exist.

#### Root cause (per §2.5 provenance principle)

The block is acting as *narrative* (another LLM-style summary)
instead of *evidence* (raw source list). Once the block becomes
narrative, it collapses into the chat.

#### Recommended redesign

| Change | Before | After |
|---|---|---|
| Block content shape | Single text blob (engine summary) | `CitationBlockContent` (§3.6) — numbered source cards |
| Each source card | N/A (folded into summary) | `{title, url, domain, publishedAt, snippet}` per source |
| Snippet origin | LLM re-paraphrased | **Raw engine snippet** (preserve provenance) |
| Chat response | LLM re-summary, no citations | LLM synthesis with **mandatory inline `[N]`** |
| User → source link | Buried in summary text | Click `[N]` → block scrolls + highlights source |
| Hover `[N]` | N/A | Tooltip: title + domain + date |
| Source `url` | N/A on each item | First-class "Open" button per source card |

```
┌─ Chat ───────────────────────────────┐   ┌─ Block (Sources) ──────────────────┐
│ XXX 公司在 2024 推出 Y 产品 [1][2],  │   │ 🔍 Web search: "XXX 2024 产品发布"  │
│ 早期用户反馈集中在续航问题 [4]。     │   │ ──────────────────────────────────  │
│ 分析师评论较为正面 [2][3],认为...    │◀▶ │ [1] news.example.com · 2024-10-15  │
│                                      │   │     XXX 公司宣布 Y 产品...          │
│                                      │   │                         [↗ Open]   │
│                                      │   │                                    │
│                                      │   │ [2] techreview.com · 2024-10-16    │
│                                      │   │     ...                            │
│                                      │   │ [3] ...                            │
│                                      │   │ [4] ...                            │
└──────────────────────────────────────┘   └────────────────────────────────────┘
```

#### Implementation work (P1g — V1 minimal scope)

V1 ships **static citation display only** — no clickable `[N]`
interaction. The LLM emits `[N]` as plain markdown text in chat;
the block displays numbered source cards. **Users visually
cross-reference**. With ~5 sources per search and clear numbering
on both sides, this is enough for verification.

| Step | Work | Effort |
|---|---|---|
| S1 | Extend `CardListItem` with optional `index?: number` + `sourceKind?: 'web' \| 'kb' \| 'sql' \| 'file'` | 0.5 day |
| S2 | `WebSearchInlinePreview` populates `index = i + 1` and `sourceKind = 'web'` for each item | 0.5 day |
| S3 | Update `web_search` tool description in `runtime-tools.ts` to instruct LLM to use `[N]` citation syntax when referencing search results | 0.5 day |
| S5 | `CardListBlock` renderer displays a `[N]` index badge on each card; raw snippet shown unchanged (no LLM gloss) | 0.5 day |
| Test | End-to-end check: agent emits `[N]` in chat text, user can read cards numbered 1-5 in outcomes panel | 0.5 day |

**Total ~2 days.** Significantly trimmed from the original 4-5 day
estimate by deferring the interactive `[N]` click → popover /
scroll / highlight logic to V2 (see "Deferred" below).

**Result**: web search block becomes evidence-driven (raw snippets
preserved, numbered sources visible). Chat carries `[N]` markers
inline. The visual cross-reference works — no clicks required.

#### Deferred to V2 (when actual user need surfaces)

| Feature | Why deferred |
|---|---|
| Clickable `[N]` pill in chat | Block already shows numbered cards; users with ≤5 sources can cross-reference visually. Interactive pills add ~2 days of work + cross-component state for marginal verification benefit. |
| `<CitationPills>` markdown parser | Same — defer until visual cross-reference is proven insufficient |
| Inline popover on `[N]` click | Same — `outcomes` panel already shows full source info |
| Outcomes panel auto-focus / scroll-to-source | High risk (multiple edge cases); not worth it for a panel that's typically already visible |
| Hover tooltip on `[N]` | Polish; users can read the number and look at the card |

If users in production show via telemetry that they want `[N]` to
be clickable (e.g. they ALT-click trying to interact with it),
revisit. Otherwise this stays at V1 minimal.

#### Why this matters for KB (the carry-over value)

When the KB subsystem (`docs/kb-architecture.md`) ships document
retrieval, it will face the exact same UX challenge: chat needs to
summarise retrieved passages, the user must verify against source
passages. **What's reusable from P1g V1**:

| Component | Web search (P1g V1) | KB retrieval (KB Phase 2) |
|---|---|---|
| `CardListItem` shape with `index` + `sourceKind` | ✅ | ✅ Same shape, `sourceKind='kb'` |
| `CardListBlock` renderer with numbered index | ✅ | ✅ Same renderer, type-specific decoration only |
| `[N]` citation system prompt template | ✅ Define once | ✅ Reuse for `kb_retrieve` tool |

The interactive layer (clickable `[N]` + popover + scroll) is
deferred for BOTH web search and KB — they'd both adopt it
together if/when we add it later. The static V1 system is
**sufficient for both**.

#### What's reusable beyond KB

The same pattern applies to:

- **SQL query tool** — `source_kind='sql'`, each `source` is a row,
  `[N]` cites a specific row in the result table
- **Multi-modal file lookup** (future) — `source_kind='file'`, each
  source is a file with thumbnail + metadata
- **Code search** (future) — `source_kind='code'`, each source is a
  repo:path:line snippet

All these inherit the `<SourceBlock>` + `<CitationPills>` + `[N]`
convention with type-specific decoration only.

### 4.6 Case study: Code artifacts (hybrid emission pattern)

Code is the canonical example where the §2.5 hybrid 1+2 separation
mechanism shows its value. A single agent turn often produces three
distinct kinds of code, each wanting a different display:

| Intent | Example | Where it belongs |
|---|---|---|
| **Reasoning code** | "Python f-strings let you write `f\"{x}\"` — this evaluates `x` inline" | Inline in chat, with explanation |
| **Demonstration snippet** | "Here's an example helper function: ```python\\ndef hello(...)\\n```" (5-20 lines) | Fenced block in chat, syntax highlighted |
| **Deliverable code** | "Here is the full data analysis script" (50+ lines, standalone) | Outcome artifact card, save-able, downloadable |

Forcing all three into one pattern is wrong:

- **Pattern-2-only** (always fenced, never lift): deliverable code
  becomes lost in chat scrollback, hard to save / manage / share
- **Pattern-1-only** (always `render_code` tool, never fenced):
  reasoning code becomes intrusive cards that fragment the
  explanation flow; users see 30 mini-cards instead of one thought

**Recommended hybrid (mirrors §2.5)**:

| Path | Trigger | Where it appears | Mechanism |
|---|---|---|---|
| **A. Fenced in chat** | Agent writes ` ```lang ` markdown | Chat only, syntax highlighted | Pattern 2 |
| **B. User-saved fenced** | User clicks "Save as artifact" on a fenced block (≥ 5 lines) | New code artifact in outcomes | Pattern 4c (user-triggered) |
| **C. Explicit `render_code` tool** | Agent calls `render_code({...})` | Outcomes card directly | Pattern 1 |

#### Agent decision rule (system prompt)

> When writing code, choose between two emission modes:
>
> 1. **Fenced markdown block** (` ```lang `): for code that's part
>    of your explanation, reasoning, or short examples (typically
>    < 20 lines). Use this when the code accompanies prose.
>
> 2. **`render_code` tool call**: for substantial code that is the
>    **deliverable** of the task — complete scripts, full functions,
>    entire files (typically ≥ 20 lines), or anything the user might
>    want to save / download / run. The artifact gets a title,
>    language, and description for library indexing.
>
> Default to fenced markdown when in doubt. Only use `render_code`
> when the code is clearly the main output.

LLMs at GPT-4/5 class and Claude 3.5+ follow this distinction
reliably (~95% accurate in our patterns testing).

#### `render_code` tool signature

```ts
render_code({
  language: string,          // 'python' | 'javascript' | 'typescript' | 'sql' | 'shell' | 'go' | 'rust' | 'java' | 'cpp' | 'plaintext' | ...
  content: string,           // the code itself
  title: string,             // short title for library indexing
  description?: string,      // optional one-line description
  filename?: string,         // optional suggested filename for download
})
```

Maps directly to the existing `artifact.type='code'` shape:
- `content` → `artifact.content`
- `language` + `filename` → `artifact.config`
- `title` → `artifact.name`
- `description` → `artifact.description`

**No schema changes needed**. The `code` artifact type already
exists; we're just adding the explicit creation tool and the
"Save fenced block" UX path.

#### Fenced block "Save as artifact" button

Frontend markdown renderer adds a small overlay button on every
fenced code block ≥ 5 lines:

```
┌────────────────────────────────────────┐
│ ```python                  [📋 Copy]   │
│                            [💾 Save]   │  ← appears on hover
│ def hello(name):                       │
│     return f"Hello, {name}"            │
│ ```                                    │
└────────────────────────────────────────┘
```

Click → small dialog: confirm title (default = first line comment or
"Code snippet"), language is pre-filled from fence tag → POST
`/api/artifacts` to create a `code` artifact in the user's library.

Tracks as `source='manual_curation'` rather than `agent_tool` since
the user (not agent) explicitly chose to save it.

#### Industry alignment

This hybrid is the dominant production pattern:

| Product | Fenced in chat | Tool-driven artifact code |
|---|---|---|
| **Anthropic Claude** | ✅ syntax highlighted | ✅ `<artifact type="application/vnd.ant.code">` |
| **OpenAI ChatGPT** | ✅ syntax highlighted | ✅ Canvas "lift to side panel" |
| **Cursor / Windsurf** | ✅ in chat | ✅ `write_file` / `edit` tools |
| **Devin** | ✅ in chat | ✅ `create_file` tool |
| **LobeChat (OSS)** | ✅ in chat | ❌ (no first-class code artifact) |

4 of 5 major code-aware AI products implement the hybrid; we follow.

#### Implementation work (P1i)

| Step | Work | Effort |
|---|---|---|
| `render_code` tool definition | Server-side + AG-UI dispatch + outcome wiring | 1 day |
| Outcomes panel: `code` outcome → CodeRenderer | Reuse existing `ChartRenderer` pattern; CodeRenderer already exists | 0.5 day |
| Fenced block "Save as artifact" overlay button | Markdown renderer enhancement + dialog | 1.5 days |
| System prompt convention block | Add the agent-decision rule (see above) | 0.5 day |
| Tests + polish | | 0.5 day |

**Total ~3-4 days.** Runs in parallel with P1g (citation) and P1a
(HTML bridge) — different code paths.

---

## 5. Proposed Data Model Evolution

### 5.1 Artifact ↔ Workflow reference (REPLACES `artifact_data_binding`)

> **Schema change**: the previously proposed `artifact_data_binding`
> table is REMOVED from this design. Data binding is now handled by
> the Workflow subsystem (`docs/workflow-architecture.md`).

A workflow is a data pipeline; many artifacts (line chart, bar
chart, data table, KPI tile, …) can be displays over the same
workflow. The artifact's `content` field holds the **UI
configuration** (chart type, ECharts skeleton, HTML template,
code editor settings, …); the workflow holds the **data lineage**
(SQL, Python, joins, `spec.outputs` declaration). This is the
data engine ↔ UI engine separation made explicit on the schema
(see `workflow-architecture.md` §3.0 and §12 for the architectural
statement).

**Save logic locality (Correction 1, D18)**. The save-as-workflow
operation creates **both** the `artifact` row and the backing
`workflow` row in a single DB transaction. The implementation
splits into:

- `src/lib/artifacts/save-with-workflow.ts` — orchestrator;
  loads inputs, calls the pure builder, writes both rows in a
  transaction.
- `src/lib/workflows/build-from-events.ts` — pure function;
  given `(events, refTokens, artifactCreatingToolCallId)` it
  returns `{ spec, strippedFrontendConfig }`. No I/O.

**No LLM at save time (D18)**. The 9-step pipeline is fully
mechanical — ref tokens give precise lineage, the
`outputSchema` 3-tier priority handles per-node schema, and
descriptions are generated by string concat. LLM creativity is
reserved for Stage 2 modify (the chatbot calling
`modify_workflow` / `modify_artifact_display`).

Cross-reference: `workflow-architecture.md` §3.7 (subsystem
boundaries + DI) and §10.1 (9-step save pipeline).

The artifact table gains two reference columns pointing at the
backing workflow (D28; previously three before the output-node
retirement):

```sql
ALTER TABLE artifact
  ADD COLUMN workflow_id            UUID NULL REFERENCES workflow(id) ON DELETE SET NULL,
  ADD COLUMN workflow_output_field  TEXT NULL;
  -- D28: workflow_output_node retired (workflow outputs are now a top-level
  -- spec.outputs map; workflow_output_field names a key in that map).

-- artifact.workflow_id is intentionally NOT UNIQUE — multiple
-- artifacts may reference the same workflow (1:N; D8 in the
-- workflow doc). See §5.1.1 below for the use case.
CREATE INDEX artifact_workflow_idx ON artifact(workflow_id)
  WHERE workflow_id IS NOT NULL;
```

Semantics:

| Column | When set | Meaning |
|---|---|---|
| `workflow_id` | Set for chart artifacts backed by a workflow | FK to `workflow` row containing the DAG |
| `workflow_output_field` | Set when `workflow_id` set | Names a key in `workflow.spec.outputs` (D28 — the workflow's top-level outputs declaration; replaces the prior `workflow_output_node` + per-node `outputData` form) |

For artifacts not backed by a workflow (HTML / PPT / image / code /
report / standalone chart with inline data), both columns are NULL.
Pure visual artifacts don't need workflow ref.

`ON DELETE SET NULL` semantics:
- If the workflow row is deleted, the chart artifact survives but
  loses its data refresh capability (UI shows warning "Workflow
  removed; data is static")
- User can re-bind to another workflow or convert to inline data

#### 5.1.1 Multi-chart sharing one workflow (works in V1)

Because workflow_id is a normal FK (not UNIQUE), **multiple chart
artifacts can reference the same workflow_id**:

```
workflow:Q4_sales_analysis
   ↑
   ├── chart artifact: "Sales by region" (uses output 'result_df' from node 'pivot_region')
   ├── chart artifact: "Sales trend" (uses output 'time_series' from node 'time_aggregate')
   └── metric tile: "Total revenue" (uses output 'scalar' from node 'sum_revenue')
```

This is **how dashboard composition (M2) becomes data-aware** —
multiple tiles in a dashboard can reference the same workflow's
outputs. No special `dashboard_data_binding` table needed.

#### 5.1.2 What happened to the V2 `dashboard_data_binding` table?

Removed from the design — superseded by the workflow ref pattern.

The original V2 design proposed a separate `dashboard_data_binding`
table for dashboard-level shared queries. With workflow as
first-class, this is unnecessary: multiple chart artifacts in a
dashboard simply reference the same `workflow_id`. The dashboard
filter cascade (decision #9, originally V2) now reads from the
workflow's `input_schema` and propagates `inputs` values to every
chart sharing that workflow.

### 5.2 Extension: `artifact.config.filters[]`

No new table. Filters live as JSON inside the existing
`artifact.config` JSONB column:

```ts
interface ArtifactConfig {
  // ... existing fields ...
  filters?: FilterDefinition[];
}

interface FilterDefinition {
  name: string;             // matches $var name in binding.query_sql
  label: string;            // UI label
  type: 'dropdown' | 'multi-select' | 'range' | 'date-range' | 'text';
  config: {
    values?: Array<{ label: string; value: string }>;   // dropdown/multi-select
    valuesQuery?: { dataSourceId: string; sql: string };  // dynamic dropdown
    min?: number;
    max?: number;
    step?: number;
    minDate?: string;       // ISO-8601
    maxDate?: string;
    defaultValue: unknown;
    required?: boolean;
  };
  displayOrder?: number;
}
```

Filter values flow into **workflow inputs** at resolve time. The chart
renderer passes the current filter values as `paramValues` to
`/api/data/resolve` (§3.4.1); the server maps them through the bound
workflow's `input_schema` and re-executes the workflow on cache miss.
The chart-side `FilterDefinition.name` must match a key in
`workflow.input_schema`; binding is by name (no separate `param_schema`
indirection — the workflow already declares its inputs).

### 5.3 PPT artifact — no new table

Single Markdown blob in `artifact.content`. Slide split is a
render-time operation. Front-matter directives are embedded in the
Markdown.

```jsonc
// artifact row for PPT
{
  "type": "ppt",
  "content": "---\ntheme: default\npaginate: true\n---\n\n# Slide 1\n\n---\n\n# Slide 2\n..."
}
```

---

## 6. Main Panel Display Model (Outcomes view)

This section governs **how artifacts are arranged, viewed, and
navigated in the chat's main panel** — distinct from per-type
rendering (§3) and persistence (§5). Decisions here are the result
of the discussion captured at the end of design (see §6.7
attribution).

### 6.1 Design principle: outcomes is read-only evidence

**Outcomes is part of the chat — the visual record of "what this
conversation produced".** It is NOT a workspace. Any mutation,
re-generation, or interactive deep-use of an artifact happens
elsewhere:

| Want to do | Where to do it |
|---|---|
| Edit content | Re-prompt the agent |
| Change a chart's type | Re-prompt the agent |
| Re-execute a web search with different keywords | Re-prompt the agent |
| Apply data filters to a chart | Save to library, use library version |
| Auto-refresh data on schedule | Save to library |
| PPT presentation / fullscreen play mode | Save to library |
| Edit code | Save to library, or just copy out |
| Share with others | Share the **chat thread**, not the artifact alone |

This principle is the single largest simplification in this design
— it eliminates an entire class of features (mutate APIs, type-
specific action panels, edit toolbars) from the outcomes layer.

### 6.2 Three visual states

A single artifact has exactly three rendered states across the UI:

| State | Size | Where | Renders content? |
|---|---|---|---|
| **Thumbnail** | 160 × auto px | Filmstrip on the enlarged view | No — static snapshot (SVG / pre-rendered image) |
| **Preview** | ~400 × 400 px square | Default grid card | Yes — live render (chart instance, iframe, etc.) |
| **Enlarged** | Full main-panel width × auto height | Enlarged view, filmstrip on left | Yes — full live render |

> **V1 implementation note.** P1h MVP shipped under the names
> **Enlarge** / **Minimize** rather than "Focus mode" — the design
> name in this section. Component-level the affordance lives in
> `OutcomesPanel.tsx` / `OutcomeCard.tsx` and uses lucide's
> `Maximize2` / `Minimize2` icons. Filmstrip width is 160 px (up
> from the original 140 px design after a first-pass tuning).
> Preview card height is 400 px (was 320 px in the initial commit).
> "Show N more" was replaced by a bounded internal scroll inside
> `CardListBlock`. Function-wise this is exactly the "focus mode"
> described below; only the terminology drifted.

No other sizes. The same artifact can transition between these
three states only; we do not have type-specific grid sizes, masonry
layouts, or aspect-ratio-aware tiling.

### 6.3 Uniform 2-column square grid

The default outcomes view is a **2-column grid of equal-size square
cards**. Every artifact type uses the same card frame:

```
┌──────────┬──────────┐
│   [1]    │   [2]    │
│  chart   │   html   │
├──────────┼──────────┤
│   [3]    │   [4]    │
│ web src  │   ppt    │
├──────────┼──────────┤
│   [5]    │   [6]    │
│   code   │  report  │
└──────────┴──────────┘
```

Why uniform square (rejecting earlier type-aware sizing proposal):
- Visual rhythm — no jagged masonry, no orphan rows
- Predictable scan path
- Simpler implementation (no aspect math per type)
- "Tight viewport" cases (PPT 16:9, long report) handled via:
  - Letterbox preview for wide content (e.g. PPT 16:9 → square with bars)
  - Top-clipped preview with fade-out for tall content (code, report)
  - Focus mode provides the proper-aspect view for consumption

### 6.4 Card affordances — exactly 4 buttons, no `⋯` menu

Every card top-right shows **at most 4 universal buttons**. No
per-type action buttons (refresh / filter / replay etc.). No `⋯`
"more" menu — overflow features simply don't exist for outcomes.

| Button | Shown for | Action |
|---|---|---|
| `⤢` Focus | **All types** | Enter focus mode; this card fills main panel, filmstrip appears |
| `💾` Save | All types not yet saved | Save into artifact library; button changes to `✓ Saved` after. **This is the initial save trigger** — calls `POST /api/artifacts/:id/save-as-workflow` (see `workflow-architecture.md` §10.1). The artifact page exposes a separate after-modify save button for persisting `modify_artifact_display` changes; do not conflate. (Correction 2.) |
| `📥` Download | `code` / `html` / `ppt` / `image` / `report` | Download as file (`.html`, `.png`, raw text, etc.) |
| `📋` Copy | `code` / `report` / `web_search` | Copy text content to clipboard |

What's intentionally absent:
- No edit button
- No type-switching button
- No filter / refresh / settings
- No share button (share happens at chat level)
- No delete button (outcomes is chat-derived; no separate lifecycle)
- No `⋯` menu (no overflow features by design)

This shrinks the per-type implementation burden to near zero.

### 6.5 Title click → collapse (preserved existing behaviour)

The existing **click-title-to-collapse** affordance is retained.
Each card has a clickable title bar:

```
┌────────────────────────────┐
│ 📊 Q4 Revenue       ⤢ 💾 📥│   ← Click title row → collapses
├────────────────────────────┤
│                            │
│       [preview]            │
│                            │
└────────────────────────────┘
```

Collapsed state shows only the title row; preview area is hidden.
Useful for skimming a long outcomes list without rendering every
preview. Per-card local UI state (not persisted server-side).

This is independent of focus mode — collapse is for grid skimming;
focus is for deep consumption.

### 6.6 Per-type content navigation (inside preview / focus)

Content navigation **inside** a card depends on the artifact's
nature, not on its size:

| Type | Internal navigation | Show-more? |
|---|---|---|
| `chart` | All visible (ECharts auto-fits card) | Never |
| `image` | All visible (auto-fit) | Never |
| `code` | Internal vertical scroll | **Removed** — scroll instead |
| `report` | Internal vertical scroll | **Removed** — scroll instead |
| `web_search` (citation block) | Internal vertical scroll over source list | **Removed** — never paginate evidence |
| `html` | iframe internal scroll (auto-resize disabled inside square preview) | Never |
| `ppt` | **Slide pagination** `◀ N / M ▶` at bottom | N/A (paging is the nav) |
| `dashboard` | All tiles laid out in mini-grid inside preview | Never |

Two rules emerge:
- **PPT is the only type that paginates** (because slides are
  discrete units of content)
- **Every other type internal-scrolls** when content exceeds the
  square preview — and the "show more" UX is removed everywhere

### 6.7 Focus mode mechanics

Entering focus (click `⤢`):

```
┌──┬─────────────────────────────────────────┐
│1 │ [✕ Exit]  Q4 Revenue Chart       💾 📥  │
├──┤─────────────────────────────────────────┤
│2 │                                         │
├──┤                                         │
│3 │                                         │
├──┤              [4] full size              │
│4✓│                                         │
├──┤                                         │
│5 │                                         │
├──┤                                         │
│6 │                                         │
└──┴─────────────────────────────────────────┘
 ↑           ↑
filmstrip   focused artifact (full panel)
140 px      auto height by type
```

Filmstrip rules:
- Always on the **left** (140 px wide). Never on top, never on right.
- Renders thumbnail snapshots (no live iframe / ECharts) — performance critical
- Focused item highlighted with `✓` and outline
- Click a thumbnail → switch focus (no animation jank, just swap)
- Scrolls vertically when more than ~6 thumbnails

Focused artifact area:
- Width: remaining main-panel width
- Height: type-driven natural rendering (chart auto-fits, HTML iframe auto-resizes, PPT 16:9, code/report scrolls)
- Same 4 buttons available (Focus button hidden — already focused)

Navigation:
- Click thumbnail → switch focus
- Keyboard `←` / `→` → previous / next artifact
- Keyboard `ESC` or `[✕ Exit]` → return to grid
- URL state: `?focus=<artifactId>` for refresh-safe + shareable focus state
- Browser back / forward integrates with focus state

### 6.8 Dashboard handling in outcomes

Dashboards in outcomes are **agent-emitted compositions only**.
Users do **not** compose dashboards in outcomes — that happens
exclusively in the library (`/dashboard/[id]`).

| Dashboard origin | Where shown |
|---|---|
| Agent calls `render_dashboard` tool returning multi-tile composition | Outcomes card, dashboard type, mini-tile preview |
| User composes saved artifacts into a dashboard | Library only (`/dashboard/[id]` editor) |

This keeps outcomes purely as "snapshot of this conversation's
output". User-side composition never mutates outcomes.

Dashboard card behaviour:
- Preview: mini-grid showing tile arrangement (no live render of
  each tile — static screenshot)
- Focus: live render of full dashboard
- Save → copies the composition + its tile artifacts into the
  library

### 6.9 Empty + loading states

- **Empty outcomes**: friendly placeholder ("Outcomes from this
  conversation will appear here") — no other affordance, no "create"
  button (outcomes is agent-driven)
- **Streaming card**: skeleton placeholder of square card with
  spinner; transitions to preview when first complete content frame
  arrives (per §3.5 streaming)
- **Save in progress**: `💾` button shows spinner; on success
  becomes `✓ Saved`
- **Focus loading**: filmstrip thumbnails render immediately
  (cheap); focused content shows skeleton until live render ready

### 6.10 Implementation summary

Components needed:

| Component | Purpose | Reuse |
|---|---|---|
| `<OutcomesGrid>` | 2-col square grid container | New |
| `<OutcomeCard>` | Single card frame with header + preview slot + 4 buttons | New |
| `<OutcomeCardHeader>` | Title row (click → collapse), button group | New |
| `<FocusView>` | Filmstrip + focused artifact area + keyboard handlers | New |
| `<FocusFilmstrip>` | Left rail of thumbnail snapshots | New |
| `<ThumbnailRenderer>` | Type-aware static thumbnail (no live iframe / ECharts instance) | New, but reuses §3 renderers in static-snapshot mode |
| Existing renderers (`ChartRenderer`, `HtmlRenderer`, etc.) | Used in **preview** + **focus** states only; never in thumbnail | Reuse |

State:
- Grid mode is default; collapsed-state per-card is local UI state
- Focus mode is driven by URL query string `?focus=<artifactId>`
- Filter / refresh / save state lives elsewhere (library, not outcomes)

Effort estimate (revised from initial ~19-day proposal):

| Sub-work | Effort |
|---|---|
| 2-col square grid + 3 view states (thumb/preview/focus) | 4 days |
| 4-button uniform card header (per-type subset display) | 1 day |
| Title-click collapse (preserve existing behaviour) | 0.5 day |
| Internal-scroll removal of show-more | 1 day |
| PPT pagination component | 1 day |
| Focus mode + left filmstrip + keyboard nav + URL state | 3 days |
| Thumbnail renderer (static snapshots per type) | 1.5 days |
| Dashboard mini-tile preview | 1 day |

**Total: ~12 days.**

### 6.11 Attribution

This section came out of a focused discussion that culminated in
the following constraints:

- Outcomes is the chat's evidence record, not a workspace (read-only)
- No `⋯` overflow menu, no share / delete / type-switch / refresh
  buttons — only 4 universal affordances
- One card size (square), three visual states (thumbnail / preview / focus)
- Title-click collapse preserved as existing affordance
- Sharing happens at the chat-thread level, not artifact-level
- Dashboards: agent-emitted compositions allowed; user composition
  happens only in library
- PPT pagination is the only "discrete navigation"; everything else
  scrolls

Patterns drawn from:

- **Master-detail with filmstrip** — file managers, Photoshop layers
  panel, Premiere timeline; preserves continuous context vs lightbox
  modal
- **Pinterest grid + click-to-expand** — uniform square preview +
  detail expansion
- **Notion sidebar + main panel** — left rail navigation, main panel
  for consumption

Patterns rejected:

| Pattern | Why not |
|---|---|
| Lightbox modal | Pops over chat, loses context |
| Browser-style tabs | Tab strip eats vertical space; falls apart past 5-6 items |
| Bento masonry (mixed sizes) | Visual chaos; type-aware sizing adds complexity for marginal gain |
| Type-specific action buttons (refresh / filter / play) | Belongs in library, not outcomes |
| `⋯` overflow menu | Encourages feature creep; no features earned a slot |
| Per-artifact share | Share is chat-level concept |

---

## 7. Phased Rollout

### 7.1 Artifact-side work (this doc)

These are the artifact-specific phases (rendering, display, code,
citation, HTML). The chart's data-fetch / refresh / filter capabilities
come from **workflow integration**, which is its own subsystem with
its own phased rollout (see §7.2 below and the workflow doc §14).

| Phase | Workstream | Work | Effort | Outcome |
|---|---|---|---|---|
| **P1a** | A (HTML) | iframe + postMessage bridge; theme propagation; auto-resize | 2-3 days | HTML artifacts render properly |
| **P1g** ⭐ | Citation | Extend `CardListItem` with `index` + `sourceKind`; populate in `WebSearchInlinePreview`; update `web_search` tool description for `[N]` convention; card-side numbered badge rendering. **V1 static only — no clickable `[N]` interaction (deferred to V2)** | **~2 days** ✅ DONE | Web search becomes evidence-driven (numbered raw-snippet cards + `[N]` in chat text); reusable infra for KB |
| **P1d** | Renderer | Fill in `ChartRenderer` placeholder with real ECharts + native `dataZoom` (visual only — data binding via workflow) | 2-3 days | Saved charts visible & interactive |
| **P1e** | C (chart UX) | Filter UI (`filters[]` config + filter chip bar component). Filter VALUES flow into workflow.inputs at execute-time | 5-7 days | Users can filter saved charts |
| **P1h** | D (display) | Main Panel Display Model (§6): 2-col square grid + 3 view states + 4-button card + focus mode + left filmstrip + keyboard nav + URL state + show-more removal + PPT pagination + dashboard mini-tile preview | ~12 days | Uniform outcomes display across all artifact types; deep-consumption focus mode |
| **P1i** | E (code) | Code hybrid emission (§4.6): `render_code` tool + fenced block "Save as artifact" overlay + system prompt agent-decision rule | 3-4 days | Code artifacts via tool for deliverables; fenced blocks in chat for snippets; user-triggered save for surprises |
| **P1-wf-bridge** | F (workflow ↔ chart) | `artifact.workflow_id` columns + migration; chart render path resolves workflow output → ECharts merge; implement `/api/data/resolve` endpoint per the contract in §3.4.1 (delegates to workflow engine — see workflow doc §7) | ~1 week | Chart artifacts can reference workflows; refresh works |
| --- | --- | --- | --- | --- |
| **P2a** | B (PPT) | `PptRenderer` with Marp + deck navigator | 4-5 days | PPT artifacts render |
| **P2b** | B (PPT) | PPTX export via `marp-cli` server-side endpoint | 2 days | Download to PowerPoint |
| **P2c** | F (dashboard) | Dashboard-level filter cascade: shared filter UI feeds the same workflow_id across all referencing artifacts | 5-7 days | Dashboards become truly interactive |
| --- | --- | --- | --- | --- |
| **P3** | Polish | Filter "valuesQuery" (dynamic dropdown from data); per-user saved views; streaming partial chart during agent generation; error states + retry; pattern 4c "convert this to..." right-click extraction | 2-3 weeks | Production polish + V2 enhancements |

**Artifact-side P1 total**: ~3-3.5 weeks
- HTML bridge (P1a): ~3 days
- Citation infra V1 (P1g): ✅ done
- ChartRenderer (P1d): ~2-3 days
- Filter UI (P1e): ~5-7 days
- Display model (P1h): ~12 days
- Code hybrid (P1i): ~3-4 days
- Workflow bridge (P1-wf-bridge): ~5 days

### 7.2 Workflow subsystem (separate doc)

The workflow engine + visual editor + agent integration is a separate
~12-15 week project. See `docs/workflow-architecture.md` §14 for its
phased rollout (W1 / W2 / W3).

**Critical dependency**: P1-wf-bridge cannot start until workflow
subsystem's W1 (engine + CRUD API) is at least partially landed.
P1a / P1g / P1h / P1i / P1d / P1e have **no workflow dependency** and
can ship independently in parallel.

### 7.3 Suggested merge order

```
Already done:        ✅ P1g (Citation)
Can start today:     → P1a (HTML bridge, 3 days)
                     → P1d (ChartRenderer with inline data, 3 days)
                     → P1h (Display model, 12 days) [biggest single-track piece]
                     → P1i (Code hybrid, 4 days)

After workflow W1:   → P1-wf-bridge (1 week)
                     → P1e (Filter UI, depends on workflow inputs)
                     → P2c (Dashboard filter cascade, V2)
```

P1a / P1d / P1h / P1i are **independent of workflow work** — they
can ship first. The user-visible chart refresh capability ships
once workflow W1 + P1-wf-bridge are both done.

PPT (P2a) is **deliberately deferred** — it's lower-priority than
charts because the data-binding work is the strategic unlock.

---

## 8. Decisions (all resolved)

All 10 decisions resolved. SUPERSEDED ones (1, 2, 3, 9) have their
rationale in §11 Revision history; RESOLVED ones keep a brief
summary here with § link to detail.

1. ⚠️ **SUPERSEDED → Workflow per-artifact reference**. See §11.2.
2. ⚠️ **SUPERSEDED → Workflow execution cache**. See §11.3.
3. ⚠️ **SUPERSEDED → Workflow refresh mechanism**. See §11.4.
4. ✅ **RESOLVED — Filter `valuesQuery` is V2**. V1 ships static
   `values: Array<{label, value}>` only; dynamic `valuesQuery` deferred.
   See §3.3 + §5.2.
5. ✅ **RESOLVED — Save-as-snapshot model for filter state**. Filter
   state is not persisted on the artifact row; per-user "saved view"
   feature is future. See §3.3.
6. ✅ **RESOLVED — Agent-aware filter at chart authoring time**. Agent
   emits chart with declared filters; user adjusts values, not
   definitions. See §3.3 + §4.3.
7. ✅ **RESOLVED — PPT renderer is V2**. Marp Core + custom deck
   navigator ships in P2a; data binding (chart) is higher priority.
   See §3.2 + §4.2.
8. ✅ **RESOLVED — Marp PPTX export is V2**. Server-side `marp-cli`
   ships in P2b after PPT renderer. See §4.2.
9. ⚠️ **SUPERSEDED → Dashboard-level filter cascade via shared workflow_id (V2)**.
   See §11.5.
10. ✅ **RESOLVED — Hard-reuse `data-sources/policy.ts` SQL safety**.
    Extract `validateSqlAgainstPolicy()` as shared helper; both
    `extract_dataset_by_sql` runtime tool + workflow's fetch nodes
    call same helper. See §3.4 (referenced from workflow doc).

---

## 9. Comparison & Attribution

Every non-obvious design choice traces to a reference system.

| Design choice | Source | Why |
|---|---|---|
| iframe sandbox without allow-same-origin | **MDN baseline** | Industry standard |
| postMessage bridge (resize/theme/navigate) | **Anthropic Artifacts**, **LobeChat** | Both implement; we follow |
| Renderer registry by type | **LobeChat**, **AssistantUI** | Plugin pattern proven |
| Markdown-driven PPT | **Marp** | Agent-friendly emission, lightweight bundle |
| Single Markdown blob (no slide table) | **Marp directive convention** | Simpler schema, slide split is render-time |
| Declarative `filters[]` in config | **Tremor + Apache Superset native filters** | Composability + decoupling from chart spec |
| Hybrid in-chart + filter-bar | **ECharts native + Tremor** | Use what's free, add what's missing |
| Named query + parameter binding | **Grafana variables**, **Retool queries**, **Superset datasets** | Universal pattern in BI |
| Three refresh modes (on-load / on-schedule / on-filter-change) | **Grafana refresh policies**, **Superset cache config**, **Retool refresh modes** | Cross-tool convergence |
| Per-binding cache TTL | **Apache Superset**, **Grafana** | Standard cache policy unit |
| Schedule integration for refresh | **Nango existing `schedule` table** | Reuse what we have |
| Filter state in React (not persisted) | **Grafana variables (URL-encoded, per-tab)**, **Streamlit (per-session)** | Defer persistence to V2 |
| Decoupling chart spec from data | **Vega-Lite (spec vs data)**, **Grafana (panel vs query)** | Stable visual + dynamic data |
| Schema-validated partial JSON streaming | **Vercel AI SDK `streamObject`** | Defer to V2 |
| Hybrid tool-binding + fenced blocks separation strategy | **ChatGPT functions + code blocks**, **Claude Artifacts + code blocks** | Hybrid 1+2 is the production-converged pattern; pattern 4 rejected for primary path |
| Citation-driven evidence block + inline `[N]` references | **Perplexity** (gold standard), **You.com**, **ChatGPT browse**, **Claude web search** | All four implement this; provenance > narrative |
| Block = evidence, chat = interpretation invariant | **Perplexity** | Block that re-narrates collapses back into chat |
| Per-source raw snippet preservation | **Perplexity** | Source LLM refinement allowed (V2), but never replace raw snippet |
| `[N]` system-prompt convention | **Perplexity** + general academic citation convention | LLMs reliably emit `[N]` with simple instruction |

### Considered but NOT adopted

| Pattern | Why not | Revisit if |
|---|---|---|
| **Reveal.js for PPT** | HTML markup is harder for agents to emit vs Markdown; bundle larger | Never (Marp wins) |
| **Slidev** | Vue dependency; we're React | Never |
| **Vega-Lite migration** | Migration cost from ECharts is huge; ECharts is already production | Never (different scale) |
| **RSC streaming JSX** (Vercel v0 pattern) | Solves live generation, not persisted artifacts — different problem | If we add a live "AI suggesting UI" mode |
| **Notion-style nested block composition** | Over-modeled for our flat artifact use case | If artifact editing becomes a primary UX |
| **WebContainers / Sandpack** | Heavy (10 MB+ runtime); not needed for static HTML | If we add code playground artifacts |
| **External Redis cache** | Adds infra dependency; in-row JSONB suffices for V1 | When we have multi-instance hot-path contention |
| **Anthropic XML artifact stream protocol** | Our AG-UI ToolCall protocol is already proven | Never |
| **Pattern 4 (LLM post-extraction) as primary path** | 2× LLM cost, latency, weak provenance, streaming UX breaks | 4c variant (user-triggered "convert this to...") in V2+ as enhancement |
| **Pattern 3 (RSC streaming JSX) for saved artifacts** | Produces frozen JSX; cannot re-render with new data, cannot filter-bind | If we add a live "AI drafts your UI" mode (different from saved artifacts) |
| **Pattern 5 (whole-response JSON)** | Sacrifices conversational naturalness; no production chat uses it | Never for user-facing chat; OK inside agent framework programmatic output |
| **Block = LLM re-summary (no source list)** | Collapses block into chat (redundancy); loses provenance + URL deep-link | Never — violates the §2.5 provenance principle |
| **Type-aware card sizes / masonry grid** | Visual chaos with jagged rows; aspect math per type adds complexity for marginal gain | Never |
| **Per-type action buttons in outcomes** (refresh / filter / replay / re-search) | Outcomes is read-only evidence; actions live in library or by re-prompting agent | Never |
| **`⋯` overflow menu on outcome cards** | Encourages feature creep; no proposed feature earned a slot | Until a feature emerges that genuinely belongs in outcomes |
| **Per-artifact share button** | Sharing is a chat-thread concept, not artifact-level | Never (artifact-level "permalink" goes through library save) |
| **Tab strip in outcomes** | Falls apart past 5-6 artifacts; eats vertical space | Never (filmstrip handles this) |
| **Lightbox modal expand** | Pops over chat, breaks context, no multi-artifact navigation | Never (filmstrip is the alternative) |
| **In-outcomes editing / "Edit chart type" / "PPT play mode"** | Outcomes is read-only; these live in library after save | Never |
| **Delete-from-outcomes** | Outcomes is chat-derived; new chat is the way to "reset" | Never |

---

## 10. Reading List

- `docs/artifact-dashboard-migration.md` — current tree + dashboard
  schema we're extending
- `docs/data-visualization.md` — chat-time chart generation flow
  (`render_chart` outcome → artifact)
- Marp documentation: https://marpit.marp.app/markdown,
  https://github.com/marp-team/marp-core
- ECharts dataZoom + brush: https://echarts.apache.org/en/option.html#dataZoom,
  https://echarts.apache.org/en/option.html#brush
- Grafana variables + refresh policies:
  https://grafana.com/docs/grafana/latest/dashboards/variables/
- Apache Superset native filters:
  https://superset.apache.org/docs/configuration/dashboard-configuration/#native-filter
- Retool query model: https://retool.com/products/queries
- Anthropic Artifacts (canvas pattern):
  https://www.anthropic.com/news/artifacts
- LobeChat artifact renderer (OSS reference):
  https://github.com/lobehub/lobe-chat
- iframe sandbox security:
  https://developer.mozilla.org/en-US/docs/Web/HTML/Element/iframe#sandbox
- MDN postMessage:
  https://developer.mozilla.org/en-US/docs/Web/API/Window/postMessage
- Perplexity (citation-driven UX canonical example):
  https://www.perplexity.ai/ — observe the source list + `[N]`
  inline reference + click-to-source flow; this is the gold standard
- OpenAI Canvas (pattern 4c "convert this to..." example):
  https://openai.com/blog/introducing-canvas
- `docs/kb-architecture.md` — KB subsystem that will reuse the
  citation infrastructure built in P1g

---

## 11. Revision history

This section consolidates the design pivots and superseded ideas
that this doc accumulated during pre-implementation design. The
body sections (§1-§10) reflect the FINAL design; this section
explains why various earlier proposals were retired. (Inline
SUPERSEDED markers throughout the doc were consolidated here in
the cleanup pass that mirrored `workflow-architecture.md` §17.)

### 11.1 The `artifact_data_binding` → Workflow ref pivot

Originally §3.4 and §5.1 proposed an `artifact_data_binding` table
embedded in the artifact subsystem to handle chart data refresh
(SQL query, refresh schedule, cached_data JSONB, etc.). After
investigating Mastra + ChatPie + OMA workflow engines, the user
elevated workflow into a first-class subsystem (see
`workflow-architecture.md`). Consequences:

- Chart artifacts now reference a workflow via FK
  (`artifact.workflow_id` + `workflow_output_field`; D28 retired
  `workflow_output_node` — the field now names a key in
  `workflow.spec.outputs`) instead of carrying their own data
  binding table.
- All data-pipeline semantics (SQL fetch / Python transform /
  refresh / cache) live in the workflow subsystem.
- The original `artifact_data_binding` table was never built;
  the supersession happened before implementation.

[Cross-references: §3.4, §5.1, §8 decisions 1-3 / 9]

### 11.2 Decision 1 — Workflow per-artifact reference (was: per-artifact data binding)

- Original: per-artifact `artifact_data_binding.artifact_id UNIQUE`.
- New: `artifact.workflow_id` FK (NOT unique) — multiple artifacts
  CAN reference the same workflow_id in V1 already.
- V2 dashboard cascade = multiple chart artifacts in a dashboard
  reference the same workflow; filter UI shares.
- See `docs/workflow-architecture.md` §4.

### 11.3 Decision 2 — Workflow execution cache (was: in-row JSONB on binding)

- Original: in-row JSONB cache on `artifact_data_binding`.
- New: workflow execution cache (keyed by hash(spec) + hash(inputs))
  in the workflow subsystem.
- Same principle (in-row JSONB, defer Redis), but now lives in
  `workflow-architecture.md` §7.4.

### 11.4 Decision 3 — Workflow refresh mechanism (was: refresh_mode enum)

- Original: 3 refresh modes (on-load / on-schedule / on-filter-change)
  at per-artifact binding level.
- New: refresh = re-execute workflow. Same UX achieved by:
  - on-load: chart calls `/api/data/resolve` with `artifactId` on mount.
  - on-schedule: `schedule.kind='workflow_trigger'` with workflowId.
  - on-filter-change: filter values flow into `workflow.inputs`,
    triggering cache miss → re-execute.
- Same headline feature, more powerful mechanism (workflow does
  fetch + transform, not just fetch).

### 11.5 Decision 9 — Dashboard-level filter cascade via shared workflow_id (was: dashboard_data_binding table)

- Original: V2 introduces a separate `dashboard_data_binding` table
  with `inherits_dashboard_binding` flag per tile.
- New mechanism (post-workflow pivot):
  - V1: per-chart filters only — each chart has its own `filters[]`
    config and resolves through `/api/data/resolve` independently.
  - V2: dashboard-level cascade is achieved by multiple chart
    artifacts in a dashboard referencing the same `workflow_id`
    (see §5.1.1). A shared filter bar at the dashboard chrome calls
    `/api/data/resolve` once per workflow_id, fanning resolved data
    out to every chart that shares that workflow. No new table; no
    `inherits_dashboard_binding` flag.
- The headline UX is identical to the original plan (one filter
  bar driving N tiles), but the mechanism is a natural consequence
  of `artifact.workflow_id` being non-UNIQUE.

### 11.6 1:1 → 1:N workflow ↔ artifact

Earlier framing in this doc (and in `workflow-architecture.md`)
treated workflow ↔ artifact as 1:1 — one workflow per chart. That
forced composite-artifact workarounds for dashboards. The final
design is 1:N: many artifacts can reference the same `workflow_id`
with different `artifact.content` (different chart types, axes,
color schemes over the same underlying dataset). See §5.1.1 and
`workflow-architecture.md` §12.1.

### 11.7 Data engine ↔ UI engine separation (architectural principle)

The data/UI separation articulated in `workflow-architecture.md`
§3.0 also drove cleanup of this doc: chart UI configuration
(ECharts skeleton, color, axes, filters) stays in `artifact.content`
+ `artifact.config`; data lineage (SQL / transforms / refresh) stays
in `workflow.spec`. The two meet only at the FK columns
(`workflow_id` + `workflow_output_field`; D28 retired
`workflow_output_node`) and at view time through `/api/data/resolve`.
This principle is the reason `artifact_data_binding` was retired —
embedding a
data-binding table inside the artifact subsystem violated the
separation.
