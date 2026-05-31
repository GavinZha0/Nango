# Built-in Runtime — Pools and Invalidation Contract

> Status: v1
> Audience: backend engineers and operators of the Nango Built-in Agent feature
> See also: `docs/architecture.md` §5.2, `docs/cache.md` (full cache
> inventory + §2.7 HMR `globalThis` pinning rule), `docs/key-rotation.md`

---

## 1. What Replaced the Old Per-User Runtime Cache

The previous design (`src/lib/builtin-runtime-cache.ts`, removed) cached
one `CopilotRuntime` per user for 10 minutes. That design coupled three
unrelated concerns into one cache key:

1. **Construction.** Building `BuiltInAgent` and `CopilotRuntime`
   objects requires DB reads + credential decryption — worth caching.
2. **MCP transport lifetime.** Every (user, agent) tuple opened its own
   MCP connection, scaling as O(N·M) for N users × M servers per agent
   — pure waste for connection-stateless servers.
3. **Authorization.** Whatever rows the cache loader's SQL returned was
   exactly what the user could invoke. Authorization was an emergent
   property of cache contents; any code path that bypassed the cache
   also bypassed the access check.

The new design splits these into independent pieces:

| Concern | Module | Lifetime |
|---|---|---|
| Authorization | `src/lib/access/agent-visibility.ts` | per request, no cache |
| Decrypted spec | `src/lib/builtin-agents/agent-pool.ts` | LRU + 10-min TTL, keyed by `agentId`, shared across users |
| MCP transport | `src/lib/mcp/provider-pool.ts` | refcounted + idle reaper, keyed by `mcpServerId`, shared globally |
| `CopilotRuntime` | `src/app/api/copilotkit/builtin/[...path]/route.ts` | per request — never cached |

The route handler simply orchestrates them; on a warm process, every
request is two map lookups and a refcount increment per bound MCP
server.

---

## 2. Pool Contracts

### 2.1 AgentSpec Pool — `src/lib/builtin-agents/`

```ts
class AgentPool {
  get(agentId: string): Promise<AgentSpec | null>
  invalidate(agentId: string): void
  invalidateByCredential(credentialId: string): Promise<void>
  invalidateAll(): void
}
```

**Key properties.**

- LRU bounded (default 500) with absolute TTL (default 10 min). Even
  with no explicit invalidation, no entry survives longer than the TTL.
- `null` results from the loader (missing / disabled / unresolvable
  credential) are **NOT** cached. A transient null re-enters the loader
  on the next call. This is deliberate: re-enabling an agent must take
  effect immediately.
- Concurrent `get(id)` calls during the first miss share one in-flight
  loader Promise (`lru-cache` `fetchMethod`). No thundering herd.
- `invalidateByCredential(credentialId)` does a reverse-index SELECT
  on `builtin_agent.credential_id` and drops only matching entries.
  Cost scales with the number of dependents, not the cache size.

**What is in an `AgentSpec`.** Decrypted `apiKey`, prompt / temperature
/ maxTokens, plus a polymorphic `AgentToolRef[]` decoded from the
`builtin_agent_tool` junction table (kinds: `mcp_server`, `mcp_tool`,
`skill`, `builtin_tool`). Today the runtime acts on `mcp_server`,
`skill`, and `builtin_tool`; `mcp_tool` (single-tool granularity from
an MCP server) is loaded but not yet wired.

### 2.2 MCP Provider Pool — `src/lib/mcp/`

```ts
class McpProviderPool {
  borrow(serverId: string): Promise<GracefulMcpProvider>
  release(serverId: string, provider: GracefulMcpProvider): void
  evict(serverId: string): Promise<void>
  startReaper(): void
  shutdown(): Promise<void>
}
```

**Lifecycle states for one entry.**

```
                 borrow (first miss)
nothing ──────────────────────────────► in-flight create
                                          │ resolved
                                          ▼
            ┌───────────────────────  active (refs > 0)  ◄────────────┐
            │                              │                            │
            │                          all releases                    borrow
            │                              │                            │
            │                              ▼                            │
            │                       idle (refs=0,  ───────► reaper ────►│
            │                       idleSince set)   waits idleTimeoutMs│
            │                                                          │
            ▼                                                           │
        evict()                                                         │
            │  refs > 0 ─► detached (entry removed; finishes on old)    │
            │                                                           │
            └─ refs = 0 ─► immediate close + remove ───────────────────►
                                                                  closed
```

**Key properties.**

- One transport per server, period. Refcounting ensures concurrent
  borrows share the same connection.
- `evict(id)` while a borrow is active **detaches** the entry: the
  current users keep using the old connection; the next `borrow()`
  opens a fresh one. The old connection is closed when its last
  release lands. This prevents "yank the rug under in-flight requests"
  failures during credential / config changes.
- The reaper runs on `reaperIntervalMs` (default 60 s) and closes
  entries that have been idle (`refs=0`) for `idleTimeoutMs` (default
  5 min). The interval is `unref()`'d so the reaper never keeps the
  Node process alive on its own.
- Concurrent first-time borrows for the same server share an in-flight
  creation Promise. Failed creates are **not** cached; the next borrow
  retries.

**Safety assumption.** The pool assumes every MCP server is
**connection-stateless** — tool calls do not depend on per-connection
state on the server side (current working directory, open transactions,
session affinity, …). This holds for the tools we ship: search APIs,
HTTP/REST bridges, read-only DB queries. If you add a stateful MCP
server, do NOT register it through this pool; build a per-call client
instead.

### 2.3 Skill Pool — `src/lib/skills/skill-pool.ts`

| Aspect | Value |
|---|---|
| Cardinality | One `SkillSpec` per `skillId`, shared across users |
| Eviction | LRU with `maxSize = 500` |
| Idle TTL | 10 minutes (in-progress refresh on hit) |
| Cost to build | 1 round-trip to disk (parse SKILL.md frontmatter), no upstream IO |
| Mutation triggers | API write, watcher upsert, manual sync — all funnel through `invalidateForSkillChange(skillId)` (`src/lib/skills/invalidation.ts`), which evicts the skill from this pool **and** invalidates every `agentPool` entry binding it (reverse-lookup via `builtin_agent_tool`) |

A `SkillSpec` is a parsed `SKILL.md` (frontmatter +
body) plus computed metadata (file checksum, runtime tools created
via `defineTool`). The pool is read-mostly and disk-bound; the LRU
cap is a memory ceiling rather than a contention strategy.

The pool is on the same lifecycle hooks as `agentPool` and
`mcpProviderPool` — see §4 below for the cross-pool invalidation
contract.

---

## 3. Per-Request Flow

```
GET/POST /api/copilotkit/builtin/[...path]
  │
  ├─ session = getSession()         (401 on miss)
  ├─ classify(url.pathname) → { agentId, action } | null
  │
  ├─ Authorize
  │     run/connect: isAgentVisibleTo(agentId, userId) || 404
  │     /info, /threads/*: agentIds = listVisibleAgentIds(userId)
  │                         (503 when empty)
  │
  ├─ For each agentId in the chosen set:
  │     spec = agentPool.get(agentId)
  │     if spec is null: skip silently  (race: just-disabled / dead credential)
  │     for tool in spec.tools where kind=="mcp_server":
  │         try provider = await mcpProviderPool.borrow(serverId)
  │              ledger.push({ serverId, provider })
  │         catch: log warn, agent runs without that tool
  │     agents[agentId] = new BuiltInAgent({...})
  │
  ├─ if agents map is empty: 503         (rare race: every spec returned null)
  │
  ├─ runtime = new CopilotRuntime({ agents })
  ├─ handleRequest = createCopilotRuntimeHandler({ runtime, basePath })
  │
  ├─ withTrace(...) when run/connect, else plain
  │     dispatch(req)
  │
  └─ finally:
        for each entry in ledger: mcpProviderPool.release(serverId, provider)
        await flushLangfuse()
```

The `finally` block must release every borrow regardless of dispatch
outcome. Double-release is tolerated by the pool (the entry's
`provider === provider` identity check rejects a stale release), but
keeping the ledger one-shot keeps refcount accounting auditable in
logs.

### 3.1 User-scoped tool catalog (workflow + chat shared factory)

`src/lib/builtin-tools/build-user-catalog.ts` exports
`buildUserToolCatalog(ownerId)` — the assembly point for the
server-side tool set both chat dispatch (per agent run, filtered to
the agent's bindings) and workflow execution (no agent context,
flat lookup by `node.tool`) consume. Returning the same
`defineTool`-produced `ToolDefinition` objects on both paths keeps
validation, errors, and side effects identical regardless of how a
tool was invoked.

Current entries:

- All catalog tools from `BUILTIN_TOOLS` (run_code_in_sandbox,
  web_search) — zero binding required.
- `extract_dataset_by_sql` — global by design; the data-source slug
  is a parameter and permission is checked inside `execute`.

Intentionally absent: SSH / Skills / MCP / supervisor tools are
all agent-binding-scoped today, and workflow scoping of those
needs a separate decision. The `ownerId` parameter on the factory
is pre-wired so binding-aware tool builders can join later without
breaking callers.

---

## 4. Invalidation Contract

Every write path that mutates a row referenced by either pool **must**
notify the pool. The cross-cutting helpers in
`src/lib/cache/invalidation.ts` package the right combination.

### 4.1 Helper Reference

```ts
// src/lib/cache/invalidation.ts

invalidateForCredentialChange(credentialId): Promise<void>
  // 1) agentPool.invalidateByCredential(credentialId)
  // 2) for every mcp_server WHERE credential_id = ?:
  //      mcpProviderPool.evict(id)

invalidateForMcpServerChange(mcpServerId): Promise<void>
  // 1) mcpProviderPool.evict(mcpServerId)
  // 2) for every distinct builtin_agent_tool.agent_id WHERE
  //      tool_type='mcp_server' AND mcp_server_id = ?:
  //      agentPool.invalidate(agentId)
```

### 4.2 Wiring Map

| Write path | Hook | Notes |
|---|---|---|
| `PATCH /api/admin/credentials/[id]` | `invalidateForCredentialChange(id)` + `invalidateCredentialCache()` | Order doesn't matter — UPDATE doesn't break FKs. |
| `DELETE /api/admin/credentials/[id]` | same | The route's 409 usage-precheck guarantees no rows reference the credential at this point, so the reverse-index queries return empty (correct no-op). |
| `POST /api/builtin-agents` | none | A fresh row cannot be in any cache. |
| `PATCH /api/builtin-agents/[id]` | `agentPool.invalidate(id)` | Tool-binding edits are part of the same row's lifecycle; this invalidate covers them. |
| `DELETE /api/builtin-agents/[id]` | `agentPool.invalidate(id)` | Order doesn't matter — `invalidate` is just a `Map.delete`. |
| `PATCH /api/mcp-servers/[id]` | `invalidateForMcpServerChange(id)` (after the UPDATE) | Any field can affect the cached transport (URL, headers, transport type, credential rebind). |
| `DELETE /api/mcp-servers/[id]` | `invalidateForMcpServerChange(id)` (**before** the DELETE) | `builtin_agent_tool.mcp_server_id` is `ON DELETE SET NULL`. After the delete, the reverse-index query returns zero dependent agents — invalidating before captures them. |

### 4.3 Order-of-Operations Rule

For every mutation that breaks an FK reference (`ON DELETE SET NULL`
or `CASCADE`), invalidate **before** the mutation. For mutations that
preserve references (UPDATE, INSERT), order is irrelevant.

There is one borderline case:
`/api/admin/credentials/[id]` DELETE has a 409 precheck that aborts
when *anything* still references the credential. Because the precheck
already ensures no dependents, the post-delete invalidate is a defensive
no-op — kept as a safety net in case the precheck is ever relaxed.

---

## 5. Operator Guide

### 5.1 Tunables

| Variable | Default | Effect |
|---|---|---|
| `AgentPool` `max` | 500 | Hard cap on cached agent specs. Each entry is a small POJO; 500 is generous for typical deployments. |
| `AgentPool` `ttl` | 10 min | Absolute upper bound on staleness. Can be lowered if you don't trust the invalidation hooks. |
| `McpProviderPool` `idleTimeoutMs` | 5 min | How long an unused MCP transport survives. Lower to reclaim faster, raise for bursty workloads. |
| `McpProviderPool` `reaperIntervalMs` | 60 s | Reaper poll cadence. |

Currently neither pool exposes these via env vars; change them at
construction time in `src/lib/builtin-agents/index.ts` /
`src/lib/mcp/index.ts` if needed.

### 5.2 Diagnosing "Why does my edit not take effect?"

Symptom: an admin edited a credential or MCP server and Built-in agent
behavior is still using the old value.

Checklist:

1. **Did the write path call the right hook?** Grep
   `invalidateFor*` near the route's mutation. Missing hook →
   change waits up to `ttl` (AgentSpec) or `idleTimeoutMs` (MCP) to
   self-heal.
2. **Is the caller inside the same Node process?** The pools are
   process-local. Multi-instance deployments with sticky sessions are
   fine; without sticky sessions, an invalidation on instance A does
   not reach instance B. The TTL bounds staleness regardless.
3. **MCP edit specifically:** check that the `evict` call ran *before*
   any DELETE on the row. Post-delete eviction queries can return
   zero dependents (FK already null'd).
4. **Credential edit specifically:** verify both
   `invalidateForCredentialChange` AND `invalidateCredentialCache` ran
   — they target two different caches (the spec pool vs. the
   credential lookup cache used by adapters).

### 5.3 SIGTERM / Graceful Shutdown

`McpProviderPool.shutdown()` is the SIGTERM handler. It:
- flips `shuttingDown = true`, so future `borrow()` calls reject;
- stops the reaper;
- closes every entry (in-flight borrows are released on the old
  connection then closed).

The route module does not currently wire this to a process signal;
deployments that care should add a `process.on('SIGTERM', ...)` handler
that awaits `mcpProviderPool.shutdown()`. CopilotRuntime objects are
per-request and need no shutdown.

### 5.4 Multi-Instance Considerations

> **v1 boundary:** Nango is a single-instance runtime — multi-replica
> auto-scaling is **not** a supported deployment shape (see AGENTS.md
> "Runtime boundary"). The notes below are forward-looking only; they
> describe what *would* break if someone bypassed the v1 boundary.

The `AgentSpec`, MCP, Skill, credential lookup and `EntityCatalog`
caches all live per process. Under multi-replica scale-out, every
cache entry can independently exist N times and invalidation hooks
reach only the instance that handled the write — TTL eventually
heals staleness, but the window is the per-cache TTL (mostly 10 min).
The pools' refcounting + reaper logic doesn't distribute cleanly over
a network, so the right fix if v1 boundary is ever lifted is a Redis
pub/sub (or PG `LISTEN/NOTIFY`) channel that broadcasts invalidate
calls — not a shared cache.

---

## 6. Test Coverage

| Layer | File | What it covers |
|---|---|---|
| Visibility | `tests/unit/lib/access/agent-visibility.test.ts` | `isAgentVisibleTo` truth table; `listVisibleAgentIds` projection |
| AgentSpec pool | `tests/unit/lib/builtin-agents/agent-pool.test.ts` | LRU semantics; null-not-cached; concurrent dedup; `invalidate*` variants; full spec hydration; tool-row mapping; dangling FK drop |
| MCP provider pool | `tests/unit/lib/mcp/provider-pool.test.ts` | borrow/release; concurrent dedup; reaper eviction; explicit evict (active vs idle); shutdown idempotence |
| Cross-cutting hooks | `tests/unit/lib/credentials/invalidation.test.ts` | both helpers; reverse-index empty-set behavior; agentId dedup |

End-to-end smoke tests of the route handler itself are intentionally
out of scope for the unit suite — the CopilotKit runtime needs a real
LLM credential to exercise meaningfully, so those run as part of the
deployment smoke checklist (build a session → send a message → swap
agent → delete agent + send → update credential + send).

---

## 7. Implementation Details and Quirks

### Agent Pool (`agent-pool.ts`)
- **Quirk (Re-enabling/Disabling):** `null` results from the loader are never cached. If a credential is dead or an agent is disabled, the next `get(id)` will re-fetch it from the DB. This deliberate design ensures that re-enabling an agent or fixing a credential takes effect immediately without waiting for TTL.
- **Contract:** Concurrent `get(id)` calls share one in-flight loader Promise. Thundering herd is prevented natively by `lru-cache`.
- **Invalidation order:** To invalidate properly, you call `invalidateByCredential` which performs a reverse-index `SELECT` on `builtin_agent.credential_id`. The cost scales with the number of dependent agents, not the cache size.

### MCP Provider Pool (`provider-pool.ts`)
- **Quirk (Thundering herd deduplication):** Concurrent first-time `borrow()` calls share the same in-flight creation Promise.
- **Quirk (Re-check on await):** After `await pending`, the pool re-checks the state in the synchronous turn to prevent races where another borrower may have installed an entry or `evict()` re-detached it.
- **Quirk (Reaper interval):** The interval handle is explicitly `unref()`'d. The background reaper never keeps the Node process alive on its own.
- **Quirk (Snapshot iteration):** The reaper uses snapshot iteration `[...this.entries]` because it deletes items from the map inside the loop.

### Credential Lookup Cache (`credentials/lookup.ts`)
- **Quirk (Fallback Strategy):** When multiple enabled credentials exist for the same provider, the most-recently-created wins. This guarantees deterministic behavior.
- **Quirk (Decryption Failure):** A decryption error typically means the encryption key changed (rotation without re-encrypt) or the row is corrupted. Such errors are explicitly logged.
- **Quirk (Lazy load / TTL):** Also operates on a 10-minute TTL, similar to the agent-pool. Write paths explicitly call `invalidateCredentialCache()` after mutations.
