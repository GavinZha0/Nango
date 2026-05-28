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

### Why server-derive kind on the chat route

EntityCatalog is on the chat dispatch path, but it's almost always
free in practice:

- 10-minute LRU TTL with concurrent-fetch dedup (`lru-cache.fetch`).
- Warmed by `WorkspaceProvider` on UI mount (the agent picker
  pre-pulls the catalog for every enabled credential).
- Cache hit = synchronous in-process Map lookup (sub-ms).
- Cache miss happens at most once per credential per 10 minutes, and
  only if no one has loaded the picker since the last invalidation.

The cold-miss cost (one upstream `/agents` or `/teams` listing call,
typically 200-800ms) is acceptable because:

1. It happens at most once per credential per 10 minutes (not per chat
   message). After server boot, the first user to mount the workspace
   pays it; everyone else hits cache.
2. The catalog is already needed for the agent picker, so the cache is
   warm well before any chat dispatch.
3. The alternative (trusting `kind` from the browser) lets a malformed
   or malicious client supply a wrong kind that routes to a
   non-existent upstream endpoint and 404s — observably broken instead
   of safely rejected. The server-derived path returns a clean "agent
   not found in credential" 404 instead.

Apart from `kind` lookup, the chat hot path depends only on:

- session validation (cheap, in-process),
- credential lookup (10-min TTL cache, near-100% hit rate after warmup),
- synchronous registry lookup (`getChatHandler(provider)`).

There is no upstream round-trip on chat dispatch unless the
EntityCatalog cache is cold for that credential.

---

## 4. Provider Module Pattern

### The `BackendModule` interface

```ts
export interface BackendModule {
  readonly id: BackendId;
  readonly capabilities: BackendCapabilities;
  readonly controlPlane: {
    /** Client-safe REST helpers proxied via /api/backend. */
    readonly adapter: IBackendAdapter;
    /** Server-only entity discovery for EntityCatalog. */
    readonly fetchEntities: EntityFetcher;
  };
  readonly dataPlane: {
    readonly chatHandler: IBackendChatHandler;
  };
}
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

## 11. Provider-Specific Quirks and Mappings

### agno

**Bridge (`agno/chat.server.ts`)**
- Targets agno 2.6.4. Endpoints: `POST /agents/{id}/runs` (kind = agent) or `/teams/{id}/runs` (kind = team), `multipart/form-data` body (`message`, `stream=true`, `monitor=true`, `session_id`, `user_id`).
- **Quirk:** agno owns its session memory keyed by `session_id`, so we send only the latest user message. Re-sending historical assistant + tool messages round-trips OpenAI tool-call ids back into agno's bridge in problematic ways.
- **Quirk (`monitor=true`):** This param makes AgentOS persist the run to its session DB so the History panel can list it later.
- **Quirk (Reasoning / Streaming):** agno 2.6 added streaming `*Delta` distinct from the full-text `*Step`. Both carry text in `reasoning_content`; we forward whichever arrives. Any open reasoning blocks are closed before final-answer text starts, as the agent has moved on.
- **Mapping (agno → AG-UI):**
  - `RunContent` / `TeamRunContent` → `TEXT_MESSAGE_*` (delta = `content`)
  - `Reasoning(Started|*Delta|Step|*|Completed)` / `Team*` → `REASONING_*` + `REASONING_MESSAGE_*` (delta = `reasoning_content`)
  - `ToolCall*Started` / `Team*` → `TOOL_CALL_START` + `ARGS` + `END`
  - `RunError` / `TeamRunError` → throws → `RUN_ERROR`
  - Everything else is silently dropped.

**Discovery (`agno/entity.server.ts`)**
- Direct fetch to the credential's `restUrl` for `/agents`, `/teams`, `/workflows`.
- Sub-failures degrade gracefully — a deployment without `/workflows` still surfaces agents and teams.
- **Quirk (Opaque DB IDs)**: agno requires an opaque `dbId` per-entity for memory/evals/metrics API calls. We capture it at entity discovery so future server-side endpoints can read it back from `EntityCatalog` on demand, keeping it off the client side.

### Mastra

**Bridge (`mastra/chat.server.ts`)**
- Endpoint: `POST /agents/:agentId/stream` (`streamFormat: 'sse'`).
- **Quirk:** Mastra emits each tool call twice — streaming start/delta/end trio AND a consolidated `tool-call` chunk. Both share `toolCallId`; `ToolCallFilter` dedupes on first-seen.
- **Quirk:** Strip AG-UI-only roles (`developer`, …) that Mastra/AI-SDK doesn't understand before forwarding.
- **Mapping (Chunk → AG-UI):**
  - `text-start` / `-delta` / `-end` → `TEXT_MESSAGE_START` / `CONTENT` / `END`
  - `tool-call-input-streaming-start` → `TOOL_CALL_START`
  - `tool-call-delta` → `TOOL_CALL_ARGS`
  - `tool-call-input-streaming-end` → `TOOL_CALL_END`
  - `tool-call` (single, non-streamed) → `START` + `ARGS` + `END` trio
  - `tool-result` → `TOOL_CALL_RESULT`
  - `error` → throws → `RUN_ERROR`
  - `start` / `step-*` / `response-meta` / `reasoning-*` / `workflow-*` / `abort` / `raw` / `file` / `source` / `finish` → IGNORED for v1

**Discovery (`mastra/entity.server.ts`)**
- Mastra's `GET /agents` returns an object map `{ [agentId]: agent }`.
- Mastra has no team / workflow concept (today), so the result is always `kind: "agent"`.

### Dify

**Bridge (`dify/chat.server.ts`)**
- Endpoint: `POST /chat-messages` (per-app API key model — each credential identifies a single app, so `agentId` is a synthetic placeholder and ignored on the wire).
- **Quirk (conversation_id strategy):** AG-UI `threadId` and Dify `conversation_id` are independent namespaces. We keep `(credId, threadId) → conv_id` durably in the `backend_thread_state` table (`state.dify.convId`), fronted by an LRU cache in `lib/backends/thread-state.server.ts` for hot-path reads. Cache misses lazy-hydrate from the DB; writes update both atomically (cache sync, DB fire-and-forget).
  1. If a row is mapped, send the `conv_id`. On 404 / 400, retry without `conversation_id` (stale-mapping case — Dify-side conv was deleted / expired out-of-band) and capture the new `conv_id` from `message_end`.
  2. If no row is mapped (first message of a brand-new thread), omit `conversation_id` entirely so Dify allocates a fresh one — DO NOT speculatively send Nango's `threadId` as the `conv_id`, because Dify generates conv_ids internally and rejects unknown values with 404, so that "speculation" was a guaranteed wasted round-trip.
  Persisted across Node restarts so a recurring scheduled chat keeps Dify-side LLM context. The retry only fires when we already had a known-but-expired conv_id; a 4xx on the first omit-conv_id request is a genuine error and surfaces immediately.
- **Quirk (Non-unique Identity)**: `EntityDescriptor.id` alone is not globally unique across credentials (e.g. Dify synthesizes `"default"` for every app). React keys, sets, and run inputs must use the `(credentialId, entityId)` tuple.
- **Quirk (Server-side Tools):** Agent-mode tools are server-side (Dify executes them) but we forward them to the browser so the user sees what Dify did. This synthesises the result by pairing every `TOOL_CALL_START` with a synthesised `TOOL_CALL_RESULT` (from Dify's `observation`) so CopilotKit sees a closed sequence.
- **Mapping (Dify → AG-UI):**
  - `message` / `agent_message` → `TEXT_MESSAGE_START` / `CONTENT`
  - `agent_thought` (with `tool`) → `TOOL_CALL_START` + `ARGS` + `END`
  - `agent_thought` (with `observation`) → `TOOL_CALL_RESULT`
  - `message_end` → `TEXT_MESSAGE_END`, capture `conversation_id`
  - `error` → throws → `RUN_ERROR`
  - `ping` / unknown → ignored

**Discovery (`dify/entity.server.ts`)**
- Synthesise one agent (id="default") per credential, with name/description sourced from `GET /info`.

---

## 12. AG-UI Runtime Quirks

**History Trimming (`runtime.server.ts`)**
- CopilotKit v2's transport sends the entire `messages[]` snapshot on every run. Backends that own their session memory (agno, Mastra, …) re-derive history from `threadId`, so re-sending historical assistant-with-toolCalls + tool messages is at best redundant.
- Specifically with agno + OpenAI Responses API: each historical tool message carries its OpenAI `call_id` (`fc_…`). agno's AGUI bridge forwards `function_call_output` but fails to forward the matching `function_call`, and OpenAI 400s with "No tool call found for function call output" — resulting in silent RUN_FINISHED with no content events.
- **What we keep:** "From the last user message onward" (i.e. `[…, user, assistant_with_toolCall, tool_result]`). This preserves HITL flows where trailing assistant + tool messages MUST reach the upstream to resume the run, while dropping pre-turn history.
- **Security:** Only `/agent/:id/run` POSTs are touched; `/info`, `/threads/*`, GETs pass through verbatim.

`isSupportedBackend` is a type-narrowing predicate so untrusted
strings (DB rows, request headers, query params) can be funnelled
into a registry lookup without an unchecked cast.

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

Four invariants must hold for any new provider — these are the
cross-cutting properties the kernel relies on:

1. **No control-plane round-trip on the chat hot path.** The Runner
   never calls `EntityCatalog.list` during dispatch. Kind comes from
   the caller's input. If a provider needs upstream metadata to
   dispatch (e.g. a `db_id` for session scoping), fetch it once in
   `buildAgent` and cache it in the `BridgeConfig` — do not poke the
   catalog.

2. **Cancellation propagates.** Every `fetch` call inside a bridge
   handler must pass the `abortSignal` from
   `createBridgeRunObservable`. When the user closes the chat tab,
   CopilotRuntime tears down the Observable subscription, the kit's
   `AbortController` fires, the upstream `fetch` is cancelled, and
   `PersistingAgent`'s `finalize` operator writes
   `entity_run.status = 'cancelled'` exactly once (DB-level
   idempotent UPDATE on `WHERE status='running'`).

3. **Tool-call events must never hang CopilotKit's state machine.**
   CopilotKit cannot satisfy a tool call it didn't register: a
   `TOOL_CALL_START` reaching the browser without an eventual
   `TOOL_CALL_RESULT` (either supplied by the browser executing a
   client-declared tool, or synthesised by the bridge) leaves the
   chat in a pending state that swallows subsequent text deltas.

   This invariant has two compliant implementation modes; pick the
   one matching the upstream's protocol shape:

   - **Mode A — filter to client-declared tools (agno, Mastra).**
     The upstream stream mixes (a) tools the agent executes
     internally (memory, RAG, workflow steps) — which carry no
     result and would never be closed by the browser — with (b)
     client-declared tools the browser registered via
     `RunAgentInput.tools` (e.g. `open_artifact`). Use
     `ToolCallFilter` to forward only (b); (a) is dropped. The
     browser executes (b) and emits `TOOL_CALL_RESULT` itself.

   - **Mode B — forward server-side tool calls with synthesised
     result (Dify).** Dify Agent-mode tools are server-side only —
     the upstream emits each call's args and observation together
     on `agent_thought` events sharing one stable id. The bridge
     emits a complete `TOOL_CALL_START + ARGS + END + RESULT`
     four-tuple, so CopilotKit sees a closed sequence and the user
     sees what the agent did. No client-declared tools land on this
     stream because Dify's Agent mode does not surface them.

   A bridge that fits Mode A must NOT also forward server-side
   calls (that would hang the state machine); a Mode B bridge MUST
   pair every START with a synthesised RESULT before stream end. If
   a future provider mixes both shapes (some calls self-contained,
   some client-bound), the bridge needs both: filter to declared
   tools first, then synthesise RESULT for the server-side calls
   the user should see.

4. **Persistence is best-effort.** `PersistingAgent` writes events
   fire-and-forget. Chat latency must not depend on
   `entity_run_event` writes. If an event needs to surface to the
   user, emit it as `RUN_ERROR` in the AG-UI stream — that path is
   both rendered in the UI and persisted.

---

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

What you should *not* touch:

| File | Why it stays untouched |
|---|---|
| `runner.ts` / `persisting-agent.ts` | Provider-agnostic — uses `getChatHandler(provider)`. |
| `entity-catalog.ts` | Provider-agnostic — reads `PROVIDERS[provider].controlPlane.fetchEntities`. |
| `cache-invalidation.ts` | Operates on credential ids, not provider slugs. |
| `app/api/copilotkit/[...path]/route.ts` | Already provider-agnostic; only reads headers + credential. |
| `app/api/backend/[...path]/route.ts` | Pure reverse proxy keyed by `credentialId`. |
| `bridge-runtime-kit.server.ts` | Don't fork. If you find behaviour the kit doesn't cover, extend the kit so all existing providers benefit too. |

If `pnpm exec tsc --noEmit` passes after step 4, every callsite
(Runner chat dispatch, EntityCatalog, supervisor catalog, admin run
forensics, schedule fires) routes correctly to the new provider.

### Health probes — deferred by design

`IBackendAdapter` deliberately does NOT carry a `ping` / `health`
method. Earlier iterations exposed an optional `ping(credentialId)`
shape for a planned workspace status indicator; the indicator was
never built and the optional method became dead code (only one
provider implemented it, no caller invoked it). Removed in commit
`<see git log>` to stop misleading reviewers.

If a future feature genuinely needs upstream health, design it
when the consumer exists — the right shape almost certainly is
NOT per-credential one-off probes:

- Batched (one fan-out across all enabled credentials) to amortise
  fetch cost and round-trip latency.
- Cached / debounced inside `EntityCatalog` so the indicator polling
  rate is decoupled from the actual upstream call rate.
- Returns a structured snapshot (`{ ok, latencyMs, lastError? }`)
  rather than a boolean — the indicator usually wants to show
  "degraded" / "slow" states, not just up/down.

When that lands, the adapter contract is the right place — but add
it together with the implementation, not as an aspirational stub.

---

## Future Inbound Protocols (A2A et al.)

> Status: investigated 2026-05; no implementation planned for v1.

A2A (Agent-to-Agent), Google's agent interoperability protocol
announced April 2024, defines an HTTP/JSON-RPC standard for
cross-platform agent discovery, messaging, tasks, and artifacts. The
question we evaluated: should we add an A2A backend alongside the
existing per-platform REST translators (Dify / Agno / Mastra)?

Conclusion: **not now, but the door is open**. The `BackendModule`
abstraction is protocol-agnostic, so when a triggering condition
fires, an A2A backend slots in via the four-step onboarding (§10).
This section preserves the analysis so future evaluations do not
re-derive it from scratch.

### Why not now (May 2026)

- **No upstream platform we integrate exposes a first-class A2A
  endpoint.** Dify, Agno, and Mastra all ship REST APIs only; A2A is
  mentioned in community issues but is not in any official release.
  LangGraph has an experimental A2A server behind an opt-in flag.
- **Spec is still v0.x.** A2A is not in any standards body
  (IETF / W3C); the message envelope and task schema have changed
  multiple times within six months. Early adoption would mean
  repeated churn in our wire layer.
- **Our cross-platform abstraction already exists.** AG-UI is the
  client-facing standard; per-platform translators feed it. A2A is
  an *agent ↔ agent* protocol, not a *wire-level* standard — adopting
  it as a new backend would add a translator (A2A client → AG-UI),
  not remove the existing ones.
- **The realistic v1 consumer is narrow.** As of May 2026, Google
  Vertex AI Agent Builder is the only mainstream platform with a
  production A2A endpoint, and we have not been asked to integrate
  it.

### Why the door stays open

`BackendModule` (§4) is protocol-agnostic by design. Adding A2A
follows the same four-step onboarding as any other platform (§10):

```
src/lib/backends/a2a/
├── adapter.ts           # client-safe metadata
├── entity.server.ts     # GET /.well-known/agent.json  (Agent Card)
├── chat.server.ts       # POST messages.stream → AG-UI translation
└── index.server.ts      # BackendModule export
```

The credential type would extend the existing pattern with
`serviceType: "a2a"`; `restUrl` becomes the A2A server base URL.
The bridge-runtime-kit (§12) is reusable as-is — only the SSE
event names change.

A2A's surface maps cleanly onto our existing primitives:

| A2A concept | Nango equivalent |
|---|---|
| `messages.send` (sync) | `runner.runChatRequest({ mode: "sync" })` |
| `messages.stream` (SSE) | AG-UI events on SSE |
| `tasks.create` (async) | `runner.start({ mode: "async" })` |
| `tasks.get` / `tasks.cancel` | `entity_run` lookup + cancellation |
| `artifacts` (streaming) | Outcome / `artifact` table |
| Agent Card discovery | `EntityCatalog` listing |

So the migration cost is bounded: one new folder, no abstraction
changes, no callsite changes outside the two registries.

### Triggers for revisiting

Adopt A2A as a new backend when ANY of the following becomes true:

- A user / customer request points at an **A2A-only platform** worth
  integrating (e.g. Vertex AI Agent Builder, a customer's internal
  agent registry).
- An existing integrated platform (Dify / Agno / Mastra) ships a
  first-class A2A endpoint AND that endpoint exposes capabilities the
  current REST does not — most plausibly native task lifecycle for
  long-running async runs (replacing our `entity_run`-based polling),
  or first-class streaming artifacts.
- A2A enters a real standards body (IETF / W3C) and either OpenAI or
  Anthropic publicly commits — at that point platform inertia will
  swing toward the protocol regardless of individual upstreams'
  support.

Until then, treat this section as the written record of "we looked
at it, it isn't ready, here's the migration shape when it is."

### Related: exposing Nango as an A2A *server*

The mirror question — letting external systems call our built-in
agents over A2A — is **out of scope for this section**. It's a
product decision (does anything want to call Nango remotely?) not a
backends-bridge decision, and the implementation surface is
different (HTTP endpoint + Agent Card publication + auth) rather
than another `BackendModule`. If the need arises, that work would
live alongside the runner kernel, not in `src/lib/backends/`.

---

## Document History

| Version | Date | Notes |
|---|---|---|
| v1 | 2026-05 | Extracted from `docs/architecture.md` Appendix B + §3.1/§3.2/§9.1; consolidated control/data plane separation rationale; added security model and hot-path invariants. |
| v1.1 | 2026-05 | Added "Future Inbound Protocols (A2A et al.)" — investigation notes + migration shape + revisit triggers; doc-only, no code change. |

### Entity Catalog (`entity-catalog.ts`)
- **Quirk (Caching & Singleflight)**: The `EntityCatalog` maintains a whole-table per `credentialId` cache with a 10-minute TTL. The first miss triggers one upstream fan-out. Concurrent misses share the same in-flight Promise (singleflight registry) to prevent hammering the upstream. The in-flight Promise is registered synchronously *before* the first `await` so subsequent callers in the same event loop tick can join it. It is cleared in a `finally` block so failed loads don't poison retries.
- **Quirk (Invalidation)**: `invalidate(credentialId)` drops the resolved catalog entry from memory but explicitly leaves any in-flight load alone. Concurrent invalidate + refresh callers join the in-flight fetch rather than spawning redundant parallel round-trips.

### Bridge Runtime Kit (`bridge-runtime-kit.server.ts`)
- **Quirk (Tool Filtering):** Backends like agno and Mastra mix internal tools (knowledge, memory, RAG) with client-declared tools in the same stream. Internal tools don't produce results that CopilotKit expects and would hang the client if forwarded. The `ToolCallFilter` ensures only explicitly client-declared tools are forwarded.
- **Quirk (Text Stream Framing):** Many upstreams only emit delta chunks without explicit START/END events. The `TextStreamState` helper synthesises `START` on the first non-empty delta, and `END` on explicit terminators or stream close to fulfill AG-UI's expected sequence (`TEXT_MESSAGE_START` → `CONTENT` → `END`).
