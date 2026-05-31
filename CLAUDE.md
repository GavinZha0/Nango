@AGENTS.md

# Claude-Specific Instructions

## Before You Start

- This project uses **Next.js 16.2.4** which has breaking changes from earlier versions. Always check `node_modules/next/dist/docs/` for up-to-date API references before writing code.
- **React 19** is in use — do not use deprecated patterns (e.g. `forwardRef` is no longer needed, `ref` is a regular prop).
- **Tailwind CSS 4** — use `@import "tailwindcss"` instead of the v3 `@tailwind` directives. Utility classes are the same.
- **Zod 4** — use `import { z } from "zod"` (v4 barrel export); avoid deprecated v3 methods.

## Development Commands

```bash
pnpm dev          # Start dev server (Turbopack, port 9300)
pnpm build        # Production build
pnpm lint         # ESLint check
pnpm db:generate  # Generate Drizzle migration from schema changes
pnpm db:migrate   # Run pending migrations
pnpm db:push      # Push schema directly (dev only)
pnpm db:studio    # Open Drizzle Studio
pnpm docker:db    # Start PostgreSQL via Docker Compose
```

## Key Patterns

### Authentication & RBAC (`docs/rbac.md`)
- `getSession()` from `@/lib/auth/auth-instance` — server-side session check; rejects soft-deleted users.
- Page guards: `requireSession()` / `requireEditor()` / `requireAdmin()` from `@/lib/auth/route-guards`.
- API HOFs: `withSession` / `withEditor` / `withAdmin` from `@/lib/http/route-handlers`.
- `authClient` / `useRole()` (`@/hooks/useRole`) — client-side role-aware hooks. `useRole()` exposes `{ role, isAdmin, isEditor }`.
- Permission predicates for `skill` / `mcp_server` / `builtin_agent`: `canEditResource` / `canDeleteResource` / `canChangeVisibility` from `@/lib/auth/permissions`. `source = 'builtin'` is an absolute write barrier.
- Three roles: `admin` / `editor` / `user`. First sign-up auto-`admin`; rest default to `user`. Admins promote via `/admin/user`.
- Soft delete: `DELETE /api/admin/users/[id]` sets `deleted_at` + clears sessions; never hard-deletes. Email is freed via partial unique index. Resource ownership FKs are `ON DELETE SET NULL`.

### Credential System
- Admin-only CRUD at `/api/admin/credentials`.
- All secrets AES-256-GCM encrypted before storage; keys in `CREDENTIAL_ENCRYPTION_KEYRING` env var (active key id in `CREDENTIAL_ENCRYPTION_ACTIVE_KEY_ID`). Ciphertext format: `v1:<keyId>:<iv>:<authTag>:<ct>`.
- `credentials/lookup.ts` provides cached server-side lookups: `getCredentialConfigById()`, `getAllAgentCredentials()`.
- Cache TTL: 10 minutes. Call `invalidateCredentialCache()` after writes.

### Agent Architecture
- **Backend agents** (agno/Mastra/Dify): discovered from credentials with `serviceType = "agent"`. Each platform lives in `src/lib/backends/<slug>/` with `adapter.ts` (client metadata) + `chat.server.ts` (REST→AG-UI bridge built on `bridge-runtime-kit.server.ts`) + `entity.server.ts` (server-only upstream fetcher) + `index.server.ts` (the `BackendModule` aggregator — the single import the registry consumes). Server-side wire-up is `src/lib/backends/registry.server.ts`; client-safe REST adapters stay in `src/lib/backends/registry.ts`. Chat via `/api/copilotkit`; the route dispatches into the chat handler. The credential's `restUrl` is required. Browser only ever sees AG-UI. Entities are typed by `kind: "agent" | "team" | "workflow"`. On chat dispatch the route parses `agentId` from the URL path, reads `credentialId` from `X-Credential-Id` header, and resolves `kind` server-side via `EntityCatalog.list(credentialId)` — only `credentialId` is client-supplied. Programmatic paths (supervisor delegation, scheduler) read kind from the supervisor catalog or `schedule.entity_kind`. See `docs/orchestrator.md` "Custom HTTP Headers" and `docs/backend-integration.md` §10 (onboarding walkthrough).
- **Built-in agents**: DB-configured (`builtin_agent` table), run via `/api/copilotkit/builtin` using CopilotKit `BuiltInAgent`. API key resolved from bound `credentialId` only — no env fallback. At most one built-in agent per user is the **supervisor** (Nango), flagged `is_supervisor = true`; the supervisor's catalog of routable specialists is inlined into its system prompt at request time (NO `list_agents` tool).
- **Runtime caches**: per-request `CopilotRuntime` backed by three process-wide pools — `builtin-agents/agent-pool.ts` (LRU + 10-min TTL, keyed by agentId, decrypted spec), `mcp/provider-pool.ts` (refcounted + idle reaper, keyed by mcpServerId), and `skills/skill-pool.ts` (LRU + 10-min TTL, keyed by skillId, parsed SKILL.md). The agent-pool loader transitively consults `credentials/lookup.ts` (10-min TTL, four sub-Maps); `backends/entity-catalog.ts` keeps a fifth cache (per-`credentialId`, 10-min TTL) for entity listing / supervisor catalog / schedule validation; and `backends/thread-state.server.ts` keeps a sixth (LRU keyed by `(credentialId, threadId)`) fronting the `backend_thread_state` table for upstream-session tokens (Dify `conversation_id` today) — six caches in total (see AGENTS.md §9). After writes call `invalidateForCredentialChange(id)` / `invalidateForMcpServerChange(id)` from `credentials/invalidation.ts`, or `invalidateForSkillChange(id)` from `skills/invalidation.ts`; per-agent writes call `agentPool.invalidate(id)`. See `docs/builtin-runtime.md` and `docs/skills.md`.
- **Agent tools**: junction table `builtin_agent_tool` supports MCP servers, skills, and built-in tools. Plain REST endpoints are not a first-class binding — wrap them as an MCP server (e.g. via MCPHub) and bind through `mcp_server`. Supervisor-only tools (`delegate_to_agent`, `delegate_async`, `create_schedule`, `list_schedules`, `update_schedule`, `delete_schedule`) are NOT in the junction — they're injected directly when `is_supervisor`.
- **Runner / orchestration kernel**: every dispatch — chat, supervisor delegation, async, scheduled — produces one `entity_run` row + N `entity_run_event` rows. Chat goes through `runner.runChatRequest` / `runner.runBuiltinChatRequest`; programmatic (supervisor / scheduler) goes through `runner.start({ mode: "sync" | "async" })`. Modes: `auto | tool-call | handoff | async` registered in `lib/orchestration/modes.ts`. See `docs/orchestrator.md` (kernel) and `docs/runner-events.md` (event pipeline + AG-UI ↔ `EntityRunEventType` cross-reference).
- **Notifications**: `notification` table + bell dropdown + `/notifications` page + `/api/runs/stream` SSE. Async runs and scheduled fires drop into the same inbox (kind = `run_completed | run_failed`). SSE frames are tagged with `id: <notification.id>` (UUIDv7) so EventSource auto-reconnect resumes from `Last-Event-ID` via `WHERE id > $lastId ORDER BY id LIMIT 200`; live-during-replay events are buffered and de-duplicated by id. Boot-time recovery is boot-epoch anchored: `instrumentation.ts` writes one `process_boot` row before `recoverStrandedRuns(boot.startedAt)` flips any `running` row with `started_at < boot.startedAt` (necessarily a prior-process zombie) to `failed`. The old "stuck >1h" heuristic is gone.
- **Schedules**: `schedule` table + in-process `setTimeout` scheduler (`lib/runner/scheduler.ts`, NOT cron). Trigger spec `(startAt, [intervalValue, intervalUnit], [endAt])`. Editor at `/schedule/[id]`.
- **Chat history**: unified across built-in and backend agents on top of `entity_run` + `entity_run_event` (no more upstream `/sessions` reverse proxy). Endpoints: `GET /api/threads`, `GET /api/threads/[id]/messages`, `DELETE /api/threads/[id]`. owner-scoped via `eq(EntityRunTable.ownerId, session.user.id)`; sub-runs from supervisor delegation excluded via `parent_run_id IS NULL` so the user-facing chat surface stays uncluttered. Client hydration via `useThreadHydration` calling `agent.setMessages(...)` on `<CopilotChat>` mount.
- **Admin run forensics**: `/admin/run` (list, filterable) + `/admin/run/[id]` (run + immediate children + last 1000 events from `entity_run_event`). Admin-only.
- **Skills**: DB-resident reusable capabilities (Claude Skills convention). One row in `skill` + zero-or-more rows in `skill_file` (helper bytes as `bytea`, ≤ 256 KB / file, ≤ 100 files & 10 MB / skill, enforced at write). Two kinds: **builtin** (`source='builtin'`, authored under `<repo>/skills/<name>/`, baked into `dist/builtin-skills.json` by `pnpm build:skills`, reconciled into DB at boot via `instrumentation.ts → seedBuiltinSkills`) and **custom** (`source='local'`, created through `POST /api/skills` or ZIP import at `POST /api/skills/import`). `source='builtin'` is the absolute write barrier — no role can mutate those rows through the API. The runtime exposes `get_skill` / `get_skill_file` / `run_skill_script` server-side tools via `defineTool` (`run_skill_script` delegates to the same `getActiveAdapter().run` plumbing as `run_code_in_sandbox`, dispatching by file extension: V1 supports `.py` → python3 and `.sh` → bash) and injects an "Available Skills" block into the agent's system prompt for progressive disclosure. **Pure DB reads** — no `fs.watch`, no `NANGO_SKILLS_HOME`, no `.builtin-manifest.json`. API: `GET/POST/PATCH/DELETE /api/skills`, `GET /api/skills/:id/files/[...path]`. Editor at `/skills/[id]` (center workspace, mirrors `/agent/[id]` and `/schedule/[id]`).
- **SSH**: `run_ssh_command` / `list_ssh_hosts` built-in tools (`lib/ssh/`) execute shell commands on remote hosts via `node-ssh`. Connection metadata + access policy live on the `ssh_server` table (`name`, `host`, `port`, `known_host_fingerprint`, `command_allow/deny`); the bound `credential` row carries the auth secret AND the OS `username`, reusing the existing credential types `basic_auth` (`{username, password}`) or `private_key` (`{username, privateKey, passphrase?}`). One credential identifies one OS user across many hosts. Host-key verification is **admin-confirmed TOFU**: the editor's "Verify connection" button captures the offered host key in `hostVerifier` on the first round-trip and surfaces the SHA256 fingerprint for the admin to pin; subsequent `run_ssh_command` calls strict-pin against that fingerprint and reject mismatches. See `AGENTS.md` §17 for the full flow. **Full shell access for the agent** — no sandbox, no allowlist (V1). Caps: `ssh.exec_timeout` (30s), `ssh.connect_timeout` (10s), `ssh.max_output_bytes` (1 MiB) — managed via Admin → Config. One-shot connect+exec+dispose per call; `entity_run_event` provides automatic audit. See `docs/ssh.md`.
- **Data sources**: agent-facing query targets backed by the `data_source` table. The row owns connection metadata (`provider`, `host`, `port`, `database`, `params`) + access policy (`readOnly`, `tableAllowlist`, `tableDenylist`) and points at a `credential` row that holds just `{user, password}`. One credential can back many data sources with different policies (e.g. `prod_pg_readonly` + `prod_pg_admin` over the same DB). The LLM-facing identifier is the row's `name` (regex `[a-z][a-z0-9_-]{0,62}`, globally unique). The runtime tool `extract_dataset_by_sql.dataSourceName` resolves through `data-sources/lookup.ts`, validates via `data-sources/policy.ts` (parses SQL with `node-sql-parser`, rejects writes / disallowed tables / unparseable input BEFORE the cache is touched), then runs the adapter and writes Parquet to the shared cache. Bound to agents through `builtin_agent_tool` rows with `toolType="datasource"`; binding a data source **auto-mounts** `extract_dataset_by_sql` (NOT user-tickable in the `builtin-tools/catalog.ts`, mirrors SSH/skills auto-mount) and the dispatch layer injects an "Available data sources" prompt block (`data-sources/prompt-block.server.ts`). API: `GET/POST/PATCH/DELETE /api/data-sources`, `POST /api/data-sources/[id]/test-connection`, `GET /api/datasource-credentials` (filtered credential picker for the editor). Cached datasets reference `data_source.id` in their sidecar so DELETE can `purgeDatasetsForDataSource()`. Editor at `/datasource/[id]` (mirrors `/agent/[id]` / `/skills/[id]`); panel at `DataSourcePanel` (editor+ visible). See `docs/data-sources.md`.

### Layout Architecture
- **Header** (`components/layout/Header`) — top bar: Logo, NotificationBell (live SSE-backed bell with unread badge + dropdown of last 6), user menu, chat toggle button.
- **LeftToolbar** (`components/layout/LeftToolbar`) — fixed `w-12` vertical icon bar with three permission-driven groups separated by thin dividers. (1) **User group** (everyone): Dashboard, Artifact, Schedules, Notifications. (2) **Editor group** (`editor`+): Agent, MCP, Skills, Data Sources, Evaluation, Testing. (3) **Admin group** (`admin`): Users, Credentials, Runs. Empty groups hide themselves and their preceding divider — a regular user only sees the user group, an editor sees user + editor, an admin sees all three. Items declared in `TOOLBAR_ITEMS` (single source of truth); `kind: "panel"` toggles a left side panel via `useSidebarStore`, `kind: "route"` navigates, `kind: "notifications"` is a route variant with an unread-count badge.
- **ThreePanelContent** (`components/layout/ThreePanelContent`) — three resizable panels: left (side panel), center (route content), right (chat).
- **SidePanel** (`components/layout/SidePanel`) — left panel container, renders active panel from `sidebar-panel-registry`.
- **RightPanel** (`components/layout/RightPanel`) — right panel with Chat/History tabs. Owns `<CopilotKitProvider>` with a `key={agentId::source::cred}` that intentionally remounts the chat subtree on every agent switch (clean reset of messages / threadId / in-flight requests / welcome UI). See `docs/copilotkit-provider-lifecycle.md` before changing.
- **sidebar-panel-registry** — maps `LeftPanelId` to component + icon.

### State Management
- `useWorkspaceStore` (Zustand) — agent selection, artifact display, thread/session, pinned sessions.
- `useSidebarStore` (Zustand) — left panel selection (`activeLeftPanel`), right panel open state, right tab (chat/history).
- Only `pinnedSessions` is persisted to localStorage; all other state is transient.
- `WorkspaceProvider` auto-loads agent list on mount and wraps children in `<CopilotKit>`.

### Frontend Actions (AG-UI)
- `useAgentActions` hook registers `open_artifact` and `close_artifact` CopilotKit actions.
- Artifact types: `code | chart | dashboard | image | html | ppt | report`.

## Database Schema Overview

Tables defined in `src/lib/db/schema.ts`:

| Table | Purpose |
|---|---|
| `user`, `session`, `account`, `verification` | better-auth managed |
| `menu_item` | Dynamic navigation tree |
| `data_source` | Agent-facing data-access entity: provider + connection (host/port/db/params) + policy (readOnly, table allowlist/denylist), references a `credential` row for auth |
| `artifact` | AI-generated outputs (charts, dashboards, etc.) |
| `credential` | Encrypted credential store (API keys, tokens, certs) |
| `mcp_server` | MCP server connections with tool snapshots |
| `skill` / `skill_file` | DB-resident skill row + helper-file bytes (`bytea`); see `docs/skills.md` |
| `builtin_agent` / `builtin_agent_tool` | Built-in agent config (incl. `is_supervisor` flag) and tool bindings |
| `entity_run` / `entity_run_event` | One row per dispatch (chat / delegate / scheduled) + append-only event timeline; `parent_run_id` for tree linkage |
| `notification` | Inbox rows backing the bell + `/notifications` page; populated by async + scheduled run terminal events |
| `schedule` | Recurring / one-shot trigger spec `(startAt, [intervalValue, intervalUnit], [endAt])` — fired by the in-process `setTimeout` scheduler |
| `backend_thread_state` | Per-`(credentialId, threadId)` upstream-session tokens (today: Dify `conversation_id`); JSONB provider-namespaced; LRU-cached at `lib/backends/thread-state.server.ts` |

## Do NOT

- Write continuous comments longer than 5 lines in code. Put architectural documentation, API mappings, and lengthy context in `docs/` and link to it using `@see docs/...`. Keep file header comments to 1-3 lines explaining the core responsibility.
- Put secrets in plain-text DB columns — always use `credentials/crypto.ts` encrypt/decrypt.
- Use env vars as API key fallback for built-in agents — always use bound `credentialId`.
- Hardcode backend platform type — use credential's `provider` field, not env vars.
- Import server-only modules in client components — use `import "server-only"` guard.
- Use relative imports — always use `@/` alias.
