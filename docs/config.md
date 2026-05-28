# Configuration Management

> Audience: backend engineers and administrators
> See also: `src/lib/config/defaults.ts` (single source of truth for all config keys)

---

## 1. Overview

Nango uses a centralized, DB-backed configuration system. All tunable
runtime parameters — timeouts, cache sizes, sandbox settings, file
limits, observability targets — live in the `config` table and are
managed through the Admin → Config page.

**Resolution order:** code default (fallback) → DB value (authoritative).
There is no env-var override layer for runtime parameters. The DB is
the single source of truth.

**What stays in `.env`:** only infrastructure parameters needed before
the database is available — DB connection (`POSTGRES_*`), auth secrets
(`BETTER_AUTH_*`), encryption keys (`CREDENTIAL_ENCRYPTION_*`), and
logging (`NANGO_LOG_*`).

---

## 2. Schema

```sql
CREATE TABLE config (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key         text NOT NULL UNIQUE,       -- dot-notation: 'sandbox.timeout'
  value       text NOT NULL,              -- current value (string representation)
  value_type  text NOT NULL DEFAULT 'string',  -- 'string' | 'number' | 'boolean' | 'json'
  options     jsonb,                      -- enum allowed values, NULL = free input
  prev_value  text,                       -- previous value (single-level rollback)
  description text,                       -- human-readable description
  updated_by  uuid REFERENCES "user"(id) ON DELETE SET NULL,
  created_at  timestamp DEFAULT now(),
  updated_at  timestamp DEFAULT now()
);
```

**Key design decisions:**

- **Single `key` column with dot-notation** instead of separate
  group + name columns. Avoids hierarchy ambiguity
  (`datasource.extract.ttl_hours` — is the group `datasource` or
  `datasource.extract`?). Grouping is derived from the first segment
  at display time.
- **`value` stored as text**, parsed by typed getters at read time.
  Keeps the schema simple; type safety lives in the application layer.
- **`options` as JSONB array** for enum configs (e.g.
  `["subprocess", "local-docker"]`). NULL means free input. The UI
  renders a dropdown when options is non-null.
- **`prev_value`** provides single-level undo. Sufficient for the
  rare "just changed it, want to revert" scenario. Full audit history
  can be added later via a `config_audit` table if needed.
- **`value_type`** drives UI control rendering: text input for
  `string`/`number`, switch for `boolean`, JSON editor for `json`,
  dropdown for entries with `options`.

---

## 3. Boot Sequence

```
instrumentation.ts (Next.js register hook)
  │
  ├─ 1. recordProcessBoot()        — needs DB
  │
  ├─ 2. seedDefaults()             — inserts missing keys (see §4)
  ├─ 3. loadAllConfigs()           — populates in-memory cache
  │
  ├─ 4. seedBuiltinSkills()        — may read config
  ├─ 5. bootstrapScheduler()       — may read config
  └─ 6. getActiveAdapter()         — reads sandbox.mode from config
```

Steps 2–3 run before any module that reads config values.
`seedDefaults` and `loadAllConfigs` are tolerant of DB failures (log
warning and fall back to code defaults).

---

## 4. Seeding Strategy

Two mechanisms ensure default config rows exist:

### 4.1 Migration (initial install)

Migration 0028 creates the `config` table and inserts all default
rows with `ON CONFLICT DO NOTHING`. This runs once during initial
deployment.

### 4.2 Boot-time seed (future additions)

`seedDefaults()` runs on every boot. It performs a single
`SELECT key FROM config`, computes the set difference against
`CONFIG_DEFAULTS` in code, and inserts only missing keys.

| Scenario | Behavior |
|---|---|
| Fresh install (migration ran) | 1 SELECT, 0 missing, returns immediately |
| Normal restart | Same — 0 missing |
| Code adds config key #37 | 1 SELECT, finds 1 missing, inserts it |
| Admin modified a value | Key exists — never overwritten |

This is why `CONFIG_DEFAULTS` in `defaults.ts` is the single source of
truth for adding new config keys: add the entry there, and the next
boot automatically seeds it into the DB.

---

## 5. Read API

Five typed getters, all resolving through the same internal
`resolve(key)` function:

```typescript
getConfig(key, defaultValue): string
getConfigNumber(key, defaultValue): number
getConfigMs(key, defaultSeconds): number    // reads seconds, returns ms
getConfigBoolean(key, defaultValue): boolean
getConfigJson<T>(key, defaultValue): T
```

`resolve(key)` checks the in-memory cache first (populated by
`loadAllConfigs` at boot), then falls back to `CONFIG_DEFAULTS_MAP`.
The `defaultValue` parameter is the final fallback if neither has the
key.

### Unit conventions

| Value type | Stored unit | Getter | Internal unit |
|---|---|---|---|
| Time | seconds | `getConfigMs()` | milliseconds (× 1000) |
| Size | bytes or MB (suffix in key name) | `getConfigNumber()` | same |
| Count | raw number | `getConfigNumber()` | same |
| Duration (hours) | hours | `getConfigNumber()` | same |

Time values are stored in seconds for admin readability. Code that
needs milliseconds (setTimeout, lru-cache TTL) uses `getConfigMs()`
which multiplies by 1000.

Size values keep their natural unit. Keys with `_mb` suffix store
megabytes; keys with `_bytes` suffix store bytes.

---

## 6. Write API

Used by the admin API routes:

```typescript
updateConfig({ key, value, updatedBy })  // stores prev_value
createConfig({ key, value, valueType, description, updatedBy })
deleteConfig(key)  // only custom keys; predefined keys throw
```

All write operations automatically refresh the in-memory cache by
calling `loadAllConfigs()` after the DB write.

---

## 7. Admin API

| Method | Endpoint | RBAC | Purpose |
|---|---|---|---|
| `GET` | `/api/admin/config` | admin | List all configs, grouped by key prefix |
| `POST` | `/api/admin/config` | admin | Create a custom config key |
| `GET` | `/api/admin/config/:key` | admin | Read single config |
| `PATCH` | `/api/admin/config/:key` | admin | Update value (stores prev_value) |
| `DELETE` | `/api/admin/config/:key` | admin | Delete custom key only |

**Predefined keys** (those in `CONFIG_DEFAULTS`) cannot be deleted
via the API — only their values can be updated. Custom keys (admin-
created) can be both updated and deleted.

---

## 8. Admin UI

The Config page (`/admin/config`) displays all parameters in a table
with collapsible group sections. Groups are derived from the first
dot-segment of each key.

| Column | Content |
|---|---|
| Key | Dot-notation key name (monospace) |
| Type | `number` / `string` / `boolean` / `enum` |
| Value | Inline editable: text input, switch (boolean), or dropdown (enum) |
| Previous | Last value before current change; `—` if unchanged |
| Description | Human-readable explanation of the parameter |

All groups start collapsed. Enum configs render as `<Select>` dropdown
with options from the `options` JSONB column.

---

## 9. Config Keys Reference

36 predefined keys across 8 groups.

### sandbox (6)

| Key | Default | Type | Description |
|---|---|---|---|
| `sandbox.timeout` | 30 | number | Execution timeout in seconds |
| `sandbox.memory_mb` | 256 | number | Container memory limit in MB |
| `sandbox.cpu_cores` | 0.8 | number | CPU limit as fractional cores |
| `sandbox.tmpfs_size_mb` | 512 | number | Tmpfs size in MB |
| `sandbox.stdout_max_chars` | 20000 | number | Max stdout chars before truncation |
| `sandbox.stderr_max_chars` | 10000 | number | Max stderr chars before truncation |
| `sandbox.mode` | subprocess | enum | `subprocess` / `local-docker` / `remote-docker` |
| `sandbox.runtime` | docker | enum | `docker` / `podman` |
| `sandbox.image` | sandbox-runner:latest | string | Container image for local-docker backend |

### cache (10)

| Key | Default | Type | Description |
|---|---|---|---|
| `cache.agent_pool.ttl` | 600 | number | Agent pool TTL in seconds |
| `cache.agent_pool.max` | 500 | number | Max cached agent specs |
| `cache.skill_pool.ttl` | 600 | number | Skill pool TTL in seconds |
| `cache.skill_pool.max` | 500 | number | Max cached skill specs |
| `cache.mcp_pool.idle_timeout` | 300 | number | MCP idle timeout in seconds |
| `cache.mcp_pool.reaper_interval` | 60 | number | MCP reaper poll interval in seconds |
| `cache.credential.ttl` | 600 | number | Credential lookup TTL in seconds |
| `cache.entity_catalog.ttl` | 600 | number | Entity catalog TTL in seconds |
| `cache.entity_catalog.max` | 100 | number | Max cached entity lists |
| `cache.thread_state.max` | 5000 | number | Max cached thread states |

### datasource (7)

| Key | Default | Type | Description |
|---|---|---|---|
| `datasource.extract.timeout` | 60 | number | Extract timeout in seconds |
| `datasource.extract.max_rows` | 1000000 | number | Max rows per extract |
| `datasource.extract.ttl_hours` | 24 | number | Cache lifetime in hours |
| `datasource.preview.max_rows` | 200 | number | Preview row hard cap |
| `datasource.preview.max_bytes` | 50000 | number | Preview byte hard cap |
| `datasource.preview.default_rows` | 5 | number | Default preview rows |
| `datasource.cache_root` | *(empty)* | string | Parquet cache root path |

### ssh (3)

| Key | Default | Type | Description |
|---|---|---|---|
| `ssh.exec_timeout` | 30 | number | Command timeout in seconds |
| `ssh.connect_timeout` | 10 | number | Connection timeout in seconds |
| `ssh.max_output_bytes` | 1048576 | number | Max output per stream in bytes |

### skill (3)

| Key | Default | Type | Description |
|---|---|---|---|
| `skill.max_file_bytes` | 262144 | number | Max single file size in bytes (256 KB) |
| `skill.max_files` | 100 | number | Max files per skill |
| `skill.max_total_bytes` | 10485760 | number | Max total size per skill (10 MB) |

### auth (2)

| Key | Default | Type | Description |
|---|---|---|---|
| `auth.session_expiry` | 604800 | number | Session lifetime in seconds (7 days) |
| `auth.session_refresh` | 86400 | number | Session refresh interval in seconds (1 day) |

### mcp (1)

| Key | Default | Type | Description |
|---|---|---|---|
| `mcp.discovery_timeout` | 5 | number | Tool discovery timeout in seconds |

### observability (1)

| Key | Default | Type | Description |
|---|---|---|---|
| `observability.langfuse.targets` | builtin,frontend,proxy_errors | string | Comma-separated Langfuse trace targets |

---

## 10. Adding a New Config Key

1. Add an entry to `CONFIG_DEFAULTS` in `src/lib/config/defaults.ts`:

```typescript
{ key: "mymodule.my_param", value: "42", valueType: "number", description: "..." },
```

2. Read the value in your module:

```typescript
import { getConfigNumber } from "@/lib/config";
const myParam = getConfigNumber("mymodule.my_param", 42);
```

3. That's it. Next boot, `seedDefaults()` inserts the new row. No
   migration needed for new keys.

For enum configs, add `options`:

```typescript
{ key: "mymodule.mode", value: "a", valueType: "string", description: "...", options: ["a", "b", "c"] },
```

---

## 11. File Layout

```
src/lib/config/
├── defaults.ts        36 predefined config entries (single source of truth)
├── service.ts         seed, load, read (typed getters), write, cache
└── index.ts           public re-exports

src/app/api/admin/config/
├── route.ts           GET (list) + POST (create custom)
└── [key]/route.ts     GET + PATCH + DELETE per key

src/components/admin/
└── ConfigManagement.tsx   Admin UI: grouped table with inline editing

src/lib/db/migrations/
├── 0028_*.sql         CREATE TABLE config + INSERT 36 defaults
└── 0029_*.sql         ADD COLUMN options + UPDATE enum rows
```

---

## 12. Scripts Compatibility

Scripts that run outside Next.js (via `tsx`, before DB is available)
cannot use the config service. They import `CONFIG_DEFAULTS_MAP`
directly from `defaults.ts` to read code-level defaults:

```typescript
import { CONFIG_DEFAULTS_MAP } from "@/lib/config/defaults";
const image = CONFIG_DEFAULTS_MAP.get("sandbox.image")?.value ?? "sandbox-runner:latest";
```

This ensures scripts work without DB access while staying consistent
with the default values.
