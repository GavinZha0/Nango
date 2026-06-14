# Data Source Integration Layer

> Audience: backend engineers building data-driven agent capabilities, contributors adding new database sources
> See also: `docs/architecture.md` §3.3, `docs/sandbox.md`

The data source integration layer is one of the three peer integration layers in Nango (`docs/architecture.md` §3.3). It hides the wire-protocol and dialect diversity of upstream databases (MySQL, Postgres, Vertica, …) behind a single typed contract and produces **Parquet files** as the materialised output. The sandbox layer reads those Parquet files; the two layers never call each other directly.

This document describes the implemented design. Phases D-1, D-2 (with sub-phases D-2.1 through D-2.4), and D-3 have all landed; the layer ships with Postgres / MySQL / MariaDB / Vertica adapters, a CRUD UI, and an agent-binding flow (see §6).

---

## 1. Goals and non-goals

### Goals

- One uniform interface (`IDataSourceAdapter`) that lets the agent runtime extract data from any registered source without knowing the protocol.
- Parquet as the only on-disk format. Every adapter, regardless of its source format, writes Parquet under `<repoRoot>/.cache/datasource/`.
- Cache sharing across users and threads when the source data has no row-level security: the second user asking for "Q1 sales" reuses the file the first user materialised.
- A clear ownership story: the layer owns Parquet files (creation, TTL, eviction); the sandbox layer is a pure reader.
- Compile-time enforcement that every registered adapter id has an actual implementation (the same `satisfies Record<…>` trick used by the agent provider registry).

### Non-goals (V1)

- Live streaming / change-data-capture. V1 is **pull-on-demand snapshots** with TTL.
- Cross-source joins at the SQL layer. Joining `mysql.orders` with `vertica.products` happens inside the sandbox via DuckDB attaching multiple Parquet files, not via federated SQL.
- Row-level security replication. Sources with RLS opt out of the shared cache (per-user materialisation only).
- Write-back to source databases. Adapters are read-only; data is pulled out, never pushed back.
- Schema evolution / migration tooling. If the upstream `sales` table grows a column, agents see it on the next cache refresh.

---

## 2. The contract

### Core Types

| Interface | Purpose | Key Fields/Methods |
|---|---|---|
| `ColumnSchema` | Describes a Parquet column | `name`, `type`, `nullable` |
| `DatasetSchema` | Describes a dataset | `columns`, `total_rows`, `byteSize` |
| `ExtractInput` | Input to extraction | `datasetName`, `query`, `outputPath`, `timeoutMs`, `maxRows` |
| `ExtractResult` | Result of extraction | `schema`, `queryHash` |
| `IDataSourceAdapter` | Adapter interface | `id`, `displayName`, `testConnection()`, `extract()` |

Two design choices in this contract:

1. **The adapter receives `credentialId`, not credentials.** The adapter calls `getCredentialConfigById(credentialId)` itself (the existing decryption helper) and thus stays inside the server-only boundary. This mirrors `IBackendAdapter`.
2. **Output path is supplied by the caller, not chosen by the adapter.** The cache layer (described in §4) is the path authority; the adapter is told where to write. This decouples cache key strategy from adapter implementation.

---

## 3. Per-source provider module

Like the agent layer, each data source ships a `BackendModule` aggregator:

```
src/lib/data-sources/
  types.ts                          # IDataSourceAdapter, ExtractInput, ExtractResult, ...
  registry.server.ts                # SOURCES satisfies Record<DataSourceId, DataSourceModule>
  cache.ts                          # Parquet cache layout + TTL + naming (§4)
  cache-meta.ts                     # cache_meta.duckdb writer/reader (optional, §4.4)
  providers/
    postgres/
      adapter.ts                    # client-safe metadata
      extract.server.ts             # node-postgres + duckdb COPY → parquet
      index.server.ts               # exports postgresSource: DataSourceModule
    mysql/
      adapter.ts
      extract.server.ts             # mysql2 + duckdb COPY → parquet
      index.server.ts
    vertica/
      adapter.ts
      extract.server.ts             # vertica-nodejs + parquetjs (no duckdb support)
      index.server.ts
```

Each provider module exposes a static client-safe descriptor (`adapter.ts`) and a server-only extractor (`extract.server.ts`). The same client-safe-vs-server-only split protects credential decryption from the browser bundle.

### 3.1 The DuckDB-backed extraction shortcut

For sources with DuckDB native scanner extensions (Postgres, MySQL, SQLite), the adapter uses DuckDB to directly query the source and write Parquet in a single streaming operation. This gives us:
- Streaming end-to-end (low memory)
- Type preservation
- Optimised row group sizing


Three things this gives us for free:

- Streaming end-to-end: DuckDB reads from Postgres in batches, writes Parquet without ever materialising the full result in memory.
- Type preservation: DuckDB maps Postgres types to Arrow types and emits a faithful schema in the Parquet metadata.
- Row group sizing: the `ROW_GROUP_SIZE 100000` hint optimises later DuckDB queries at the sandbox layer.

### 3.2 The custom-adapter path (e.g. Vertica)

For sources without DuckDB extensions (e.g. Vertica), the adapter uses the native Node client to fetch the full result into memory, writes it to an intermediate NDJSON file, and then uses DuckDB to convert NDJSON to Parquet. This path accepts costs in memory, CPU, and type fidelity but provides identical Parquet output to the agent.


Costs we accept in V1:

- Memory: full result set lives in V8 heap (vertica-nodejs is buffer-driven, not streaming).
- CPU: N rows × `JSON.stringify` + DuckDB JSON parse.
- I/O: NDJSON written then re-read (double disk pass).
- Type fidelity: `read_json_auto` infers from JSON sample — `TIMESTAMPTZ` and high-precision `DECIMAL` round-trip to `VARCHAR` / lossy numerics.

The same `IDataSourceAdapter` contract and the same Parquet output the runtime sees, so agents that consume Vertica datasets are not aware of the intermediate path. See §6 (Future work) for the trigger that ends this shortcut.

### 3.3 What the agent calls

Adapters are not invoked by agents directly. The agent runtime exposes a tool (provisional name, finalised in phase 4):

| Parameter | Description |
|---|---|
| `dataset_name` | The target slot name. |
| `data_source_name` | The LLM-facing slug for the data source. |
| `sql_text` | The query. |
| `row_limit` | Optional limit for inline preview. |
| `force_refresh` | Optional flag to bypass cache. |

The LLM-facing surface is intentionally minimal: `dataset_name` /
`data_source_name` / `sql_text` carry the task semantics;
`row_limit` / `force_refresh` cover the two cases where the agent
has a value-add decision (inline peek vs. sandbox-only, fresh
fetch vs. cached). System bounds — wall-clock budget, row
ceiling, default TTL — live in env vars
(`DATA_EXTRACT_TIMEOUT_MS`, `DATA_EXTRACT_MAX_ROWS`,
`DATA_EXTRACT_DEFAULT_TTL_HOURS`) so the LLM is not asked to
invent a number it has no signal to choose.

`rows` is delivered as a row-of-objects array
(`Record<columnName, cellValue>[]`); `returned_rows` is the
number of rows actually carried (≤ `row_limit`, ≤ the server
preview byte budget). When `returned_rows < total_rows` the
result was truncated — agents read the full dataset from the
parquet handle via `run_code_in_sandbox.datasets[]`.

The tool is implemented in the data-sources layer; it consults the cache (§4), invokes the adapter on cache miss, and returns the **virtual** mount path (`./data/...`) so the agent's next call to `run_in_sandbox` can mount it without leaking the host path.

---

## 4. Parquet cache

The cache is a host-filesystem region under `<repoRoot>/.cache/datasource/` owned by this layer. The sandbox layer is a pure reader and never modifies the cache.

### 4.1 Layout

```
<repoRoot>/.cache/datasource/
  parquet/
    sales_q1_2025/
      part-001.parquet                  ← single-file dataset (small / scalar tables)
    sales/
      year=2025/quarter=Q1/             ← Hive-style partitioned dataset
        part-001.parquet
        part-002.parquet
      year=2025/quarter=Q2/
        part-001.parquet
  cache_meta.duckdb                     ← optional, see §4.4
```

`datasetName` may map to either layout. Adapters writing partitioned output emit one Parquet file per partition; adapters writing scalar results emit a single file. The mount path the sandbox sees is always the **directory**, so DuckDB's `read_parquet('./data/<name>/**/*.parquet')` works regardless.

### 4.2 Naming and uniqueness — name is a SLOT

- `datasetName` is the cache key. Agent picks it; convention is `{source}_{scope}_{time}` (kebab- or snake-case).
- Names are validated: `^[a-z0-9][a-z0-9_-]{0,127}$`. Path traversal is impossible by construction.
- **A name is a slot, not an identifier.** Re-extracting under the same name with a DIFFERENT query is a slot reassignment, not an error. The cache stores the canonicalised `query_hash`; on hash mismatch the new snapshot replaces the prior bytes on disk via `commitWriteSlot`'s atomic `rm -rf + rename`. The tool result returns `replaced_prior: true` so the agent knows the prior data is gone.
- Re-extracting with the SAME query is a cache hit (`cache_hit: true`, no source roundtrip) — same as before.
- **Why slot semantics?** LLMs treat names as variables (`customers`, `recent_orders`), not as durable identifiers; the alternative (fail-fast on hash mismatch) traps the LLM after a restart when it has no memory of prior session names, and trapped the agent mid-conversation when it naturally wanted to "rebind" a slug to a refined query. The slot-reassignment model matches every programming language's variable semantics — no concept to learn.
- **Defence still in place:** in-flight readers of `./data/<name>/...` in another sandbox process keep their bytes via the OS's open-FD and page-cache semantics (POSIX: a deleted file referenced by an open FD stays alive); only NEW sandbox runs see the replaced bytes. Atomic `rename(tmp, final)` means there's no half-state window for fresh readers either.

### 4.3 TTL and invalidation

Each dataset carries a `ttl_hours`. The cache check is:

```
exists(parquet/<name>/) AND (now - created_at) < ttl_hours * 3600s
```

On expiry the cache transparently re-extracts from the source. There is **no** background eviction job — disk cleanup happens on Node boot (see §4.3.1) and lazily on stale-name access. A simple admin endpoint `POST /api/admin/data-cache/sweep` removes any directory older than its TTL.

### 4.3.1 Cache lifecycle = process lifetime

Every Node boot calls `purgeAllDatasets()` from `instrumentation.ts` before serving any request. This wipes `<cacheRoot>/parquet/` clean and pins the dataset cache to the lifetime of the current Node process — restart Nango and the cache starts empty.

Two operational problems disappear under this rule:

1. **Disk accumulation.** With no background GC, naive TTL semantics let cache files grow monotonically across the life of a long-running server / chain of restarts. Boot-time sweep gives us a deterministic upper bound: at most one process-worth of extractions on disk at any moment.



Implications:

- **In-flight extractions across boot are not preserved.** If Node restarts mid-extraction, the half-written `.tmp-<name>-<uuid>/` directory is swept along with everything else. The next call starts fresh — which is what an idempotent extract should do anyway.
- **Cache hits within a session still work as before.** TTL governs the in-session refresh decision; the boot sweep only governs what survives a Node restart (answer: nothing).
- **Multi-process deployments are NOT supported** by this design. Nango is a single-node multi-tenant runtime (see `docs/architecture.md` §"Runtime boundary"); two Node workers sharing one cache_root would race the boot sweep and clobber each other's freshly-written datasets. If you need to run multiple workers, give each its own `datasource.cache_root` config — but you should first read the runtime-boundary section about why that's not a supported topology in V1.
- **Docker sandbox mode is unaffected.** The cache is a host filesystem path; both subprocess (symlink) and local-docker (bind-mount) adapters resolve `./data/<name>/` to the same swept directory.

### 4.4 Metadata: file convention vs `cache_meta.duckdb`

Two implementations are possible:

| | File convention only | `cache_meta.duckdb` |
|---|---|---|
| Source of truth | directory mtime + sidecar `<name>.meta.json` | DuckDB row |
| Atomic write | `rename(tmp, final)` | transaction |
| List operation | `readdir` + parse N JSON files | `SELECT * FROM datasets` |
| Schema cache | embedded in Parquet metadata, re-introspected on each list | column persisted |

V1 will use **file convention only**. `cache_meta.duckdb` is mentioned for completeness; it becomes worthwhile only when the dataset count exceeds a few hundred or queries grow more sophisticated. The interface in `cache.ts` will be designed so `cache_meta.duckdb` can be added later without changing call sites.

### 4.5 Concurrency: two extractions of the same dataset

Two agents may trigger an extraction for the same `datasetName` simultaneously. The cache layer uses **atomic rename** to make the race benign:

```
1. Adapter writes to <repoRoot>/.cache/datasource/parquet/<name>.tmp-<uuid>/
2. On success: rename(tmp, final)  ← atomic
3. The loser detects the final dir already exists, deletes its tmp.
4. Both agents proceed reading the winner's output.
```

No locking; no in-process coordination. The same idiom we use in the skill builtin reconcile (`docs/skills.md` §3.4).

### 4.6 Multi-tenancy and sharing

Default policy: **shared across users and threads** for any source whose `credential` row has `dataIsolation: "shared"` (a new field, default `shared`). The agent's question is treated as "give me the *data*", not "give me *my* data".

Sources with row-level security or per-user pricing (e.g., a SaaS API where the same query returns different rows per user) set `dataIsolation: "per-user"`. The cache layout extends to:

```
<repoRoot>/.cache/datasource/parquet/<name>/         ← shared
/data/per-user/<userId>/parquet/<name>/    ← per-user
```

Adapter implementations are unchanged; only the cache key composition differs. The decision is per-credential at registration time and is immutable thereafter.

---

## 5. Credential model

Reuses the existing `credential` table:

| Column | Used as | Notes |
|---|---|---|
| `serviceType` | `"database"` | New value alongside the existing `agent` / `llm` / `search` |
| `provider` | `DataSourceId` | `"postgres"`, `"mysql"`, `"vertica"`, ... |
| `name` | UI display | per-credential nickname (`"vertica_prod"`) |
| `secrets` (JSON) | connection config | `{ host, port, user, password, database, sslMode, ... }` |
| `metadata` (JSON, new) | dataset policy | `{ dataIsolation: "shared" \| "per-user", defaultTtlHours: 24 }` |

A new admin form under `/admin/credentials` validates the JSON shape per `provider` (each adapter exposes a Zod schema for its `secrets` and `metadata`).

---

### Future / out-of-scope for V1

- BigQuery / Snowflake / ClickHouse adapters.
- `cache_meta.duckdb` migration if dataset count justifies it.
- Background TTL sweeper.
- Per-user data isolation flow end-to-end.
- Adapter "describe" endpoint for introspection.
- Streaming / CDC sources.
- **Unify non-DuckDB adapters on `odbc_scanner`:** When DuckDB's `odbc_scanner` becomes a core extension, migrate custom adapters (like Vertica) to use a shared ODBC factory. This will eliminate Node-side drivers, buffering, and NDJSON round-trips.

---

## 7. Hard invariants

1. **Adapters are read-only on the source.** No `INSERT` / `UPDATE` / `DELETE`. The layer never writes back. SQL containing those keywords is rejected at parse time.
2. **Parquet is the only on-disk format.** No CSV, no JSON-lines, no SQLite caches. Agents see one storage format everywhere.
3. **The cache directory is owned by this layer.** The sandbox layer mounts it read-only and never writes to it.
4. **Adapter call sites pass `credentialId`, not credentials.** Decryption happens inside the adapter implementation, behind `import "server-only"`.
5. **Atomic rename is the only mutation primitive.** Half-written Parquet files never become visible to readers.
6. **Adapter `extract` honours `signal` and `timeoutMs`.** A cancelled or slow query must not leak a connection or a half-written file.
