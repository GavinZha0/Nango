# Data Visualization — Outcomes Panel Design

> Status: **V1 approved for implementation** (Phase 1a — see §6.12)
> Audience: full-stack engineers, architects
> See also: `docs/architecture.md` §5.4, `docs/runner-events.md`,
> `docs/backend-integration.md`, `docs/data-sources.md`

---

## 1. Problem Statement

When chatting with any agent, the AI may produce **artifacts** — images,
charts, code blocks, HTML pages, and other resources that deserve
standalone display. These artifacts should be extracted from the chat
stream and rendered in the **main panel** (center workspace), with the
chat retaining only a lightweight link/button as a reference.

### Requirements

| # | Requirement |
|---|---|
| R1 | Works for **all** agent types: built-in agents AND external backend agents (agno / Mastra / Dify) |
| R2 | **No agent cooperation required** — agents produce content as usual; the infrastructure handles extraction and display |
| R3 | Artifacts are **removed from the chat message** and replaced with a clickable link/button |
| R4 | Artifacts are **displayed in the main panel** via `ArtifactRenderer` |
| R5 | The streaming experience (text appearing token-by-token) is preserved |

### Current State

The project has artifact **scaffolding** in place but the core wiring is
missing:

| Component | Status |
|---|---|
| `ArtifactTable` (DB schema) | Complete — type, content, config, visibility |
| `ArtifactRenderer` component | Renders code/html/image; chart/dashboard are placeholders |
| Zustand `openArtifact()` / `closeArtifact()` | State management ready |
| `WorkspacePage` main panel rendering | Checks `activeArtifact` and renders |
| `useAgentActions()` hook | **Empty no-op** — the missing connection |
| `ArtifactPanel` (left sidebar) | Placeholder for Phase 3 |
| Artifact CRUD API routes | Not yet created |

---

## 2. Approaches Evaluated

### 2.1 `useFrontendTool` — Frontend Tool (originally planned)

Register `open_artifact` / `close_artifact` as CopilotKit frontend
tools. The agent's LLM sees them as callable tools and emits a
`TOOL_CALL` event; the browser handler writes to Zustand, main panel
renders.

```
Agent LLM calls open_artifact
  → AG-UI: TOOL_CALL { name: "open_artifact", args: {...} }
  → Browser useFrontendTool handler
  → workspaceStore.openArtifact(...)
  → Main panel renders ArtifactRenderer
```

**Verdict: Rejected — fails R1 & R2.**

Frontend tools work by injecting tool definitions into the LLM's
available tool list. This only works for **built-in agents** where
CopilotKit Runtime controls the LLM. For external backend agents:

1. The bridge does **not** forward `input.tools` to external platforms.
   Each bridge sends only platform-specific payloads:
   - agno: `FormData { message, stream, session_id }`
   - Mastra: `JSON { messages, memory, runId }`
   - Dify: `JSON { query, response_mode, user }`
2. The external LLM never sees `open_artifact` and will never call it.
3. `ToolCallFilter` in the bridge uses `input.tools` only to **filter
   incoming** tool calls from upstream — it never injects tools upstream.

Reference: `src/lib/backends/bridge-runtime-kit.server.ts` →
`ToolCallFilter`, `docs/backend-integration.md` §Tool-call events.

### 2.2 `useRenderTool` — Server-Side Tool Renderer

Define `generate_artifact` via `defineTool()` on the server; register
a matching `useRenderTool()` renderer on the client to display an
inline preview card in chat. User clicks to expand into main panel.

**Verdict: Rejected — same root cause as 2.1.**

`defineTool()` injects tools through CopilotKit Runtime, which only
controls built-in agents. External agents cannot receive these tool
definitions. Additionally, `useRenderTool` only registers a **renderer**
(does not add to `input.tools`), so even if an external agent happened
to emit a matching tool call, `ToolCallFilter` would block it.

### 2.3 `useComponent` — Declarative UI Component

A convenience wrapper over `useFrontendTool` that auto-generates a tool
description. Shares the same limitation: the external LLM never sees
the registered component tool.

**Verdict: Rejected — syntactic sugar over 2.1, same limitation.**

### 2.4 Activity Message — AG-UI Structured Activity Events

Agent emits `ActivitySnapshotEvent` / `ActivityDeltaEvent` with a custom
`activityType`. Client registers a renderer via `renderActivityMessages`.

**Verdict: Partially viable — but requires bridge-level emission.**

Activity events are part of the AG-UI protocol and CopilotKit has native
rendering support. However, external agents do not emit Activity events
on their own — the bridge would need to synthesise them. This shifts the
problem to bridge-level detection, which is viable but does not cover
built-in agents (they bypass the bridge).

### 2.5 A2UI (Agent-to-UI) — Dynamic UI Surface

CopilotKit v2's most advanced generative UI system. Agent sends
`a2ui_operations` that dynamically create/update/delete UI surfaces.

**Verdict: Rejected — excessive complexity, same coverage gap.**

Requires the agent to understand the A2UI operation protocol. External
agents cannot produce these operations, and built-in agents would need
extensive prompt engineering. The component catalog and rendering
infrastructure add significant complexity for this use case.

### 2.6 Summary Matrix

| Approach | Built-in | External | No agent cooperation | Replaces in chat | Complexity |
|---|:---:|:---:|:---:|:---:|:---:|
| 2.1 `useFrontendTool` | Yes | **No** | No | N/A | Low |
| 2.2 `useRenderTool` | Yes | **No** | No | N/A | Medium |
| 2.3 `useComponent` | Yes | **No** | No | N/A | Low |
| 2.4 Activity Message | Partial | Partial | Yes | Possible | Medium |
| 2.5 A2UI | Partial | **No** | No | Possible | High |

**None of the tool-based approaches (2.1–2.3) satisfy R1** because they
all require the LLM to know about and call the tool, which is impossible
for external agents whose tool registries are managed by their respective
platforms.

---

## 3. Decision: Server-Side Detection + AG-UI Activity + Client Rendering

### 3.1 Core Insight

The key insight that unlocks a universal solution:

1. **All agent types** — both built-in and backend — flow through
   `PersistingAgent` before reaching the browser. This is the true
   universal interception point (not the bridge, which only handles
   backend agents).
2. **Artifact detection is an infrastructure concern**, not an agent
   concern. Agents produce content; the platform decides how to display
   it.
3. **Content replacement in chat** cannot happen at the AG-UI event
   stream level (text events are append-only). It must happen at the
   **React rendering layer**, which is architecturally the correct place
   for display decisions.

### 3.2 Architecture Overview

```
┌──────────────────────────────────────────────────────────────────┐
│  PersistingAgent  (universal interception point)                 │
│                                                                  │
│  InnerAgent.run(input)                                           │
│      │  Observable<BaseEvent>                                    │
│      ▼                                                           │
│  ┌─ Event Pipeline ───────────────────────────────────────────┐  │
│  │                                                            │  │
│  │  TEXT_MESSAGE_CONTENT × N  →  pass through (streaming OK)  │  │
│  │                            →  accumulate into buffer       │  │
│  │                                                            │  │
│  │  TEXT_MESSAGE_END          →  pass through                 │  │
│  │                            →  scan buffer for artifacts    │  │
│  │                            →  emit ActivitySnapshotEvent   │  │
│  │                               per detected artifact        │  │
│  │                                                            │  │
│  │  (other events)            →  pass through unchanged       │  │
│  └────────────────────────────────────────────────────────────┘  │
│      │                                                           │
│      ▼  enriched Observable<BaseEvent>                           │
│  CopilotRuntime → SSE → Browser                                 │
└──────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────┐
│  Browser                                                         │
│                                                                  │
│  ┌─ Activity Renderer (activityType: "artifact") ─────────────┐  │
│  │  • Receives artifact data from ActivitySnapshotEvent        │  │
│  │  • Stores artifact in Zustand (with message ID reference)   │  │
│  │  • Calls workspaceStore.openArtifact() → main panel         │  │
│  │  • Returns null (no inline chat UI for the activity itself) │  │
│  └────────────────────────────────────────────────────────────┘  │
│                                                                  │
│  ┌─ Custom assistantMessage Renderer ─────────────────────────┐  │
│  │  • While streaming: render markdown normally                │  │
│  │  • On message complete (+ artifacts detected):              │  │
│  │    - Read associated artifacts from Zustand store           │  │
│  │    - Replace artifact content ranges with button/link       │  │
│  │    - e.g. code block → [View Code: utils.py]               │  │
│  │    - e.g. image URL  → [View Image: chart.png]             │  │
│  │  • On message complete (no artifacts): render as-is         │  │
│  └────────────────────────────────────────────────────────────┘  │
│                                                                  │
│  ┌─ Main Panel (WorkspacePage) ───────────────────────────────┐  │
│  │  ArtifactRenderer displays full artifact content            │  │
│  │  Close button → workspaceStore.closeArtifact()              │  │
│  └────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────┘
```

### 3.3 User Experience Timeline

```
Time ──────────────────────────────────────────────────────────►

Chat panel:
  [streaming]  "Here is the analysis result:\n```python\nimport..."
  [streaming]  "...pandas as pd\ndf = ...\n```\nAs shown above..."
  [complete]   content replaced →
               "Here is the analysis result:
                [📄 View Code: analysis.py]
                As shown above..."

Main panel:
  [idle]       Welcome screen
  [complete]   ArtifactRenderer shows full code with syntax highlighting

Transition from streaming → complete is near-instantaneous.
```

### 3.4 Why Streaming Is Preserved

The fundamental tension: AG-UI text events are **append-only** — once
`TEXT_MESSAGE_CONTENT` is sent, it cannot be retracted. Content
replacement requires knowing the full message, which is only available
at `TEXT_MESSAGE_END`.

Two options were considered:

| Option | Streaming UX | Feasibility |
|---|---|---|
| Buffer entire message, transform, then send | **Killed** — user sees nothing until complete | Rejected |
| Stream normally, replace at render layer on completion | **Preserved** — user sees text appear token-by-token | **Selected** |

The selected approach:

1. **During streaming**: `TEXT_MESSAGE_CONTENT` events pass through
   unchanged. User watches text appear naturally, including raw artifact
   content (code blocks, image markdown, etc.).
2. **On `TEXT_MESSAGE_END`**: PersistingAgent scans the accumulated
   buffer, detects artifacts, emits `ActivitySnapshotEvent`(s).
3. **On the client** (near-simultaneous):
   - Activity renderer → stores artifacts, opens main panel
   - Message component re-renders → replaces artifact content with
     buttons

Steps 2–3 happen in the same event batch. The visual transition from
raw content to buttons is effectively instantaneous — the user perceives
it as the natural "message complete" moment.

### 3.5 Responsibility Split

| Responsibility | Layer | Rationale |
|---|---|---|
| Accumulate text buffer | PersistingAgent | Already buffers for `entity_run_event` persistence |
| Detect artifact patterns | PersistingAgent | Single detection logic; results are persistable |
| Emit ActivitySnapshotEvent | PersistingAgent | AG-UI native; reaches client via existing SSE |
| Persist artifact metadata | PersistingAgent | Write to `entity_run_event` (type = `artifact_detected`) or `artifact` table |
| Display artifact in main panel | Client — Activity renderer | Calls `openArtifact()` on Zustand store |
| Replace chat content with buttons | Client — message renderer | Display decision belongs in the rendering layer |

Detection logic is written **once** on the server. The client message
renderer does **not** re-detect — it reads the artifact list associated
with each message (via Zustand store or message metadata) and applies
the replacement.

### 3.6 PersistingAgent Transform (Pseudocode)

Current PersistingAgent uses `tap()` (observe-only). This change
upgrades to `mergeMap()` (can emit additional events):

```typescript
// persisting-agent.ts — run() method

inner.run(input).pipe(
  // Phase 1: accumulate text into buffer (existing logic reused)
  // Phase 2: on TEXT_MESSAGE_END, detect & emit
  mergeMap((event: BaseEvent) => {
    const events: BaseEvent[] = [event]; // always pass through original

    if (event.type === EventType.TEXT_MESSAGE_END) {
      const text = this.flushMessageBuffer();
      const artifacts = extractArtifacts(text, event.messageId);

      for (const artifact of artifacts) {
        events.push({
          type: EventType.ACTIVITY_SNAPSHOT,
          activityType: "artifact",
          content: {
            messageId: event.messageId,
            id: artifact.id,
            type: artifact.type,        // "code" | "chart" | "image" | ...
            name: artifact.name,
            content: artifact.content,
            range: artifact.range,       // { start, end } char offsets
          },
        });
      }
    }

    return from(events);
  }),

  // Phase 3: persist all events (including artifact activities)
  tap((event) => recordEvent(this.runId, this.nextSeq(), event)),
);
```

### 3.7 Client Activity Renderer (Pseudocode)

```typescript
// Registered on CopilotKitProvider
const artifactActivityRenderer = {
  activityType: "artifact",
  content: z.object({
    messageId: z.string(),
    id: z.string(),
    type: z.enum(ARTIFACT_TYPES),
    name: z.string(),
    content: z.unknown(),
    range: z.object({ start: z.number(), end: z.number() }),
  }),
  render: ({ content }) => {
    // Side-effect: store artifact and open in main panel
    useEffect(() => {
      useArtifactStore.getState().addDetected(content.messageId, content);
      useWorkspaceStore.getState().openArtifact(content);
    }, [content.id]);

    return null; // No inline chat UI for the activity itself
  },
};
```

### 3.8 Client Message Renderer (Pseudocode)

Extends the existing `AssistantMessageWithTiming` pattern:

```typescript
function AssistantMessageWithArtifacts(
  props: CopilotChatAssistantMessageProps,
): ReactNode {
  const artifacts = useArtifactStore(
    (s) => s.getForMessage(props.message.id),
  );

  // While streaming or no artifacts detected: render normally
  if (props.message.isStreaming || !artifacts.length) {
    return <CopilotChatAssistantMessage {...props} />;
  }

  // Message complete with artifacts: replace content ranges with buttons
  const transformed = replaceRangesWithButtons(
    props.message.content,
    artifacts,
  );

  return (
    <CopilotChatAssistantMessage {...props}>
      {transformed}
    </CopilotChatAssistantMessage>
  );
}
```

---

## 4. Artifact Detection Rules (To Be Defined)

The `extractArtifacts(text, messageId)` function needs clear rules for
what qualifies as an artifact. This is the primary risk area — false
positives clutter the main panel, false negatives miss content.

Candidate rules (to be refined during implementation):

| Pattern | Artifact Type | Candidate Heuristic |
|---|---|---|
| Fenced code block (` ``` `) | `code` | Lines ≥ threshold (e.g. 5+)? Has language tag? |
| Markdown image `![alt](url)` | `image` | Always extract? Or only certain URL patterns? |
| HTML block (`<html>...</html>`) | `html` | Must be self-contained document? |
| ECharts JSON option | `chart` | Detect `{ "xAxis": ..., "series": ... }` shape? |
| Mermaid block (` ```mermaid `) | `code` | Always extract (rendered diagram)? |
| SVG block | `image` | Always extract? |

### Open Questions

- Should **all** fenced code blocks be extracted, or only those above a
  size threshold?
- Should detection be configurable per-agent or per-workspace?
- Should the agent be able to opt-in via a structured marker
  (e.g. `<!-- artifact:chart -->`) as a hint?
- How to handle multiple artifacts in one message? Show the first in
  main panel, list the rest as buttons?

---

## 5. Files to Modify

| File | Change |
|---|---|
| `src/lib/runner/persisting-agent.ts` | Upgrade `tap()` → `mergeMap()`; add buffer scan + ActivitySnapshot emission |
| `src/lib/runner/artifact-extractor.ts` | **New** — `extractArtifacts(text, messageId)` detection logic |
| `src/hooks/useAgentActions.tsx` | Remain no-op (frontend tool approach abandoned) |
| `src/components/layout/RightPanel.tsx` | Register `renderActivityMessages` for `activityType: "artifact"` |
| `src/components/right-panels/ChatPanel.tsx` | Extend `messageView.assistantMessage` with artifact replacement |
| `src/store/artifact-store.ts` | **New** — Zustand store mapping `messageId → artifact[]` |
| `docs/architecture.md` §5.4 | Update to reflect new approach (replace frontend-tool description) |

---

## 6. Data Visualization: Outcomes Panel (Priority Scenario)

> **V1 scope (this section is the focused implementation target).**
> Phase 1a ships **Path A only** — built-in agent calls a frontend
> tool, output lands in a thread-scoped Outcomes Panel at the
> dedicated route `/outcomes`. The primary scenario is "agent
> extracts data, picks a chart type, the chart shows up in the main
> panel; user keeps chatting, more charts accumulate; user can
> collapse cards, save the good ones to the permanent Artifact
> library, leave / come back / switch threads without losing
> context".
>
> ### V1 includes
>
> - `render_chart` frontend tool (chart-only; HTML/image **kinds**
>   are pre-baked into the schema but no tool produces them yet)
> - Dedicated `/outcomes` route in `(workspace)/` with a collapsible
>   card list (shadcn `<Collapsible>` + `<Card>` — **no
>   react-grid-layout**, no drag-resize)
> - Polymorphic `Outcome` type (`kind: "chart" | "html" | "image"`)
>   so future kinds add without rework
> - Thread-scoped `outcomeStore` with **event-sourcing replay** on
>   thread switch (so "switch away → switch back" restores the
>   panel from `entity_run_event` history)
> - Save button on each card → `POST /api/artifacts` promotes the
>   transient outcome to a permanent row in the `artifact` table
>   (visible later in the V2 Artifact library at `/artifact`)
> - First-outcome auto-jump (only when user is currently on `/`)
> - ECharts renderer: lazy-loaded via `next/dynamic`, dark theme via
>   `next-themes`, per-card `<ErrorBoundary>`
> - Dispatch-time prompt block telling the LLM **when** to call
>   `render_chart` (only injected for agents with bound data
>   sources / sandbox; supervisor gets a "delegate, don't draw"
>   directive)
>
> ### V1 excludes (deferred to later phases)
>
> - `update_chart` / `remove_chart` / `get_dashboard_state` frontend
>   tools — Phase 1b. V1 uses "render with same `chartId` overwrites"
>   as the cheap substitute, and a UI close-X for manual removal.
> - HTML / image rendering inside cards — Phase 2. Schema admits
>   `kind: "html" | "image"` but no producer tool exists yet.
> - `react-grid-layout` / drag-resize / explicit positioning —
>   indefinitely deferred. The cards are a vertical/responsive list.
> - Plotly HTML iframe path (§6.6) — Phase 2.
> - Path B / §3 general artifact extraction from external agents —
>   PersistingAgent stays `tap()`-only in V1.
> - V2 Artifact management page at `/artifact` — V1 only ships the
>   POST endpoint and a toast on save; the management UI (category
>   tree, filtering, sharing) is V2.
>
> ### Two surfaces, two URLs — do NOT confuse them
>
> | Concept | URL | Backing data | Lifecycle | When built |
> |---|---|---|---|---|
> | **Outcomes Panel** (this V1) | `/outcomes` | `entity_run_event` rows replayed per thread | Thread-scoped, ephemeral, cleared on new chat | V1 |
> | **Artifact Library** (future) | `/artifact` | `artifact` table CRUD | Permanent, user-owned, with visibility | V2 |
>
> The Save button on an outcome card is the **only bridge** between
> the two — it copies the outcome's content into a new `artifact`
> row. Both copies coexist afterward (the outcome stays in the chat
> panel for context; the artifact lives independently in the library).
>
> Reading order: subsections marked **[V1]** are mandatory for Phase
> 1a; **[Phase 1b]** / **[Phase 2]** / **[V2]** describe eventual
> shape but are not implemented yet.

The general artifact extraction described in §3 addresses freeform
content (code blocks, images, etc.) from any agent. However, the
**primary** use case is structured data visualization: the agent
analyses data via Nango's existing pipeline and produces ECharts
chart configurations that must be displayed — and interacted with —
in the main panel.

This scenario has fundamentally different characteristics from
freeform artifact extraction:

| Dimension | Freeform artifacts (§3) | Data visualization (§6) |
|---|---|---|
| Content origin | Embedded in agent's text stream | Produced by sandbox execution (structured JSON) |
| Agent cooperation | Not required | Agent explicitly orchestrates the pipeline |
| Interaction | Display only | Bidirectional — agent reads/writes chart state |
| Agent type | All agents (built-in + external) | Built-in agents (they own the data pipeline tools) |
| Detection | Heuristic pattern matching | Explicit tool call results |

For built-in agents the data pipeline tools (`extract_dataset_by_sql`,
`run_code_in_sandbox`) are controlled by CopilotKit Runtime, so
**frontend tools work** — the limitation from §2 does not apply.

For external agents (agno / Mastra / Dify), the agent may perform
its own data analysis on its own platform and return chart configs
embedded in the text stream. These agents cannot call frontend tools,
so chart detection falls back to the PersistingAgent scanning
approach from §3, adapted specifically for ECharts JSON.

**Both paths converge on a single Outcome Store** — the rendering
and persistence layer is identical regardless of which agent produced
the chart.

### 6.1 Data Flow

The pipeline separates **data acquisition / transformation** (tools)
from **chart authoring** (the LLM itself). The sandbox is for heavy
data work — aggregation, anomaly detection, statistical tests — not
for producing chart configs. The Agent LLM reads the data (or the
sandbox-processed results) and authors the ECharts option JSON
directly.

Two paths depending on data complexity:

**Path A — Simple / small dataset (no sandbox needed):**

`extract_dataset_by_sql` returns a `preview` field that already
contains complete data (column-oriented JSON). For charts like pie,
bar, or small-series line charts, the preview IS the full dataset.

```
User: "Show sales by category as a pie chart"
                    │
                    ▼
Agent calls extract_dataset_by_sql({
  dataSourceName: "prod_pg",
  query: "SELECT category, SUM(amount) AS total FROM sales GROUP BY category"
})
                    │
                    ▼
Tool returns:
  { preview: { columns: ["category","total"],
               rows: [["Electronics",42000],["Clothing",28000],...] },
    rowCount: 5, ... }
                    │
                    ▼
Agent LLM reads preview, authors ECharts option:
  { series: [{ type:"pie", data:[{name:"Electronics",value:42000},...] }] }
                    │
                    ▼
Agent calls render_chart({ chartId:"cat-pie", title:"Sales by Category", option:{...} })
                    │
                    ▼
Frontend tool handler → Outcome Store → /outcomes route renders pie chart
```

**Path B — Complex analysis (sandbox needed):**

When data requires transformation beyond SQL (time-series
decomposition, outlier detection, correlation analysis, etc.),
the sandbox handles the heavy computation. Its output (processed
data, not chart configs) returns to the Agent, which then authors
the chart.

```
User: "Detect anomalies in daily revenue over the past year"
                    │
                    ▼
Agent calls extract_dataset_by_sql(...)    → data cached
Agent calls run_code_in_sandbox({
  stdin: "import pandas as pd\n... isolation forest ...\nprint(json.dumps(results))",
  datasets: ["daily_revenue"]
})
                    │
                    ▼
Sandbox returns:
  stdout: '{"dates":[...],"values":[...],"anomalies":[3,17,42]}'
                    │
                    ▼
Agent LLM reads sandbox output, authors ECharts option with
anomaly markers, trend lines, confidence bands, etc.
                    │
                    ▼
Agent calls render_chart({...})  → Main Panel
Agent also writes insight text: "3 anomalies detected on Mar 3, Mar 17..."
```

Key principle: **tools produce data, the LLM produces charts.** The
LLM has the context to choose chart types, colours, labels, and
layout based on the user's intent — the sandbox does not.

### 6.2 Architecture — Dual-Entry, Shared Core

> **Design decision**: two entry paths, one shared core. This is NOT
> two separate solutions — it is one solution with two input adapters.
> The divergence is limited to ~50 lines of entry-point code; the
> Outcome Store, ECharts renderer, OutcomesPanel UI, and replay /
> save logic are 100% shared.
>
> Path A (built-in agent → frontend tool) is **V1**.
> Path B (external agent → PersistingAgent text-stream detection) is
> **Phase 2** and documented for forward-compat only.

Charts reach the Outcome Store through **two entry paths** depending
on the agent type. Both paths converge on the same Zustand store and
the same OutcomesPanel UI at `/outcomes`.

```
┌─ Path A: Built-in Agent  [V1] ──────────────────────────────────┐
│                                                                  │
│  Server-side tools (existing):                                   │
│  ├─ extract_dataset_by_sql   SQL → Parquet cache + preview      │
│  ├─ run_code_in_sandbox      Data transformation (not charts)   │
│  └─ run_skill_script         Pre-authored analysis scripts      │
│                                                                  │
│  Frontend tools (NEW in V1):                                     │
│  └─ render_chart             Push chart to Outcome Store         │
│                                                                  │
│  Frontend tools (Phase 1b):                                      │
│  ├─ get_dashboard_state                                          │
│  └─ remove_chart                                                 │
│                                                                  │
│  Agent calls render_chart → CopilotKit routes to browser         │
│  → useFrontendTool handler → outcomeStore.addOutcome             │
│                                                                  │
└──────────────────────────┬───────────────────────────────────────┘
                           │
                           ▼
                 ┌─────────────────────┐
                 │   outcomeStore      │
                 │  (Zustand, thread-  │
                 │   scoped)           │
                 │                     │
                 │  outcomes: [...]    │
                 │  collapsed flags    │
                 │  savedArtifactId    │
                 │  selectedId         │
                 └────────┬────────────┘
                          │
                  ┌───────┴──────────┐
                  │ /outcomes route  │
                  │  OutcomesPanel   │
                  │  (Card list)     │
                  └──────────────────┘
                          ▲   ▲
                          │   │ Save button → POST /api/artifacts
                          │   │     → artifact table → V2 Library
                          │
┌─────────────────────────┴────────────────────────────────────────┐
│                                                                   │
│  Path B: External Agent (agno / Mastra / Dify)  [Phase 2]        │
│  Agent returns text with ECharts JSON in stream.                  │
│  PersistingAgent detects + emits ActivitySnapshot → outcomeStore. │
│                                                                   │
└───────────────────────────────────────────────────────────────────┘
```

**Interaction capabilities differ by path:**

| Capability | Path A (Built-in) [V1] | Path B (External) [Phase 2] |
|---|:---:|:---:|
| Display chart in `/outcomes` | `render_chart` tool | PersistingAgent detect + Activity |
| Modify chart | Re-render with same `chartId` (V1) / `update_chart` (Phase 1b) | Not directly |
| Read chart state | `get_dashboard_state` (Phase 1b) | Not available to external LLM |
| Save to library | Save button on card → `POST /api/artifacts` | Same (UI-driven, agent-independent) |
| Chat preview | `useRenderTool` chart preview card | Message renderer replaces JSON with link |

**Cross-path future**: The Outcome Store is shared. A chart added by
either path can be saved by the user via the same card-header button.

#### Tool registration scope — global + prompt-block gating

`useOutcomeTools()` is called once in `ChatProviderHooks` (RightPanel),
which means **every built-in agent sees `render_chart` in its tool
list** — same pattern as `useInteractiveTools` for HITL tools.
Per-agent filtering is not feasible: CopilotKit v2 has no per-agent
frontend-tool registry.

To keep the supervisor focused on delegation and to give the rest of
the agents a consistent usage policy, dispatch-time prompt composition
injects one of two blocks:

| Agent role | Prompt block injected | Effect |
|---|---|---|
| Supervisor (`role === 'supervisor'`) | "Delegate visualization tasks to a specialist; do not call `render_chart` directly." | Discouraged from drawing directly. |
| Everyone else (incl. chat-only) | "render_chart usage" rules — no-data-no-call, dataset over series.data, no JSON in chat. | Tool used correctly when called. |

> **V1 lesson learned**: an earlier design left chat-only agents
> with **no** block (the table previously listed "Neither" → "No
> chart-related prompt block"). The result: GPT-class models still
> discovered the globally-registered tool and mis-used it (empty
> options, JSON pasted in chat) because the only guidance they saw
> was the tool description. Current policy: ALWAYS inject for
> non-supervisor agents. The block is ~5 lines — negligible token
> cost for consistent behaviour. If a future agent truly should not
> have `render_chart`, fix it at the registration layer (don't call
> `useOutcomeTools()`), not via prompt absence.

Tool registration itself stays **global** (one registration site, no
per-agent branching). Behavioural channeling lives in
`lib/runner/dispatch/builtin.ts` next to the existing
`dataSourcesRuntime.promptBlock` / `supervisorCatalogBlock`
composition.

### 6.3 Frontend Tools — Detailed Design

#### `render_chart` — Push a new chart to the dashboard **[V1]**

##### Registration pattern — handler / render separation (mandatory)

The naive form `useFrontendTool({ name, handler, render })`
**conflicts** with the wildcard `useDefaultRenderTool("*")` registered
in `ChatProviderHooks`. CopilotKit registers BOTH renderers under the
same `toolCallId` and emits two React elements with identical keys
("duplicate key" warning + potential double card). This is the same
pitfall `useInteractiveTools` already documented and fixed — see
<ref_snippet file="/Users/jzhao1/Library/CloudStorage/OneDrive-SpirentCommunications/Documents/AI_Space/nango/src/hooks/useInteractiveTools.tsx" lines="13-33" />.

The required form for every chart tool: **`useFrontendTool` registers
the handler (no `render` prop); `useRenderTool` registers the render
separately**. Both share the same Zod schema.

```typescript
// useOutcomeTools.tsx — V1 registers render_chart only.
//
// V1.3: `option` was reshaped from an object schema into a JSON STRING
// parameter (`optionJson`). Earlier iterations declared option as
// z.record(z.unknown()) — the LLM saw `{type:"object",
// additionalProperties:true}` with no required sub-fields and
// repeatedly submitted `option: {}`. A required string with literal
// JSON examples removes the trap; the handler parses it back into
// an object before persisting.
const renderChartSchema = z.object({
  chartId: z.string().describe(
    "Stable per-thread identifier; re-using the same id overwrites the " +
    "previous chart. Pick a short slug like 'sales-pie'."
  ),
  title: z.string().describe("Human-readable chart title (shown on card header)"),
  description: z.string().optional().describe(
    "One-sentence description of what the chart shows."
  ),
  optionJson: z.string().min(10).describe(
    'Full ECharts option, serialized as a JSON STRING (not an object). ' +
    'Must parse to a plain object whose `series` is a non-empty array. ' +
    'Put data in `dataset.source` (2D array, first row = column names). ' +
    'Example: \'{"dataset":{"source":[["name","value"],["A",42]]},"series":[{"type":"pie"}]}\''
  ),
  datasetName: z.string().optional().describe(
    "Optional: the cache key passed to extract_dataset_by_sql for this " +
    "chart's underlying data."
  ),
});

type RenderChartArgs = z.infer<typeof renderChartSchema>;

// Handler — pure side-effect, NO render prop here.
useFrontendTool<RenderChartArgs>({
  name: "render_chart",
  description:
    "Display an ECharts chart in the user's Outcomes panel. " +
    "Re-calling with the same chartId overwrites the previous chart.",
  parameters: renderChartSchema,
  handler: async (rawArgs) => {
    // 1) Re-run safeParse — CopilotKit v2 only does JSON.parse + "is
    //    object" before invoking us, so the schema's form constraints
    //    have to be enforced here.
    const parsed = renderChartSchema.safeParse(rawArgs);
    if (!parsed.success) return JSON.stringify({ ok: false, error: "VALIDATION_FAILED", ... });
    const args = parsed.data;

    // 2) Hard size cap on the raw JSON string.
    if (args.optionJson.length > 64_000) {
      return JSON.stringify({ ok: false, error: "OPTION_TOO_LARGE", ... });
    }

    // 3) Parse the JSON string into a plain object. Rejects arrays,
    //    primitives, and unparseable garbage with a structured error
    //    the LLM can correct without entering a retry loop.
    let option: Record<string, unknown>;
    try {
      const decoded = JSON.parse(args.optionJson);
      if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded)) {
        throw new Error("must be a plain JSON object");
      }
      option = decoded as Record<string, unknown>;
    } catch (err) {
      return JSON.stringify({ ok: false, error: "OPTION_JSON_PARSE_FAILED", ... });
    }

    // 4) Capture agentId + threadId from workspaceStore (NOT from LLM
    //    args). runId is NOT available client-side; replay populates
    //    it server-side from entity_run_event.run_id.
    const ws = useWorkspaceStore.getState();
    outcomeStore.getState().addOutcome({
      outcomeId:   args.chartId,
      kind:        "chart",
      title:       args.title,
      description: args.description,
      option,                                  // parsed object
      datasetName: args.datasetName,
      agentId:     ws.activeAgentId,
      threadId:    ws.threadId ?? null,        // bindPendingThreadId back-fills later
      runId:       null,                       // server replay populates
      groupId:     null,                       // Phase 1b
      createdAt:   Date.now(),
      collapsed:   false,
      savedArtifactId: null,
    });
    return JSON.stringify({ ok: true, chartId: args.chartId });
  },
  // NO render prop — avoids double-render with useDefaultRenderTool("*")
});

// Render — registered separately so it properly overrides the wildcard.
useRenderTool({
  name: "render_chart",
  parameters: renderChartSchema,
  render: ChartPreviewCard,
});
```

`ChartPreviewCard` must be `status`-aware — see §6.9.

##### Field provenance — LLM vs handler-captured

| Field on stored Outcome | Source | Notes |
|---|---|---|
| `outcomeId` | LLM (`args.chartId`) | Semantic slug. Same value across re-render = overwrite. |
| `title` | LLM | |
| `description` | LLM (optional) | |
| `option` (object) | LLM (`args.optionJson` string → parsed) | Handler `JSON.parse`s `optionJson` into a plain object before persisting. Combined raw string is capped at 64 KB. |
| `datasetName` | LLM (optional) | Stored for future "refresh" feature. |
| `agentId` | **Handler** | Captured from `workspaceStore.activeAgentId`. Records "who drew it" even after agent switch. |
| `threadId` | **Handler** | Captured from `workspaceStore.runtimeThreadId`. Used for replay scoping. |
| `runId` | **Replay only** | Handler sets `null` (no client visibility); replay reads from `entity_run_event.run_id`. Phase 1b consumes. |
| `groupId` | Phase 1b | Always `null` in V1. |
| `createdAt` | **Handler** | `Date.now()` at call time. |
| `kind` | **Handler** | Always `"chart"` for `render_chart`. Future tools set their own kind. |
| `collapsed` | UI / replay | Defaults `false` on add; user can toggle. **Not persisted** to `entity_run_event` — purely UI state. |
| `savedArtifactId` | Save action | `null` until user clicks Save; then the new `artifact.id`. |

##### Soft size limit and oversize routing

`option` is serialised through CopilotKit's tool-call channel
(streamed as TOOL_CALL_ARGS chunks) and persisted into
`entity_run_event.payload` (jsonb). Two practical caps:

| Cap | Limit | What happens at the limit |
|---|---|---|
| Soft (prompt guidance) | 10 KB JSON | Tool description tells the LLM to aggregate or sample first. |
| Hard (handler guard) | 64 KB JSON | Handler returns `{ ok: false, error: "OPTION_TOO_LARGE" }`; LLM can retry with sampling. |

Inlining 50+ data points in a single `series.data` is the usual cause.
Recommend: aggregate via `run_code_in_sandbox` (output ≤ 200 rows),
then chart the summary.

#### `update_chart` / `remove_chart` / `get_dashboard_state` **[Phase 1b — not in V1]**

The original §6.3 design exposed three additional tools for active
dashboard manipulation. V1 ships **only `render_chart`** for three
reasons:

1. **`update_chart` is redundant with `render_chart(sameChartId)`** —
   the store's `addChart` does upsert-style overwrite, so "change
   pie → bar" is naturally one `render_chart` call. Adding a second
   tool with mostly identical args invites the LLM to mis-route.
2. **`get_dashboard_state` requires a round-trip** that doubles the
   latency of any "explain this chart" interaction; not worth shipping
   without the matching ECharts-stable foundation.
3. **`remove_chart`** is a manual-UI affordance — V1 ships a close
   button on each chart cell instead.

Phase 1b will introduce `get_dashboard_state` (paired with a
`properties`-injected lightweight summary so the agent rarely has to
call it) and a `remove_chart` *tool*. The Phase 1b design for these
three follows the same handler/render-separation rule above.

### 6.4 The `/outcomes` Route **[V1]**

The Outcomes Panel lives at its **own URL** (`/outcomes`) under
`(workspace)/`, alongside the agent / schedule / datasource editors.
It is NOT a priority-stacked state on `/page.tsx` — that earlier
approach was rejected because users need to "navigate to other
routes and come back without losing context", which Next.js routing
gives for free when the panel has its own page.

```
src/app/(workspace)/
├── page.tsx              ← welcome (unchanged)
├── outcomes/
│   └── page.tsx          ← NEW — renders <OutcomesPanel />
├── artifact/
│   └── page.tsx          ← UNCHANGED placeholder, reserved for V2 library
├── agent/[id]/page.tsx
├── schedule/[id]/page.tsx
└── …
```

The page is trivial — its job is to mount the panel and let the store
do the heavy lifting:

```tsx
// src/app/(workspace)/outcomes/page.tsx
"use client";

import dynamic from "next/dynamic";

const OutcomesPanel = dynamic(
  () => import("@/components/workspace/OutcomesPanel").then(m => m.OutcomesPanel),
  { ssr: false, loading: () => <OutcomesPanelSkeleton /> },
);

export default function OutcomesPage(): ReactNode {
  return <OutcomesPanel />;
}
```

##### First-outcome auto-jump

When a `render_chart` tool call lands in the store, the handler
checks whether to **auto-navigate the user to `/outcomes`**. Rule:

```
IF current pathname is "/" (the welcome page)
   AND outcomeStore had zero outcomes before this call
THEN router.push("/outcomes")
ELSE no navigation — outcome silently appears in store; ChartPreviewCard
     in chat carries the "View →" link.
```

Rationale: avoid yanking the user out of `/agent/[id]` or other
editors while they are working. The welcome page is the only route
where we can safely assume "showing the new chart is what the user
wants". Any subsequent chart on the same thread does NOT auto-jump.

The navigation call lives in `useOutcomeTools.tsx` (handler can read
`window.location.pathname` and call `router.push`). Implementation
detail: handlers run in a non-React context, so use the
`window.next-router` global or a small wrapper hook that captures
the router and writes a ref the handler reads.

##### Cross-route behaviour

| User action | Outcomes Panel behaviour |
|---|---|
| Navigate to `/agent/[id]` | Panel hides; store retained. |
| Navigate back to `/outcomes` | Panel re-renders from existing store; **no replay needed** unless thread changed. |
| Page refresh on `/outcomes` | `outcomeStore` is empty (Zustand not persisted) → triggers replay from `/api/threads/[id]/outcomes`. |
| Thread switch (same agent) | `outcomeStore.clearForThreadSwitch()` → replay for new thread. |
| Agent switch (same thread) | No change to outcomes — they belong to the thread, not the agent. |
| Browser back/forward across `/outcomes` ↔ `/agent/abc` | Standard Next.js routing; store is React-tree-external so state survives. |

##### `workspaceStore.activeArtifact` removal

V1 deletes the legacy `activeArtifact / openArtifact / closeArtifact`
fields from `workspaceStore` and the `(workspace)/page.tsx`
priority-render code that consumed them. Reasons:

1. Dead code today — no chat-side caller invokes `openArtifact`.
2. Conceptual collision with the new `/outcomes` panel and the
   future `/artifact` library page.
3. V2's single-artifact-detail view will use Next.js routing
   (`/artifact/[id]`), not in-page replacement.

Strip ~50 lines from `workspace.ts` and `(workspace)/page.tsx`. The
existing `ArtifactRenderer.tsx` component **stays** — its
type-dispatch logic is reused inside OutcomesPanel cards for `kind:
"html"` and `kind: "image"` later.

### 6.5 Interaction Scenarios

**Scenario A — First chart in a fresh thread [V1]:**
```
(User starts on / welcome, picks an agent in left sidebar, types prompt)
User: "Show me sales by category as a pie chart"
Agent:
  1. extract_dataset_by_sql({ name: "sales_by_cat", dataSourceName: "prod_pg",
       query: "SELECT category, SUM(amount) AS total FROM sales GROUP BY category" })
     → preview: { columns:["category","total"], rows:[["Electronics",42000],...] }
  2. LLM reads preview, authors ECharts option
  3. render_chart({
       chartId: "cat-pie",
       title: "Sales by Category",
       description: "Distribution across product categories",
       option: { series:[{ type:"pie", data:[{name:"Electronics",value:42000},...] }] },
       datasetName: "sales_by_cat"
     })
     → outcomeStore.addOutcome (kind:"chart", agentId & threadId captured)
     → User is on "/" → auto-jump to /outcomes
     → Chat: ChartPreviewCard with "View →" link
```

**Scenario B — Add a second chart in the same thread [V1]:**
```
User: "Now show the monthly trend"
Agent: extract + render_chart({ chartId: "monthly-trend", ... })
  → outcomeStore now has [cat-pie, monthly-trend]
  → User is on /outcomes (or elsewhere) → NO auto-jump (second chart)
  → Chat: ChartPreviewCard "View →" link still works
  → If user is on /outcomes, new card appears at the bottom of the list
```

**Scenario C — Modify existing chart [V1]:**
```
User: "Change the pie chart to a bar chart"
Agent:
  1. (LLM remembers prior chartId "cat-pie" from chat context)
  2. render_chart({
       chartId: "cat-pie",                    ← same chartId
       title: "Sales by Category (Bar)",
       option: { series:[{ type:"bar", data:[...] }] }
     })
     → outcomeStore.addOutcome upserts in place
     → Card on /outcomes redraws with bar chart
     → savedArtifactId preserved if it had been saved (overwrite-after-save
       case — see §6.11 for the contract)
```

**Scenario D — Save to Artifact library [V1]:**
```
(User is viewing /outcomes, likes the pie chart, clicks the Save icon
 on the card header.)
Browser:
  POST /api/artifacts {
    name: "Sales by Category",
    type: "chart",
    content: { option: {...} },
    config: { renderType: "echarts" },
    visibility: "private",
  }
  → Server inserts a row into the artifact table, returns { id: "art_xyz" }
  → outcomeStore.markSaved("cat-pie", "art_xyz")
  → Card header: Save icon becomes ✓ + toast "Saved to library"
  → Card remains in /outcomes (not removed). Library copy lives independently.
```

**Scenario E — Switch thread away and back [V1]:**
```
(User has 3 charts in Thread A's /outcomes.)
User clicks Thread B in history list → HistoryPanel.handleSelectSession(B)
  → workspaceStore.setExplicitThreadId(B) + setRuntimeThreadId(B)
  → outcomeStore subscriber (watches runtimeThreadId): clearForThreadSwitch() + load("/api/threads/B/outcomes")
  → Thread B has no charts → empty panel.
User clicks Thread A again:
  → outcomeStore clears + loads "/api/threads/A/outcomes"
  → Server replays render_chart events for Thread A → 3 charts restored.
  → Collapsed state is NOT restored (UI-only, not persisted) — all expanded.
```

**Scenario F — Multi-chart dashboard in one turn [V1]:**
```
User: "Create a dashboard with revenue trend, category breakdown, and top products"
Agent:
  1. extract_dataset_by_sql × 3
  2. render_chart × 3 (in handler-call sequence)
     → /outcomes: 3 cards appear sequentially as ARGS streams in
     → No position authoring — natural top-to-bottom order
```

**Scenario G — Explain chart [Phase 1b]:**
Requires `get_dashboard_state` for the LLM to read back option JSON.
Not in V1; LLM can attempt explanation from recent chat context if
the prior `render_chart` call's args are still in the model's window.

### 6.6 Dual-Render: ECharts + Plotly HTML **[Phase 2 — not in V1]**

> V1 ships ECharts only. The HTML / iframe path below describes the
> Phase 2 design as reference; do NOT add `renderType` to V1's
> `render_chart` schema.

The dashboard supports two rendering modes through a single store.
ECharts is the primary format (structured JSON, interactive).
Plotly HTML is the complementary format for ML / scientific charts
that are hard to express as ECharts JSON (3D scatter, violin,
subplots with dendrograms, etc.).

```
render_chart({ renderType: "echarts", option: {...} })
  → EChartsRenderer (native <div>, full interaction)

render_chart({ renderType: "html", content: "<html>...</html>" })
  → iframe sandbox (isolated, display-only)
```

**Plotly HTML generation flow (built-in agent):**

```
Agent calls run_code_in_sandbox({
  stdin: `
    import plotly.express as px, json, sys
    df = pd.read_parquet("./data/anomalies/data.parquet")
    fig = px.scatter_3d(df, x="pc1", y="pc2", z="pc3", color="cluster")
    print(fig.to_html(include_plotlyjs="cdn", full_html=True))
  `,
  datasets: ["anomalies"]
})
  → stdout: "<html>...(~30KB with CDN ref)...</html>"
  → Agent calls render_chart({
      renderType: "html",
      chartId: "cluster-3d",
      title: "3D Cluster Visualization",
      content: stdout
    })
  → iframe in main panel
```

For external agents, the same HTML may appear in the text stream.
PersistingAgent detects `<html>` blocks containing Plotly markers
(`plotly.js`, `Plotly.newPlot`) and emits ActivitySnapshotEvent →
Outcome Store → iframe.

**Interaction capability by render type:**

| Capability | ECharts (JSON) | Plotly HTML (iframe) |
|---|:---:|:---:|
| Display in main panel | Native renderer | iframe sandbox |
| Agent read chart state | `get_dashboard_state` returns option JSON | Not available (opaque HTML) |
| Agent modify chart | `update_chart` with new option | Must regenerate HTML in sandbox |
| Cross-chart linking | ECharts `connect` | Not available (iframe isolation) |
| Theme inheritance | Yes (reads app CSS vars) | No (isolated styling) |
| Interactivity within chart | Full (zoom, brush, tooltip, click events) | Full (Plotly's own zoom/hover/pan) |

This is a natural capability gradient: ECharts for everyday
interactive dashboards, Plotly HTML for powerful one-off
visualizations. The agent chooses based on the task.

### 6.7 Outcome Store **[V1]**

The store holds **polymorphic outcomes** so V1's chart-only scope
doesn't force a refactor when HTML / image outcomes ship in Phase 2.
V1 only ever puts `kind: "chart"` rows in, but the discriminated
union is the API surface from day one.

```typescript
// src/store/outcome-store.ts
type OutcomeKind = "chart" | "html" | "image";

interface BaseOutcome {
  /** LLM-supplied slug for chart (= `args.chartId`); for future tools,
   *  whatever stable id they pick. Same value across re-render = upsert. */
  outcomeId:    string;
  kind:         OutcomeKind;
  title:        string;
  description?: string;

  /** Handler-captured at render-tool time. */
  agentId:   string;
  /** Null while CopilotKit's threadId is still being lazy-captured
   *  on `onRunFinalized` — `bindPendingThreadId` back-fills it as
   *  soon as the real id arrives. Server replay always supplies the
   *  real id (no null possible). */
  threadId:  string | null;
  /** entity_run.id of the agent run that produced this outcome.
   *  V1 stores but does NOT consume — reserved so Phase 1b can switch
   *  to run-grouped UX ("one user question's charts in one card") without
   *  a schema migration. See §6 V1 scope discussion of grouping. */
  runId:     string | null;
  createdAt: number;

  /** Phase 1b grouping key. V1 always `null` — UI treats outcomes flat. */
  groupId:   string | null;

  /** UI state — NOT persisted to entity_run_event; reset to false on replay. */
  collapsed: boolean;

  /** `null` until user clicks Save; then the new artifact.id from POST /api/artifacts. */
  savedArtifactId: string | null;
}

interface ChartOutcome extends BaseOutcome {
  kind: "chart";
  option:       Record<string, unknown>;  // ECharts option
  datasetName?: string;                    // Optional: extract_dataset_by_sql name
}

// Pre-baked for Phase 2; no producer in V1.
interface HtmlOutcome extends BaseOutcome {
  kind: "html";
  htmlContent: string;
}

interface ImageOutcome extends BaseOutcome {
  kind: "image";
  url:  string;   // data: URI or http(s) URL
  alt?: string;
}

type Outcome = ChartOutcome | HtmlOutcome | ImageOutcome;

interface OutcomeState {
  /** Outcomes belonging to the CURRENT thread. */
  outcomes:    Outcome[];
  /** Card the user clicked into (used by ChartPreviewCard → select on navigate). */
  selectedId:  string | null;
  /** "loading" while replay is in flight; UI shows a skeleton. */
  status:      "idle" | "loading" | "ready" | "error";

  /** Upsert by outcomeId. V1's "re-render with same id overwrites" relies on this.
   *  CONTRACT: if an existing outcome has savedArtifactId set, the new entry
   *  inherits it (overwriting does NOT un-save the prior version). */
  addOutcome:  (o: Outcome) => void;
  removeOutcome: (outcomeId: string) => void;
  toggleCollapse: (outcomeId: string) => void;
  select:      (outcomeId: string | null) => void;
  markSaved:   (outcomeId: string, savedArtifactId: string) => void;

  /** Called by the workspaceStore subscriber when threadId changes. */
  clearForThreadSwitch: () => void;
  /** Fetches replay from /api/threads/[id]/outcomes and hydrates. */
  loadForThread: (threadId: string) => Promise<void>;
}
```

##### Lifecycle / scope rules

| Lifecycle event | Outcome panel behaviour |
|---|---|
| `render_chart` called | `addOutcome` upserts by `outcomeId`. |
| Card collapse click | `toggleCollapse(outcomeId)` flips the boolean; UI re-renders. |
| Save button click | `POST /api/artifacts` → on success, `markSaved` records the artifact id. |
| Save again on same card | UI hides the button after first save (no double-save needed). |
| Agent switch (same thread) | No change — outcomes are thread-property. |
| Thread switch | `clearForThreadSwitch` + `loadForThread(newId)`. |
| Page refresh on `/outcomes` | Empty store → `loadForThread(currentThreadId)` on mount. |

##### Overwrite-after-save contract

If outcome `cat-pie` was saved (got `savedArtifactId = "art_xyz"`)
and the LLM then re-renders it (Scenario C), the new content in the
panel replaces the visible card, **but `savedArtifactId` is
preserved**. The saved library copy is unchanged; the panel now
shows the new version with a ✓ "Already saved" badge, plus an
optional "Save as new" affordance (Phase 1b — out of scope V1; V1
just preserves the id and shows ✓).

##### `outcomeId` uniqueness

`outcomeId` is supplied by the LLM (as `args.chartId` for
`render_chart`). It is unique within a single thread because the
store is thread-scoped — two threads using `"sales-pie"`
independently never collide (only one thread's outcomes live in the
store at a time).

##### Subscriber wiring

```typescript
// src/store/outcome-store.ts (or a wiring file)
useWorkspaceStore.subscribe(
  (s) => s.threadId,
  (newThreadId, oldThreadId) => {
    if (newThreadId === oldThreadId) return;
    const store = useOutcomeStore.getState();
    store.clearForThreadSwitch();
    if (newThreadId) store.loadForThread(newThreadId);
  }
);
```

##### Phase 1b / Phase 2 additions

- `getSummary()` — lightweight projection for CopilotKit `properties` injection.
- `update_chart` / `remove_chart` tool support (already covered by `addOutcome` / `removeOutcome`).
- HTML / image outcome producers (kinds already in schema).

### 6.8 OutcomesPanel UI — Collapsible Card List **[V1]**

`/outcomes` renders a single component, `OutcomesPanel`, which maps
over `outcomeStore.outcomes` and renders one shadcn `<Card>` per
entry, wrapped in a shadcn `<Collapsible>` to support per-card
expand / collapse.

Layout: vertical stack on narrow viewports, 2 columns on `xl+`. No
drag-resize. No explicit position field.

```typescript
// src/components/workspace/OutcomesPanel.tsx
"use client";

import { useOutcomeStore } from "@/store/outcome-store";
import { OutcomeCard } from "./OutcomeCard";

export function OutcomesPanel(): ReactNode {
  const outcomes = useOutcomeStore((s) => s.outcomes);
  const status   = useOutcomeStore((s) => s.status);

  if (status === "loading") return <OutcomesPanelSkeleton />;
  if (outcomes.length === 0) return <OutcomesPanelEmpty />;

  return (
    <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 p-4 overflow-y-auto h-full">
      {outcomes.map((o) => (
        <OutcomeCard key={o.outcomeId} outcome={o} />
      ))}
    </div>
  );
}
```

##### `OutcomeCard` — collapsible + kind-dispatched body

```typescript
// src/components/workspace/OutcomeCard.tsx
"use client";

import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { ChevronDown, ChevronRight, Save, Check, Trash2 } from "lucide-react";
import { useOutcomeStore } from "@/store/outcome-store";
import { EChartsRenderer } from "./EChartsRenderer";
import { ChartErrorBoundary } from "./ChartErrorBoundary";
import { useSaveOutcome } from "@/hooks/useSaveOutcome";   // §6.11
import type { Outcome } from "@/store/outcome-store";

export function OutcomeCard({ outcome }: { outcome: Outcome }): ReactNode {
  const toggleCollapse = useOutcomeStore((s) => s.toggleCollapse);
  const removeOutcome  = useOutcomeStore((s) => s.removeOutcome);
  const { save, isSaving } = useSaveOutcome();

  const expanded = !outcome.collapsed;

  return (
    <Collapsible open={expanded} onOpenChange={() => toggleCollapse(outcome.outcomeId)}>
      <Card>
        <CardHeader className="flex flex-row items-center gap-2 py-3">
          <CollapsibleTrigger asChild>
            <button className="flex items-center gap-2 flex-1 text-left">
              {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
              <div className="flex-1 min-w-0">
                <CardTitle className="text-sm truncate">{outcome.title}</CardTitle>
                {outcome.description && (
                  <CardDescription className="text-xs truncate">{outcome.description}</CardDescription>
                )}
              </div>
            </button>
          </CollapsibleTrigger>

          {/* Save button — primary control */}
          {outcome.savedArtifactId ? (
            <span className="inline-flex items-center text-xs text-green-600" title="Saved">
              <Check className="h-4 w-4" />
            </span>
          ) : (
            <button
              onClick={() => save(outcome)}
              disabled={isSaving}
              className="text-muted-foreground hover:text-foreground"
              aria-label="Save to library"
            >
              <Save className="h-4 w-4" />
            </button>
          )}

          {/* Remove button — V1's substitute for remove_chart tool */}
          <button
            onClick={() => removeOutcome(outcome.outcomeId)}
            className="text-muted-foreground hover:text-destructive"
            aria-label="Remove from panel"
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </CardHeader>

        <CollapsibleContent>
          <CardContent className="p-2">
            <div className="min-h-[280px]">
              <ChartErrorBoundary resetKey={outcome.outcomeId}>
                <OutcomeBody outcome={outcome} />
              </ChartErrorBoundary>
            </div>
          </CardContent>
        </CollapsibleContent>
      </Card>
    </Collapsible>
  );
}

/** Body dispatch by kind. V1 only handles "chart"; others throw to
 *  the ErrorBoundary above so partial deployments don't silently no-op. */
function OutcomeBody({ outcome }: { outcome: Outcome }): ReactNode {
  if (outcome.kind === "chart") {
    return <EChartsRenderer option={outcome.option} />;
  }
  // Phase 2:
  // if (outcome.kind === "html")  return <iframe srcDoc={outcome.htmlContent} sandbox="allow-scripts" />;
  // if (outcome.kind === "image") return <img src={outcome.url} alt={outcome.alt} />;
  throw new Error(`Outcome kind "${outcome.kind}" is not supported in V1`);
}
```

##### EChartsRenderer — three hard constraints

1. **Bundle size**: `echarts` ~1 MB minified (~350 KB gzipped).
   Loading it on every workspace page is wasteful. The cost is
   paid only when the user navigates to `/outcomes`, which
   lazy-loads `OutcomesPanel` via `next/dynamic({ ssr: false })`.
2. **Theme**: Nango defaults to dark mode (`next-themes`). ECharts
   default light palette clashes — switch to built-in `dark` theme
   based on `resolvedTheme`. ECharts has no live-swap-theme API, so
   a theme change disposes the instance and creates a fresh one;
   the `setOption` effect re-runs (it depends on `resolvedTheme`)
   and re-applies the current option into the new instance.
3. **Error isolation**: `setOption` throws synchronously if `option`
   is malformed. One bad chart must NOT take down the whole panel —
   the handler catches and re-throws so `ChartErrorBoundary`
   (wrapping each card body) renders a fallback.

The renderer is a hand-rolled imperative wrapper around the `echarts`
core package. The imperative approach gives us direct control over
the `setOption` call (the size-cap log and ChartErrorBoundary
integration both rely on intercepting it).

```typescript
// src/components/workspace/EChartsRenderer.tsx
"use client";
import { useEffect, useRef } from "react";
import * as echarts from "echarts";
import { useTheme } from "next-themes";

export function EChartsRenderer({ option }: { option: Record<string, unknown> }): ReactNode {
  const containerRef = useRef<HTMLDivElement>(null);
  const instanceRef = useRef<echarts.ECharts | null>(null);
  const { resolvedTheme } = useTheme();

  // Init / re-init on theme change.
  useEffect(() => {
    if (!containerRef.current) return;
    const inst = echarts.init(
      containerRef.current,
      resolvedTheme === "dark" ? "dark" : undefined,
    );
    instanceRef.current = inst;
    const ro = new ResizeObserver(() => inst.resize());
    ro.observe(containerRef.current);
    return () => {
      ro.disconnect();
      inst.dispose();
      instanceRef.current = null;
    };
  }, [resolvedTheme]);

  // Push option on (option, theme) changes. `resolvedTheme` must be
  // in the deps so a theme flip — which re-creates the instance
  // above — re-applies the option into the new (empty) instance.
  useEffect(() => {
    const inst = instanceRef.current;
    if (!inst) return;
    try {
      inst.setOption(option, true /* notMerge */, true /* lazyUpdate */);
    } catch (err) {
      throw err; // ChartErrorBoundary catches and renders fallback UI.
    }
  }, [option, resolvedTheme]);

  return <div ref={containerRef} style={{ height: "100%", width: "100%" }} />;
}
```

##### `ChartErrorBoundary`

Standard React error boundary — renders a small "Chart failed to
render" panel with the error message. Resets on `outcomeId` change
(so re-rendering with same id after a fix recovers cleanly).

### 6.9 Chat Preview Card **[V1]**

Shown inline in chat when `render_chart` is called. Must be
**`status`-aware**: during streaming, `props.parameters` is a
`Partial<RenderChartArgs>` whose `option` field may be a half-token
of malformed JSON — any attempt to read or parse it will throw.
Mirror the `adaptRenderProps` state machine in
<ref_snippet file="/Users/jzhao1/Library/CloudStorage/OneDrive-SpirentCommunications/Documents/AI_Space/nango/src/hooks/useInteractiveTools.tsx" lines="144-182" />.

```typescript
function ChartPreviewCard(props: RenderToolProps): ReactNode {
  const router = useRouter();

  // inProgress — args are partial; only chartId/title are *likely* present.
  if (props.status === "inProgress") {
    const partial = props.parameters as Partial<RenderChartArgs>;
    return (
      <div className="my-2 rounded-lg border bg-card p-3">
        <div className="flex items-center gap-2">
          <BarChart3 className="h-4 w-4 text-muted-foreground animate-pulse" />
          <span className="text-sm font-medium">
            {partial.title ?? partial.chartId ?? "Generating chart…"}
          </span>
        </div>
      </div>
    );
  }

  // executing / complete — args are fully validated.
  const args = props.parameters as RenderChartArgs;
  // On `complete + ok` the title itself is the link into /outcomes;
  // the trailing `↗` icon + hover underline are the affordance, no
  // separate action button.
  return (
    <div className="my-2 rounded-lg border bg-card p-3">
      <div className="flex items-center gap-2">
        <BarChart3 className="h-4 w-4 text-blue-500" />
        {props.status === "complete" ? (
          <button
            type="button"
            onClick={() => {
              router.push("/outcomes");
              useOutcomeStore.getState().select(args.chartId);
            }}
            className="inline-flex cursor-pointer items-center gap-1 text-sm font-medium text-blue-600 hover:underline"
            aria-label={`View ${args.title} in Outcomes`}
          >
            {args.title}
            <ArrowUpRight className="h-3 w-3" aria-hidden />
          </button>
        ) : (
          <span className="text-sm font-medium">{args.title}</span>
        )}
        <StatusBadge status={props.status} />
      </div>
    </div>
  );
}
```

### 6.10 Thread-scoped Event Replay **[V1]**

Outcomes are durable because all `render_chart` tool calls are
already persisted in `entity_run_event` by PersistingAgent
(<ref_snippet file="/Users/jzhao1/Library/CloudStorage/OneDrive-SpirentCommunications/Documents/AI_Space/nango/src/lib/runner/persisting-agent.ts" lines="254-284" />,
event type `tool_call_chunk`). V1 wires up the replay end-to-end so
"switch thread away and back" restores the panel from this server-
side history.

##### Replay API: `GET /api/threads/[id]/outcomes`

New route under `src/app/api/threads/[id]/outcomes/route.ts`,
wrapped with `withSession` (any authenticated user can read their
own thread's outcomes).

```typescript
// src/app/api/threads/[id]/outcomes/route.ts
export const GET = withSession("/api/threads/[id]/outcomes", async (req, ctx, { params }) => {
  const threadId = params.id;
  // Authorisation: ensure threadId belongs to ctx.userId.
  await assertThreadAccess(threadId, ctx.userId);

  // Query: join entity_run (filtered by thread_id) with entity_run_event
  // where event_type = "tool_call_chunk" AND payload->>'toolName' = "render_chart".
  const rows = await db
    .select(/* run.id, run.agent_id, event.payload, event.created_at */)
    .from(entityRunEvent)
    .innerJoin(entityRun, eq(entityRun.id, entityRunEvent.runId))
    .where(and(
      eq(entityRun.threadId, threadId),
      eq(entityRunEvent.eventType, "tool_call_chunk"),
      // Postgres JSON path operator: payload->>'toolName' = 'render_chart'
      sql`${entityRunEvent.payload}->>'toolName' = 'render_chart'`,
    ))
    .orderBy(entityRunEvent.createdAt);

  // Upsert into a Map keyed by chartId — last write wins.
  //
  // `coerceOption` handles both wire shapes: the V1.3 LLM-facing
  // `optionJson` (JSON string we parse back into an object) and the
  // legacy V1.0–V1.2 `option` field (object stored directly).
  // Rows with neither shape — malformed or unrecognised — are
  // skipped rather than crashing the whole replay.
  const outcomes = new Map<string, ChartOutcome>();
  for (const row of rows) {
    let args: RenderChartArgs;
    try {
      args = JSON.parse(row.payload.args);
    } catch { continue; }   // skip malformed
    const option = coerceOption(args);    // see helper below
    if (!option) continue;                // neither optionJson nor legacy option
    outcomes.set(args.chartId, {
      outcomeId:   args.chartId,
      kind:        "chart",
      title:       args.title,
      description: args.description,
      option,
      datasetName: args.datasetName,
      agentId:     row.run_agentId,
      threadId,
      runId:       row.run_id,              // Phase 1b reserved
      groupId:     null,                    // V1: always null
      createdAt:   row.createdAt.getTime(),
      collapsed:   false,                   // UI state never persisted
      savedArtifactId: null,                // back-fill via separate query (see below)
    });
  }

  // Back-fill savedArtifactId: SELECT id FROM artifact WHERE source_outcome_id = ?
  // This requires `artifact.source_outcome_id` (composite of threadId + outcomeId)
  // to be set on Save — see §6.11.
  await backfillSavedArtifactIds(threadId, outcomes);

  return NextResponse.json({ outcomes: [...outcomes.values()] });
});
```

##### Client-side `loadForThread`

```typescript
// inside outcome-store.ts
loadForThread: async (threadId: string) => {
  set({ status: "loading" });
  try {
    const res = await fetch(`/api/threads/${threadId}/outcomes`);
    if (!res.ok) throw new Error(`replay failed: ${res.status}`);
    const { outcomes } = await res.json();
    set({ outcomes, status: "ready" });
  } catch (err) {
    set({ status: "error" });
    // OutcomesPanel surfaces this state as "Failed to load — Retry".
  }
},
```

##### What is and isn't restored

| Field | Restored on replay? | Why |
|---|---|---|
| `outcomeId`, `kind`, `title`, `description`, `option`, `datasetName` | ✅ | Originated from LLM args, persisted. |
| `agentId`, `threadId`, `createdAt` | ✅ | Recoverable from `entity_run` + `entity_run_event` row metadata. |
| `runId` | ✅ | From `entity_run_event.run_id`. Phase 1b grouping consumes. |
| `groupId` | ❌ — always `null` in V1 | Phase 1b will assign from `runId`. |
| `savedArtifactId` | ✅ via back-fill | Joined from `artifact` table — see §6.11 contract. |
| `collapsed` | ❌ — reset to `false` | UI-only state, not worth persisting. Acceptable UX: user re-collapses if they want. |
| Selected card | ❌ | Same reason. |

##### Cost bounds

Each `render_chart` row in `entity_run_event` is bounded at ~64 KB
(`§6.3` hard cap). A thread with 20 charts → ≤ 1.3 MB of replay
payload, returned as a single JSON response. The endpoint runs one
SQL query; no N+1.

For threads with hundreds of `render_chart` calls (e.g. the LLM
re-rendered the same `chartId` 50 times), the Map dedup keeps the
final list small.

### 6.11 Save Flow — Outcome → Artifact **[V1]**

The Save button on each card promotes a transient outcome into the
permanent `artifact` table. This is the **only** write to `artifact`
in V1; the V2 Artifact library (`/artifact` page) will be the
read/manage side.

##### Server: `POST /api/artifacts`

New route, `withSession`-wrapped. Inserts one row into the existing
`artifact` table. The schema already has `type / content / config /
visibility` (per AGENTS.md §"Artifact"); V1 just adds one optional
column for the back-fill join (§6.10):

```
ALTER TABLE artifact ADD COLUMN source_thread_id  text NULL;
ALTER TABLE artifact ADD COLUMN source_outcome_id text NULL;
CREATE INDEX artifact_source_idx ON artifact (source_thread_id, source_outcome_id);
```

Both columns are nullable — future direct-creation flows (V2 manual
upload, programmatic export) won't have a source outcome.

```typescript
// src/app/api/artifacts/route.ts
const createArtifactSchema = z.object({
  name:             z.string().min(1).max(200),
  type:             z.enum(["chart", "html", "image", "code", "ppt", "report"]),
  content:          z.unknown(),
  config:           z.unknown().optional(),
  description:      z.string().optional(),
  visibility:       z.enum(["private", "public"]).default("private"),
  sourceThreadId:   z.string().optional(),
  sourceOutcomeId:  z.string().optional(),
});

export const POST = withSession("/api/artifacts", async (req, ctx) => {
  const body = await parseBody(req, createArtifactSchema);

  // Idempotency: if (sourceThreadId, sourceOutcomeId) already has an
  // artifact row owned by this user, return it instead of creating.
  if (body.sourceThreadId && body.sourceOutcomeId) {
    const existing = await db.query.artifact.findFirst({
      where: and(
        eq(artifact.sourceThreadId, body.sourceThreadId),
        eq(artifact.sourceOutcomeId, body.sourceOutcomeId),
        eq(artifact.createdBy, ctx.userId),
      ),
    });
    if (existing) return NextResponse.json({ id: existing.id, alreadySaved: true });
  }

  const [row] = await db.insert(artifact).values({
    name:        body.name,
    type:        body.type,
    content:     body.content,
    config:      body.config ?? null,
    description: body.description ?? null,
    visibility:  body.visibility,
    createdBy:   ctx.userId,
    sourceThreadId:  body.sourceThreadId  ?? null,
    sourceOutcomeId: body.sourceOutcomeId ?? null,
  }).returning({ id: artifact.id });

  return NextResponse.json({ id: row.id, alreadySaved: false });
});
```

##### Client: `useSaveOutcome` hook

```typescript
// src/hooks/useSaveOutcome.ts
"use client";
import { toast } from "sonner";
import { useOutcomeStore } from "@/store/outcome-store";
import type { Outcome } from "@/store/outcome-store";

export function useSaveOutcome() {
  const markSaved = useOutcomeStore((s) => s.markSaved);
  const [isSaving, setIsSaving] = useState(false);

  const save = async (outcome: Outcome) => {
    if (outcome.savedArtifactId) return;   // idempotent UI guard
    setIsSaving(true);
    try {
      const res = await fetch("/api/artifacts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(toCreateArtifactBody(outcome)),
      });
      if (!res.ok) throw new Error(`save failed: ${res.status}`);
      const { id } = await res.json();
      markSaved(outcome.outcomeId, id);
      toast.success("Saved to Artifact library");
    } catch (err) {
      toast.error("Failed to save — try again");
    } finally {
      setIsSaving(false);
    }
  };

  return { save, isSaving };
}

function toCreateArtifactBody(o: Outcome) {
  if (o.kind === "chart") {
    return {
      name:            o.title,
      type:            "chart",
      content:         { option: o.option },
      config:          { renderType: "echarts", datasetName: o.datasetName },
      description:     o.description,
      visibility:      "private",
      sourceThreadId:  o.threadId,
      sourceOutcomeId: o.outcomeId,
    };
  }
  // Phase 2: html / image mappings
  throw new Error(`Save not implemented for outcome kind "${o.kind}"`);
}
```

##### Save semantics

| Action | Result |
|---|---|
| First click on Save | POST → row in `artifact` → `markSaved` → ✓ icon + toast. |
| Click Save again on same card | Hidden (✓ replaces button); no double-save risk. |
| LLM re-renders same `chartId` after Save | Card content updates; `savedArtifactId` preserved (overwrite-after-save contract §6.7). Library copy is **unchanged** — V1 does NOT auto-update the saved artifact. |
| Replay restores card with prior save | Back-fill query finds matching artifact row → ✓ already present. |
| User saves the "updated" card again | Idempotency check matches the same `(threadId, outcomeId)` → server returns existing `artifact.id` with `alreadySaved: true`. UI shows ✓ as if newly saved (no toast change needed). |

Note: V1 does not implement "update the saved artifact when the
outcome changes" — that requires UX for "save as new version" vs
"overwrite". Deferred to V2 when the Artifact library has its own
edit flow.

### 6.12 V1 Implementation Plan **[V1]**

5-6 working days, organized so each day produces a runnable
checkpoint. Implementer can stop at any day-end and the app still
builds.

##### Day 1 — Foundation: store + types + replay endpoint

- [ ] `pnpm add echarts sonner` (sonner for toast).
- [ ] `src/store/outcome-store.ts` — Zustand store with polymorphic
      `Outcome` union, `addOutcome`, `removeOutcome`,
      `toggleCollapse`, `markSaved`, `clearForThreadSwitch`,
      `loadForThread`. **No UI consumer yet.**
- [ ] DB migration: add `artifact.source_thread_id`,
      `artifact.source_outcome_id` (nullable), index.
- [ ] `src/app/api/threads/[id]/outcomes/route.ts` — replay endpoint.
      Hand-test with curl.
- [ ] Subscriber wiring in `WorkspaceProvider` so `threadId` changes
      drive `clearForThreadSwitch` + `loadForThread`.
- [ ] Smoke test: in dev tools, manually `addOutcome(...)`; verify
      store updates and subscribe selectors fire.

**Checkpoint**: store + API exist; nothing rendered yet.

##### Day 2 — UI: route, panel, card

- [ ] `src/app/(workspace)/outcomes/page.tsx` — lazy import
      `OutcomesPanel`.
- [ ] `src/components/workspace/OutcomesPanel.tsx` — list + empty +
      skeleton states.
- [ ] `src/components/workspace/OutcomeCard.tsx` — `<Collapsible>` +
      `<Card>`, header with title / description / chevron / Save /
      Trash, body slot calls `OutcomeBody`.
- [ ] `src/components/workspace/EChartsRenderer.tsx` — `next/dynamic`
      lazy, `next-themes` dark, `<ChartSkeleton />` loading.
- [ ] `src/components/workspace/ChartErrorBoundary.tsx`.
- [ ] Manual test on `/outcomes`: hard-code a few outcomes in store
      via dev tools, verify cards render, collapse toggles work.

**Checkpoint**: `/outcomes` renders a list of injected charts.

##### Day 3 — Frontend tool wiring + auto-jump

- [ ] Rename `src/hooks/useAgentActions.tsx` → `useOutcomeTools.tsx`.
- [ ] Implement `useOutcomeTools` with `useFrontendTool` (handler-only)
      + `useRenderTool` (render-only) for `render_chart`. Handler
      captures `agentId` / `threadId` from `workspaceStore`, enforces
      64 KB hard cap, calls `outcomeStore.addOutcome`.
- [ ] First-outcome auto-jump: if `pathname === "/"` and outcomes
      were empty before, `router.push("/outcomes")`.
- [ ] `src/components/right-panels/ChartPreviewCard.tsx` —
      three-state branching (`inProgress` / `executing` / `complete`).
- [ ] Update `RightPanel.tsx`: rename `useAgentActions()` call to
      `useOutcomeTools()`.
- [ ] End-to-end test against a built-in agent with `extract_dataset_by_sql`:
      ask "show category sales as pie chart" → chart appears on
      `/outcomes`.

**Checkpoint**: V1 happy path works.

##### Day 4 — Save flow + prompt block

- [ ] `src/app/api/artifacts/route.ts` — POST with idempotency on
      `(sourceThreadId, sourceOutcomeId)`.
- [ ] `src/hooks/useSaveOutcome.ts` — POST wrapper + toast.
- [ ] Wire Save button in `OutcomeCard` to `useSaveOutcome`.
- [ ] Verify ✓ state, toast, idempotency on re-click.
- [ ] In `lib/runner/dispatch/builtin.ts`: when agent has bound data
      source / sandbox, append chart-guidance prompt block. When
      `spec.role === "supervisor"`, append "delegate, don't draw"
      prompt block. Place after `dataSourcesRuntime.promptBlock`.

**Checkpoint**: Save works; LLM behaviour is guided correctly per
agent kind.

##### Day 5 — Replay integration + cleanup

- [ ] End-to-end thread-switch test:
      1. Create charts in Thread A
      2. Switch to Thread B → panel clears
      3. Switch back to A → charts restored, ✓ preserved on saved
         ones (back-fill works)
- [ ] End-to-end page-refresh test: charts restore on `/outcomes`
      after refresh.
- [ ] Delete `workspaceStore.activeArtifact`, `openArtifact`,
      `closeArtifact`. Update `(workspace)/page.tsx` to remove the
      priority branch.
- [ ] Update `docs/architecture.md` §5.4 with a one-paragraph
      mention of the Outcomes panel.
- [ ] Lint, typecheck, build.

**Checkpoint**: V1 feature-complete.

##### Day 6 — Polish, edge cases, doc sync

- [ ] Edge cases:
  - Empty thread (no `render_chart` calls): replay returns `[]`;
    panel shows empty state.
  - Malformed `option` from LLM: ErrorBoundary catches; user can
    re-ask to re-render.
  - 64 KB cap hit: handler returns error string; LLM should retry
    with aggregation.
  - Concurrent thread switches (user rapid-clicks): each
    `loadForThread` is fire-and-forget; only the last one's set
    state wins because of the `clearForThreadSwitch` before fetch.
    Add an in-flight token if races prove problematic.
- [ ] Acceptance review against the criteria in §6.13.
- [ ] Final doc pass: ensure §6 reflects shipped behaviour.

**Checkpoint**: V1 ready for merge.

### 6.13 Acceptance Criteria **[V1]**

V1 is considered done when each of these is verifiable against a
local dev instance:

- [ ] **Generate**: with a built-in agent bound to a Postgres
      datasource, "Show me sales by category as a pie chart" yields
      a pie chart in `/outcomes`. The auto-jump triggers when user
      was on `/`.
- [ ] **Stream**: while the agent is calling `render_chart`,
      `ChartPreviewCard` shows "Generating chart…" without crashing
      on partial JSON.
- [ ] **Multi-chart**: agent renders 3 charts in one turn; all 3
      cards appear stacked on `/outcomes`, each independently
      collapsible.
- [ ] **Modify**: agent re-renders with the same `chartId` →
      existing card content updates in place; `savedArtifactId` is
      retained if previously saved.
- [ ] **Collapse**: clicking the chevron / header collapses the
      card to the title row; clicking again expands.
- [ ] **Save**: clicking Save creates a row in `artifact`; ✓ icon
      replaces the Save icon; toast appears; clicking the now-
      ✓ icon does NOT issue a second POST.
- [ ] **Thread switch**: switching to another thread clears the
      panel; switching back restores all prior charts including
      ✓ states (back-fill).
- [ ] **Refresh**: page refresh on `/outcomes` restores the panel
      via replay.
- [ ] **Cross-route**: navigating to `/agent/[id]` and back to
      `/outcomes` preserves the panel without a replay request.
- [ ] **Dark theme**: charts use ECharts' dark palette when the app
      is in dark mode.
- [ ] **Error isolation**: deliberately feed a broken `option`
      (e.g. via dev tools); only that one card shows an error
      panel — the rest of `/outcomes` works.
- [ ] **Supervisor**: with a supervisor agent active, asking it to
      "show me a chart" causes it to delegate (or refuse, not draw
      directly), per the prompt-block directive.
- [ ] **Oversize guard**: a 100 KB `option` returns
      `OPTION_TOO_LARGE`; LLM retries with smaller version (manual
      verification — feed the LLM a prompt likely to produce large
      JSON).
- [ ] **`activeArtifact` removed**: codebase grep for
      `activeArtifact` / `openArtifact` / `closeArtifact` returns
      zero hits in `src/`.

---

## 7. Reference Projects — Borrowed Patterns

| Source | Pattern | Applied to |
|---|---|---|
| **DeerFlow** | `ArtifactsContext` — separate state for artifacts list / selected / open / autoOpen | `outcomeStore` in §6.7 |
| **DeerFlow** | `autoOpen` / `autoSelect` — first chart auto-opens panel | `addChart()` triggers main panel display |
| **DeerFlow** | Code/Preview toggle in artifact detail view | Future: raw JSON / rendered chart toggle |
| **DeerFlow** | ResizablePanelGroup for chat/artifact split | Existing `ThreePanelContent` serves same role |
| **CopilotKit chat-with-data** | Recharts wrapper API (`data + index + categories + valueFormatter`) | Chart component API design reference |
| **CopilotKit chat-with-data** | `useCopilotAction({ available:"disabled", render })` — render-only action | Future: generative UI cards in chat |
| **CopilotKit Open Gen UI** | Sandbox iframe with CDN library support + auto-resize | HTML artifact renderer enhancement |
| **CopilotKit A2UI** | `renderActivityMessages` as the standard extension point | Validates §3 Activity-based approach |
| **CopilotKit A2UI** | Fixed Schema Streaming — pre-declared schemas + streamed data | Future: streaming chart rendering |
| **CopilotKit MCP Apps** | Thread persistence — UI stored in history, restored on reconnect | §6.10 event-sourcing reconstruction |

---

## 8. Files to Modify

### Phase 1a — V1 (Path A: Built-in Agent → Outcomes Panel at `/outcomes`)

| File | Change | Day |
|---|---|---|
| `package.json` | `pnpm add echarts sonner` | 1 |
| `src/lib/db/migrations/<next>_artifact_source_cols.sql` | **New** migration — `ALTER TABLE artifact ADD COLUMN source_thread_id`, `source_outcome_id` (both nullable) + composite index. | 1 |
| `src/lib/db/schema.ts` | Add the two new columns to the `artifact` Drizzle table definition. | 1 |
| `src/store/outcome-store.ts` | **New** — Zustand store with polymorphic `Outcome` union (chart V1; html/image stubs), `addOutcome` (upsert), `removeOutcome`, `toggleCollapse`, `markSaved`, `clearForThreadSwitch`, `loadForThread`. | 1 |
| `src/app/api/threads/[id]/outcomes/route.ts` | **New** — `withSession` GET. Joins `entity_run_event` + `entity_run` filtered by `thread_id`, `event_type='tool_call_chunk'`, `payload->>'toolName'='render_chart'`. Dedups by `chartId`. Back-fills `savedArtifactId` from `artifact` table. | 1 |
| `src/components/layout/WorkspaceProvider.tsx` | Subscribe to `workspaceStore.runtimeThreadId` and call `outcomeStore.clearForThreadSwitch()` + `loadForThread()` on change. | 1 |
| `src/app/(workspace)/outcomes/page.tsx` | **New** — lazy import + mount `<OutcomesPanel />`. | 2 |
| `src/components/workspace/OutcomesPanel.tsx` | **New** — list / empty / skeleton states; subscribes to `outcomeStore`. | 2 |
| `src/components/workspace/OutcomeCard.tsx` | **New** — `<Collapsible>` + `<Card>`, header (chevron, title, description, Save, Trash), body dispatch by `kind`. | 2 |
| `src/components/workspace/EChartsRenderer.tsx` | **New** — `next/dynamic({ ssr: false })` wrapper, dark-mode theme via `next-themes`, lazy skeleton. | 2 |
| `src/components/workspace/ChartErrorBoundary.tsx` | **New** — per-card React error boundary; resets on `outcomeId` change. | 2 |
| `src/hooks/useAgentActions.tsx` | **Rename → `src/hooks/useOutcomeTools.tsx`**. Replace the no-op body with `useFrontendTool` (handler-only, captures `agentId`/`threadId`, enforces 64 KB cap, optionally `router.push("/outcomes")` on first outcome) + `useRenderTool` (render-only, `ChartPreviewCard`). | 3 |
| `src/components/right-panels/ChartPreviewCard.tsx` | **New** — three-state branching (`inProgress` skeleton, `executing` badge, `complete` title-as-link with `↗` icon → `router.push("/outcomes")` + `select`). | 3 |
| `src/components/layout/RightPanel.tsx` | Replace `useAgentActions()` call with `useOutcomeTools()`. | 3 |
| `src/hooks/useSaveOutcome.ts` | **New** — POST `/api/artifacts`, on success `markSaved` + `toast.success`; on failure `toast.error`. Guards against double-save. | 4 |
| `src/app/api/artifacts/route.ts` | **New** — `withSession` POST. Validates `createArtifactSchema`. Idempotency: if `(sourceThreadId, sourceOutcomeId)` already exists for this user, returns the existing row's id. | 4 |
| `src/lib/runner/dispatch/builtin.ts` | Append chart-guidance prompt block when agent has bound data source / sandbox; append "delegate, don't draw" prompt block when `spec.role === "supervisor"`. Inserted next to existing `dataSourcesRuntime.promptBlock`. | 4 |
| `src/store/workspace.ts` | **Delete** `activeArtifact` field, `openArtifact`, `closeArtifact`. Remove from the partialize allowlist (already excluded). | 5 |
| `src/app/(workspace)/page.tsx` | **Delete** the `activeArtifact ? <ArtifactRenderer/> : <Welcome/>` priority branch; revert to plain welcome page. | 5 |
| `docs/architecture.md` §5.4 | Replace the chart-dashboard paragraph with a one-paragraph description of the Outcomes panel + link to this doc. | 5 |

### Phase 1b — Active dashboard manipulation (post-V1)

| File | Change |
|---|---|
| `src/hooks/useOutcomeTools.tsx` | Add `get_dashboard_state` (handler-only) + matching `useRenderTool` returning `null`. Add explicit `remove_chart` tool (for symmetry with the V1 Trash button). |
| `src/store/outcome-store.ts` | Add `getSummary()` lightweight projection. |
| `src/components/layout/RightPanel.tsx` | Pass `outcome_summary` via `<CopilotKitProvider properties>`. |
| (Optional) `src/hooks/useSaveOutcome.ts` | Add "Save as new version" affordance when re-rendering already-saved outcomes. |

### Phase 2 — HTML / image producers + external-agent detection

| File | Change |
|---|---|
| `src/hooks/useOutcomeTools.tsx` (→ `useOutcomeTools.tsx`) | Add `render_html_artifact` + `render_image_artifact` frontend tools; same handler/render split. |
| `src/components/workspace/OutcomeCard.tsx` | Add `kind === "html"` (iframe sandbox) and `kind === "image"` (img) branches in `OutcomeBody`. |
| `src/lib/runner/persisting-agent.ts` | `tap()` → `mergeMap()`; buffer scan for chart JSON / `<html>` blocks; emit ActivitySnapshot. |
| `src/lib/runner/outcome-detector.ts` | **New** — `detectOutcomes(text)` (ECharts JSON, Plotly HTML, `![](image)`). |
| `src/components/layout/RightPanel.tsx` | Register `renderActivityMessages` for `activityType: "outcome"` → `outcomeStore.addOutcome`. |

### V2 — Artifact Library (`/artifact`)

| File | Change |
|---|---|
| `src/app/(workspace)/artifact/page.tsx` | Replace placeholder redirect with the library main panel. |
| `src/app/(workspace)/artifact/[id]/page.tsx` | **New** — single-artifact detail / edit view. |
| `src/components/sidebar-panels/ArtifactPanel.tsx` | **New** — category / tag tree in left sidebar. |
| `src/app/api/artifacts/route.ts` | Add GET (list), filtering by type / visibility / owner. |
| `src/app/api/artifacts/[id]/route.ts` | **New** — GET / PATCH / DELETE single artifact. |
| `docs/artifacts.md` | **New** — V2 design doc. |

---

## 9. Out of Scope (Future Work)

- **ArtifactPanel** (left sidebar) — listing saved artifacts in a
  permanent library view. V1 ships single-outcome persistence (Save
  button → `POST /api/artifacts` writes to `ArtifactTable`); the
  library-style UI to browse / search / re-open those artifacts is
  V2.
- **Save as new version** — re-saving an already-saved chart silently
  no-ops in V1 (`savedArtifactId` short-circuits the request). V2
  should let the user choose between "overwrite original" and "save
  as new version" semantics.
- **Stream-time chart rendering** — render chart as ECharts JSON streams
  in (A2UI fixed-schema-streaming pattern).
- **External agent chart support** — PersistingAgent detection (§3)
  as fallback for agents that produce ECharts JSON in text.
- **Dashboard persistence** — save/load named dashboards beyond
  event-sourcing reconstruction.
- **Chart export** — PNG/SVG/PDF download from rendered charts.
  ECharts ships `getDataURL()` / `renderToSVGString()` natively, so
  this is a small lift once we decide on UX placement.
- **Agent-assisted markers** — structured tags for content hints.
