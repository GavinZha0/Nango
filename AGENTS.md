<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Nango Frontend — Agent Guidelines

> **Runtime boundary (v1) — read this first.** Nango runs as a **single
> long-running Node process** (Docker / VM / bare metal). Do **not**
> refactor toward multi-replica auto-scaling, and do **not** deploy
> to serverless runtimes (Vercel / Netlify / Cloudflare Workers) — the
> in-process caches, the `setTimeout`-based scheduler, in-flight async
> run Promises, and the SSE event-bus all assume long-lived process
> semantics. Positioning is **single-node multi-tenant** for personal
> and small-team usage; heavy / distributed work is delegated outward
> to backend agent platforms (agno / Mastra / Dify / …); built-in
> agents are a lightweight orchestration complement, not a distributed
> execution engine. See `docs/architecture.md` §"Runtime boundary",
> `docs/backend-integration.md`, and `docs/orchestrator.md` for the
> same statement at each entry point.

## Project Overview

Nango is an AI-powered agent workspace built with **Next.js 16.2.4**, **React 19**, **TypeScript**, and **Tailwind CSS 4**. It supports multi-backend AI agent platforms (agno, Mastra, Dify) via the **AG-UI** protocol — natively for AG-UI backends, via per-platform bridges for the rest. **Built-in agents** are configured in-app via the **CopilotKit** runtime and are the right path for raw LLM endpoints (Ollama, vLLM, Groq, OpenAI itself, …); do NOT register raw LLM endpoints as backend agent platforms. For OpenAI-Compat agent platforms (FastGPT / AnythingLLM / Coze), each has its own request schema (`chatId`, `mode`, bot_id, …); contribute a dedicated `providers/<slug>/` folder rather than reusing a generic adapter — see `docs/backend-integration.md` §10.

## Tech Stack

- **Framework**: Next.js 16.2.4 (App Router, Turbopack default)
- **React**: 19.2.4
- **Auth**: better-auth (email/password, admin plugin, session cookies)
- **Database**: PostgreSQL 18 via Drizzle ORM
- **State**: Zustand (client), SWR (data fetching)
- **UI**: shadcn/ui, Tailwind CSS 4, Lucide icons, next-themes (dark default)
- **AI Runtime**: @copilotkit/runtime + @copilotkit/react-core, @ag-ui/client
- **Validation**: Zod 4 (static, design-time schemas — API parsing, spec shape, etc.) · ajv 8 (runtime dynamic JSON Schema validation, scoped to `src/lib/workflows/nodes/` for node `input_schema` / `output_schema` enforcement)
- **Encryption**: AES-256-GCM for credential storage

## Development Commands

```bash
pnpm dev          # Dev server (Turbopack, http://localhost:9300)
pnpm build        # Production build
pnpm start        # Run the production build
pnpm lint         # ESLint
pnpm check-types  # TypeScript no-emit
pnpm test         # Vitest unit tests
pnpm test:e2e     # Playwright E2E
pnpm db:generate  # Drizzle migration from schema diff (commit BOTH .sql + meta/*.json)
pnpm db:migrate   # Apply pending migrations
pnpm db:push      # Push schema directly — dev only, never against prod
pnpm db:studio    # Drizzle Studio
pnpm docker:db    # Start bundled Postgres 18 on localhost:5433
pnpm build:skills # Bake builtin skills directory tree → dist/builtin-skills.json
pnpm sandbox:build  # Aggregate per-skill python deps → docker/sandbox/requirements.txt
pnpm sandbox:check  # Guard CI against drift between SKILL.md deps and requirements.txt
pnpm comments:check       # Run the source-comment rule guard on the file list passed as args
pnpm comments:check:all   # Same guard, but sweep all of src/ and scripts/
```

## Architecture Rules

1. **Route groups**: `(auth)` for sign-in/sign-up; `(workspace)` for authenticated pages. Server-side guards in layouts enforce session checks.
2. **API routes** live under `src/app/api/`. Wrap every handler with `withSession(routePath, handler)`, `withEditor(routePath, handler)`, or `withAdmin(routePath, handler)` from `src/lib/http/route-handlers.ts` — these resolve the session, generate a `requestId`, bind a child logger, and render the standard error envelope (`{ ok:false, code, message, requestId, details? }`) on auth failures or thrown `ApiError`s. Throw `new ApiError(code, status, message, details?)` from anywhere inside the handler to short-circuit with a precise envelope; `parseBody(req, schema)` from `src/lib/http/validation.ts` throws `ApiError` on JSON / Zod failures so handlers never need to branch on parse results. The HOFs intentionally do NOT touch success response shapes — keep returning `NextResponse.json(data)` directly.
3. **Role-based access** (`docs/rbac.md`): three roles — `admin` (everything), `editor` (AI resource builder), `user` (consumer). Page-level guards: `requireSession()` / `requireEditor()` / `requireAdmin()`. API HOFs: `withSession` / `withEditor` / `withAdmin`. Resource permissions on `skill` / `mcp_server` / `builtin_agent` use the row's `(source, visibility, createdBy)` evaluated by `canEditResource` / `canDeleteResource` / `canChangeVisibility` from `lib/auth/permissions.ts`. `source = 'builtin'` is an absolute write barrier no role can pass.
4. **Credentials**: managed only by admin. All secrets encrypted with AES-256-GCM. Enabled credentials are reusable by all team members.
5. **Built-in agents**: use their bound `credentialId` for model auth (no env API key fallback). Visibility restricted to owner-created or public agents.
6. **Backend agents**: each platform lives under `src/lib/backends/<slug>/`. The folder owns four files — `adapter.ts` (`IBackendAdapter`, client-side metadata via the `/api/backend` reverse proxy), `chat.server.ts` (`IBackendChatHandler`, server-only REST→AG-UI bridge), `entity.server.ts` (server-only direct upstream fetcher), and `index.server.ts` which aggregates the three into a single `BackendModule`. The full server-side wire-up happens in **one place**: `src/lib/backends/registry.server.ts` (`BACKENDS satisfies Record<BackendId, BackendModule>`). The client-safe REST adapter map stays in `src/lib/backends/registry.ts` so client components don't pull server-only modules. **Every chat handler bridges the upstream platform's REST + SSE stream into AG-UI events on the fly** (agno, Mastra, Dify all share this shape) and is built on top of `src/lib/backends/bridge-runtime-kit.server.ts`, which provides `createBridgeRunObservable`, `attachBridgeConfig`, `readSseLines`, `resolveBridgeCredential`, plus the shared helpers `ToolCallFilter`, `TextStreamState`, and `lastUserText`. (`user_id` for `forwardedProps` is server-injected upstream by `lib/runner/inject-user-id.ts`, so bridges read it directly without a helper.) The credential's `restUrl` is required for any backend integration. The legacy AG-UI pass-through helper still lives in `src/lib/backends/runtime.server.ts` (`passthroughAgUiChat`) but no current handler uses it. Browser only ever sees AG-UI; secrets stay server-side. Multiple backends can be active simultaneously — each credential represents one backend (or one Dify app), and entities (agent / team / workflow) are grouped by credential name in the UI. The entity *kind* used by chat dispatch is server-derived: the chat route resolves it via `EntityCatalog.list(credentialId)` (10-min LRU cache, warmed by the agent picker on UI mount); supervisor tools read it from their precomputed catalog, the scheduler reads it from `schedule.entity_kind`. The browser supplies only `X-Credential-Id`; `agentId` comes from the URL path. **Do not** register raw LLM endpoints as backend agent platforms; use the Built-in agent path instead. Architectural reference (control / data plane separation, `BackendModule` pattern, security model, hot-path invariants) and the four-step onboarding for a new platform: `docs/backend-integration.md` (§10 is the onboarding mechanics). Runner kernel + supervisor / async / schedule design: `docs/orchestrator.md`.
7. **Schema**: all domain tables in `src/lib/db/schema.ts`. Migrations in `src/lib/db/migrations/`. ALWAYS run `pnpm db:generate --name=<descriptive>` to produce migrations — drizzle-kit emits BOTH a `<idx>_<name>.sql` and a `meta/<idx>_snapshot.json`; commit BOTH. Hand-writing SQL desyncs the snapshot chain that `db:generate` depends on for future diffs (`drizzle-kit` reads the most recent snapshot to compute the next diff). If you must hand-edit a generated SQL for clarity (comments, multi-statement reordering), do so AFTER drizzle-kit produced the snapshot — never edit or delete the snapshot itself. To verify the chain is intact: every entry in `meta/_journal.json` must have a corresponding `meta/<idx>_snapshot.json` file.
8. **Server-only imports**: use `import "server-only"` for modules that must never reach the client bundle.
9. **Caching**: six process-wide caches live in the Node process. Four back the Built-in runtime: the credential lookup cache (`credentials/lookup.ts`, 10-min TTL), the AgentSpec pool (`builtin-agents/agent-pool.ts`, LRU + 10-min TTL), the MCP provider pool (`mcp/provider-pool.ts`, refcounted + idle reaper), and the Skill pool (`skills/skill-pool.ts`, LRU + 10-min TTL). The fifth is the control-plane EntityCatalog cache (`backends/entity-catalog.ts`, keyed by `credentialId`, 10-min TTL) used for UI entity listing, supervisor catalog rendering, and schedule validation. The sixth is the backend thread-state cache (`backends/thread-state.server.ts`, LRU keyed by `(credentialId, threadId)`) which fronts the `backend_thread_state` table for per-thread upstream-session tokens (today: Dify `conversation_id`); cache misses lazy-hydrate from the DB so values survive Node restart. After write operations call the appropriate hook from `credentials/invalidation.ts` (`invalidateForCredentialChange` fans out to AgentSpec / MCP provider / EntityCatalog; `invalidateForMcpServerChange` covers MCP-only) or `skills/invalidation.ts` (`invalidateForSkillChange`) plus `invalidateCredentialCache()`. Per-agent writes call `agentPool.invalidate(id)` directly. See `docs/builtin-runtime.md` and `docs/skills.md`.
10. **Skills**: DB-resident reusable capabilities (Claude Skills convention). Each skill is one row in `skill` (frontmatter `name`, `description`, optional `version`, optional `dependencies-python`) plus zero-or-more rows in `skill_file` (helper bytes as `bytea`; ≤ 256 KB / file, ≤ 100 files & 10 MB / skill, enforced at write). Two kinds: **builtin** (`source='builtin'`, authored as directory trees under `<repo>/skills/<name>/` with `SKILL.md` + `references/` / `scripts/` / `assets/` / `evals/`, baked into `dist/builtin-skills.json` by `pnpm build:skills` — wired to `prebuild` — and reconciled into the DB at boot via `instrumentation.ts → seedBuiltinSkills`) and **custom** (`source='local'`, created via `POST /api/skills` or ZIP import at `POST /api/skills/import`). `source='builtin'` is the absolute write barrier — no role can mutate those rows through the API. The runtime injects only `name + description` of bound skills into the system prompt and exposes server-side tools `get_skill`, `get_skill_file`, `run_skill_script` via `defineTool` from `@copilotkit/runtime/v2` (`run_skill_script` delegates to the active sandbox adapter — same enforcement envelope as `run_code_in_sandbox`; V1 dispatches `.py` → python3 and `.sh` → bash, stdin not exposed as a parameter); reads are pure DB. **Sandbox Python deps** are declared per-skill via `dependencies-python: [...]` in builtin SKILL.md frontmatter and aggregated into `docker/sandbox/requirements.txt` by `pnpm sandbox:build` (`scripts/collect-skill-deps.ts`); CI guards drift via `pnpm sandbox:check`. Do NOT add inline `pip install` lines to the Dockerfile. User skills' declarations are advisory until promoted to builtin. The editor lives at `/skills/[id]` (center workspace, mirrors `/agent/[id]` and `/schedule/[id]`). See `docs/skills.md` (§9.x for the dep-aggregation design).
11. **Runner / orchestration kernel**: every dispatch — chat, supervisor delegation, async, scheduled — is materialised as one `entity_run` row + N `entity_run_event` rows (see `lib/runner/`). The chat path goes through `runner.runChatRequest` / `runner.runBuiltinChatRequest`; programmatic dispatch from supervisor tools / scheduler goes through `runner.start({ mode: "sync" | "async" })`. Each run carries `parent_run_id` for tree linkage (3-level depth limit) and `initiator ∈ { user | orchestrator | schedule | system }`. See `docs/orchestrator.md` for the kernel and `docs/runner-events.md` for the event pipeline (reception → coalescing → persistence → replay → admin display, plus the AG-UI ↔ `EntityRunEventType` reference table).
12. **Supervisor (Nango) + agent `role` enum**: `builtin_agent.role` is a nullable enum (`'supervisor' | 'secretary' | 'evaluator' | null`) — `null` is a regular user-authored agent. Mutability is **monotonic**: a regular agent (`role = null`) can be promoted exactly once to any system role; once set, the value is frozen, and the row must be deleted & recreated to "change" it (`409 CONFLICT` otherwise). Per-user uniqueness: supervisor and secretary are 1-per-user (separate partial unique indexes); evaluator is unconstrained — a user can author multiple evaluators targeting different evaluation types. System-role agents (`role !== null`) are filtered out of (a) the chat picker, (b) the handoff target list, and (c) `buildCatalog()` for the supervisor — they are never user-routable. The supervisor (`role = 'supervisor'`) is the only system role with runtime behaviour in Stage 1: identity (`name = 'Nango'`, `description`, `prompt`) is **server-managed and read-only** — the canonical values live in `lib/constants/supervisor.ts` (`SUPERVISOR_NAME` / `SUPERVISOR_DESCRIPTION` / `SUPERVISOR_PROMPT`); POST + PATCH-promotion write them synchronously, and `instrumentation.ts → canonicalizeSupervisorAgents()` re-syncs every supervisor row on every boot so constant updates between deploys converge automatically. `SUPERVISOR_PROMPT` is **self-contained** (identity / mission / capabilities / SOP / decision policy / safety / examples) — the dispatch layer reads it from `spec.prompt` exactly like any other agent and does NOT prepend any extra static blocks: `SAFETY_POLICY_BLOCK` / `ERROR_POLICY_BLOCK` / chart-prompt block are skipped for supervisor (they're already covered inside `SUPERVISOR_PROMPT`). The catalog of routable specialists is precomputed at request time and **appended after** `spec.prompt` and any bound capability blocks (skills / data sources / SSH) — there is no `list_agents` tool. Supervisor-only tools (`delegate_to_agent`, `delegate_async`, `create_schedule`, `list_schedules`, `update_schedule`, `delete_schedule`) are injected directly when `role === 'supervisor'`, NOT via the `builtin_agent_tool` junction table. `update_schedule` is partial (omitted fields stay as-is) and stricter than the REST PATCH route — a `startAt` in the past is rejected so the LLM can't accidentally backfill. `delete_schedule` is hard-delete; pause-without-delete is `update_schedule({enabled: false})`. The user-selected orchestration mode (`auto | tool-call | handoff | async`) feeds a per-mode prompt directive appended LAST (per-turn recency); see `lib/orchestration/modes.ts`. `secretary` / `evaluator` values are reserved in the enum but their runtime behaviour will land later; UI exposes only the supervisor promotion path (via the "Set as Nango" toggle). See `docs/prompts.md` for the prompt-block inventory and dispatch-time composition order.
13. **Notifications & async**: `mode: "async"` runs return a `runId` immediately and notify on terminal events. The `notification` table backs the bell dropdown + `/notifications` page; `lib/runner/event-bus.ts` provides in-process pub/sub keyed by `ownerId`, surfaced via SSE on `/api/runs/stream`. SSE frames carry `id: <notification.id>` (UUIDv7) so EventSource auto-reconnect with `Last-Event-ID` resumes via `notification WHERE owner_id = $u AND id > $lastId ORDER BY id LIMIT 200`; live events that arrive during replay are buffered and de-duplicated by id, never lost. `run_finalized` frames intentionally carry no `id:` (informational only — the durable copy is the matching `notification` row). Recovery on Next.js boot is **boot-epoch anchored**: `instrumentation.ts` calls `recordProcessBoot()` (one row per Node start in `process_boot`) BEFORE `recoverStrandedRuns(boot.startedAt)`. Any `entity_run` with `started_at < boot.startedAt` is by definition a zombie from a prior process and gets flipped to `failed` + a `run_failed` notification within seconds of boot. The old "stuck >1h" heuristic is gone — current-process long runs (>1h) are NOT swept here.
14. **Schedules**: `schedule` table + in-process `setTimeout`-based scheduler (`lib/runner/scheduler.ts`, NOT cron). Trigger spec is `(startAt, [intervalValue, intervalUnit], [endAt])` — one-shot or recurring with optional window. Each fire dispatches through `runner.start({ mode: "async", initiator: "schedule" })` so scheduled runs land in the same notification inbox. Editor at `/schedule/[id]`.
15. **Admin run forensics**: `/admin/run` (list) + `/admin/run/[id]` (detail with children + event timeline) under `withAdmin`. End-user surfaces (chat task card, notification) stay outcome-focused; the run forest is admin-only triage.
16. **Data sources**: agent-facing query target. One row in `data_source` = "an agent can read this DB under this policy". Layout splits cleanly: connection metadata (`provider`, `host`, `port`, `database`, `params`) + access policy (`readOnly` / `tableAllowlist` / `tableDenylist`) live on the row; authentication (`user`, `password`) lives on the linked `credential` (slimmed to `{user, password}` for datasource providers — host etc. live on the `data_source` row). One credential can back many data sources with different policies (e.g. `prod_pg_readonly` and `prod_pg_admin` over the same DB). `extract_dataset_by_sql.dataSourceName` is the row's `name` (a stable, LLM-facing identifier — globally unique, regex `[a-z][a-z0-9_-]{0,62}`); the runtime resolves it via `data-sources/lookup.ts`, then runs SQL through `data-sources/policy.ts` (parses with `node-sql-parser`, rejects writes / disallowed tables BEFORE the cache is touched, fails closed on parse errors). The tool is **auto-mounted whenever the agent has any data_source binding** — it is NOT in the user-tickable `builtin-tools/catalog.ts` (parallels `run_ssh_command` / `ssh_server` and `get_skill` / `skill`). `ondelete restrict` on the `credential_id` FK so a referenced credential can't disappear out from under the runtime. CRUD via `/api/data-sources` (editor+) + `/api/data-sources/[id]/test-connection` (10s probe via the adapter). Bound to agents through `builtin_agent_tool` rows with `toolType="datasource"`; the dispatch layer injects an "Available data sources" block (`data-sources/prompt-block.server.ts`) into the system prompt so the LLM sees `name (provider) — description` for each enabled binding. Cached Parquet datasets carry `sidecar.dataSourceId` so DELETE can `purgeDatasetsForDataSource()`. Editor at `/datasource/[id]` (mirrors `/agent/[id]`); panel at `DataSourcePanel`. See `docs/data-sources.md`.
17. **SSH integration**: `run_ssh_command` and `list_ssh_hosts` built-in tools (`lib/ssh/runtime-tools.ts`) execute shell commands on remote hosts using `node-ssh`. Connection metadata + access policy live on the `ssh_server` table (`name` slug / `host` / `port` / `known_host_fingerprint` / `command_allow / command_deny` regex patterns / `enabled` / `visibility`); the bound `credential` row carries the auth secret AND the OS `username`, reusing the existing credential types `basic_auth` (`{username, password}`) or `private_key` (`{username, privateKey, passphrase?}`). The runtime normalises both shapes into a single `NormalisedSshAuth` (`auth-loader.ts`) before handing the connect builder a `kind`-discriminated record — Nango never invents an SSH-specific credential payload. One credential identifies one OS user across many ssh_server rows. Host-key verification is **admin-confirmed TOFU**: the editor's "Verify connection" button (`POST /api/ssh-servers/[id]/verify-connection` for saved rows or stateless `POST /api/ssh-servers/verify-connection` for the New flow) does one round-trip that captures the host key in `hostVerifier` AND attempts auth, returning `{fingerprint, durationMs}` so the field auto-fills. Save with an empty fingerprint triggers the same auto-verify server-side; auth failure aborts the save. Subsequent `run_ssh_command` calls always strict-pin via `lookup.ts` → `client.ts`. Command policy is **enforced at runtime** by `lib/ssh/policy.ts` BEFORE the SSH channel opens — denied commands return `error: "POLICY_DENIED"` with the matched pattern; malformed regexes fail closed. `commandAllow === null` is "no constraint", `[]` is "deny all"; deny precedence over allow. The host-list prompt block tags restricted hosts with `[restricted]` so the LLM knows up front. Beyond the policy gate the credential's user has full shell access — there is no remote sandbox. Caps via env vars `SSH_EXEC_TIMEOUT_MS` / `SSH_CONNECT_TIMEOUT_MS` / `SSH_EXEC_MAX_OUTPUT_BYTES` (`lib/ssh/limits.ts`, mirrors `data-sources/limits.ts`). No connection pool in V1 — each call connects + execs + disposes; auditing is automatic via `entity_run_event`. APIs: `GET/POST/PATCH/DELETE /api/ssh-servers`, `POST /api/ssh-servers/[id]/verify-connection` (saved-row), `POST /api/ssh-servers/verify-connection` (stateless), `GET /api/ssh-credentials` (picker — filters by `type IN ('basic_auth', 'private_key') AND enabled`). See `docs/ssh.md`.
18. **Chat history (unified source)**: persisted in `entity_run` + `entity_run_event` (the same tables that back the orchestration kernel); reconstructed for the UI via `GET /api/threads` (list, scoped to `owner_id`, optional `?entityId=` filter), `GET /api/threads/[id]/messages` (returns AG-UI `Message[]` from entity_run.input_task as user turns + entity_run_event `message` / `tool_call` / `tool_result` rows as assistant turns), `DELETE /api/threads/[id]` (recursive CTE walks the run forest to remove top-level + delegated sub-runs together). This **replaces** the previous reverse-proxy of upstream session APIs (agno / Mastra / Dify `/sessions`) — built-in and backend agents now share one PG-side history source. SECURITY: every endpoint filters by `owner_id = session.user.id` so a user guessing another user's threadId returns empty. Sub-runs (supervisor delegation forests) are excluded from `/api/threads*` reads via `parent_run_id IS NULL`; admins still see them at `/admin/run/[id]`. Client hydration: `useThreadHydration` (in `hooks/`) seeds `<CopilotChat>` via `agent.setMessages(...)` on first mount per `(agentId, threadId)` so refresh / history-click resumes mid-conversation.
19. **Tool execution failure contract**: every tool wired into a Built-in agent — MCP (Class A), auto-mounted (Class B: skills / data sources / SSH / supervisor), and manually-selected (Class C: `run_code_in_sandbox`) — has its `execute` function wrapped by `wrapToolExecute` from `src/lib/runner/tool-failure.ts`. The wrapper guarantees that an uncaught throw is **converted into a return value** of shape `{ isError: true, message, toolName }` instead of bubbling up to the AI SDK as a `tool-error` part. This is mandatory because CopilotKit 1.56's AI SDK → AG-UI converter (`@copilotkit/runtime/src/agent/converters/aisdk.ts`) has no `case "tool-error"` branch — a `tool-error` is silently dropped, the browser never receives `TOOL_CALL_RESULT`, and the React tool-call UI stays stuck on `TOOL_CALL_END` forever. MCP tools are wrapped at borrow time in `lib/mcp/client-providers.ts → wrapTools`; Class B/C are wrapped at dispatch time in `lib/runner/dispatch/builtin.ts` before `new BuiltInAgent({ tools })`. The wrapper is idempotent (`__nangoWrapped` marker) so MCP tools don't get a second try/catch layer. The single source of truth for the LLM-facing failure shape and the system-prompt error-handling block (`ERROR_POLICY_BLOCK`, injected into the composed prompt whenever the agent has at least one tool) is `tool-failure.ts`. **Authoring rule** for new server-side tools: business errors should still return a structured object (e.g. `{ ok: false, error: "..." }` — kept as-is per current convention); the wrapper exists only to catch **unexpected** throws. Do not throw from `execute` as a control-flow mechanism — return a domain-specific shape instead.
    - **Ops monitoring**: every wrapper-caught throw emits a pino `warn` (not `error`) because the business flow is still alive — the agent run continues and the user sees a structured error in the UI. Configure Datadog / Sentry / equivalent to alert on `event=server_tool_failed` (Class B/C) and `event=mcp_tool_call_failed` (MCP transport) at `warn` level so genuine infrastructure failures (db down, network partition) don't get buried in noise. Don't blanket-escalate these to `error` — that would page on every LLM mis-call.
    - **Known limitation — invalid-args path is NOT covered**: AI SDK validates tool-call arguments against each tool's Zod / JSON-Schema BEFORE calling `execute` (`doParseToolCall` → `safeParseJSON` / `safeValidateTypes`). On `InvalidToolInputError` or `NoSuchToolError`, AI SDK marks the toolCall `invalid: true` and **manually enqueues** a `tool-error` part to the fullStream without invoking `execute` at all (see `ai/dist/index.js` lines 3858-3909 and 4609-4621). Our wrapper never gets a chance to convert it, and CopilotKit's converter still drops it — so a hallucinated arg payload from the LLM still leaves the browser stuck. Modern LLMs (GPT-4, Claude 3.5+) with `additionalProperties: false` rarely trip this in practice, but if production observability surfaces `InvalidToolInputError` in agent logs, the fix is patch-package on CopilotKit's converter (add a `case "tool-error"` branch) or an upstream PR. Tracked for follow-up — do not silently extend `wrapToolExecute` to "fix" this; it can't see `invalid: true` parts.
20. **Verification subsystem**: deterministic assert-on-output harness for MCP tools (V1) and Nango internal workflows (V2). Named "Verification" (not "Test") to (a) avoid collision with the playground "Test" tab inside the MCP management page and (b) form a clean lexical pair with the sibling **Evaluation** subsystem (`docs/eval.md`, TBD) for stochastic agent quality scoring. Four tables — `verification_suite` (mgmt group, `category ∈ {mcp,workflow}`), `verification_case` (target XOR by category: `(mcp_server_id, tool_name)` for MCP, `workflow_id` for workflow), `verification_run` (per-suite execution summary, UUIDv4 — URL-exposed via `?run=`), `verification_case_result` (per-case execution detail, frozen `input_snapshot`, structured `error: {source, message, details?}` with `source ∈ {mcphub, upstream, transport, assertion, timeout, internal}`). MCP cases do **NOT** go through `entity_run` — they call `mcp/provider-pool` directly, since a tool call is not an entity dispatch; workflow cases reuse `runner.start({mode:"async", initiator:"verification"})` and link via `verification_case_result.entity_run_id`. Suite execution is **serial, alphabetical, failure-tolerant**, suite-level timeout (`timeout_sec`, default 5min) marks remaining cases as `skipped`. SSE updates piggyback `lib/runner/event-bus.ts` with `topic:"verification_run"` frames (`run_started` / `case_finished` / `run_finished`). Assertions in `verification_case.assertions` are one of `json_schema` (ajv 8), `jsonpath_equals`, or `js_expression` (sandboxed `node:vm`, 1s); empty array = smoke test. UI: left panel `VerificationPanel` with `[MCP][Workflow]` tabs; suite editor `/verification/[id]` is three columns (cases tree / Input·Assertions tabs / Run + Result viewer) plus a recent-runs banner (5 chips, Prev/Next pagination, no Latest; click chip = inline history-view mode with `?run=<id>` URL state, frozen `input_snapshot` + `assertion_results` + `result_payload`, exit button returns to live edit). All routes `withEditor`. Single-case run is synchronous and leaves no trace; suite run is async and persists. See `docs/verification.md` (single source of truth).

## Key Directories

```
src/
  app/
    (auth)/           # Sign-in, sign-up pages
    (workspace)/      # Authenticated workspace (main page, admin, profile)
    api/              # API routes (auth, copilotkit, admin, backend, tools, skills)
  components/
    admin/            # CredentialMgmt, UserMgmt, RunMgmtTable, RunDetailView
    auth/             # Shared auth form
    chat/             # Chat UI (if present)
    layout/           # Header, NotificationBell, LeftToolbar, SidePanel,
                      # ThreePanelContent, RightPanel, WorkspaceProvider
    left-panels/      # Side-bar list / menu views shown in the LEFT
                      # resizable panel (registered in
                      # sidebar-panel-registry). DashboardPanel,
                      # ArtifactPanel (placeholders), AgentPanel,
                      # McpPanel, SkillsPanel, SchedulesPanel,
                      # DataSourcePanel, SshServerPanel
    middle-panels/    # Editors mounted as the CENTER content of
                      # /agent/[id], /datasource/[id],
                      # /schedule/[id], /skills/[id],
                      # /ssh-server/[id]. BuiltinAgentEditor,
                      # DataSourceEditor, ScheduleEditor, SkillEditor,
                      # SshServerEditor
    right-panels/     # Chat-related views shown in the RIGHT
                      # resizable panel + tab content. ChatPanel,
                      # HistoryPanel, ChatErrorBanner,
                      # DelegateToAgentCard, HandoffCard,
                      # NangoSlotButton, TimingChip
    ui/               # shadcn/ui primitives
    workspace/        # ArtifactRenderer, etc.
  hooks/              # useAgentActions, useChatTiming, useNotifications,
                      # useHandoff
  instrumentation.ts  # Next.js boot hook: stranded-run recovery + scheduler
                      # bootstrap
  lib/
    http/                       # HTTP route plumbing (used by src/app/api/*)
      route-handlers.ts         #   withSession / withAdmin / withEditor HOFs
      validation.ts             #   parseBody (zod-driven) + ApiError
    backends/                   # Agent backend integration layer
                                # (one file per concept + one folder per platform)
      types.ts                  #   IBackendAdapter, IBackendChatHandler,
                                #   EntityFetcher, BackendModule, BackendId,
                                #   EntityDescriptor, ChatContext, capabilities
      facade.ts                 #   client-facing: getEntities, hasEntityKind, …
      registry.ts               #   client-safe ADAPTERS: Record<BackendId, IBackendAdapter>
      registry.server.ts        #   server-only BACKENDS: Record<BackendId, BackendModule>
                                #   + getChatHandler / getBackend
      entity-catalog.ts         #   control-plane EntityCatalog facade
                                #   (list / invalidate); reads BACKENDS
      runtime.server.ts         #   AG-UI runtime helper (CopilotRuntime adapter)
      bridge-runtime-kit.server.ts
                                #   shared bridge spine: createBridgeRunObservable,
                                #   readSseLines, resolveBridgeCredential, ToolCallFilter,
                                #   TextStreamState, lastUserText
      agno/                     #   one folder per platform; each ships
        adapter.ts              #     client IBackendAdapter (proxied REST)
        chat.server.ts          #     server IBackendChatHandler + BridgeAgent
        entity.server.ts        #     server-only upstream fetcher (EntityCatalog only)
        index.server.ts         #     exports agnoBackend: BackendModule
      mastra/  ...
      dify/    ...
    builtin-agents/             # Built-in agent runtime cache
      agent-pool.ts             #   Process-wide AgentSpec LRU pool
      agent-spec.ts             #   AgentSpec + polymorphic AgentToolRef types
      model-resolver.ts         #   AgentSpec → (model, apiKey?) for BuiltInAgent
      index.ts                  #   agentPool singleton
    mcp/                        # MCP subsystem
      provider-pool.ts          #   Process-wide refcounted MCP provider pool
      client-providers.ts       #   Graceful CopilotKit MCPClientProvider for built-ins
      index.ts                  #   mcpProviderPool singleton + DB config loader
    auth/                       # better-auth instance, client, route guards, access rules
    db/                         # Drizzle DB connection, schema, migrations
    domain/                     # Domain types (artifact)
    constants/                  # App constants (incl. credential provider entries)
    credentials/                # Credential subsystem
      crypto.ts                 #   AES-256-GCM encrypt/decrypt (versioned keyring)
      lookup.ts                 #   Server-side credential resolution with cache
      invalidation.ts           #   Cross-pool invalidation hooks (credential / MCP)
    access/
      agent-visibility.ts       # isAgentVisibleTo / listVisibleAgentIds
    skills/                     # Skill subsystem (Claude Skills convention, DB-first)
      parser.ts                 #   YAML frontmatter parser (server+client safe)
      skill-pool.ts             #   process-wide LRU of resolved SkillSpec
      builtin-reconcile.ts      #   seedBuiltinSkills(): diff dist/builtin-skills.json at boot
      invalidation.ts           #   invalidateForSkillChange (cross-pool)
      runtime-tools.ts          #   defineTool builders for get_skill / get_skill_file
      storage/                  #   SkillStorage interface + DbSkillStorage impl
      index.ts                  #   barrel export
    runner/                # Execution kernel — every chat / delegate / schedule
                           # produces an entity_run row + N entity_run_event rows
      types.ts             #   Runner interface + StartRunInput + RunEvent
      runner.ts            #   concrete impl: runChatRequest, runBuiltinChatRequest,
                           #   start (sync + async)
      persisting-agent.ts  #   AG-UI event tee → entity_run_event
      event-store.ts       #   entity_run + entity_run_event writes
      event-bus.ts         #   in-process pub/sub for async / SSE
      notifications.ts     #   recordRunNotification (NUL strip + truncation)
      recovery.ts          #   stranded-run sweep at boot (boot-epoch
                           #   anchored; consumes process_boot.startedAt)
      process-boot.ts      #   recordProcessBoot — one process_boot row
                           #   per Node start; cached in globalThis
      scheduler.ts         #   setTimeout-based scheduler for `schedule` rows
      schedule-dto.ts      #   wire shape for /api/schedules + computed nextRunAt
      supervisor-tools.server.ts # delegate_to_agent / delegate_async /
                                 # create_schedule / list_schedules /
                                 # update_schedule / delete_schedule +
                                 # agent catalog renderer
      dispatch/
        builtin.ts         #   build BuiltInAgent + bind supervisor runtime
        backend.ts         #   build BridgeAgent for backend platforms
      index.ts
    orchestration/
      modes.ts             #   mode registry (auto / tool-call / handoff / async)
                           #   + per-mode prompt directives
      display-name.ts      #   computeSourceLabel / computeDisplayName
                           #   (server + client share)
    workflows/         # DAG workflow runtime (artifact refresh backbone)
                       # nodes/ (per-node implementations with input_schema /
                       # output_schema validated by ajv 8), engine, dto
    artifacts/         # Artifact service: persist AI outputs into a
                       # browsable library; pairs each savable artifact
                       # with a frozen replayable workflow
    data-sources/      # Agent-facing query subsystem
                       # lookup.ts, policy.ts (node-sql-parser based
                       # read-only + allow/deny enforcement),
                       # prompt-block.server.ts (system-prompt block),
                       # adapters (pg / mysql / vertica / …)
    ssh/               # SSH tool subsystem
                       # auth-loader.ts, client.ts (strict host-key pin),
                       # policy.ts (command allow/deny), runtime-tools.ts
                       # (run_ssh_command, list_ssh_hosts)
    sandbox/           # Code-execution sandbox adapters
                       # (run_code_in_sandbox + run_skill_script delegate
                       # to the active adapter; Python image baked from
                       # docker/sandbox/)
    builtin-tools/     # User-tickable built-in tools catalog
                       # (auto-mounted tools — datasource / SSH / skills /
                       # supervisor — are NOT in this catalog)
    copilot/           # CopilotKit runtime glue (composed system prompt,
                       # supervisor catalog injection, mode directives)
    cache/             # Shared columnar dataset cache (Parquet sidecars
                       # carrying dataSourceId for purge cascading)
    web-search/        # web_search built-in tool + provider adapters
    verification/      # Verification subsystem (deterministic assert-on-output)
                       # storage.ts, assertions.ts (json_schema / jsonpath /
                       # js_expression), runner-mcp.ts, run-orchestrator.ts
                       # (serial, failure-tolerant, suite-timeout),
                       # event-bus-channel.ts (topic:"verification_run" frames).
                       # See docs/verification.md
    outcomes/          # Outcome envelope helpers used by tool wrappers
    observability/     # pino logger + secret redaction
    config/            # Admin-editable runtime config (Admin → Config)
    time/              # Time helpers (UUIDv7 epoch math, scheduler windows)
  store/              # Zustand stores (workspace.ts, sidebar.ts,
                      # notifications.ts, schedules.ts, chat-timing.ts)
  types/              # Shared type definitions
```

## Frontend Architecture

### Layout
- **`Header`** (`components/layout/Header`) — top bar: Logo, `NotificationBell` (live SSE-backed bell with unread badge + dropdown of last 6), user menu, chat toggle.
- **`LeftToolbar`** (`components/layout/LeftToolbar`) — fixed `w-12` vertical icon bar with three permission-driven groups separated by thin dividers: (1) **user group** (everyone): Dashboard, Artifact, Schedules, Notifications; (2) **editor group** (`editor`+): Agent, MCP, Skills, Data Sources, Evaluation, Testing; (3) **admin group** (`admin`): Users, Credentials, Runs. Empty groups hide themselves and their preceding divider. Items declared in `TOOLBAR_ITEMS` (single source of truth); `kind: "panel"` toggles a left side panel via `useSidebarStore`, `kind: "route"` navigates, `kind: "notifications"` is a route variant with an unread-count badge.
- **`ThreePanelContent`** — three resizable panels: left (side panel), center (route content), right (chat).
- **`SidePanel`** — left panel container, renders the active panel from `sidebar-panel-registry`.
- **`RightPanel`** — right panel with Chat / History tabs. Owns `<CopilotKitProvider>` with `key={agentId::source::cred}` that intentionally remounts the chat subtree on every agent switch (clean reset of messages / threadId / in-flight requests / welcome UI). See `docs/copilotkit-provider-lifecycle.md` before changing.
- **`sidebar-panel-registry`** — maps `LeftPanelId` → component + icon.

### State Management
- **`useWorkspaceStore`** (Zustand) — agent selection, artifact display, thread/session, pinned sessions.
- **`useSidebarStore`** (Zustand) — `activeLeftPanel`, right panel open state, right tab (chat / history).
- Only `pinnedSessions` is persisted to `localStorage`; all other state is transient.
- `WorkspaceProvider` auto-loads agent list on mount and wraps children in `<CopilotKit>`.

### Frontend Actions (AG-UI)
- `useAgentActions` hook registers CopilotKit actions: `open_artifact`, `close_artifact`.
- Artifact types: `code | chart | dashboard | image | html | ppt | report`.

## Database Schema Reference

Tables defined in `src/lib/db/schema.ts`:

| Table | Purpose |
|---|---|
| `user`, `session`, `account`, `verification` | better-auth managed |
| `menu_item` | Dynamic navigation tree |
| `credential` | Encrypted secret store (`v1:<keyId>:<iv>:<authTag>:<ct>`); admin-only CRUD |
| `data_source` | Agent-facing data-access entity: provider + connection + policy; references a `credential` |
| `mcp_server` | MCP server connections with tool snapshots |
| `skill` / `skill_file` | DB-resident skill row + helper-file bytes (`bytea`) |
| `builtin_agent` / `builtin_agent_tool` | Built-in agent config (incl. `role` enum) + tool bindings (MCP / skill / datasource / SSH / built-in) |
| `ssh_server` | SSH host metadata + access policy (`command_allow / command_deny`); references a `credential` |
| `entity_run` / `entity_run_event` | One row per dispatch + append-only event timeline; `parent_run_id` for run-forest linkage |
| `notification` | Inbox rows backing the bell + `/notifications`; UUIDv7 PK for monotonic SSE replay |
| `schedule` | Recurring / one-shot trigger spec `(startAt, [intervalValue, intervalUnit], [endAt])`; fired by the in-process `setTimeout` scheduler |
| `backend_thread_state` | Per-`(credentialId, threadId)` upstream-session tokens (today: Dify `conversation_id`); LRU-cached |
| `artifact` | Saved AI-generated outputs (charts, dashboards, code, image, html, ppt, report) |
| `process_boot` | One row per Node process start; anchors the boot-epoch zombie sweep |
| `verification_suite` | Verification management group; `category ∈ {mcp, workflow}` decides left-panel tab and case target shape; see `docs/verification.md` |
| `verification_case` | One row per case; target XOR by category — `(mcp_server_id, tool_name)` for MCP suites, `workflow_id` for workflow suites (CHECK enforced) |
| `verification_run` | Per-suite execution summary; UUIDv4 PK (URL-exposed via `?run=`); banner pagination served by `(suite_id, started_at DESC)` index |
| `verification_case_result` | Per-case execution detail; frozen `input_snapshot`; structured `error: {source, message, details?}`; MCP cases have `entity_run_id = NULL`, workflow cases (V2) link to `entity_run` |

## Comment Policy

Code comments answer **why**, not **what**. The code itself shows
what. Architecture, onboarding, and protocol descriptions live in
`docs/`, not in module headers — file headers point to docs (one-line
ref) instead of duplicating them.

Three markers identify comments that **must survive a refactor**.
Anything multi-paragraph that is *not* tagged is a candidate for
deletion the next time the area is touched:

| Marker | Use for |
|---|---|
| `// QUIRK:` | Hard-won knowledge that the code itself can't show: upstream protocol oddities, behavioural workarounds, double-emit dedupe rationales, in-process state that compensates for missing upstream features. |
| `// SECURITY:` | Non-obvious safety constraints: input validation rationales, defence-in-depth notes, encoding/escaping requirements, trust-boundary clarifications. |
| `// CONTRACT:` | Externally-observable behaviour the function/type guarantees that signatures alone don't convey: error modes (returns `null` vs throws), idempotency, ordering, side-effect timing, retention semantics. |

When a refactor changes behaviour, **delete the stale comment first**;
update only if it carries one of the three markers. Architecture-level
prose belongs in `docs/`; the next maintainer should be able to read
the code top-to-bottom without needing the comment to recite the
architecture.

Necessary comments worth keeping (typically ≤ 3 lines):

- Field-level descriptions on public interfaces and DTOs.
- Reason for a non-obvious algorithmic choice at a specific call
  site (e.g. why we URL-encode here, why this `Set` exists).
- Pointers to other files / docs that hold the long-form context.

## Conventions

- Use **absolute imports** via `@/` alias (maps to `src/`).
- **Primary key choice** — pick by access shape, not habit. Three tiers:
  1. **`bigint generated always as identity`** *(default)* — junction tables, server-internal-only tables, parent-owned children that are never URL-exposed. Smaller indexes, smaller FKs, easier debug. Currently used by `builtin_agent_tool`, `menu_item`. Choose this unless one of the next two clearly applies.
  2. **`uuid` v7 (`default uuidv7()`, PG18+)** — append-heavy, time-ordered, owner-scoped streams that feed an SSE replay or admin time-paginated list. Currently used by `entity_run` and `notification`. The embedded ms timestamp gives free monotonic ordering and write-side index locality.
  3. **`uuid` v4 (`defaultRandom()`)** — URL-exposed user content where guessability matters (`/agent/[id]`, `/skills/[id]`, `/schedule/[id]`, `/admin/credentials/[id]`, `/mcp/test/[serverId]`, `/datasource/[id]`). Currently used by `builtin_agent`, `skill`, `schedule`, `credential`, `mcp_server`, `artifact`, `data_source`, plus the better-auth tables `user / session / account / verification` (those are not free to change without breaking better-auth's `drizzleAdapter`).
- Do **not** default new FK targets to UUID without one of the three reasons above — `bigint identity` cascades better through the schema (smaller FK columns, smaller indexes) and is the v1 default.
- All timestamps default to `CURRENT_TIMESTAMP`.
- Credential payloads are stored as `"v1:<keyId>:<iv_hex>:<authTag_hex>:<ciphertext_base64>"`.
- `CREDENTIAL_ENCRYPTION_KEYRING` env var is a comma-separated list of `<keyId>=<64-hex>` entries; `CREDENTIAL_ENCRYPTION_ACTIVE_KEY_ID` selects which keyId encrypts new writes. See `docs/key-rotation.md`.
- The first user to sign up is automatically assigned the `admin` role; subsequent self sign-ups default to `user`. Admins promote team members to `editor` from `/admin/user`. See `docs/rbac.md`.
- Soft delete is the only user-deletion path: `DELETE /api/admin/users/[id]` sets `deleted_at` + `deleted_by`, drops the user's sessions, and frees the email for re-use (partial unique index on `email WHERE deleted_at IS NULL`). Resources contributed by deleted users keep `created_by` pointing at the row; FKs are `ON DELETE SET NULL` so a future hard purge is safe.
- CopilotKit runtime URLs: `/api/copilotkit` (backend proxy), `/api/copilotkit/builtin` (built-in agents).
- Agent selection state lives in Zustand; `WorkspaceProvider` wraps children in `<CopilotKit>` with the correct runtime URL and headers.
