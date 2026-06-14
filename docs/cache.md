# Cache Layer — Architecture and Invalidation

> Audience: backend engineers and operators
> See also: `docs/builtin-runtime.md` (per-request flow, pool contracts, operator tunables)

---

## 1. Overview

Nango maintains six process-wide caches to avoid redundant DB queries,
credential decryption, and upstream API calls on the hot chat path. The
caches use two implementation patterns:

| Pattern | Implementation | What it caches |
|---|---|---|
| **Data cache** | [`lru-cache`](https://www.npmjs.com/package/lru-cache) v11 | Pure data — specs, configs, entity lists, thread state |
| **Connection pool** | Custom refcount + idle reaper | Stateful external connections (MCP WebSocket / HTTP) |

Five data caches share the `lru-cache` library. One connection pool
(`McpProviderPool`) uses a custom implementation because stateful
resources require reference counting and graceful drain — patterns
that TTL/LRU eviction cannot provide.

---

## 2. The Six Caches

### 2.1 Credential Lookup

| Aspect | Value |
|---|---|
| File | `src/lib/credentials/lookup.ts` |
| Type | 4 `LRUCache` instances (configById, fieldsById, agentCredentials, observability) |
| Key | credentialId (per-id caches) or singleton key (list/observability caches) |
| TTL | 10 min |
| Eviction | Full-clear on any credential write via `invalidateCredentialCache()` |
| Subscribers | `onCredentialCacheInvalidated()` — Langfuse client rebuilds on clear |

Four sub-caches serve different query patterns:

- `configByIdCache` — `getCredentialConfigById(id)`, the general-purpose lookup.
- `fieldsByIdCache` — `getCredentialFieldsById(id)`, full decrypted payload for multi-field credentials.
- `agentCredentialsCache` — `getAllAgentCredentials()`, singleton list of all enabled agent credentials.
- `observabilityCredentialCache` — `getEnabledObservabilityCredential()`, singleton Langfuse config.

**Security note.** `getAgentCredentialConfigById()` intentionally
bypasses the cache on read. It is the security gate for chat dispatch
endpoints, enforcing `serviceType = 'agent'` and `isSupportedBackend()`
— constraints that the generic `configByIdCache` cannot guarantee. The
`cache.set()` at the end is a warm-up side-effect for
`getCredentialConfigById()` callers only.

**Cross-cache fill.** `getAllAgentCredentials()` populates both
`agentCredentialsCache` and `configByIdCache` in one pass, so
subsequent per-id lookups hit without a DB round-trip.

### 2.2 Agent Pool

| Aspect | Value |
|---|---|
| File | `src/lib/builtin-agents/agent-pool.ts` |
| Type | `LRUCache<string, AgentSpec>` with `fetchMethod` |
| Key | agentId (UUID) |
| Max | 500 |
| TTL | 10 min |
| Load cost | DB query + credential decryption + tool binding resolution (3 IOs) |

An `AgentSpec` holds the decrypted API key, prompt, temperature,
maxTokens, and a polymorphic `AgentToolRef[]` decoded from the
`builtin_agent_tool` junction table.

Key properties:
- `null` results from the loader are **not** cached. Re-enabling an
  agent or fixing a credential takes effect immediately.
- Concurrent `get(id)` calls share one in-flight loader Promise
  (`fetchMethod` built-in dedup). No thundering herd.
- `invalidateByCredential(credentialId)` does a reverse-index SELECT
  on `builtin_agent.credential_id` and drops only matching entries.

See `docs/builtin-runtime.md` §2.1 for full contract.

### 2.3 MCP Provider Pool

| Aspect | Value |
|---|---|
| File | `src/lib/mcp/provider-pool.ts` |
| Type | Custom: reference-counted entries + idle reaper + graceful drain |
| Key | mcpServerId (UUID) |
| Idle timeout | 5 min |
| Reaper interval | 60 s |

The only cache managing **stateful external connections**. Cannot use
TTL/LRU eviction — closing a connection mid-use breaks in-flight tool
calls.

Lifecycle:

```
borrow (first miss) → in-flight create → active (refs > 0)
                                              │
                              all releases    │    borrow
                                  ↓           │       │
                            idle (refs=0)  ───+───────┘
                                  │
                    reaper (idleTimeoutMs) → close
                                  │
                   evict() while refs > 0 → detached (draining)
                   evict() while refs = 0 → immediate close
```

Key properties:
- `evict(id)` while borrowed **detaches** the entry: current users
  keep the old connection; the next `borrow()` opens a fresh one. The
  old connection closes when its last release lands.
- Concurrent first-time borrows share one in-flight creation Promise.
- The reaper handle is `unref()`'d — never keeps the Node process alive.

See `docs/builtin-runtime.md` §2.2 for full contract.

### 2.4 Skill Pool

| Aspect | Value |
|---|---|
| File | `src/lib/skills/skill-pool.ts` |
| Type | `LRUCache<string, SkillSpec>` with `fetchMethod` |
| Key | skillId (UUID) |
| Max | 500 |
| TTL | 10 min |
| Load cost | DB read + SKILL.md frontmatter parse |

Structurally identical to Agent Pool. A `SkillSpec` holds the parsed
SKILL.md, frontmatter metadata, source (`builtin` | `local`), and
visibility/enabled flags.

See `docs/builtin-runtime.md` §2.3 for full contract.

### 2.5 Entity Catalog

| Aspect | Value |
|---|---|
| File | `src/lib/backends/entity-catalog.ts` |
| Type | `LRUCache<string, EntityDescriptor[]>` with `fetchMethod` |
| Key | credentialId (UUID) |
| Max | 100 |
| TTL | 10 min |

Caches the list of backend entities (agents, teams, workflows)
discovered from upstream platforms (agno, Mastra, Dify). Used by the
UI entity list, supervisor agent catalog, and schedule validation.

Return value semantics:
- `null` — credential missing/disabled (not cached, next call retries).
- `[]` — credential valid but has no entities (cached).

**Invalidation during in-flight fetch.** `lru-cache` aborts an
in-flight `fetchMethod` when `cache.delete()` is called. The
`ignoreFetchAbort: true` option ensures the original caller still
receives its result. A new caller after the `delete()` starts a fresh
fetch — this is intentional: the second caller picks up any credential
changes that triggered the invalidation.

### 2.6 Thread State

| Aspect | Value |
|---|---|
| File | `src/lib/backends/thread-state.server.ts` |
| Type | `LRUCache<string, CacheEntry>` (no TTL) |
| Key | `${credentialId}:${threadId}` |
| Max | 5,000 |
| Persistence | `backend_thread_state` table (source of truth) |

Write-through cache for per-thread upstream-session tokens (today:
Dify `conversation_id`). The process is the single writer, so no TTL
is needed — the cache is always authoritative within the process
lifetime.

Key properties:
- True LRU eviction via `lru-cache` — frequently-accessed conversations
  are never evicted ahead of idle ones.
- `cache.get()` on read automatically promotes the entry to
  most-recently-used.
- Writes update the cache synchronously, then persist to DB
  asynchronously (fire-and-forget). A DB failure does not block the
  chat stream.

### 2.7 HMR survival — `globalThis` pinning

To survive Next.js dev server Hot Module Replacement (HMR), all module-scope mutable singletons (caches, connection pools, clients) are pinned to `globalThis` (e.g., `globalThis.__nangoAgentPool`). This prevents memory leaks and stale connections during development.
### 2.8 OAuth Token Manager

Manages access tokens for the OAuth 2.0 Client Credentials grant.

| Property | Behavior |
|---|---|
| **Refresh** | Lazy refresh on first call, auto-refresh within 60s of expiry. No background timers. |
| **Concurrency** | Multiple callers await the same in-flight fetch. |
| **Invalidation** | Listens to credential cache clears to apply admin edits immediately. |

---

## 3. Invalidation

### 3.1 Unified Entry Point

All cascade invalidation functions live in `src/lib/cache/invalidation.ts`.
API write routes call exactly **one** `invalidateFor*` function per
write — no additional calls needed.

```
src/lib/cache/invalidation.ts
├── invalidateForCredentialChange(credentialId)
├── invalidateForMcpServerChange(mcpServerId)
├── invalidateForSkillChange(skillId)
├── invalidateForDataSourceChange(dataSourceId)
├── invalidateForSshServerChange(sshServerId)
└── invalidateForAgentChange(agentId)
```

Backward-compatible re-export shims exist at the old import paths
(`credentials/invalidation.ts`, `skills/invalidation.ts`) so existing
code continues to work.

### 3.2 Cascade Topology

Each function uses **reverse-index queries** on the `builtin_agent_tool`
junction table to find dependent agents, then invalidates precisely
those entries — cost scales with the number of dependents, not the
cache size.

```
invalidateForCredentialChange(credentialId)
  ├─ invalidateCredentialCache()              clears 4 lookup caches + notifies subscribers
  ├─ EntityCatalog.invalidate(credentialId)   drops entity list for this credential
  ├─ agentPool.invalidateByCredential(id)     reverse-index: all agents bound to credential
  └─ mcpProviderPool.evict(serverId)          for each MCP server bound to the credential

invalidateForMcpServerChange(mcpServerId)
  ├─ mcpProviderPool.evict(mcpServerId)       closes/detaches the MCP connection
  └─ agentPool.invalidate(agentId)            for each agent binding that MCP server

invalidateForSkillChange(skillId)
  ├─ skillPool.invalidate(skillId)            drops the SkillSpec
  └─ agentPool.invalidate(agentId)            for each agent binding that skill

invalidateForDataSourceChange(dataSourceId)
  └─ agentPool.invalidate(agentId)            for each agent binding that data source

invalidateForSshServerChange(sshServerId)
  └─ agentPool.invalidate(agentId)            for each agent binding that SSH server

invalidateForAgentChange(agentId)
  └─ agentPool.invalidate(agentId)            direct single-entry drop
```

### 3.3 Order-of-Operations Rule

For mutations that break FK references (`ON DELETE SET NULL` or
`CASCADE`), invalidate **before** the mutation. After a delete, the
reverse-index query would return zero dependents — invalidating first
captures them.

For mutations that preserve references (UPDATE, INSERT), order is
irrelevant.

```ts
// DELETE MCP server — FK is ON DELETE SET NULL
await invalidateForMcpServerChange(id);   // BEFORE delete
await db.delete(McpServerTable).where(eq(McpServerTable.id, id));

// PATCH credential — FK preserved
const [row] = await db.update(CredentialTable).set(updates).where(...);
await invalidateForCredentialChange(id);  // AFTER update (order doesn't matter)
```

### 3.4 Reverse-Index Queries

All cascade functions query the `builtin_agent_tool` junction table to find agents bound to the changed resource, deduplicate the `agentId`s, and selectively invalidate those agents in the `agentPool`.

### 3.5 Subscriber Pattern

`invalidateCredentialCache()` notifies registered subscribers after clearing. For example, the Langfuse client singleton listens to this event to rebuild itself when the observability credential changes.

---

## 5. Pattern Selection Rationale

Why each cache uses its specific pattern — recorded so future
maintainers understand which constraints drove each choice.

### 5.1 When to Use `lru-cache` + TTL + `fetchMethod`

**Use for**: pure data with expensive load, many possible keys,
and a need for memory bounds.

- `fetchMethod` provides transparent load-on-miss and concurrent
  dedup (no thundering herd).
- `max` bounds memory. `ttl` ensures staleness is time-bounded even
  if explicit invalidation is missed.
- `null`/`undefined` returns from `fetchMethod` are not cached —
  transient failures auto-retry on the next call.

**Used by**: Agent Pool, Skill Pool, Entity Catalog.

### 5.2 When to Use `lru-cache` Without TTL

**Use for**: write-through caches where the process is the single
writer and external mutation is impossible.

- No TTL needed — the cache is always authoritative within the
  process lifetime.
- LRU eviction still needed to bound memory.

**Used by**: Thread State.

### 5.3 When to Use `lru-cache` for Simple TTL (No `fetchMethod`)

**Use for**: caches with multiple query patterns that share the same
backing store, where a single `fetchMethod` can't serve all shapes.

- Manual `get()` + `set()` with library-managed TTL eliminates
  hand-written `isFresh()` checks.
- Full-clear invalidation (`cache.clear()`) is appropriate when the
  entry count is small and writes are rare.

**Used by**: Credential Lookup (4 sub-caches).

### 5.4 When to Use Custom Refcount + Drain

**Use for**: stateful external connections that cannot be closed while
in use.

- TTL/LRU eviction would close connections mid-request.
- Reference counting tracks active users; `evict()` detaches the
  entry so current users keep the old connection while new borrows
  get a fresh one.
- Idle reaper cleans up connections that have been unused for
  `idleTimeoutMs`.

**Used by**: MCP Provider Pool.

---

## 6. File Layout

```
src/lib/
├── cache/
│   ├── invalidation.ts         All 6 invalidateFor* cascade functions
│   ├── health.ts               CacheHealthReport aggregation
│   └── index.ts                Public re-exports
│
├── credentials/
│   ├── crypto.ts               AES-256-GCM encrypt/decrypt
│   ├── lookup.ts               4 LRUCache sub-caches + subscriber pattern
│   └── invalidation.ts         Re-export shim → cache/invalidation.ts
│
├── builtin-agents/
│   ├── agent-pool.ts           LRUCache<string, AgentSpec> + fetchMethod
│   └── index.ts                Singleton export
│
├── mcp/
│   ├── provider-pool.ts        Custom refcount + idle reaper
│   └── index.ts                Singleton export + startReaper()
│
├── skills/
│   ├── skill-pool.ts           LRUCache<string, SkillSpec> + fetchMethod
│   ├── invalidation.ts         Re-export shim → cache/invalidation.ts
│   └── index.ts                Singleton export
│
└── backends/
    ├── entity-catalog.ts       LRUCache + fetchMethod + ignoreFetchAbort
    └── thread-state.server.ts  LRUCache (no TTL)
```

All caches and the `langfuse` / `oauth-token-manager` singletons are
pinned to `globalThis` for HMR survival — see §2.7.

### 6.1 Naming Conventions

Cache files use **role-based** suffixes that reflect abstraction, not
caching strategy:

| Suffix | Meaning | Files |
|---|---|---|
| `-pool` | 1:1 resource pool: `get(id)` → single spec or connection | `agent-pool.ts`, `skill-pool.ts`, `provider-pool.ts` |
| `-catalog` | 1:N discovery: `list(credentialId)` → array of descriptors | `entity-catalog.ts` |
| `-state` | Write-through store: process writes and reads its own data | `thread-state.server.ts` |
| `lookup` | Multi-query lookup: several functions, different WHERE clauses | `lookup.ts` |

---

## 7. Observability

### 7.1 Health Endpoint

`GET /api/admin/cache-stats` (admin-only) returns a JSON snapshot of
all six caches:

```json
{
  "agentPool":        { "size": 8,  "max": 500 },
  "skillPool":        { "size": 5,  "max": 500 },
  "mcpPool":          { "active": 3, "creating": 0, "draining": 0 },
  "entityCatalog":    { "size": 2,  "max": 100 },
  "credentialLookup": { "config": 12, "fields": 4, "agents": 1, "observability": 1 },
  "threadState":      { "size": 127, "max": 5000 }
}
```

Aggregation is in `src/lib/cache/health.ts`. Each cache module
exposes `_size()`, `_cacheSize()`, `_cacheSizes()`, or `_inspect()`
for this purpose.

### 7.2 Diagnosing "Why Does My Edit Not Take Effect?"

1. **Did the write path call the right hook?** See §4 Wiring Map.
   Missing hook → change waits up to `ttl` (10 min) to self-heal.
2. **Is the caller inside the same Node process?** Caches are
   process-local. See §8 for multi-instance considerations.
3. **MCP edit specifically:** check that `evict()` ran **before** any
   DELETE on the row (§3.3 order rule).
4. **Check `/api/admin/cache-stats`:** verify cache sizes are
   reasonable. A `size: 0` after a recent write confirms invalidation
   fired.

---

## 8. Constraints and Future Considerations

### 8.1 Single-Instance Assumption

All six caches are process-local. Nango v1 is a single-instance
runtime — multi-replica auto-scaling is **not** a supported deployment
shape (see AGENTS.md "Runtime boundary").

If the v1 boundary is lifted, invalidation hooks reach only the
instance that handled the write. TTL eventually heals staleness, but
the window is 10 min. The recommended fix is `PG LISTEN/NOTIFY` or
Redis pub/sub to broadcast invalidate calls — NOT a shared cache. The
pools' refcounting and reaper logic do not distribute cleanly over a
network.

### 8.2 Tunables

| Cache | Parameter | Default | Effect |
|---|---|---|---|
| Agent Pool | `max` | 500 | Hard cap on cached agent specs. |
| Agent Pool | `ttl` | 10 min | Upper bound on staleness. |
| Skill Pool | `max` | 500 | Hard cap on cached skill specs. |
| Skill Pool | `ttl` | 10 min | Upper bound on staleness. |
| Entity Catalog | `max` | 100 | Hard cap on per-credential entity lists. |
| Entity Catalog | `ttl` | 10 min | Upper bound on staleness. |
| Credential Lookup | `max` | 200 (per sub-cache) | Hard cap on cached credentials. |
| Credential Lookup | `ttl` | 10 min | Upper bound on staleness. |
| Thread State | `max` | 5,000 | Hard cap on cached thread entries. |
| MCP Pool | `idleTimeoutMs` | 5 min | How long an unused MCP connection survives. |
| MCP Pool | `reaperIntervalMs` | 60 s | Reaper polling cadence. |

Currently none of these are exposed via env vars. Change them at
construction time in the respective module if needed.

