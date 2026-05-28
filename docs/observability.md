# Observability — Structured Logs + Langfuse Tracing

This document describes the observability layer of Nango: what it covers,
how it is wired, why each design choice was made, and what is intentionally
left for later phases.

The layer has two independent components:

1. **Phase 1 — Structured logs (`pino`)**: a single in-process logger that
   covers every server-side request path. Always on (subject to an env
   kill switch); no external dependencies.

2. **Phase 2 — Langfuse traces**: targeted traces for the slices that the
   backend agent platforms (agno / Mastra / Dify) cannot instrument
   themselves. Currently scoped to the BuiltIn agent runtime.

These are deliberately separate so the structured logs keep working when
Langfuse is misconfigured, unreachable, or simply not in use.

---

## 1. Why this layer exists

Nango is a unified frontend + proxy in front of multiple agent backends.
Each backend already runs its own observability (most production agno /
Mastra deployments push traces to a Langfuse project). Re-tracing the
same LLM calls from the proxy would:

- double the storage cost,
- create conflicting "source of truth" trees in Langfuse,
- and force us to re-parse upstream protocols just to recover what the
  backend already captured.

So Nango deliberately captures only what backend-side instrumentation
**cannot see**:

| Slice | Visible to backend Langfuse? | Captured by Nango? |
|---|---|---|
| LLM prompt / completion / tokens (backend agent) | ✅ | ❌ (skip) |
| Server-side tool calls (backend agent) | ✅ | ❌ (skip) |
| BuiltIn agent runtime (no upstream) | n/a | ✅ Phase 2 |
| Frontend tool calls (`open_artifact`, …) | ❌ (browser) | ⏳ Phase 3 |
| Proxy-layer errors (cred fail, timeout) | ❌ (never reached backend) | ⏳ Phase 2-C |
| Cross-backend user journey (multi-agent thread) | ❌ | ⏳ via `userId` + `sessionId` correlation |
| Application-level user identity | ❌ (only via forwarded_props) | ✅ Phase 1+2 |

Phase 1 logs already give us the full request audit trail for *all*
slices above. Phase 2 adds rich, queryable traces for the slices where
no backend Langfuse exists (BuiltIn) — so we can still answer questions
like "why was that BuiltIn run slow yesterday?" without grepping logs.

---

## 2. Phase 1 — Structured logs

### 2.1 What it covers

The `pino` logger is wired into every server-side hop on the chat path:

| Component | File | Logs |
|---|---|---|
| Backend chat route | `src/app/api/copilotkit/[...path]/route.ts` | request id, auth result, validation, dispatch outcome with provider + agentId + userId + duration |
| BuiltIn chat route | `src/app/api/copilotkit/builtin/[...path]/route.ts` | request id, auth result, dispatch outcome with userId + status + duration |
| AG-UI passthrough | `src/lib/backends/_passthrough-agui.ts` | credential resolution failures (404 / missing aguiUrl / missing token), AG-UI dispatch ok/failed with HTTP status + duration |
| Credential lookup | `src/lib/credentials/lookup.ts` | decryption failures (rare, indicates corrupted row or rotated key), cache invalidation (debug level) |

### 2.2 Logger module

`src/lib/observability/logger.ts` exports:

```typescript
import { logger, childLogger, newRequestId, timed } from "@/lib/observability/logger";

logger.info({ event: "startup" }, "service ready");

const requestId = newRequestId();
const log = childLogger({ requestId, route: "/api/copilotkit" });
log.warn({ event: "auth", outcome: "unauthorized" }, "unauthorized");
```

Conventions enforced by the codebase:

- Every request-scoped log line carries `requestId`, `route`, `method`,
  `path` so a single request can be reconstructed by filtering one
  field in any log shipper.
- Field names are stable: `event` + `outcome` + `component`. Same shape
  across all hops — copy-paste filters work everywhere.
- Sensitive paths are redacted automatically (`token`, `secretKey`,
  `publicKey`, `password`, `apiKey`, `encryptedPayload`,
  `headers.authorization`, `headers.cookie`, `headers['x-credential-id']`,
  plus their `*.foo` nested forms — `*.token`, `*.apiKey`,
  `*.encryptedPayload`, `*.headers.authorization`, `*.headers.cookie`).

### 2.3 Configuration

`.env.example` documents three env switches:

```env
NANGO_LOG_ENABLED=true        # master kill switch
NANGO_LOG_LEVEL=info          # debug | info | warn | error | silent
# NANGO_LOG_PRETTY=true       # auto: true in dev, false in prod
```

Production output is JSON (so Loki / Datadog / CloudWatch ingest it
verbatim). Development output is colorised by `pino-pretty` for
readability.

### 2.4 Why we did not log every cache hit

`getCredentialConfigById` is on the hot path (every request). Logging
the cache outcome on each call would generate one log line per request
per credential lookup — pure noise. We instead log only:

- decryption failures (`error`-level, always — these indicate real bugs)
- cache invalidations (`debug`-level, low rate)

Cache hit/miss telemetry, when needed, belongs in metrics (Phase 3+).

---

## 3. Phase 2 — Langfuse traces (BuiltIn runtime)

### 3.1 What is traced today

A Langfuse `trace` is created for each BuiltIn agent dispatch on
exactly two URL patterns:

| URL pattern | Trace name | Why traced |
|---|---|---|
| `/api/copilotkit/builtin/agent/{id}/run` | `builtin_agent_run` | The user-perceived "send a message" call |
| `/api/copilotkit/builtin/agent/{id}/connect` | `builtin_agent_connect` | Thread replay on session reload |

`/info`, `/threads/*`, and other bookkeeping endpoints are dispatched
without tracing — they fire many times per session and would drown
meaningful traces in Langfuse if included.

Each trace carries:

- `userId` — better-auth UUID
- `sessionId` — agent thread id, extracted via `extractRunInput` from
  the AG-UI POST body for `run` and from the `?threadId=` query string
  for `connect`
- `tags` — `["agent:<id>", "action:run|connect"]`, plus `"error"` on
  failure
- `metadata` — `{ requestId, path, method, durationMs }` and on failure
  the `error` message
- `output` — `{ status: <http status> }` on success, `{ error: <message> }`
  on failure
- A child `error` event with `level: "ERROR"` is attached on failure
  so the trace stands out in Langfuse error filters (Langfuse traces
  themselves do not carry a `level` field — only observations do)

### 3.2 What is NOT yet traced (deliberately deferred)

The current trace is **request-level metadata only**. It can answer
"who ran which agent when, and did it succeed?" — **not** "what did
the user say and what did the model reply".

Specifically, none of the following are captured:

| Item | Why not yet |
|---|---|
| **User message text** | Body would need to be cloned + parsed before forwarding to CopilotKit runtime; we did not want to risk touching the request stream |
| **Assistant response text** | Response is an AG-UI SSE stream; capturing it requires a `TransformStream` wrapper that parses each `data:` line into typed events |
| **Tool calls** (which tool, args, result) | Same as above — they arrive as `TOOL_CALL_*` events embedded in the AG-UI stream |
| **Underlying LLM call** (model, prompt, completion, tokens, cost) | Happens inside CopilotKit runtime; would require either Langfuse `observeOpenAI` wrapping at the SDK construction site or a runtime middleware hook |
| **Reasoning / thinking blocks** | Same — needs LLM-level instrumentation |
| **Frontend tool execution** (`open_artifact`, `close_artifact`) | Runs in the browser; would need a small `/api/observability/frontend-event` endpoint to receive client reports |
| **Backend agent traces** (agno / Mastra / Dify) | **Intentionally** out of scope — those backends already trace to their own Langfuse projects; re-tracing would double cost and confuse the trace tree |
| **Proxy-layer errors as Langfuse events** (cred fail, timeout, AG-UI parse error) | Currently captured in structured logs only; adding Langfuse traces is the next step (target `proxy_errors`, see §3.6) |

### 3.3 Module layout

```
src/lib/observability/
├── logger.ts        Phase 1 — pino singleton + helpers
└── langfuse.ts      Phase 2 — Langfuse client lazy singleton + withTrace
```

`langfuse.ts` exports:

```typescript
export type TracingTarget = "builtin" | "frontend" | "proxy_errors";

export function tracingEnabled(target: TracingTarget): boolean;
export async function withTrace<T>(
  options: WithTraceOptions,
  fn: (trace: LangfuseTraceClient | null) => Promise<T>,
): Promise<T>;
export async function flushLangfuse(): Promise<void>;
export function invalidateLangfuseClient(): void;
```

`withTrace` is a no-op when the target is disabled, the credential is
missing, or the master switch is off — `fn` runs with `trace = null`
and callers are expected to `null`-check before touching trace methods.

The singleton holder (`{ client, initPromise, subscribed }`) is pinned
to `globalThis.__nangoLangfuse` so dev-server HMR reloads don't reset
the client mid-session or leak duplicate credential-invalidation
subscriptions. See `docs/cache.md` §2.7 for the project-wide HMR
pinning rule.

### 3.4 Lifecycle

```
First /agent/<id>/run request after process start
  └─ withTrace → resolveClient
       ├─ getEnabledObservabilityCredential()      (1 DB hit, cached)
       │   ↳ returns null if no credential is enabled → tracing OFF
       ├─ self-register invalidateLangfuseClient   (one-time)
       └─ new Langfuse({ publicKey, secretKey, baseUrl, flushAt:1, sdkIntegration:"nango" })

Every /agent/<id>/run request thereafter
  └─ withTrace
       ├─ tracingEnabled(target)                   (env check, cached set)
       ├─ resolveClient()                          (returns memoised client)
       ├─ trace = client.trace({...})              (in-memory, queued)
       ├─ run dispatch
       ├─ trace.update({ output, metadata })       (in-memory, queued)
       └─ finally: flushLangfuse()                 (HTTP POST to Langfuse)

Admin updates the Langfuse credential
  └─ admin route calls invalidateCredentialCache()
       └─ subscribers fire → invalidateLangfuseClient()
            └─ next request rebuilds the client with fresh keys
```

Master on/off lives **on the credential, not in env**. To stop sending
traces, toggle the Langfuse credential's `enabled` flag in the admin
UI. The PATCH handler calls `invalidateCredentialCache()`, which fires
the subscription that clears the cached client. The next request sees
no enabled credential and `withTrace` becomes a no-op. No env change,
no restart.

Three caches collaborate:

1. **Credential lookup cache** (`fieldsByIdCache`,
   `observabilityCredentialCache`) — TTL 10 min, cleared on credential
   write.
2. **Langfuse client singleton** (`_client`) — three states: `undefined`
   (not yet initialised), `null` (no credential), `Langfuse` (ready).
   Cleared by the subscription callback.
3. **Parsed env target set** (`cachedTargets`) — populated lazily on
   first access, cleared alongside the client so an env reload during
   a hot-reload dev session takes effect.

### 3.5 Configuration

#### Credential entry (Admin → Credentials)

| Field | Value |
|---|---|
| Type | `keypair` |
| Service Type | auto-fills to `observability` from the provider |
| Provider | `langfuse` |
| Public Key | `pk-lf-…` from the Langfuse project settings |
| Secret Key | `sk-lf-…` from the Langfuse project settings |
| REST URL | Langfuse host, e.g. `https://cloud.langfuse.com` or your self-hosted URL. Leave empty for the default (`cloud.langfuse.com`) |

**Exactly one** credential with `serviceType=observability` is consumed
at a time. Disabled or older entries are ignored. (See
`getEnabledObservabilityCredential()` for the selection rule —
most-recently-created enabled wins.)

#### Env switches (`.env`)

```env
# Phase 1 — structured logs
NANGO_LOG_ENABLED=true
NANGO_LOG_LEVEL=info
# NANGO_LOG_PRETTY=true

# Phase 2 — Langfuse traces (master on/off lives on the credential)
# NANGO_OBSERVABILITY_TARGETS=builtin,frontend,proxy_errors  # default: all
```

`NANGO_OBSERVABILITY_TARGETS` lets you turn off a class of traces
without touching the credential — useful for staging environments
where you want only `builtin` traces. To turn tracing off entirely,
disable the Langfuse credential in the admin UI rather than adding an
env switch.

### 3.6 Trace failure semantics

Langfuse traces themselves do **not** carry a `level` field — only
observations (span / event / generation) do. To make a failed trace
filter-able in Langfuse UI, `withTrace` does two things on exception:

1. Adds `"error"` to the trace's tags.
2. Attaches a child `event` with `name: "error"`, `level: "ERROR"`,
   `statusMessage: <message>`.

Both are visible in the Langfuse trace list and detail views.

---

## 4. The credential extension that supports this

`Phase 2` ships with two reusable schema additions, not Langfuse-specific:

### 4.1 New `keypair` credential type

`PAYLOAD_FIELDS.keypair` in `CredentialFormDialog.tsx` collects two
encrypted fields, `publicKey` and `secretKey`. Storage layer required
no migration — `encryptedPayload` already stores arbitrary JSON.

This unblocks future credentials that need two keys: Stripe (pk_/sk_),
AWS access/secret, any HMAC-pair API.

### 4.2 New `observability` service type

Generic service category, distinct from `agent` / `llm` / `search` /
`api` / `other`. Reserved for tracing and logging backends. Today only
Langfuse is registered, but the type is intentionally generic.

### 4.3 New lookup helper `getCredentialFieldsById()`

Returns the entire decrypted payload as `Record<string, unknown>`.
Use this for any multi-field credential (`keypair`, `oauth_client`,
…) instead of the legacy `getCredentialTokenById` which discards
non-primary fields.

`getEnabledObservabilityCredential()` is a thin wrapper that pre-parses
the `keypair` shape: `{ id, provider, host, publicKey, secretKey }`.
Call this from any future observability provider integration.

---

## 5. Status snapshot

### Done

- [x] `pino` structured logs with redaction, request-id correlation,
      env switches, JSON-in-prod / pretty-in-dev
- [x] Logs at backend chat route, BuiltIn chat route, AG-UI passthrough,
      credential lookup
- [x] `keypair` credential type (publicKey + secretKey, both encrypted)
- [x] `observability` service type
- [x] Admin UI support for the new type / service in
      `CredentialFormDialog` and `CredentialManagementTable`
- [x] `getCredentialFieldsById()` and `getEnabledObservabilityCredential()`
      helpers with their own caches
- [x] Cache invalidation subscription mechanism so credential rotation
      transparently rebuilds dependent caches
- [x] `langfuse` SDK installed (v3.38.x)
- [x] `langfuse.ts` lazy singleton with `tracingEnabled` /
      `withTrace` / `flushLangfuse` / `invalidateLangfuseClient`
- [x] BuiltIn `/agent/<id>/run` and `/agent/<id>/connect` traces with
      userId, sessionId, tags, metadata, status, durationMs
- [x] Read `threadId` from the run request body so `sessionId` is
      populated for `/run` (not just `/connect`)
- [x] Failed traces marked with `"error"` tag + ERROR child event
- [x] Credential `enabled` flag is the single master on/off (no env duplicate)
- [x] `NANGO_OBSERVABILITY_TARGETS` per-target opt-out
- [x] `.env.example` documents both Phase 1 and Phase 2 env vars

### Not yet done (deliberately deferred)

#### BuiltIn run content (Phase 2-A)

Capture the actual conversation inside each `builtin_agent_run` trace.

- [ ] Read the `messages[-1]` from the request body (clone + parse JSON)
      and write it as `trace.input`
- [ ] Wrap the response stream in a `TransformStream` that parses
      AG-UI events as they fly through:
  - [ ] Accumulate `TEXT_MESSAGE_CONTENT` deltas → `trace.output`
  - [ ] Convert `TOOL_CALL_START` / `TOOL_CALL_ARGS` / `TOOL_CALL_END`
        / `TOOL_CALL_RESULT` into Langfuse spans nested under the trace
  - [ ] Capture `RUN_FINISHED` as the trace finalisation point

This is the highest-value follow-up. Implementation notes:

- AG-UI parsing logic already exists in
  `src/lib/backends/mastra/chat.server.ts` (search for the
  `MastraChunk` switch). Refactor it into a reusable AG-UI event
  parser before adding a second consumer.
- The `TransformStream` wrapper must be transparent — bytes pass
  through verbatim; only side-effects on a Langfuse trace are added.
- Backpressure: avoid buffering the entire stream. Emit trace updates
  every N events or every M ms.

#### LLM-level traces (Phase 2-B)

Capture each LLM invocation inside the BuiltIn runtime.

- [ ] Audit the route handler at
      `src/app/api/copilotkit/builtin/[...path]/route.ts` to see whether
      the CopilotKit runtime exposes a hook for replacing the LLM client
- [ ] If yes: wrap the OpenAI / Anthropic SDK with Langfuse
      `observeOpenAI(client)` (Langfuse SDK already imports a helper
      named `observeOpenAI` — confirmed in `node_modules/langfuse/lib/index.d.ts`)
- [ ] If no: investigate CopilotKit middleware (v2's `runtime` object
      may accept `before/after` hooks — check the runtime source)

This gives prompt / completion / tokens / cost. Without it, Phase 2-A
gives the user-visible conversation but not the underlying model
economics.

#### Proxy-layer error traces (Phase 2-C)

Promote the most useful structured-log lines to short Langfuse traces:

- [ ] In `lib/backends/runtime.server.ts` (the `runWithAgents` entry point),
      when credential resolution fails or AG-UI dispatch throws, wrap
      the failure in `withTrace({ target: "proxy_errors", ... })` so
      the failure shows up in Langfuse UI next to BuiltIn traces —
      easier to find than grepping logs
- [ ] Tag each error trace with `error_class` (e.g.
      `credential_not_found`, `aguiUrl_missing`, `upstream_5xx`,
      `network_timeout`) so we can plot error rate by class

Cheap and high-signal once Phase 2-A is in.

#### Frontend tool call traces (Phase 3)

Surface frontend-only tool executions (`open_artifact`,
`close_artifact`) that the backend never sees.

- [ ] Add `POST /api/observability/frontend-event` route that accepts
      `{ traceId, name, status, input, output, ts }` and writes a
      Langfuse event into the parent trace
- [ ] In `useAgentActions`, around each tool handler:
  - emit a `frontend_tool_call_started` event (with the parent trace
    id obtained from the current run — needs CopilotKit v2 to expose
    it, see below)
  - emit `_completed` or `_failed` after the handler resolves
- [ ] Investigate how to plumb the parent trace id from server to
      browser. Options:
  - Server includes a `Langfuse-Trace-Id` header in the AG-UI
    response, client parses it from `response.headers.get(...)`
  - Or generate trace id client-side and pass it via
    `<CopilotKitProvider properties>` so server-side `withTrace`
    adopts it (`client.trace({ id: providedId })`)

Without this, frontend tools remain invisible — currently no record
of *whether the artifact actually opened* exists anywhere outside the
browser.

#### Cross-backend correlation (nice-to-have)

When a user switches agents mid-thread (backend A → backend B), the
two backends each emit traces in their own Langfuse projects. To
reconstruct the cross-backend journey we currently rely on shared
`userId` and `sessionId` (= threadId) field values that are visible
in all three places (Nango, agno, Mastra).

- [ ] Document this convention in this file (and surface it in
      `docs/backend-integration.md` if a new platform integrator
      needs the cross-reference) so backend integrators know which
      fields to forward through their Langfuse instrumentation

#### Metrics layer (Phase 4, far future)

`pino` logs and Langfuse traces both have ingestion costs that scale
with traffic. For high-cardinality counters (request rate, error rate,
LLM cost per user) a Prometheus / OTEL-metrics layer is a better fit.

- [ ] If/when needed, add `prom-client` and expose `/metrics`. Same
      `tracingEnabled`-style env switch design.

---

## 6. Reading list

External references that informed these decisions:

- [Langfuse JS SDK reference](https://langfuse.com/docs/sdk/typescript)
- [Anthropic — Effective Harnesses for Long-Running Agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)
  — argues for separating "session as append-only event log" from
  "model + harness" and "tools + sandbox", which matches the Nango
  proxy / runtime / frontend separation
- [Anthropic — Scaling Managed Agents](https://www.anthropic.com/engineering/managed-agents)
  — the Phase 2 design borrows the "trace at each architectural
  boundary, not at every call" rule from this article
- [OpenTelemetry GenAI Semantic Conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/)
  — the field names we use in Langfuse `metadata` (`durationMs`,
  `error`) align with these where possible
- `awesome-harness-engineering` —
  https://github.com/ai-boost/awesome-harness-engineering — broader
  context on harness patterns

---

## 7. Operational runbook

### How to disable all observability quickly

- **Logs**: set `NANGO_LOG_ENABLED=false` in `.env` and restart the
  process. Required because logs have no DB-backed equivalent.
- **Langfuse traces**: open Admin → Credentials, toggle the Langfuse
  credential to disabled. Effective on the next request — no restart.

### How to disable only Langfuse traces (keep logs)

Open Admin → Credentials and toggle the Langfuse credential off.
Alternatively, remove the credential entirely.

To narrow Langfuse traces to a subset of targets without touching the
credential, edit `.env`:

```env
NANGO_OBSERVABILITY_TARGETS=frontend,proxy_errors    # builtin disabled
```

### How to rotate Langfuse keys

1. Generate new keys in Langfuse UI.
2. In Admin → Credentials, edit the existing `langfuse` row and update
   `publicKey` / `secretKey`.
3. Save. The PATCH handler calls `invalidateCredentialCache()`, which
   in turn fires `invalidateLangfuseClient()` via the subscription
   mechanism. The next BuiltIn request rebuilds the client with the
   new keys. **No restart required.**

### How to debug "no traces showing up"

1. Confirm the Langfuse credential is enabled in Admin → Credentials
   (the `enabled` flag is the master switch).
2. Confirm `NANGO_OBSERVABILITY_TARGETS` includes the target you
   expect (default: all three; unset env var = default).
3. Set `NANGO_LOG_LEVEL=debug` and watch the logs on the next request:
   - `event: "init_skipped"` with reason → check the credential
   - `event: "init_failed"` → check Langfuse host and keys
   - `event: "init_ok"` → traces should appear; check the URL trigger
     (only `/run` and `/connect` are traced; not `/info` or `/threads/*`)
4. If `init_ok` shows but no trace lands in Langfuse: check
   `flush_failed` warnings and inspect Langfuse host reachability from
   the server.

### How to verify in production without sending real traces

Set up a separate Langfuse project, register its credentials in admin,
disable the production credential, hit the staging environment.
Because credential selection is "first enabled", flipping `enabled`
flags on the credentials is enough — no env change.

---

### 3.7 Implementation Details and Quirks

- **Flush Strategy (`flushAt: 1`)**: Every event ships immediately. The proxy is low-throughput compared to LLM cost, so immediate flush latency is negligible against the agent run itself, and it avoids losing data if the Node process is recycled.
- **Client Caching**: The Langfuse client is cached via a singleton `_client`. Upon credential update, `invalidateLangfuseClient` drops this cache. The actual next client creation happens lazily on the next `resolveClient` call.
- **Flush Lifecycle**: `flushLangfuse()` is executed in a `finally` block on every `run`/`connect` request to ensure Langfuse events ship before a Serverless environment can suspend the process.
- **Enabled State Driven By DB**: Tracing is fully driven by the credential's `enabled` flag. Disabling the row clears the cached client on the next request via `onCredentialCacheInvalidated`—no process restart needed.
- **Trace Error Flagging**: Langfuse traces don't natively carry a `level` field, only observations do. Therefore, a "trace failed" scenario is modeled via tag (`"error"`) + a child `ERROR` event to provide visual consistency in the Langfuse dashboard.
