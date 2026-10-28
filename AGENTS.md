<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Nango Frontend — Agent Guidelines

> **Runtime boundary (v1) — read this first.** Nango runs as a **single long-running Node process** (Docker / VM / bare metal). Do **not** refactor toward multi-replica auto-scaling, and do **not** deploy to serverless runtimes (Vercel / Netlify / Cloudflare Workers) — the in-process caches, the `setTimeout`-based scheduler, in-flight async run Promises, and the SSE event-bus all assume long-lived process semantics. Positioning is **single-node multi-tenant** for personal and small-team usage; heavy / distributed work is delegated outward to backend agent platforms (agno / Mastra / Dify / …); built-in agents are a lightweight orchestration complement, not a distributed execution engine. See `docs/architecture.md` §"Runtime boundary", `docs/backend-integration.md`, and `docs/orchestrator.md` for the same statement at each entry point.

## Project Overview

Nango is an AI-powered agent workspace built with **Next.js 16.2.4**, **React 19**, **TypeScript**, and **Tailwind CSS 4**. It supports multi-backend AI agent platforms (agno, Mastra, Dify) via the **AG-UI** protocol — natively for AG-UI backends, via per-platform bridges for the rest. **Built-in agents** are configured in-app via the **CopilotKit** runtime. Do NOT register raw LLM endpoints as backend agent platforms.

## Tech Stack

- **Framework**: Next.js 16.2.4 (App Router, Turbopack default) · **React**: 19.2.4
- **Auth**: better-auth (email/password, admin plugin, session cookies)
- **Database**: PostgreSQL 18 via Drizzle ORM · **State**: Zustand (client), SWR (data fetching)
- **UI**: shadcn/ui, Tailwind CSS 4, Lucide icons, next-themes (dark default)
- **AI Runtime**: @copilotkit/runtime + @copilotkit/react-core, @ag-ui/client
- **Validation**: Zod 4 (static parsing) · ajv 8 (runtime workflows node schema enforcement)
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
pnpm comments:check:all   # Run comment guard sweep on src/ and scripts/
```

## Architecture Rules

1. **Route groups**: `(auth)` for sign-in/sign-up; `(workspace)` for authenticated pages.
2. **API routes**: Wrap every handler under `src/app/api/` with `withSession`, `withEditor`, or `withAdmin` from `src/lib/http/route-handlers.ts`. Handlers throw `ApiError` to render standard envelopes; `parseBody(req, schema)` handles Zod validation errors automatically.
3. **Role-based access** (`docs/rbac.md`): `admin` (everything), `editor` (AI resource builder), `user` (consumer). Page-level guards: `requireSession/Editor/Admin`. Resource permissions evaluated by `canEditResource` / `canDeleteResource` / `canChangeVisibility`.
4. **Credentials**: Managed only by admin. All secrets encrypted with AES-256-GCM.
5. **Built-in agents**: Use bound `credentialId` for model auth (no env API key fallback).
6. **Backend agents**: Each platform lives under `src/lib/backends/<slug>/`. Handlers bridge upstream REST/SSE into AG-UI events on the fly using `bridge-runtime-kit.server.ts`. Secrets stay server-side; browser only sees AG-UI. See `docs/backend-integration.md`.
7. **Schema**: Domain tables live in `src/lib/db/schema.ts`. Migrations in `src/lib/db/migrations/`. ALWAYS run `pnpm db:generate --name=<name>` to produce migrations. Commit BOTH the SQL and `meta/` snapshot. Never edit or delete the Drizzle snapshots.
8. **Server-only imports**: Use `import "server-only"` for modules that must never reach the client bundle.
9. **Caching**: Six process-wide caches live in the Node process (credentials, agent specs, MCP providers, skills, entity catalog, thread-state). Call appropriate hooks from `credentials/invalidation.ts` or `skills/invalidation.ts` on writes to invalidate.
10. **Skills**: DB-resident reusable capabilities (`skill` + `skill_file`), authored through the editor or imported as a folder (the browser POSTs a JSON `{path, contentBase64}` manifest — there is no archive format, no decompression, and no symlink surface). `source` is a free-form origin label, not a builtin switch. The frontmatter `name:` is the single source of truth; PATCH re-syncs it and allows renames. The editor supports text helper-file create/edit/rename/delete; folders are implicit path prefixes, and binary assets are import-only. Import uses a text/image allowlist; dotfiles are skipped and reported, while executables/media/archives/documents are rejected. `scripts-on-ssh` and `scripts-on-db` declarations are rewritten when declared files are renamed/deleted. Executable scripts must live under `scripts/`. Runtime injects prompt blocks and mounts server-side tools `get_skill`, `get_skill_file`, `run_skill_script`, `run_skill_script_on_ssh` (when `scripts-on-ssh` and SSH bindings are present), and `run_skill_sql_script` (when `scripts-on-db` and a data-source binding are present). See `docs/skills.md`, `docs/ssh.md`, and `docs/data-sources.md`.
11. **Runner / orchestration kernel**: Every dispatch creates an `entity_run` row and timeline event. Programmatic runs use `runner.start({ mode: "sync" | "async" })`. See `docs/orchestrator.md`.
12. **Supervisor (Nango) + agent `role` enum**: `builtin_agent.role` can be `'supervisor' | 'secretary' | 'evaluator' | null`. Uniqueness enforced (1 supervisor & 1 secretary per user). Supervisor identity is server-managed and read-only (defined in `lib/constants/supervisor.ts`). `evaluator` roles are programmatically scheduled for quality assessment (see `docs/evaluation.md`); their runtime execution calls the `submit_evaluation_scores` tool. `secretary` roles are reserved.
13. **Notifications & async**: `mode: "async"` runs return a `runId` and notify via the bell dropdown. SSE updates multiplexed over `/api/runs/stream`. Process boots sweep prior zombie runs using `process_boot` startedAt.
14. **Schedules**: `schedule` table + in-process `setTimeout` scheduler. Dispatches async runs.
15. **Admin run forensics**: Triage layouts at `/admin/run` and `/admin/run/[id]` wrapped by `withAdmin`.
16. **Data sources**: One row in `data_source` defines DB read policy. Handled via connection metadata + linked auth credentials. Querying goes through SQL parsing policy checks. Auto-mounted when data sources are bound. See `docs/data-sources.md`.
17. **SSH integration**: SSH command policy verified at runtime via regex rules before connecting. OS username and keys resolve via credentials. Auto-verify probes for connection validation. See `docs/ssh.md`.
18. **Chat history**: Reconstructed from `entity_run` + `entity_run_event`. Replaces legacy backend proxying. Sub-runs (delegation trees) are excluded from client threads via `parent_run_id IS NULL`.
19. **Tool execution failure contract**: Every built-in agent tool execution is wrapped by `wrapToolExecute` converting thrown errors into a return value `{ isError: true, message, toolName }`. Do not throw errors from custom tool `execute` methods; return structured failure states instead.
20. **Verification subsystem**: Deterministic assert-on-output testing framework exclusively for MCP tools. MCP test runs do not write `entity_run` records. Suite runs are serial, alphabetical, and fail-tolerant. Cross-case references (`{{cases.<alias>.output}}`) support 3-digit prefix aliasing (`010`) with MCP structured unwrapping and intra-suite isolation. Assertions support `json_schema`, `jsonpath`, and `js_expression` (vm sandbox). See [docs/verification.md](file:///d:/AI/nango/docs/verification.md).
21. **Evaluation subsystem**: Stochastic LLM-as-Judge conversational quality testing. Targets are run via `runner.start({mode: "sync"})`. Evaluations are executed programmatically by a system evaluator agent (not user-routable) which submits structured grades via `submit_evaluation_scores` tool. Results are compiled and persisted. See [docs/evaluation.md](file:///d:/AI/nango/docs/evaluation.md).
22. **Web Auto subsystem**: Deterministic Playwright-based browser automation and regression test harness with dual-tier evaluation (JS VM sandbox assertions + LLM Evaluator). Directly executes scripts on Playwright MCP servers and broadcasts live progress via SSE. See [docs/web-auto.md](file:///d:/AI/nango/docs/web-auto.md).
23. **Host file access**: Built-in tools `read_file`, `write_file` and `download_file` are separate per-agent toggles confined to the single directory named by the `host.file.root` config key — defaulted to `/shared_folder`, the container side of the compose bind mount (`./shared_folder`). `create_folder` and `edit_file` are not toggles: they are auto-mounted by `buildBuiltinTools` (`create_folder` beside either write-side tool, `edit_file` only beside `write_file`) and are deliberately absent from `BUILTIN_TOOLS`, so they never show in the editor picker and cannot grant a read-only agent write reach. There is no availability gate: an empty or unmounted root fails the call with `ROOT_NOT_CONFIGURED` and the error message names the mount check. `read_file` is UTF-8 text only, paginated by `offset`/`limit` for both files (line windows) and directories (entry windows); `raw: true` reads the file exactly as stored and pages by byte (`offset` is a byte position, `limit` is ignored, `nextByteOffset` is the exact continuation), which is also the only way to reach the tail of a single line the byte budget cut. `write_file` replaces whole files atomically or extends them with `mode: "append"` (not atomic, budgeted per call, so a file larger than `host.file.write_max_bytes` stays writable); `edit_file` swaps one uniquely-matching substring (`NOT_UNIQUE` reports the count, `replace_all` opts in) through the same atomic replace, and only the matched span changes bytes — the snippet is tried as given, then CRLF, then LF, so untouched lines keep their own endings. No delete, rename, move, glob, versioning or rollback. `download_file` saves one public HTTPS file to an agent-chosen `target_path` (never derived from the URL), gated by `download.max_bytes` (50 MB default), `download.timeout` (single deadline, seconds, 60 default), `download.max_redirects`, `download.allowed_extensions` (matched on the destination name) and `download.allow_private_network` (off = SSRF guard on, re-checked per redirect hop). Downloaded bytes never enter the LLM context — the envelope is `{ok, path, sizeBytes, contentType}` and `read_file` is the only way to see them. The path jail neutralizes absolute/drive input and never follows symlinks, with a second entry point for `create_folder` that proves containment on the deepest existing ancestor. See [docs/host-files.md](file:///d:/AI/nango/docs/host-files.md).
24. **Knowledge Base (LLM wiki)**: Three tables (`kb_collection` → `kb_group` → `kb_page`) hold human-authored, agent-read pages — no vectors, no embeddings, no `kb_search`. Disclosure is structural: the collection is the only mountable level, binding it injects its *derived* index (groups only, never page titles) and auto-mounts the read-only tools `list_kb_pages(kb_name, group_name?)` and `read_kb_page(kb_name, page_name, offset?, limit?)`. There is no `kb_write` — humans own the corpus. There is **no KB cache and no invalidation hook**: the binding is the grant, so reads go straight to the DB. Deletes are hard — deleting a group deletes its pages with it — and ownership FKs are `SET NULL` so a user purge never destroys shared knowledge. `source_ref` is human-only provenance and must never be resolved, validated, or returned on an agent path. Group depth caps at 2 through `MAX_GROUP_DEPTH` in `src/lib/kb/limits.ts` (client-readable, unlike the server-only `kb.*` budgets); description and label bounds are code constants, not config keys. Tool args are snake_case while response fields are camelCase. Editor bodies are plain textareas with no format control — pages are plain text, `content_type` is a server-side parse hint that `createPage` defaults to `text/markdown` and no UI chooses or patches — and there is no file import: an author pastes the converted text. Node metadata (group name/description/parent; page group/name/source) lives in row dialogs, so the editor pane holds only a page's description and body. The KB editor is deliberately not wired to `useCopilotDraft` because agents cannot rewrite knowledge. See [docs/kb.md](file:///d:/AI/nango/docs/kb.md).

## Codebase Organization

Refer to [docs/architecture.md](file:///d:/AI/nango/docs/architecture.md) for the codebase directory tree, layout definitions, and database domain table details.

## Comment Policy

Code comments answer **why**, not **what**. File headers point to docs instead of duplicating them. Three comment markers must survive refactoring:
- `// QUIRK:` Hard-won knowledge, e.g. upstream workarounds.
- `// SECURITY:` Non-obvious safety constraints, input validation.
- `// CONTRACT:` Externally-observable guarantees (e.g. error throw policies, ordering).

Delete stale comments if a refactor changes their behavior. Keep simple pointers (≤ 3 lines) to long-form docs.

## Conventions

- Use **absolute imports** via `@/` alias (pointing to `src/`).
- **Primary key choice**:
  1. `bigint generated always as identity` (Default): Server-internal tables, junction tables, parent-owned child rows.
  2. `uuid` v7 (`default uuidv7()`): Append-heavy, time-ordered tables (e.g., `entity_run`, `notification`).
  3. `uuid` v4 (`defaultRandom()`): URL-exposed resources where guessability matters (e.g., `builtin_agent`, `skill`, `schedule`, `credential`, `mcp_server`, `artifact`, `data_source`).
- All timestamps default to `CURRENT_TIMESTAMP`.
- Credentials are encrypted as `"v1:<keyId>:<iv_hex>:<authTag_hex>:<ciphertext_base64>"` using versioned keys in `CREDENTIAL_ENCRYPTION_KEYRING`.
- First user signup is promoted to `admin`; subsequent signups default to `user`.
- Soft delete is the only user-deletion path (sets `deleted_at` + `deleted_by`).
- CopilotKit runtimes: `/api/copilotkit` (backend) and `/api/copilotkit/builtin` (built-in).
