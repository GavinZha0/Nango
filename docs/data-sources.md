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

```ts
// src/lib/data-sources/types.ts

/** Stable string id used for registry lookup ("mysql", "postgres", "vertica", ...). */
export type DataSourceId = string;

/** Schema describing a single Parquet column, used by adapters that
 *  preserve type fidelity (Postgres `numeric`, Vertica `LONG VARCHAR`, ...). */
export interface ColumnSchema {
  name: string;
  type: "bool" | "int32" | "int64" | "float32" | "float64"
      | "string" | "timestamp" | "date" | "decimal" | "binary";
  nullable: boolean;
  description?: string;
}

export interface DatasetSchema {
  columns: ColumnSchema[];
  rowCount: number;
  byteSize: number;
}

export interface ExtractInput {
  /** Stable cache key — the dataset identity. */
  datasetName: string;
  /** SQL the adapter executes against the source. Adapter is free to
   *  rewrite for dialect compatibility; the result must match the SQL's
   *  semantics from the agent's perspective. */
  query: string;
  /** Optional bound parameters; safer than string interpolation. */
  params?: Record<string, string | number | boolean | null>;
  /** Where to write the Parquet output. */
  outputPath: string;
  /** Hard time budget. Adapter MUST cancel if exceeded. */
  timeoutMs: number;
  /** Hard row cap; adapter aborts if exceeded. */
  maxRows: number;
  /** AbortSignal plumbed through cancellable network clients. */
  signal: AbortSignal;
}

export interface ExtractResult {
  schema: DatasetSchema;
  /** sha256 of the canonicalised query text — used for cache-key composition. */
  queryHash: string;
}

export interface IDataSourceAdapter {
  /** Stable id matching `credential.provider` for sources of `serviceType="database"`. */
  readonly id: DataSourceId;

  /** Human-readable display name for the UI / logs. */
  readonly displayName: string;

  /** Quick connectivity probe; called by admin "Test connection" button. */
  testConnection(credentialId: string, signal: AbortSignal): Promise<{
    ok: boolean;
    latencyMs: number;
    error?: string;
  }>;

  /** Run the query, stream rows, write Parquet at `input.outputPath`. */
  extract(credentialId: string, input: ExtractInput): Promise<ExtractResult>;

  /** Optional: list available tables / views so the agent can introspect.
   *  V1 may stub this — agents typically receive an explicit allow-list. */
  describeNamespace?(credentialId: string, namespace: string): Promise<DatasetSchema[]>;
}
```

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

For sources DuckDB has a native scanner extension (Postgres, MySQL, SQLite, Iceberg, Delta), the adapter implementation is short:

```ts
// src/lib/data-sources/providers/postgres/extract.server.ts
import { Database } from "duckdb-async";

export async function extract(input: ExtractInput, conn: PgConnInfo) {
  const db = await Database.create(":memory:");
  await db.run(`INSTALL postgres; LOAD postgres;`);
  await db.run(`ATTACH '${conn.toAttachString()}' AS src (TYPE POSTGRES, READ_ONLY);`);
  await db.run(`
    COPY (${input.query})
    TO '${input.outputPath}'
    (FORMAT PARQUET, COMPRESSION ZSTD, ROW_GROUP_SIZE 100000)
  `);
  return introspectParquet(input.outputPath);
}
```

Three things this gives us for free:

- Streaming end-to-end: DuckDB reads from Postgres in batches, writes Parquet without ever materialising the full result in memory.
- Type preservation: DuckDB maps Postgres types to Arrow types and emits a faithful schema in the Parquet metadata.
- Row group sizing: the `ROW_GROUP_SIZE 100000` hint optimises later DuckDB queries at the sandbox layer.

### 3.2 The custom-adapter path (e.g. Vertica)

DuckDB has no Vertica extension. We use the source's native Node client and produce Parquet through DuckDB. **V1 takes a JSON-intermediate shortcut**, knowingly, because Vertica is currently the *only* adapter on this path and the type-mapping work for a streaming approach was disproportionate at that scale:

```ts
// Actual V1 shape (vertica/extract.server.ts):
const client = new VerticaClient(conn);
const result = await client.query(input.query);                         // ← buffers full result in JS heap
const ndjson = result.rows.map((r) => JSON.stringify(r)).join("\n");    // ← N × JSON.stringify
await fs.writeFile(tmpJson, ndjson);                                    // ← disk pass 1

// Convert NDJSON → Parquet via DuckDB. read_json_auto infers types.
const db = await DuckDBInstance.create(":memory:");
await db.run(
  `COPY (SELECT * FROM read_json_auto('${tmpJson}', format='newline_delimited')) ` +
  `TO '${outputPath}' (FORMAT PARQUET, COMPRESSION ZSTD, ROW_GROUP_SIZE 100000)`,
);                                                                       // ← disk pass 2 (read NDJSON)
```

Costs we accept in V1:

- Memory: full result set lives in V8 heap (vertica-nodejs is buffer-driven, not streaming).
- CPU: N rows × `JSON.stringify` + DuckDB JSON parse.
- I/O: NDJSON written then re-read (double disk pass).
- Type fidelity: `read_json_auto` infers from JSON sample — `TIMESTAMPTZ` and high-precision `DECIMAL` round-trip to `VARCHAR` / lossy numerics.

The same `IDataSourceAdapter` contract and the same Parquet output the runtime sees, so agents that consume Vertica datasets are not aware of the intermediate path. See §6 (Future work) for the trigger that ends this shortcut.

### 3.3 What the agent calls

Adapters are not invoked by agents directly. The agent runtime exposes a tool (provisional name, finalised in phase 4):

```ts
extract_dataset_by_sql({
  name: "sales_q1_2025",
  dataSourceName: "vertica_prod",  // matches data_source.name (LLM-facing slug)
  query: "SELECT * FROM sales WHERE quarter = '2025-Q1'",
  // Optional: previewRows (default 5), forceRefresh (default false)
}) → { cacheHit, name, rowCount, schema: { columns }, ttlHours, preview? }
```

The LLM-facing surface is intentionally minimal: `name` / `dataSourceName` /
`query` carry the task semantics; `previewRows` / `forceRefresh` cover the
two cases where the agent has a value-add decision (inline peek vs.
sandbox-only, fresh fetch vs. cached). System bounds — wall-clock budget,
row ceiling, default TTL — live in env vars (`DATA_EXTRACT_TIMEOUT_MS`,
`DATA_EXTRACT_MAX_ROWS`, `DATA_EXTRACT_DEFAULT_TTL_HOURS`) so the LLM is
not asked to invent a number it has no signal to choose.

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
- **A name is a slot, not an identifier.** Re-extracting under the same name with a DIFFERENT query is a slot reassignment, not an error. The cache stores the canonicalised `query_hash`; on hash mismatch the new snapshot replaces the prior bytes on disk via `commitWriteSlot`'s atomic `rm -rf + rename`. The tool result returns `replacedPrior: true` so the agent knows the prior data is gone.
- Re-extracting with the SAME query is a cache hit (`cacheHit: true`, no source roundtrip) — same as before.
- **Why slot semantics?** LLMs treat names as variables (`customers`, `recent_orders`), not as durable identifiers; the alternative (fail-fast on hash mismatch) traps the LLM after a restart when it has no memory of prior session names, and trapped the agent mid-conversation when it naturally wanted to "rebind" a slug to a refined query. The slot-reassignment model matches every programming language's variable semantics — no concept to learn.
- **Defence still in place:** in-flight readers of `./data/<name>/...` in another sandbox process keep their bytes via the OS's open-FD and page-cache semantics (POSIX: a deleted file referenced by an open FD stays alive); only NEW sandbox runs see the replaced bytes. Atomic `rename(tmp, final)` means there's no half-state window for fresh readers either.

### 4.3 TTL and invalidation

Each dataset carries a `ttlHours`. The cache check is:

```
exists(parquet/<name>/) AND (now - created_at) < ttl_hours * 3600s
```

On expiry the cache transparently re-extracts from the source. There is **no** background eviction job — disk cleanup happens on Node boot (see §4.3.1) and lazily on stale-name access. A simple admin endpoint `POST /api/admin/data-cache/sweep` removes any directory older than its TTL.

### 4.3.1 Cache lifecycle = process lifetime

Every Node boot calls `purgeAllDatasets()` from `instrumentation.ts` before serving any request. This wipes `<cacheRoot>/parquet/` clean and pins the dataset cache to the lifetime of the current Node process — restart Nango and the cache starts empty.

Two operational problems disappear under this rule:

1. **Disk accumulation.** With no background GC, naive TTL semantics let cache files grow monotonically across the life of a long-running server / chain of restarts. Boot-time sweep gives us a deterministic upper bound: at most one process-worth of extractions on disk at any moment.

2. **Cross-restart name collisions (historical).** The earlier `QUERY_HASH_MISMATCH` guard rejected `same-name + different-queryHash` to defend against in-session ambiguity. After a restart the LLM had no memory of prior session names, so reusing a slug like `customers` for an unrelated query failed unexpectedly. The boot sweep removed the cross-restart half of this problem; §4.2 ("name is a SLOT") removed the in-session half by switching to slot reassignment semantics instead of fail-fast.

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

## 6. Implementation phases

All three phases (D-1, D-2, D-3) are landed.

### Phase D-1 — Skeleton + Postgres adapter ✅ done

- Defined `IDataSourceAdapter`, `ExtractInput`, `ExtractResult`.
- Both registries (`registry.ts` + `registry.server.ts`) wired with
  `satisfies Record<DataSourceId, …>` for compile-time coverage.
- Cache layer (`cache.ts`) using file convention + sidecar
  `<name>.meta.json`. Atomic-rename concurrency.
- Postgres adapter as reference: `INSTALL postgres → ATTACH → COPY (...)
  TO 'x.parquet'` via DuckDB.
- `serviceType="datasource"` added to `CredentialServiceType`;
  `provider="postgres"` entry in `src/lib/constants/providers.ts`.

### Phase D-2 — Agent tools + sandbox handoff ✅ done

- `extract_dataset_by_sql` agent tool
  (`src/lib/data-sources/runtime-tools.ts`): validates the cache key,
  resolves the data source by name (D-2.2 — was credentialId before),
  applies the policy gate (read-only / table allowlist / denylist via
  `node-sql-parser`), picks the right adapter, checks cache first
  (cheap on hit + matching query hash), acquires a tmp slot on miss,
  runs `adapter.extract`, commits. Naming uses the `extract_dataset_by_*`
  family so future siblings can fetch datasets by URL or REST API call
  without breaking callers.
- Return shape: `{ cacheHit, name, rowCount, schema: { columns },
  ttlHours, preview? }`. `rowCount` is top-level so agents can
  short-circuit empty results without poking the schema. The mount
  path is conventional (`./data/<name>/`) and is documented in
  the `run_code_in_sandbox` description, so neither `mountedAt` nor
  `byteSize` are surfaced to the LLM (`byteSize` lives in the
  `<name>.meta.json` sidecar for admin debugging). On a cache hit the
  `columns` array is empty (sidecar persists totals only).
- `previewRows: number` (optional, max 200) lets the LLM peek at the
  first N rows inline — handy when the result is small enough to
  reason over directly without entering the sandbox. The runtime
  reads via DuckDB `read_parquet(..) LIMIT N` and trims to a
  ≤50KB JSON budget; `preview.truncated` flips when either cap kicks
  in so the LLM knows to fall back to the sandbox.
- Preview is **column-oriented** —
  `preview = { columns: string[], rows: unknown[][], truncated }` —
  not row-of-objects. This saves ~50% tokens vs the obvious
  `[{col1: v1, col2: v2}, …]` shape (column names appear once
  instead of once-per-row) while keeping full JSON type fidelity
  (number / boolean / null / nested values). The tool description
  spells out the DataFrame-style indexing convention so the LLM
  doesn't try `row.colName`.
- Hash-mismatch handling: same `name` + different `query` REPLACES
  the prior snapshot under that slot (last-write-wins) and the
  result carries `replacedPrior: true`. See §4.2 for the rationale.
- The companion `run_code_in_sandbox` tool (sandbox layer)
  bind-mounts each dataset name from `datasets: [...]` at
  `./data/<name>` read-only — the prompt convention and the
  return value of `extract_dataset_by_sql` are symmetric.
- `run_code_in_sandbox` is in the user-selectable built-in tool catalog
  (`src/lib/builtin-tools/catalog.ts`); admins enable it per agent
  via `BuiltinAgentEditor`'s "Built-in Tools" section. Bound names
  land as `builtin_agent_tool` rows; dispatch (`runner/dispatch/
  builtin.ts`) resolves the names back through the catalog and
  injects the `ToolDefinition` into the agent at run time.
- `extract_dataset_by_sql` is **auto-mounted by data_source binding**,
  not user-selectable. Whenever an agent has at least one
  `builtin_agent_tool { toolType="datasource" }` row, dispatch
  force-adds the tool name to the build set (`runner/dispatch/
  builtin.ts:205-207`) and `data-sources/prompt-block.server.ts`
  emits the "Available data sources" block listing the legal
  `dataSourceName` values. The two move as one unit — without a
  binding the tool would have nothing to call and no prompt block
  to describe what slugs are valid. This mirrors the
  `run_ssh_command` / `ssh_server` and `get_skill` / `skill`
  auto-mount patterns. Legacy `builtin_agent_tool` rows pointing at
  `"extract_dataset_by_sql"` (from before this tool moved out of the
  catalog) are silently dropped via the catalog's forward-compat
  branch — no migration needed; auto-mount covers the same agents.

### Phase D-2.1/D-2.2 — DataSource entity + runtime swap ✅ done

- `data_source` table is the agent-facing access entity: connection
  metadata (host / port / database / params), policy (readOnly /
  tableAllowlist / tableDenylist), and a FK to `credential` for auth.
  One credential can back multiple data sources with different
  policies (e.g. `prod_pg_readonly` + `prod_pg_admin` over the same
  DB).
- `credential.fields` for datasource providers slimmed to
  `{ user, password }` only; `restUrl` is kept as an admin-facing
  reference label ("which DB is this credential pointing at?").
- `extract_dataset_by_sql.dataSourceName` carries the
  `data_source.name` (a stable LLM-facing slug, NOT a uuid); the
  runtime joins datasource + credential via
  `resolveDataSourceByName()` before calling the adapter.
- Policy enforcement (`policy.ts`): app-layer SQL parse via
  `node-sql-parser` rejects writes (when `readOnly`), denied tables,
  and tables outside the allowlist BEFORE the cache is even touched.
  CTE names are stripped (parser lists them as if they were real
  tables; we walk `ast.with` to subtract them). On parse failure
  we fail closed with `PARSE_ERROR`. Adapter-level read-only
  transactions are deferred to D-2.3 (defence in depth).
- Cache cleanup: `purgeDatasetsForDataSource(dataSourceId)` walks
  the parquet root, reads each sidecar, and removes datasets whose
  `dataSourceId` matches. Wired into the data source DELETE API
  in D-2.3.
- Runtime tool error codes surfaced to LLM:
  `INVALID_NAME` / `NOT_FOUND` / `DISABLED` /
  `UNSUPPORTED_PROVIDER` / `CREDENTIAL_MISSING` /
  `CREDENTIAL_DECRYPT_FAILED` / `WRITE_NOT_ALLOWED` /
  `TABLE_DENIED` / `TABLE_NOT_ALLOWED` / `PARSE_ERROR` /
  `EXTRACT_FAILED`. (`QUERY_HASH_MISMATCH` was retired in favour
  of slot-reassignment — see §4.2.)

### Phase D-2.3 — REST API ✅ done

- `GET/POST/PATCH/DELETE /api/data-sources` + `/api/data-sources/[id]`
  + `POST /api/data-sources/[id]/test-connection`. RBAC: editor+ for
  create/edit, creator-or-admin for delete + visibility flips, any
  signed-in user for `GET` (visibility-filtered).
- `name` is immutable on PATCH — agent prompts and schedules may
  reference it directly, so renaming silently breaks dependents.
  Delete + recreate to rename. `provider` IS mutable on PATCH (see
  the editor's "provider unlocked" change); cache invalidation on
  provider change is intentionally NOT triggered here — a separate
  admin "purge cache" workflow is on the roadmap, and the runtime
  re-applies the new provider on the next cache miss.
- POST/PATCH do NOT cross-check `credential.provider` against
  `data_source.provider`. Same DB account often spans heterogeneous
  engines (one ops user covering MariaDB + Vertica), and the shared
  `DatabaseConnectionBase` payload (`{username, password}`) makes
  the swap safe at runtime. The credential's own `provider` tag is
  shown next to the name in the picker as a hint, not a filter.
- DELETE invalidates agent specs first, then calls
  `purgeDatasetsForDataSource()`, then drops the row — so no
  half-deleted state can be observed by an in-flight runtime call.
- `GET /api/datasource-credentials` returns the editor's credential
  picker list filtered to `serviceType="datasource"` and the
  matching `provider`.

### Phase D-2.4 — UI (panel + editor + agent binding) ✅ done

- `DataSourcePanel` (left side panel, editor+ visible) lists data
  sources grouped by provider; new-button opens a blank editor.
- `/datasource/[id]` route hosts `DataSourceEditor` (mirrors
  `/agent/[id]` and `/skills/[id]`). Form covers connection metadata,
  policy (readOnly + table allowlist/denylist), credential picker,
  visibility, enabled flag, and a "Test connection" button that hits
  the `/test-connection` endpoint.
- Agent binding: `BuiltinAgentEditor` gains a "Data Sources" section;
  bound rows land in `builtin_agent_tool` with `toolType="datasource"`
  and a `dataSourceId` FK. Disabled data sources are filtered out of
  the picker.
- Dispatch wiring (`runner/dispatch/builtin.ts`) resolves bound
  data sources at request time and passes them as
  `dataSourcesRuntime` so `extract_dataset_by_sql` can scope its
  lookup to *this agent's* allowed sources.
- Prompt injection: `data-sources/prompt-block.server.ts` renders
  the bound list into the system prompt as
  `Available data sources (pass the slug as dataSourceName...): - name (provider) — description`
  so the LLM knows which `dataSourceName` values are valid without
  needing a separate "list_data_sources" tool.

### Phase D-3 — MySQL / MariaDB / Vertica coverage ✅ done

- MySQL adapter via DuckDB `mysql` extension (mirrors Postgres).
- MariaDB adapter shares the `mysql` extension and reuses the
  MySQL secrets schema + attach-string builder; the `provider`
  slug stays distinct so the admin form / labels remain accurate.
- Vertica adapter via `vertica-nodejs` (custom client; no DuckDB
  scanner extension exists). Rows are written to NDJSON then
  converted to Parquet via DuckDB's `read_json_auto` —
  type-fidelity is best-effort in V1; high-precision use cases
  can swap to a typed `DuckDBAppender` path later without
  changing `IDataSourceAdapter`.
- `vertica-nodejs` is plain JavaScript with no `.d.ts`; the
  adapter declares only the slice it uses (`Client.connect /
  query / end`) and a top-level shim sits at
  `vertica/vertica-nodejs.d.ts`.
- Adapter contract tests: `tests/unit/lib/data-sources/registry.test.ts`
  covers all four ids; `secrets-schemas.test.ts` covers Zod payload
  parsing + the MySQL attach-string builder.

### Future / out-of-scope for V1

- BigQuery / Snowflake / ClickHouse adapters (write when needed).
- `cache_meta.duckdb` migration if the dataset count justifies it.
- Background TTL sweeper (cron-style) instead of lazy expiry.
- Per-user data isolation flow end-to-end (interface is reserved; no UI yet).
- Adapter "describe" endpoint for agent-driven schema introspection.
- Streaming / CDC sources.
- **Unify non-DuckDB-extension adapters on `odbc_scanner` (deferred).** §3.2 explains the V1 NDJSON shortcut Vertica takes (full buffer + JSON round-trip + double disk pass + a `vertica-nodejs` direct dependency). Acceptable for one adapter; **not** acceptable as a copy-paste pattern. The plan to fold all such adapters onto a single ODBC backbone is recorded here and **deferred until DuckDB's `odbc_scanner` ships as a core extension**.

  **Why `odbc_scanner` is the right backbone.** DuckDB Labs released `odbc_scanner` (<https://github.com/duckdb/odbc-scanner>) in mid-2025 as a Labs / nightly extension and has publicly stated intent to promote it to a **core extension** in a future DuckDB release. It exposes a `odbc_query(handle, sql)` table function that streams results through DuckDB's pipeline straight into `COPY ... TO ...parquet` — the same code shape the Postgres / MySQL DuckDB extensions already use. With it, every database that ships an ODBC driver (Vertica, Oracle, SQL Server, DB2, Snowflake, Firebird, …) becomes a ~40-line adapter built on a shared factory; no Node-side driver, no V8-heap buffering, no NDJSON round-trip. This **supersedes** the earlier "createDuckdbStreamingAdapter via DuckDB Appender" sketch — same goal, smaller and more uniform footprint.

  **Trigger condition (do not implement before either holds):**
  1. `odbc_scanner` is promoted to a DuckDB core extension (currently still has to be installed via `INSTALL odbc_scanner FROM core_nightly` and lacks `ATTACH` support — issue duckdb/odbc-scanner#162), **OR**
  2. A second non-DuckDB-extension adapter is requested (Oracle / MSSQL / Snowflake / ClickHouse) before condition 1 holds — at that point the `core_nightly` channel is acceptable cost to avoid copy-pasting a second 250-line custom client.

  **Design decisions, frozen for the future PR:**
  - **Provider ids stay specific** (`vertica`, future `oracle`, `mssql`, …) — not a generic `odbc`. Existing `data_source.provider` rows survive zero-migration; UI keeps DB-typed labels; users don't have to know their ODBC driver name. Internally each is a thin wrapper over a shared `createOdbcAdapter` factory.
  - **New factory, not a `mode` switch on `createDuckdbExtensionAdapter`.** The ATTACH lifecycle (long-lived catalog mapping) and the `odbc_connect` + `odbc_query` lifecycle (per-call handle) differ enough that mixing them in one factory makes `pinDefaultSchema`-style flags semantically wrong. New file: `src/lib/data-sources/odbc-adapter.server.ts`.
  - **Bound params remain rejected** (same as the ATTACH path) — agents don't use them and `odbc_query` supports them via a separate `params = row(...)` arg the factory can wire up later without changing the public contract.
  - **First call cost.** `odbc_scanner` is ~5 MB. Hot-load it once at boot in `instrumentation.ts` (mirrors how DuckDB extensions cache locally after first download).
  - **Driver shipping.** unixODBC into the Dockerfile unconditionally; per-DB drivers gated by build ARGs (`VERTICA_ODBC_TARBALL`, `ORACLE_INSTANTCLIENT_TARBALL`, …) because most are commercial-license tarballs that can't be baked into the OSS image.

  **Per-adapter shape after migration (Vertica is the worked example):**

  ```ts
  // vertica/extract.server.ts — ~40 lines total
  const adapter = createOdbcAdapter({
    driverName: "Vertica",
    buildOdbcConnString: (r) =>
      `Driver={Vertica};Server=${r.host};Port=${r.port};Database=${r.database};` +
      `SSLMode=${r.params.tls_mode ?? "disable"}`,
  });
  export const { extract: extractFromVertica, testConnection: testVerticaConnection } = adapter;
  ```

  Adding Oracle / MSSQL / Snowflake post-migration is the same three-file pattern (`adapter.ts` + `extract.server.ts` + `index.server.ts`), no Node-native driver.

  **Phased plan when the trigger fires** — each phase is a separate PR:
  1. Spike: confirm `INSTALL odbc_scanner FROM core_nightly` works under the project's locked `@duckdb/node-api` version against a real ODBC endpoint.
  2. Plumbing: add `odbc-scanner.server.ts` + `odbc-adapter.server.ts`; extract `raceWithTimeoutAndAbort` / `introspectParquet` to a `duckdb-shared.server.ts` for reuse.
  3. Cut Vertica over to the factory; remove `vertica-nodejs` from `package.json` / `pnpm-lock.yaml` / `next.config.ts:serverExternalPackages` / `vertica/vertica-nodejs.d.ts`.
  4. Dockerfile: unixODBC + optional Vertica ODBC driver via build ARG.
  5. Update §3.2 to point at the new factory; add an "Adding an ODBC-backed provider" recipe.

  **Acceptance gate:** the same Vertica `SELECT` produces a Parquet whose `SUMMARIZE` (column names, types, row count) is byte-equivalent to the legacy path's output before `vertica-nodejs` is removed.

  **One known compatibility caveat to schedule into Phase 3.** The legacy adapter respects `params.schema` by issuing `SET search_path TO ...` on the connection; the ODBC path can't do this transparently (no equivalent `odbc_set_session_param`). Phase 3 needs to either (a) drop `params.schema` after auditing existing `data_source` rows for usage, or (b) inline the schema as a query prefix at extract time.

  Why not now: `odbc_scanner` is still a Labs-owned nightly extension. Its `ATTACH` support is on the roadmap but not in a stable release. Both make the swap a moving target. Cost of waiting is one custom adapter; cost of moving early is tracking a non-frozen extension API. The decision is reversible — if a second non-extension adapter is requested before the trigger, jump to phase 2 above with `core_nightly` as the install channel and accept the upgrade churn.

---

## 7. Hard invariants

1. **Adapters are read-only on the source.** No `INSERT` / `UPDATE` / `DELETE`. The layer never writes back. SQL containing those keywords is rejected at parse time.
2. **Parquet is the only on-disk format.** No CSV, no JSON-lines, no SQLite caches. Agents see one storage format everywhere.
3. **The cache directory is owned by this layer.** The sandbox layer mounts it read-only and never writes to it.
4. **Adapter call sites pass `credentialId`, not credentials.** Decryption happens inside the adapter implementation, behind `import "server-only"`.
5. **Atomic rename is the only mutation primitive.** Half-written Parquet files never become visible to readers.
6. **Adapter `extract` honours `signal` and `timeoutMs`.** A cancelled or slow query must not leak a connection or a half-written file.
