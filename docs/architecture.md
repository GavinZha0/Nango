# Nango Architecture

> Status: v1 (initial)
> Scope: `nango` frontend AI workspace
> Audience: full-stack engineers, architects, agent platform developers

---

## 1. Project Positioning

Nango is an **AI agent workspace frontend** that unifies multi-backend agent integration, in-app agent construction, and AI artifact management into a single platform. Technically it is a Next.js App Router monolith (frontend + backend in one repo); server-side capabilities are exposed via API Routes / Server Components, and **all third-party secrets and agent traffic stay strictly on the server**.

### Runtime boundary (v1)

- **Single-instance runtime.** Nango is designed to run on one process / one node.
- **Single-node multi-tenant positioning.** The runtime targets personal and small-team use: one deployment can host multiple tenants.
- **Tenant model is evolving.** Multi-tenant capabilities are supported in principle and will be refined in follow-up iterations.
- **No automatic horizontal scaling.** Do not enable multi-replica auto-scaling for the app runtime.
- **Complex work is delegated outward.** Long-running and heavy tasks should be executed by backend agent platforms (agno / Mastra / Dify / others).
- **Built-in agents are a lightweight complement.** Built-in runtime is for local orchestration glue and lightweight capabilities, not distributed heavy execution.

Key system capabilities:

| Capability | Description | Key modules / References |
|---|---|---|
| **Multi-backend agent integration** | Connect heterogeneous agent platforms (agno / Mastra / Dify); browser sees a uniform **AG-UI protocol** | `src/lib/backends/` |
| **Built-in Agent + MCP** | Build agents in-app via the CopilotKit runtime; extend tools through the Model Context Protocol (MCP) | `src/lib/builtin-agents/agent-pool.ts`, `src/lib/mcp/provider-pool.ts` |
| **AI outcome / artifact pipeline** | Per-thread Outcomes panel (`/outcomes`) for transient chat outputs; permanent Artifact library via Save | `src/lib/artifacts/` |
| **Verification Subsystem** | Deterministic quality gate for testing MCP tools and workflows using assertions | `src/lib/verification/` ([docs/verification.md](file:///d:/AI/nango/docs/verification.md)) |
| **Evaluation Subsystem** | Stochastic quality assessment for agent conversations using LLM-as-Judge | `src/lib/evaluation/` ([docs/evaluation.md](file:///d:/AI/nango/docs/evaluation.md)) |

---

## 2. Tech Stack

| Layer | Technology |
|---|---|
| Framework | Next.js 16.2.4 (App Router + Turbopack) |
| Language | TypeScript 6 / React 19 |
| Auth | better-auth (email/password, admin plugin, session cookies) |
| Database | PostgreSQL 18 + Drizzle ORM 0.45 |
| State | Zustand (client) + SWR (data fetching) |
| UI | shadcn/ui, Tailwind CSS 4, Lucide, next-themes, react-resizable-panels |
| AI Runtime | `@copilotkit/runtime`, `@copilotkit/react-core`, `@ag-ui/client` |
| Tool protocols | `@modelcontextprotocol/sdk` (MCP), `@ai-sdk/mcp` |
| Validation | Zod 4 |
| Encryption | AES-256-GCM (credential storage) |
| Observability | pino (structured logs) + Langfuse (tracing) |

---

## 3. Overall Architecture

### 3.1 Layered View

```
┌─────────────────────────────────────────────────────────────────────┐
│                         Browser (React 19)                          │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────────┐   │
│  │ ThreePanel   │  │ Zustand      │  │ <CopilotKit/> v2          │   │
│  │ Layout       │  │ workspace +  │  │  - Frontend tools         │   │
│  │ (left/main/  │  │ sidebar      │  │    (render_chart, HITL …) │   │
│  │  right)      │  │              │  │  - AG-UI client           │   │
│  └──────────────┘  └──────────────┘  └──────────────────────────┘   │
└──────────────────────────────┬──────────────────────────────────────┘
                               │  HTTP (cookies + X-Credential-Id;
                               │         agentId in URL path)
┌──────────────────────────────▼──────────────────────────────────────┐
│                Next.js API Routes (server-only)                     │
│                                                                     │
│  /api/copilotkit/[...path]   ──►  Backend chat → Runner → AG-UI     │
│  /api/copilotkit/builtin/... ──►  Built-in chat → Runner → AG-UI    │
│  /api/{agents, mcp, skills}       Resource configs & lifecycles      │
│  /api/{verification, eval}        Test suites, cases & run loops     │
│  /api/{schedules, notifications}  Triggers & live user notifications │
│  /api/runs/stream                 SSE: notifications + finalized     │
│  /api/admin/{credentials, runs}   Admin credentials & forensics      │
│  /api/auth/[...all]               better-auth handler                │
│                                                                     │
│  ┌──────────────────┐  ┌──────────────────────────────────────────┐ │
│  │ Runner kernel    │  │ Process-wide caches (6)                  │ │
│  │ entity_run +     │  │  agentPool          (LRU + 10-min TTL)    │ │
│  │ entity_run_event │  │  mcpProviderPool    (refcounted + reaper) │ │
│  │ EventBus + SSE   │  │  skillPool          (LRU + 10-min TTL)    │ │
│  │ Scheduler        │  │  credential cache   (10-min TTL)          │ │
│  └──────────────────┘  │  EntityCatalog      (control plane, TTL)  │ │
│                        │  thread-state       (LRU, backend chat)   │ │
│                        └──────────────────────────────────────────┘ │
└──────────────────────────────┬──────────────────────────────────────┘
                               │
   ┌───────────┬───────────────┼───────────────┬──────────────┬──────────────┐
   ▼           ▼               ▼               ▼              ▼              ▼
┌────────┐ ┌─────────┐ ┌──────────────┐ ┌──────────────┐ ┌──────────┐ ┌──────────┐
│Postgres│ │ Backend │ │ MCP Servers  │ │ SSH Hosts    │ │External  │ │ LLM      │
│SQL     │ │ Agent   │ │ (stdio /     │ │ (Linux /     │ │ DBs      │ │ Providers│
│(Nango  │ │ Platform│ │  sse /       │ │  network     │ │ (Postgres│ │ (OpenAI /│
│ DB)    │ │ — agno /│ │  streamable) │ │  devices)    │ │ MySQL /  │ │ Anthropic│
└────────┘ │ Mastra /│ └──────────────┘ └──────────────┘ │ MariaDB /│ │ /…)      │
           │ Dify…)  │                                    │ Vertica) │ └──────────┘
           └─────────┘                                    └──────────┘
```

**See also**: a self-contained visual rendering of this architecture lives at `docs/diagrams/architecture-diagram.html` (open in any browser; supports PNG / PDF export). Other diagrams in `docs/diagrams/` cover the chat-dispatch downstream / upstream paths and the tool-execution lifecycle.

### 3.2 Architectural Principles

1. **Protocol unification**: The browser only ever sees an AG-UI event stream.
2. **Secret isolation**: All API keys are AES-256-GCM encrypted and never reach the browser.
3. **Parallel multi-source loading.** `WorkspaceProvider` loads three agent sources in parallel on mount (Backend Agents / Backend Teams / Built-in Agents). The first source with available agents auto-selects the default; the UI is never blocked by the slowest source.
4. **Adapter pattern.** Each backend platform plugs in by implementing `IBackendAdapter` (metadata) and `IBackendChatHandler` (chat). The registry uses `satisfies Record<BackendId, …>` so forgetting to register an adapter is a compile error.
5. **Cache with precise, reverse-indexed invalidation.** Six process-wide caches live in the Node process (e.g., credentials, agents, MCP connections). Writes invalidate only dependent entries. All caches are pinned to `globalThis` to survive dev-server HMR reloads.
6. **Run-as-first-class.** Every execution (chat, scheduled, workflow refresh) produces a unified `entity_run` row and an append-only timeline.
7. **Supervisor catalog inlined.** The supervisor agent sees available specialists directly in its system prompt—avoiding extra round-trips to list agents.
8. **Vendor lock-in mitigation.** Third-party SDKs (e.g., CopilotKit, AG-UI) are wrapped in centralized barrel files (`lib/copilot/`). Upgrades require editing a single file rather than touching scattered call sites.
9. **LLM is direct, not adapted.** Built-in agents interact directly with LLM providers without an intermediate adapter layer, as the LLM drives the reasoning process itself.

### 3.3 Four Integration Layers (Adapter Pattern)

Nango exposes four peer integration layers, each shielding the agent runtime from a different axis of upstream / runtime diversity. They share the same architectural pattern (adapter interface + per-implementation provider module + uniform interface to consumers) and live side-by-side at the same level of the dependency graph.

```
                                External World
  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐
  │ Remote agent │  │ External     │  │ SSH hosts    │  │ (no external —│
  │ platforms    │  │ data sources │  │ (Linux /     │  │  local        │
  │ agno /       │  │ MySQL /      │  │  network     │  │  sandbox is a │
  │ Mastra /     │  │ Postgres /   │  │  devices)    │  │  local OS/VM  │
  │ Dify / …     │  │ Vertica / …  │  │              │  │  capability)  │
  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘  └───────────────┘
         │                  │                  │
  ░░░░░░░│░░░░░░░░░░░░░░░░░░│░░░░░░░░░░░░░░░░░░│░  trust / network boundary  ░░░
         │                  │                  │
╔════════│══════════════════│══════════════════│═════ Nango Server ═══════════╗
║        ▼                  ▼                  ▼                              ║
║  ┌──────────────┐   ┌──────────────┐  ┌──────────────┐  ┌──────────────┐    ║
║  │ IBackend-     │   │ IDataSource- │  │ SSH client    │  │ ISandbox-     │    ║
║  │  Adapter      │   │  Adapter     │  │ (node-ssh +   │  │  Adapter      │    ║
║  │               │   │              │  │  host-key pin)│  │               │    ║
║  │ agno / Mastra │   │ MySQL /      │  │               │  │ LocalDocker / │    ║
║  │ / Dify / …    │   │ Postgres /   │  │ login-shell   │  │ Subprocess    │    ║
║  │               │   │ Vertica / …  │  │  wrap option  │  │ (remote — V2) │    ║
║  │ writes:       │   │ writes:      │  │ writes:       │  │ reads:        │    ║
║  │  AG-UI events │   │  Parquet     │  │  exec result  │  │  Parquet      │    ║
║  │               │   │  files       │  │               │  │  files        │    ║
║  │               │   │      ↓       │  │               │  │      ↑        │    ║
║  │               │   │ ┌────────────────────────────┐  │  │               │    ║
║  │               │   │ │ Parquet Cache (shared FS)  │  │  │               │    ║
║  │               │   │ │  /data/shared_cache/       │  │  │               │    ║
║  │               │   │ │ owned by data-source layer;│  │  │               │    ║
║  │               │   │ │ read-only mounted by sandbox│ │  │               │    ║
║  │               │   │ └────────────────────────────┘  │  │               │    ║
║  └──────┬───────┘   └──────┬───────┘  └──────┬───────┘  └──────┬───────┘    ║
║         │                  │                  │                  │           ║
║         └──────────────────┴──────────┬───────┴──────────────────┘           ║
║                                       ▼                                      ║
║                            Agent runtime / agent tools                       ║
╚══════════════════════════════════════════════════════════════════════════════╝
```

| | Agent Adapter Layer | Data Source Adapter Layer | SSH Layer | Sandbox Adapter Layer |
|---|---|---|---|---|
| **Status** | shipped | shipped | shipped | shipped (local); remote planned |
| **Code** | `src/lib/backends/` | `src/lib/data-sources/` | `src/lib/ssh/` | `src/lib/sandbox/` |
| **Interface** | `IBackendAdapter` | `IDataSourceAdapter` | direct `node-ssh` client + policy | `ISandboxAdapter` |
| **Hides** | Agent platform protocol diversity | Database protocol diversity | Per-host auth + login-shell quirks | OS isolation tech diversity |
| **External** | REST + SSE per platform | DB wire protocol per source | SSH protocol; strict host-key pin | Docker daemon (local); HTTP service (remote V2) |
| **Credentials** | `credential` table (encrypted) | `credential` table (encrypted) | `credential` table (`basic_auth` or `private_key`) | none |
| **Output** | AG-UI event stream | Parquet files in shared cache | stdout / stderr / exit code | Bounded code execution |

**Parquet cache as the data-source ↔ sandbox handshake.** The two layers do not call each other directly. The data-source layer writes Parquet to `/data/shared_cache/`; the sandbox layer mounts those files read-only into the jail. This keeps the layers independently swappable and means the trust boundary is a file-system region, not an RPC interface.

**Same pattern, four uses.** Each layer uses the same authoring shape: a typed adapter interface (or equivalent — SSH uses a more direct client wrapper since the protocol surface is already uniform), a per-implementation provider module aggregating its parts, a server-only registry that fails compilation if a registered key is missing an implementation. Adding a new agent platform / data source / isolation backend always follows the same four-step recipe.

For detailed design and implementation phases, see:

- `docs/data-sources.md` — `IDataSourceAdapter` contract, Parquet cache strategy, per-source adapter onboarding, multi-tenancy / sharing rules.
- `docs/ssh.md` — SSH client design, host-key pinning, login-shell wrap, command allow/deny policy, runtime tools (`run_ssh_command` / `list_ssh_hosts`).
- `docs/sandbox.md` — `ISandboxAdapter` contract, local providers (Subprocess / LocalDocker), virtual path mapping, output truncation / masking, agent-tool surface (`run_code_in_sandbox`).

---

## 4. Module Layout

### 4.1 Route Groups

| Group | Paths | Guards | Purpose |
|---|---|---|---|
| `(auth)` | `/sign-in`, `/sign-up` | none | accessible while signed out |
| `(workspace)` | `/`, `/admin/*`, `/profile`, `/agent[/[id]]`, `/mcp`, `/artifact`, `/dashboard`, `/outcomes`, `/skills[/[id]]`, `/schedule[/[id]]`, `/notifications` | `requireSession()` in layout; `admin/*` adds `requireAdmin()` | main workspace |
| API | `/api/*` | `getSession()` per-route | unified 401 handling |

### 4.2 Frontend Layout (Three-Pane)

`ThreePanelContent` uses `react-resizable-panels` for draggable, collapsible panels:

- **Left**: `SidePanel`, renders one of `DashboardPanel` / `ArtifactPanel` / `AgentPanel` / `McpPanel` / `SkillsPanel` / `SchedulesPanel` based on `useSidebarStore.activeLeftPanel`.
- **Center**: route-driven main area. `/outcomes` shows the current thread's transient Outcomes panel (V1); editor routes like `/agent/[id]` render their own pages; `/` is the welcome page.
- **Right**: `RightPanel` — hosts the CopilotKit provider plus `ChatPanel` / `HistoryPanel` / `BuiltinAgentEditor`.

The CopilotKit provider is mounted inside `RightPanel` (not the root layout) on purpose: switching agents remounts only the chat subtree, never the page chrome (header, toolbar, panel widths).

### 4.3 Backend API Route Matrix

| Route | Method | Function | Auth |
|---|---|---|---|
| `/api/copilotkit/[...path]` | GET/POST | Backend agent chat proxy (AG-UI), routed through Runner | session + header validation |
| `/api/copilotkit/builtin/[...path]` | GET/POST | Built-in Agent CopilotRuntime, routed through Runner | session |
| `/api/entities` | GET | Unified entity list across all enabled agent credentials | session |
| `/api/agent-credentials` | GET | Agent-type credentials visible to current user (no secret) | session |
| `/api/builtin-agents`, `/[id]` | CRUD | Built-in agent + tool bindings (incl. `role` enum) | session |
| `/api/mcp-servers`, `/[id]/discover`, `/[id]/call-tool` | CRUD/RPC | MCP server registration, tool discovery, invocation | session |
| `/api/skills`, `/api/skills/[id]`, `/api/skills/[id]/files/[...]` | CRUD | Skills CRUD + helper-file read | session |
| `/api/notifications`, `/api/notifications/[id]` | GET/POST/PATCH/DELETE | Inbox list / mark-all-read / mark-read / delete | session |
| `/api/runs/stream` | GET (SSE) | Live notification + `run_finalized` stream keyed by ownerId. Notification frames carry `id: <uuidv7>`; on EventSource auto-reconnect we replay missed `notification` rows via `Last-Event-ID` (header or `?lastEventId=`), capped at 200 rows per resume. | session |
| `/api/threads`, `/api/threads/[id]`, `/api/threads/[id]/messages` | GET / DELETE / GET | Unified chat history surface. Lists threads (filtered by optional `?entityId=`), reconstructs AG-UI `Message[]` from `entity_run.input_task` + post-coalesce `entity_run_event` rows, deletes a thread + its delegation sub-tree via recursive CTE. owner-scoped end to end (`owner_id = session.user.id`); sub-runs excluded by `parent_run_id IS NULL`. Replaces the previous reverse-proxy of upstream agent platform `/sessions` APIs. | session |
| `/api/schedules`, `/api/schedules/[id]`, `/api/schedules/[id]/trigger` | CRUD/RPC | Schedule CRUD + manual trigger | session |
| `/api/admin/credentials` | CRUD | Credential management | requireAdmin |
| `/api/admin/threads`, `/api/admin/threads/[id]` | GET | Thread forensics list + detail (runs + per-run metrics) | requireAdmin |
| `/api/admin/runs/[id]` | GET | Single-run events (children + last 1000 events) — fetched lazily by the thread detail right column | requireAdmin |
| `/api/auth/[...all]` | better-auth | Sign-in / sign-up etc. | — |

### 4.4 Core Library (`src/lib/`)

| Module | Responsibility |
|---|---|
| `backends/types.ts` | Domain models (`EntityDescriptor` / `SessionDescriptor`), interfaces (`IBackendAdapter` / `IBackendChatHandler`), `BackendCapabilities` flags |
| `backends/facade.ts` | Façade: fan-out across credentials, capability checks, error aggregation |
| `backends/registry.ts` | Client-safe `IBackendAdapter` map (`ADAPTERS`) |
| `backends/registry.server.ts` | Server-only `BackendModule` map (`PROVIDERS`) — single source of truth for chat handler + entity fetcher + adapter per platform |
| `backends/entity-catalog.ts` | Entity discovery + caching (`EntityCatalog.list / .invalidate`); reads `PROVIDERS` to dispatch fetch. Used by the agent picker (warm) and once-per-dispatch on the chat route to look up `kind` server-side. |
| `backends/<slug>/index.server.ts` | Per-platform `BackendModule` aggregator (one per provider) |
| `backends/bridge-runtime-kit.server.ts` | Shared bridge spine: `createBridgeRunObservable`, `attachBridgeConfig`, `readSseLines`, `resolveBridgeCredential`, `ToolCallFilter`, `TextStreamState`, `lastUserText` (`user_id` is server-injected upstream by `lib/runner/inject-user-id.ts`) |
| `backends/runtime.server.ts` | Single AG-UI runtime entry point (`runWithAgents`) — plugs an `Record<string, AbstractAgent>` map into `CopilotRuntime` and returns the AG-UI SSE response. Used by BOTH backend and built-in chat dispatch — this is the "execution convergence point" for the two routes. Also hosts `trimHistoricalMessages` (only enabled when `trimMessages: true`, i.e. backend dispatches) |
| `auth/auth-instance.ts` | better-auth instance, `getSession` / `requireAdmin` / `requireSession` |
| `db/schema.ts` | All Drizzle table definitions (auth + Nango domain) |
| `credentials/crypto.ts` | AES-256-GCM `encrypt`/`decrypt`; keyring from `CREDENTIAL_ENCRYPTION_KEYRING` (+ `CREDENTIAL_ENCRYPTION_ACTIVE_KEY_ID`); ciphertext format `v1:<keyId>:<iv>:<tag>:<ct>` |
| `credentials/lookup.ts` | Decrypt + lookup with in-memory cache and explicit invalidation |
| `access/agent-visibility.ts` | Server-side visibility checks: `isAgentVisibleTo` (point lookup) and `listVisibleAgentIds` (enumeration). Replaces implicit cache-based authorization. |
| `builtin-agents/agent-pool.ts` + `builtin-agents/index.ts` | Process-wide LRU cache (max 500, 10-min TTL) of decrypted `AgentSpec` keyed by agentId. Singleton in `builtin-agents/index.ts`. |
| `builtin-agents/agent-spec.ts` | Polymorphic `AgentToolRef` (mcp_server / mcp_tool / skill / builtin_tool) decoded from `builtin_agent_tool` rows. |
| `mcp/provider-pool.ts` + `mcp/index.ts` | Process-wide MCP provider pool: one transport per server, refcounted, with idle reaper and detach-on-evict. Singleton in `mcp/index.ts`. |
| `credentials/invalidation.ts` | Cross-cutting helpers: `invalidateForCredentialChange` and `invalidateForMcpServerChange`. Call from any write path. |
| `mcp/client-providers.ts` | `createGracefulMcpProvider` — degrade MCP failures without aborting agent runs |
| `runner/runner.ts` | Execution kernel: `runChatRequest` (backend) / `runBuiltinChatRequest` (built-in) / `start` (programmatic, sync + async). Every dispatch produces an `entity_run` row. Sync runs timeout after `runner.sync_timeout` (default 300s); async runs timeout after `runner.async_timeout` (default 1800s / 30 min). Both are configurable in the admin config table. |
| `runner/persisting-agent.ts` | AG-UI event tee — wraps every dispatched agent so the event stream both reaches the browser and persists into `entity_run_event`. Storage is **coalesced**: TEXT_MESSAGE_CONTENT / REASONING_MESSAGE_CONTENT deltas are buffered in memory and flushed to a single `message` / `reasoning` row at each natural boundary (tool call, message-id change, stream end). The browser still sees real-time deltas on the wire. |
| `runner/event-bus.ts` | In-process pub/sub keyed by `ownerId`, surfaced via `/api/runs/stream` SSE; `globalThis` slot for HMR safety. |
| `runner/notifications.ts` | `recordRunNotification` (NUL-strip + 280-char preview + 16 KB body cap); used by async + scheduled fires + recovery. |
| `runner/recovery.ts` | `recoverStrandedRuns(currentBootStartedAt)` — boot-time sweep flipping `running` rows from a prior process (`started_at < currentBootStartedAt`) to `failed` and emitting recovery notifications. Wired in `instrumentation.ts` AFTER `recordProcessBoot()`. |
| `runner/process-boot.ts` | `recordProcessBoot()` — inserts one `process_boot` row per Node process start; caches `(id, startedAt)` in a `globalThis` slot so HMR / instrumentation re-evaluation does not duplicate. Provides the boot epoch consumed by `recoverStrandedRuns`. |
| `runner/scheduler.ts` | In-process `setTimeout`-based scheduler over `schedule` rows: `(startAt, [intervalValue, intervalUnit], [endAt])`. One-shot rows auto-disable after firing; recurring rows auto-disable past `endAt`. Calendar arithmetic uses the row's IANA timezone for DST safety. |
| `runner/supervisor-tools.server.ts` | `delegate_to_agent` (sync) + `delegate_async` (async) + `create_schedule` / `list_schedules` / `update_schedule` / `delete_schedule`. Injected on agents with `role === 'supervisor'` only. The supervisor's catalog of routable specialists is rendered via `formatCatalogBlock` and inlined into the system prompt — no `list_agents` round-trip. |
| `runner/schedule-mutate.ts` | `applyScheduleUpdate` — single source of truth for schedule partial updates (merge → validate → persist → in-process timer re-arm). Shared by the REST PATCH route and the supervisor `update_schedule` tool; the latter sets `requireFutureStartAt` so the LLM can't backfill. |
| `orchestration/modes.ts` | Mode registry: `auto | tool-call | handoff | async`. Each mode contributes a `promptDirective` merged into the supervisor prompt at dispatch time. |
| `orchestration/display-name.ts` | Stable `${sourceLabel} / ${name}` rendering shared between server (catalog block) and client (panels, editors). |
| `observability/logger.ts` | pino structured logging with automatic secret redaction |
| `domain/artifact.ts` | Artifact type enum: `code` / `chart` / `dashboard` / `image` / `html` / `ppt` / `report` |

### 4.5 Client State (Zustand)

| Store | Key fields |
|---|---|
| `workspace.ts` | agent list cache (agents/teams/builtinAgents), `activeAgentId`/`activeAgentSource`/`activeCredentialId`/`activeProvider`, `threadId` (CopilotKit v2), `pinnedSessions` (persisted), `orchestrationMode` |
| `outcome-store.ts` | Thread-scoped polymorphic Outcome list (chart V1; html/image Phase 2), `addOutcome` upsert, `markSaved`, `toggleCollapse`, `loadForThread` (replay from `entity_run_event`) |
| `sidebar.ts` | left-panel switcher, right-panel open flag |
| `notifications.ts` | inbox items, `isStreamConnected` flag (SSE), updated by `useStartNotifications` + BroadcastChannel for cross-tab sync |
| `schedules.ts` | schedule list cache + `scheduleActions` (refresh / create / patch / remove / triggerNow) |

Only `pinnedSessions` is persisted to `localStorage` via the `persist` middleware; everything else is transient.

> Per-run timing (TTFT, duration, inter-event gaps) is **not** kept in
> client state. The authoritative timeline lives on
> `entity_run` + `entity_run_event` (server-side timestamps) and is
> surfaced through `/admin/thread/[id]` (`ThreadDetailView`).

---

## 5. Key Flows

### 5.1 Backend Agent Chat (Unified to AG-UI)

```
Browser                       /api/copilotkit                Backend Agent Platform
   │                                 │                              │
   │  POST /agent/{agentId}/run      │                              │
   │  cookies: session                │                              │
   │  X-Credential-Id: <uuid>         │                              │
   │ ─────────────────────────────────►                              │
   │                                  │ getSession() → 401?          │
   │                                  │ getCredentialConfigById()    │
   │                                  │   ↳ 10min cache hit?         │
   │                                  │   ↳ AES-256-GCM decrypt      │
   │                                  │ getChatHandler(provider)     │
   │                                  │                              │
   │                                  │  AG-UI native (agno/mastra)  │
   │                                  │  → passthroughAgUiChat       │
   │                                  │  → HttpAgent(aguiUrl)        │
   │                                  │ ───────────────────────────► │
   │                                  │                              │
   │                                  │  Bridge (dify)               │
   │                                  │  → custom AbstractAgent      │
   │                                  │  → parse upstream SSE        │
   │                                  │  → emit AG-UI events         │
   │                                  │                              │
   │  ◄──────────────────  AG-UI SSE  ◄────────────────────────────  │
   │  (TEXT_MESSAGE_CHUNK,            │                              │
   │   TOOL_CALL_*, RUN_FINISHED, …)  │                              │
```

**Header contract**:
- `X-Credential-Id` selects the backend connection (one credential = one connection config). It is the only client-supplied identity field on the chat route; everything else is server-derived. See `docs/orchestrator.md` "Custom HTTP Headers".
- `agentId` is parsed from the URL path (`/agent/<id>/run|connect|stop`) by `route.ts`.
- `agentKind` is looked up server-side from `EntityCatalog.list(credentialId)`.
- The server reads `aguiUrl` (template containing `{agentId}`) and the bearer token from the credential cache. The browser never sees either.

### 5.2 Built-in Agent Chat

```
Browser → /api/copilotkit/builtin/[...path]
            │
            ├─ getSession() → userId
            │
            ├─ classifyBuiltinPath(url)
            │     └─ { agentId, action: "run" | "connect" }   ├─ single-agent path
            │     └─ null  ("/info", "/threads/*", …)        └─ listing path
            │
            ├─ Authorize
            │     single-agent: isAgentVisibleTo(agentId, userId) || 404
            │     listing:      agentIds = listVisibleAgentIds(userId)  (503 if empty)
            │
            ├─ For each agentId:
            │     spec = agentPool.get(agentId)            # usually a hit
            │     for tool in spec.tools where kind="mcp_server":
            │        provider = mcpProviderPool.borrow(serverId)  # usually a hit
            │        ledger.push({ serverId, provider })
            │     agents[id] = new BuiltInAgent(spec, providers)
            │
            ├─ runtime = new CopilotRuntime({ agents })
            ├─ handleRequest = createCopilotRuntimeHandler({ runtime, basePath })
            ├─ dispatch(req)
            └─ finally: release every borrow
```

**Design notes**:
- The `CopilotRuntime` is built per request; the cost amortizes through the AgentSpec pool (decryption + DB query) and the MCP provider pool (network connection).
- Authorization is explicit, not a side effect of cache contents. The single-agent path uses an indexed point lookup; the listing path enumerates.
- MCP connections are injected via `mcpClients` (pool-managed lifecycle); `BuiltInAgent` does not own them.
- Cache invalidation is precise: see `docs/builtin-runtime.md`.

Full pool semantics (refcounting, reaper, detach-on-evict, dedupe of concurrent borrows) are documented in `docs/builtin-runtime.md`.

### 5.3 MCP Server Discovery & Invocation

```
Registration: user enters url + auth credential in McpPanel
   ↓
/api/mcp-servers/[id]/discover
   ├─ decrypt credential → inject Authorization header
   ├─ MCP client connects (SSE / HTTP transport)
   ├─ list_tools → diff against stored snapshot
   └─ persist mcp_server.tools

Runtime (inside Built-in Agent):
   spec = agentPool.get(agentId)        # AgentToolRef[] already decoded
   for tool in spec.tools where kind="mcp_server":
      provider = mcpProviderPool.borrow(serverId)   # shared, refcounted
   inject providers into BuiltInAgent.mcpClients
   release every provider in the route's `finally`
```

### 5.4 Outcomes Panel & Artifact Library

Transient Outcomes Panel (/outcomes) for per-thread charts; Permanent Artifact Library (/artifact) for saved outcomes.

### 5.5 Credential Lifecycle

```
Admin creates credential at /admin/credentials
   ↓
plaintext payload → encrypt() → "v1:<keyId>:<iv>:<authTag>:<ciphertext>"
   ↓
persist to credential table (with metadata.keyPreview for list views;
                              avoids decryption when listing)
   ↓
every write calls invalidateCredentialCache() +
                  invalidateForCredentialChange(id)   // pool-aware
                                                       // → agentPool.invalidateByCredential
                                                       // → mcpProviderPool.evict (per dependent server)
   ↓
Lookup paths (server-side only):
   getCredentialConfigById(id)        // primary: token + restUrl + aguiUrl + provider
   getCredentialTokenById(id)         // token only
   getCredentialFieldsById(id)        // multi-field credentials (keypair, …)
   getEnabledObservabilityCredential() // Langfuse-specific helper
```

---

## 6. Data Model

### 6.1 Table Groups

| Domain | Tables | Notes |
|---|---|---|
| Auth (managed by better-auth) | `user`, `session`, `account`, `verification` | First registered user is automatically promoted to `admin` |
| Credentials | `credential` | All secrets encrypted; `serviceType` ∈ `llm/search/agent/observability/integration/datasource/other` |
| Built-in Agents | `builtin_agent`, `builtin_agent_tool` | Agent definition + tool bindings (discriminated union) |
| Tool sources | `mcp_server`, `skill`, `skill_file` | MCP server / DB-resident Skill (helper bytes in `skill_file.content::bytea`) |
| Data analysis | `data_source`, `artifact`, `menu_item` | DataSource = agent-facing connection + access policy (referencing a `credential` for auth); Artifact = first-class resource for charts / dashboards |
| Verification | `verification_suite`, `verification_case`, `verification_run`, `verification_case_result` | Deterministic assert-on-output testing for tools and workflows (see [docs/verification.md](file:///d:/AI/nango/docs/verification.md)) |
| Evaluation | `eval_suite`, `eval_case`, `eval_run`, `eval_case_result` | Stochastic quality evaluations using LLM-as-Judge (see [docs/evaluation.md](file:///d:/AI/nango/docs/evaluation.md)) |

### 6.2 Built-in Agent → Tool Binding (Polymorphic FK)

`builtin_agent_tool.tool_type` discriminates which FK column is meaningful:

| toolType | Active FK | Meaning |
|---|---|---|
| `mcp_server` | `mcp_server_id` | whole server, all enabled tools |
| `mcp_tool` | `mcp_server_id` + `mcp_tool_name` | single MCP tool |
| `skill` | `skill_id` | DB-resident skill |
| `builtin_tool` | `builtin_tool` (text) | named built-in tool e.g. `web_search` |
| `datasource` | `data_source_id` | data source the agent is allowed to query via `extract_dataset_by_sql` |

Tool table deletes use `SET NULL` (so orphaned bindings can be surfaced to the user); deleting the parent agent uses `CASCADE`.

> Plain REST APIs are not a first-class binding kind. To expose a REST endpoint to a built-in agent, wrap it as an MCP server (e.g. via [MCPHub](https://github.com/samanhappy/mcphub) or a similar OpenAPI→MCP bridge) and bind that MCP server through `mcp_server` / `mcp_tool`.

### 6.3 Artifact Model

`artifact` is a first-class resource for AI outputs, related to:
- `menuItemId` → `menu_item` — placement in the dynamic menu tree
- `visibility` — `private` | `shared`
- `content` is JSONB (ECharts option / HTML string / image URL / …)

---

## 7. Time & Timezone
- **UTC Everywhere**: All DB 	imestamp columns and server-side computations use absolute UTC.
- **Display**: Timezone is purely a edge/presentation concern, resolved via useDisplayTimezone() + ormatTimestamp(iso, tz, style).
- **User Profile**: 	imezone field in user table is the source of truth, optionally synced to browser via 	imezone_follow_browser.
- **Schedules**: schedule.timezone captures a snapshot of the user's timezone at creation time, used for DST-safe interval arithmetic.

## 8. Security

| Risk | Control |
|---|---|
| Secret leakage | AES-256-GCM at rest with a versioned keyring (`v1:<keyId>:…`); supports zero-downtime rotation (see `docs/key-rotation.md`). `CREDENTIAL_ENCRYPTION_KEYRING` and `BETTER_AUTH_SECRET` are deliberately separate. |
| Secret in client bundle | All decryption modules start with `import "server-only"` (compile-time enforced) |
| Session hijacking | better-auth session cookies + CSRF + secure cookies (forced HTTPS in production) |
| Privilege escalation | `(workspace)` layout calls `requireSession()`; `admin/*` layout adds `requireAdmin()`; API routes also call `getSession()` |
| Injection | Incoming IDs (`X-Credential-Id`, `agentId`) are matched against strict regex patterns; `entityKind` is server-derived from EntityCatalog so cannot be tampered |
| Log leakage | pino redacts `headers.authorization` / `headers.cookie` / `headers['x-credential-id']` etc. automatically |
| MCP failures | `GracefulMcpProvider` wraps tool calls: 5s timeout, errors degrade to readable text — never abort the LLM run |

---

## 9. Observability

Two independent phases:

1. **Structured logs (pino)** — covers credential lookup, proxy dispatch, Built-in runtime, etc. Tunable via `NANGO_LOG_ENABLED` / `LEVEL` / `PRETTY`. Sensitive fields are redacted automatically.
2. **Langfuse tracing** — only traces what backends cannot see: Built-in agent runtime, frontend tool calls, proxy errors. Backends that already trace to Langfuse (agno / Mastra / Dify) are not re-traced. Master switch is the `enabled` flag on the `observability` credential — no restart required.

See `docs/observability.md` for details.

---

## 10. Extensibility
- **New Agent Backend**: See docs/backend-integration.md. Create adapter/chat handlers under src/lib/backends/<slug>/ and register in 
egistry.ts.
- **New MCP Server**: Handled fully via UI at /mcp (saves to mcp_server table).
- **New Frontend Tool**: Define schema in src/hooks/useOutcomeTools.tsx, add render logic in OutcomesPanel.tsx.
