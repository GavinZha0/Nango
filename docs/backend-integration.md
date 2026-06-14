# Backend Integration — Layered Architecture & Control / Data Plane Separation

> Status: stable (v1)
> Audience: full-stack engineers, agent platform integrators
> Companion docs:
>   - `docs/architecture.md` — overall workspace architecture
>   - `docs/orchestrator.md` — Runner kernel, supervisor, async, schedules

This document is the architectural reference for Nango's multi-backend
agent platform integration. It describes the layered design,
control-plane / data-plane separation, the `BackendModule` registration
pattern, and the end-to-end dispatch path. §10 (*Adding a New
Platform*) is the four-step onboarding mechanics; the rest of this
doc explains *why* the abstractions are shaped the way they are.

Runtime boundary (v1): Nango is operated as a **single-instance**
frontend workspace runtime (no multi-replica auto-scaling for this app
process). Heavy and distributed execution is delegated to backend agent
platforms; the built-in runtime is a lightweight orchestration
complement. Positioning is **single-node multi-tenant** for personal
and small-team usage; tenant isolation and lifecycle capabilities will
continue to evolve.

---

## 1. Goals & Non-Goals

### Goals

- **One protocol facing the browser.** Regardless of which agent
  platform the user is talking to (agno / Mastra / Dify today; CrewAI
  / DeepAgents / AgentScope / FastGPT / AnythingLLM / Coze tomorrow),
  the browser only ever sees an **AG-UI event stream**.
- **Localised platform additions.** Adding a new platform should
  touch one folder + two lines on registries; the chat dispatch code,
  the API routes, the runner kernel, the cache layer, and every UI
  surface stay untouched.
- **Server-side secret isolation.** All upstream credentials (bearer
  tokens, API keys) stay on the server; AES-256-GCM encrypted at
  rest, decrypted only inside `import "server-only"` modules.
- **Zero round-trip on the chat hot path.** Once the browser has the
  active `EntityDescriptor`, dispatching a chat run does not require
  the server to look anything up except the credential token.
- **Cancellation propagates end-to-end.** Closing the chat tab
  must stop the upstream LLM consumption within one network round-trip.

### Non-goals (for v1)

- WebSocket-native upstreams. The bridge kit is built for REST + SSE;
  WebSocket support would be additive and is not yet exercised.
- Per-platform observability dashboards. Backends that already trace
  to their own Langfuse projects are not re-traced (see
  `docs/observability.md`).
- Cross-tenant agent sharing. Built-in agents have a `visibility`
  field; backend agents inherit visibility from their owning
  credential and currently do not surface a per-agent ACL.

---

## 2. Layered View

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                                  Browser (UI Layer)                             │
│                                                                                 │
│   WorkspaceProvider — loads agent list once, manages workspace store           │
│   RightPanel        — owns <CopilotKitProvider> (keyed by agent+source+cred);   │
│                       holds activeAgentId / activeAgentType (kind) /            │
│                       activeCredentialId / activeMode                           │
│                       @see docs/copilotkit-provider-lifecycle.md                │
│   Workspace store   — Zustand: agents/teams/workflows/builtinAgents             │
└──────┬──────────────────────────────────────────────────────────┬───────────────┘
       │                                                          │
       │  Control Plane                                       Data Plane
       │  (catalog, sessions, capabilities,                   (chat dispatch:
       │   admin actions)                                      AG-UI streams)
       │                                                          │
       │  GET /api/entities                            X-Credential-Id  (backend)
       │  GET/POST/DEL /api/backend/[...path]          X-Orchestration-Mode (builtin)
       │    (reverse proxy for client adapter)         agentId is in the URL path
       │  (other control surfaces — /api/skills,                  │
       │   /api/schedules, /api/builtin-agents,                   │
       │   /api/mcp-servers, /api/admin/* …)                      │
       ▼                                                          ▼
┌─────────────────────────────┐         ┌─────────────────────────────────────────┐
│   /api/entities/route.ts    │         │  /api/copilotkit/[...path]/route.ts     │
│   (withSession)             │         │  /api/copilotkit/builtin/[...path]      │
│         │                   │         │  (withSession)                          │
│         ▼                   │         │         │                               │
│   EntityCatalog.list /      │         │         │ parse agentId from URL path   │
│   .invalidate               │         │         │ validate X-Credential-Id      │
│   (entity-catalog.ts)       │         │         │ getAgentCredentialConfigById  │
│         │                   │         │         │ EntityCatalog.list → kind     │
│         │ control plane     │         │         ▼                               │
│         │  is the only      │         │  runner.runChatRequest /                │
│         │  caller of        │         │  runBuiltinChatRequest                  │
│         │  fetchEntities    │         │                                         │
└─────────┼───────────────────┘         └──────────────────┬──────────────────────┘
          │                                                │
          │                                                ▼
          │                             ┌──────────────────────────────────────┐
          │                             │   Runner Kernel  (lib/runner/)       │
          │                             │   ─────────────────────────────────  │
          │                             │   • runChatRequest(req, input)       │
          │                             │       - input.entityKind required    │
          │                             │         (no entity-catalog probe)    │
          │                             │       - recordRunStart → entity_run       │
          │                             │       - getChatHandler(provider)     │
          │                             │           .buildAgent(ctx)           │
          │                             │       - PersistingAgent wrap         │
          │                             │           · tap → entity_run_event   │
          │                             │           · finalize observes abort, │
          │                             │             writes 'cancelled'       │
          │                             │           · wraps BridgeAgent or     │
          │                             │             HttpAgent passthrough    │
          │                             │       - runWithAgents → CopilotRuntime│
          │                             │   • runBuiltinChatRequest            │
          │                             │       - dispatch/builtin             │
          │                             │       - buildBuiltinAgents           │
          │                             │   • start({mode:'sync'|'async'})     │
          │                             │       - dispatch/backend             │
          │                             │       - called by supervisor-tools / │
          │                             │         scheduler                    │
          │                             └────────────┬─────────────────────────┘
          │                                          │
          ▼                                          ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│             registry.server.ts  (server-only)                       │
│                                                                              │
│   BACKENDS satisfies Record<BackendId, BackendModule>                     │
│      agno | mastra | dify                                                    │
│                                                                              │
│   BackendModule {                                                           │
│     id, capabilities,                                                        │
│     controlPlane: {                                                          │
│       adapter,        // IBackendAdapter (re-exported from registry.ts)      │
│       fetchEntities,  // EntityFetcher consumed by EntityCatalog             │
│     },                                                                       │
│     dataPlane: {                                                             │
│       chatHandler,    // IBackendChatHandler with .buildAgent(ctx)           │
│     },                                                                       │
│   }                                                                          │
│                                                                              │
│   exports: getProvider, getChatHandler                                       │
│                                                                              │
│   registry.ts (client-safe) — ADAPTERS only, for /api/backend client proxy   │
└────────────────────────────────────────┬─────────────────────────────────────┘
                                         │
                                         ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│   src/lib/backends/<slug>/                                              │
│                                                                              │
│   Each provider folder ships exactly four files:                             │
│      adapter.ts          — client metadata (browser → /api/backend proxy)    │
│      entity.server.ts    — server-only EntityFetcher                         │
│      chat.server.ts      — IBackendChatHandler with `buildAgent(ctx)`        │
│      index.server.ts     — exports the aggregated BackendModule             │
│                                                                              │
│   buildAgent(ctx) flow (every provider):                                     │
│      1. buildPassthroughAgentIfConfigured(ctx)                               │
│           → if credential.aguiUrl set, return HttpAgent(url, token)          │
│                  url = aguiUrl.replace("{agentId}", encoded)                 │
│           → else null, fall through                                          │
│      2. resolveBridgeCredential(...)                                         │
│      3. return new <Provider>BridgeAgent(cfg)                                │
└────────────────────────────────────────┬─────────────────────────────────────┘
                                         │
                                         ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│   bridge-runtime-kit.server.ts                                               │
│                                                                              │
│   Lifecycle helpers (every BridgeAgent uses them):                           │
│     createBridgeRunObservable  — RxJS Observable shell (RUN_STARTED /        │
│                                  RUN_FINISHED / abort / error sentinels)    │
│     attachBridgeConfig         — preserve subclass cfg through clone()       │
│     resolveBridgeCredential    — credential → {baseUrl, apiKey} or 4xx/5xx   │
│     buildPassthroughAgentIfConfigured                                        │
│                                — credential.aguiUrl → HttpAgent              │
│     readSseLines               — simple `data:` line iterator                │
│     readShortErrorBody         — diagnostic body capture                     │
│     assertValidSseResponse     — fail-fast on non-200                        │
│                                                                              │
│   Translation helpers (shared across providers):                             │
│     ToolCallFilter             — declared-tool gate + dedupe by id           │
│     TextStreamState            — START/CONTENT/END pairing                   │
│     lastUserText               — pull most recent user message               │
│                                                                              │
│   user_id is read directly from forwardedProps; the runner layer             │
│   (lib/runner/inject-user-id.ts) injects the server-trusted value before     │
│   bridges see it, so no helper-level validation is needed.                   │
│                                                                              │
│   agno-only (in providers/agno/chat.server.ts):                              │
│     readSseMessages            — full WHATWG SSE (event: + data: pairing)    │
└──────────────────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────────────────┐
│                                Persistence                                   │
│                                                                              │
│   entity_run                — one row per dispatch (chat / delegate /        │
│                                async / scheduled)                            │
│   entity_run_event          — append-only event timeline                     │
│   schedule.entity_kind      — kind snapshotted at create time so the         │
│                                scheduler fires without an entity-catalog     │
│                                round-trip                                    │
│   notification              — bell + /notifications inbox                    │
│                                                                              │
│   credential.aguiUrl        — opt-in AG-UI passthrough                       │
│   credential.restUrl        — bridge mode (default)                          │
└──────────────────────────────────────────────────────────────────────────────┘
```

---

## 3. Control Plane vs Data Plane Separation

The single most important architectural decision is the **physical
separation of the two planes onto different routes** with different
caching, different validation, and different latency budgets.

### Control plane — discovery, capabilities, lifecycle

| Surface | Route | Reads | Writes |
|---|---|---|---|
| Entity discovery | `GET /api/entities` | `EntityCatalog` (whole-table cache, 10-min TTL) | invalidates on credential / schedule change |
| Backend REST proxy | `/api/backend/[...path]` | per-credential | session listing, deletion, health |
| Schedules | `/api/schedules` | `schedule` table | full CRUD; persists `entity_kind` + `credential_id` |
| Built-in agents | `/api/builtin-agents` | `agentPool` (LRU + 10-min TTL) | invalidates on agent CRUD |
| MCP servers | `/api/mcp-servers` | `mcpProviderPool` | invalidates on MCP CRUD |

**Caching strategy.** Each control-plane resource has a process-wide
cache with TTL + reverse-indexed invalidation. The cache assumptions
are documented in `docs/builtin-runtime.md` for the pools and inline
in `entity-catalog.ts` for the entity table.

**The control plane is the only consumer of `EntityFetcher`.** When
`EntityCatalog.list(credentialId)` misses, it hits the upstream
platform once to fetch the full agent / team / workflow table for that
credential and stores it. Subsequent reads (any consumer) are pure
in-memory finds.

### Data plane — chat dispatch

| Surface | Route | Path on hot dispatch |
|---|---|---|
| Backend chat | `/api/copilotkit/[...path]` | session check → header validation → credential lookup (cache hit) → `runner.runChatRequest` → `getChatHandler(provider).buildAgent(ctx)` → CopilotRuntime → AG-UI SSE |
| Built-in chat | `/api/copilotkit/builtin/[...path]` | session check → visibility check → `agentPool.get` (cache hit) → `mcpProviderPool.borrow` × N (cache hit) → `BuiltInAgent` → CopilotRuntime → AG-UI SSE |

**The data plane uses `EntityCatalog` solely as a server-trusted
lookup for `kind`.** Three callers source the entity `kind`, each
through its own server-owned channel:

| Caller | Source of `kind` |
|---|---|
| Browser (chat route) | `EntityCatalog.list(credentialId)` lookup in the route handler, keyed by `(credentialId, agentId)` — no client trust |
| Supervisor tools | Precomputed catalog entry attached to each `delegate_to_agent` target (also from EntityCatalog at supervisor build time) |
| Scheduler | `schedule.entity_kind` column, snapshotted at create time from EntityCatalog |

The browser does **not** carry `kind` on the chat route — there is no
`X-Agent-Kind` header. A client cannot supply or override the field.

### Why server-derive kind
EntityCatalog cache cold-miss cost is acceptable because it warms on UI mount, and prevents malicious clients from routing to non-existent upstream endpoints.

## 4. Provider Module Pattern

### The `BackendModule` interface

```ts
| Field | Type | Description |
|---|---|---|
| `id` | `BackendId` | The unique slug for the backend. |
| `capabilities` | `BackendCapabilities` | Feature flags for UI. |
| `controlPlane.adapter` | `IBackendAdapter` | Client-safe REST helpers proxied via /api/backend. |
| `controlPlane.fetchEntities` | `EntityFetcher` | Server-only entity discovery for EntityCatalog. |
| `dataPlane.chatHandler` | `IBackendChatHandler` | Chat handler that bridges upstream to AG-UI. |
```

Each backend platform exposes itself through one `BackendModule`
aggregating capabilities, control-plane (REST adapter + entity
fetcher), and data-plane (chat handler). The runtime never imports
per-file modules — it only sees the registry.

### Two registries, one source of truth

Two registries wire the modules in. They look almost identical but
serve different bundles:

| Registry | Visibility | Contents | Consumers |
|---|---|---|---|
| `registry.ts` | Client-safe | `ADAPTERS: Record<BackendId, IBackendAdapter>` | Browser components reading capability flags + the `/api/backend` reverse proxy |
| `registry.server.ts` | Server-only (`import "server-only"`) | `BACKENDS: Record<BackendId, BackendModule>` | Runner, EntityCatalog, supervisor tools, schedule trigger |

Both maps use `as const satisfies Record<BackendId, …>`, which makes
forgetting to register a slug a compile-time error. The two-registry
split exists because chat handlers transitively import server-only
modules (CopilotRuntime, the credential cache, AG-UI server bindings)
that cannot be in the client bundle. The `id` field on each module
must equal its registry key — a typo there fails `tsc` thanks to the
`satisfies` clause.

### Single source of truth for `BackendId`

```ts
// src/lib/backends/types.ts
export const PROVIDER_IDS = ["agno", "mastra", "dify"] as const;
export type BackendId = (typeof PROVIDER_IDS)[number];
```

The const tuple is the only place a slug is declared. Adding a slug:

1. appends to `PROVIDER_IDS`,
2. cascades the union through `BackendId`,
3. forces both registries to gain a matching key (via `satisfies`),
4. updates the runtime guard `isSupportedBackend` automatically (it
   builds a `Set` from the same tuple).

---

## 4.1 Provider API Mappings

Each provider has unique bridging logic codified in its `chat.server.ts` to map upstream events to AG-UI events:
- **Agno**: Maps `*Delta` and `*Step` to AG-UI text/reasoning events. Filters out internal tools to avoid CopilotKit hangs.
- **Mastra**: Dedupes double-emitted tool calls. Translates SSE stream to AG-UI standard.
- **Dify**: Manages stateful `conversation_id` persistently. Synthesizes `TOOL_CALL_RESULT` for server-side tools to close the CopilotKit sequence.

*Note: Historical edge cases and workarounds are documented natively within the respective bridging files.*

### Per-provider folder shape

```
src/lib/backends/<slug>/
   adapter.ts          — client-safe metadata, IBackendAdapter
   entity.server.ts    — server-only EntityFetcher
   chat.server.ts      — server-only IBackendChatHandler
   index.server.ts     — exports the aggregated BackendModule
```

The folder is the unit of integration. Code outside the folder never
knows the upstream's wire protocol — the chat handler exports an
AG-UI-shaped agent and the entity fetcher exports a canonical
`EntityDescriptor[]`.

---

## 5. Two Wire-Protocol Modes per Provider

Every chat handler supports two modes, picked dynamically per
credential at request time:

### Bridge mode (default)

The handler subscribes to the upstream's native SSE stream and
translates each chunk into AG-UI events on the fly. Implementation
lives in `providers/<slug>/chat.server.ts`, all using the shared
`bridge-runtime-kit.server.ts`:

```
fetch(upstream/run, { signal })
  → readSseLines / readSseMessages
    → switch on chunk.type → emit AG-UI BaseEvent
```

The kit handles `RUN_STARTED` / `RUN_FINISHED` sentinels, abort
propagation, error wrapping, and the AG-UI three-stage text protocol
(`TEXT_MESSAGE_START` / `_CONTENT` / `_END`). Per-provider code only
writes the upstream-specific switch.

### AG-UI passthrough mode (opt-in)

When the credential row has `aguiUrl` populated, dispatch
short-circuits to `@ag-ui/client`'s `HttpAgent` against that URL. No
per-provider chunk → AG-UI translation needed because the upstream is
already emitting AG-UI events.

Compatibility (as of v1):

| Provider | Passthrough enabled by | `aguiUrl` example |
|---|---|---|
| mastra | `@ag-ui/mastra` package via `registerCopilotKit({ path, resourceId })` | `http://host:4111/chat` (no `{agentId}` — `resourceId` baked at registration) |
| agno | AgentOS's optional `AGUI(agent=…)` mount | `http://host:7878/agents/{agentId}/agui` |
| dify | does not speak AG-UI today | leave null |

The passthrough decision is per credential, not per provider. A
deployer can run two agno credentials side by side — one in bridge
mode, one in passthrough — without code changes.

PersistingAgent wrap, AbortSignal handling, and `entity_run`
persistence behave identically for both modes; they're applied by the
Runner *after* the handler returns its agent.

---

## 6. Security Model

### Trust boundaries

| Field | Source of trust | Validation / tamper consequence |
|---|---|---|
| `X-Credential-Id` header | Browser-supplied; pattern-validated to UUID v4 (`/^[a-f0-9-]{36}$/`) | Wrong id → 404 from `getAgentCredentialConfigById`; `enabled + serviceType="agent" + supported provider` invariants enforced server-side. credential rows are admin-managed and globally shared, so spoofing a different id only switches between credentials the user already has access to. |
| `agentId` (URL path) | Parsed from `/agent/<id>/<run\|connect\|stop>` in `route.ts`; pattern `^[A-Za-z0-9._\-]{1,128}$` | If `(credentialId, agentId)` is not in `EntityCatalog.list(credentialId)`, route returns 404. agent-id space is per-credential, no cross-tenant leak. |
| `entityKind` | Server-derived via `EntityCatalog.list(credentialId)` keyed by `agentId` | Not client-supplied; cannot be tampered. If the catalog itself is stale (entity removed upstream within the 10-min TTL window), the route returns 404 on next miss; chat handler does not see a wrong kind. |
| Scheduler kind | `schedule.entity_kind`, written at schedule create time from EntityCatalog | Snapshotted from the catalog at creation; user cannot retroactively change it without going through a fresh write that re-validates against current catalog state. |
| Supervisor catalog kind | Precomputed at supervisor build time from EntityCatalog | Not user-editable. |

### Encoding & isolation

- `agentId` is URL-decoded once during path parsing (`fetch-router`
  helper) and URL-encoded again inside each chat handler before
  interpolation into upstream paths — defence in depth, even though
  the route already rejects characters outside `[A-Za-z0-9._-]`.
- All third-party secrets stay in `import "server-only"` modules.
  `registry.server.ts` cannot accidentally end up in a
  client bundle because the `server-only` package throws at build
  time if imported from a client component.
- Logs redact `Authorization`, `cookie`, `x-credential-id`, and
  every `*.token` / `*.apiKey` / `*.secretKey` field path through
  pino's `redact` config (`logger.ts`).

---

## 7. Hot-Path Invariants

1. **No control-plane round-trip on the chat hot path**: The Runner never calls `EntityCatalog.list` during dispatch. Kind comes from the caller's input.
2. **Cancellation propagates**: Closing the chat tab aborts the upstream fetch and writes `cancelled` status.
3. **Tool-call events must never hang CopilotKit**: Bridge must either filter to client-declared tools (Mode A) or synthesise `TOOL_CALL_RESULT` for server-side calls (Mode B).
4. **Persistence is best-effort**: `PersistingAgent` writes `entity_run_event` fire-and-forget.

## 8. End-to-End Dispatch Flow

```
Browser                        /api/copilotkit                 Backend Platform
   │                                  │                              │
   │  POST /agent/{agentId}/run       │                              │
   │  cookies: session                │                              │
   │  X-Credential-Id: <uuid>          │                              │
   │  ─────────────────────────────► │                              │
   │                                  │ getSession() / 401            │
   │                                  │ parse agentId from URL path   │
   │                                  │ validate X-Credential-Id       │
   │                                  │ getAgentCredentialConfigById  │
   │                                  │   ↳ 10-min cache hit?         │
   │                                  │   ↳ AES-256-GCM decrypt       │
   │                                  │ EntityCatalog.list → kind     │
   │                                  │ runner.runChatRequest         │
   │                                  │   ↳ recordRunStart(entity_run row) │
   │                                  │   ↳ getChatHandler(provider)  │
   │                                  │       .buildAgent(ctx)        │
   │                                  │         ├─ aguiUrl set?       │
   │                                  │         │   → HttpAgent       │
   │                                  │         └─ else BridgeAgent   │
   │                                  │   ↳ wrap in PersistingAgent   │
   │                                  │   ↳ runWithAgents(req, {…})   │
   │                                  │       (CopilotRuntime hosts)  │
   │                                  │                               │
   │                                  │   ─── upstream fetch ────────►│
   │                                  │   ◄── upstream SSE ──────────  │
   │                                  │   bridge translates chunk →   │
   │                                  │     AG-UI BaseEvent            │
   │                                  │   PersistingAgent tee →       │
   │                                  │     entity_run_event INSERT   │
   │                                  │                               │
   │  ◄──────────────  AG-UI SSE  ────│                               │
   │  (TEXT_MESSAGE_*, TOOL_CALL_*,   │                               │
   │   REASONING_*, RUN_FINISHED)     │                               │
   │                                  │                               │
   │  user closes tab                 │                               │
   │  ──────────────────────────────► │                               │
   │  (subscriber unsubscribe)        │ AbortController.abort()       │
   │                                  │   ↳ fetch aborts              │
   │                                  │   ↳ PersistingAgent finalize  │
   │                                  │       writes 'cancelled'       │
```

For supervisor delegation and scheduled fires, the path differs only
at the entry: instead of HTTP → header validation, the caller invokes
`runner.start({ mode: 'sync' | 'async', initiator: 'orchestrator' |
'schedule', entityKind: <from-catalog-or-row> })` directly. The
runner-internal pipeline (recordRunStart → buildAgent → PersistingAgent →
agent.run subscribe) is identical, including cancellation propagation
on the orchestrator's side.

---

## 9. Persistence Surface

| Table | Purpose | Written by |
|---|---|---|
| `credential` | encrypted bearer / API keys + `restUrl` + `aguiUrl` per backend connection | admin UI |
| `entity_run` | one row per dispatch (chat / delegate / async / scheduled) | `runner.recordRunStart` |
| `entity_run_event` | append-only event timeline; ordered by `seq` | `PersistingAgent` |
| `schedule` | trigger spec `(startAt, [intervalValue, intervalUnit], [endAt])` + `entity_kind` snapshot | `/api/schedules`, supervisor `create_schedule` tool |
| `notification` | bell + `/notifications` inbox; populated by async + scheduled terminal events | `recordRunNotification` |

The `entity_run` row carries `parent_run_id` for the supervisor tree
(3-level depth limit), `initiator ∈ { user, orchestrator, schedule,
system }`, and a NULL `credential_id` for built-in dispatches. See
`docs/orchestrator.md` for run-tree semantics, recovery on restart,
and the async EventBus / SSE notification model.

---

## 10. Adding a New Platform

In one paragraph: declare the slug in `PROVIDER_IDS`, create
`providers/<slug>/{adapter, chat.server, entity.server, index.server}.ts`,
and register in both `registry.ts` and `registry.server.ts`.
The `satisfies Record<BackendId, …>` clauses on the registries make
forgetting either step a compile-time error.

Only modify `PROVIDER_IDS` and the two registries. Do not fork `bridge-runtime-kit.server.ts` or `runner.ts`.

If `pnpm exec tsc --noEmit` passes after step 4, every callsite
(Runner chat dispatch, EntityCatalog, supervisor catalog, admin run
forensics, schedule fires) routes correctly to the new provider.

---
