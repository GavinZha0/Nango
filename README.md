# Nango Frontend

AI-powered agent workspace. Connect multiple AI backends, manage credentials, create built-in agents, and generate artifacts — all in one place.

## Tech Stack

| Layer | Technology |
|---|---|
| Framework | Next.js 16.2.4 (App Router, Turbopack) |
| Language | TypeScript, React 19 |
| Auth | better-auth (email/password, admin plugin) |
| Database | PostgreSQL 18 via Drizzle ORM |
| State | Zustand (client), SWR (data fetching) |
| UI | shadcn/ui, Tailwind CSS 4, Lucide icons |
| AI Runtime | CopilotKit, AG-UI protocol |
| Encryption | AES-256-GCM |

## Prerequisites

- **Node.js** ≥ 24 (LTS)
- **pnpm** ≥ 9
- **Docker** (for PostgreSQL) or an existing PostgreSQL 18 instance

## Getting Started

### 1. Install dependencies

```bash
pnpm install
```

### 2. Start PostgreSQL

```bash
pnpm docker:db
```

This starts a PostgreSQL 18 container on port **5433** (configurable via `POSTGRES_PORT`).

### 3. Configure environment

```bash
cp .env.example .env
```

Edit `.env` and fill in required values. Key variables:

| Variable | Description |
|---|---|
| `BETTER_AUTH_SECRET` | Session signing secret (≥ 32 chars) |
| `BETTER_AUTH_URL` | App base URL (e.g. `http://localhost:3000`) |
| `CREDENTIAL_ENCRYPTION_KEYRING` | `<keyId>=<64-hex>` keyring for AES-256-GCM credential encryption (comma-separated) |
| `CREDENTIAL_ENCRYPTION_ACTIVE_KEY_ID` | keyId from the keyring used to encrypt new writes |
| `NO_HTTPS` | Set to `1` for local dev without SSL |

**Postgres connection** is **optional** — defaults match the bundled
`pnpm docker:db` setup (`postgres://nango:nango@localhost:5433/nango`).
Override only if you point at a different database; either set
`POSTGRES_URL` for a full connection string, or any subset of
`POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_HOST` /
`POSTGRES_PORT` / `POSTGRES_DB` to override individual parts.

Generate an encryption key, then put it in the keyring as `k1=<hex>`:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

For key rotation procedure, see [`docs/key-rotation.md`](docs/key-rotation.md).

### 4. Run database migrations

```bash
pnpm db:migrate
```

### 5. Start the dev server

```bash
pnpm dev
```

Open [http://localhost:3000](http://localhost:3000). The first user to sign up is automatically assigned the **admin** role; subsequent self sign-ups default to **user** (consumer). Admins promote teammates to **editor** at `/admin/user`. See [`docs/rbac.md`](docs/rbac.md).

## Available Scripts

| Command | Description |
|---|---|
| `pnpm dev` | Start dev server (Turbopack, port 3000) |
| `pnpm build` | Production build |
| `pnpm start` | Start production server |
| `pnpm lint` | Run ESLint |
| `pnpm test` | Run unit tests (Vitest) |
| `pnpm test:watch` | Run unit tests in watch mode |
| `pnpm test:coverage` | Run unit tests with coverage report |
| `pnpm check-types` | TypeScript type check |
| `pnpm db:generate` | Generate Drizzle migration from schema changes |
| `pnpm db:migrate` | Run pending migrations |
| `pnpm db:push` | Push schema directly to DB (dev only) |
| `pnpm db:studio` | Open Drizzle Studio (DB GUI) |
| `pnpm docker:db` | Start PostgreSQL only (for local dev) |
| `pnpm docker:up` | Start all services (pull pre-built image) |
| `pnpm docker:up:build` | Build locally and start all services |
| `pnpm docker:down` | Stop all services |
| `pnpm docker:logs` | Follow app container logs |

## Project Structure

```
src/
├── app/
│   ├── (auth)/               # Sign-in / sign-up pages
│   ├── (workspace)/          # Authenticated workspace
│   │   ├── admin/            # Admin pages (credentials, users, config)
│   │   └── profile/          # User profile
│   └── api/                  # API routes
│       ├── admin/credentials # Credential CRUD (admin-only)
│       ├── builtin-agents/   # Built-in agent CRUD
│       ├── copilotkit/       # Backend agent proxy (AG-UI)
│       │   └── builtin/      # Built-in agent runtime
│       ├── backend/          # Backend agent REST proxy
│       ├── tools/            # Tool management APIs
│       └── skills/           # Skill management APIs
├── components/
│   ├── admin/                # Credential & user management UI
│   ├── auth/                 # Shared auth form
│   ├── layout/               # Sidebar, drawer, toolbar, workspace provider
│   ├── right-panels/         # Agent, chat, history, skills panels
│   ├── ui/                   # shadcn/ui primitives
│   └── workspace/            # Artifact renderer
├── hooks/                    # CopilotKit frontend actions
├── lib/
│   ├── http/                 # HTTP route plumbing (withSession / withAdmin / parseBody)
│   ├── backends/             # Agent backend adapters (agno, mastra, dify)
│   ├── builtin-agents/       # Built-in AgentSpec pool (LRU + TTL)
│   ├── credentials/          # Encryption + lookup cache + cross-pool invalidation
│   ├── auth/                 # Auth instance, client, route guards
│   ├── db/                   # Database connection, schema, migrations
│   ├── domain/               # Domain types
│   ├── constants/            # App constants
│   ├── access/               # Server-side access control (agent visibility)
│   ├── mcp/                  # MCP provider pool + client providers
│   ├── skills/               # DB-resident skills subsystem
│   ├── runner/               # Execution kernel (entity_run + events)
│   └── orchestration/        # Orchestration mode + display-name helpers
└── store/                    # Zustand client stores
```

## Architecture Overview

### Authentication

Uses [better-auth](https://www.better-auth.com/) with email/password authentication. Three-role RBAC: `admin` / `editor` / `user`. Session cookies are validated server-side via `requireSession()` / `requireEditor()` / `requireAdmin()` guards. Soft delete is the only user-removal path; deleted accounts retain their resource attribution. See [`docs/rbac.md`](docs/rbac.md).

### Multi-Backend Agent Support

Nango supports multiple AI agent backends simultaneously:

- **agno** — Python-based agent framework
- **Mastra** — TypeScript agent framework
- **Dify** — open-source LLM application platform
- **OpenAI-Compatible** — Groq / vLLM / Ollama / OpenAI itself etc.

Every backend chat handler bridges its upstream platform's REST + SSE stream into AG-UI events on the fly; the browser only ever sees AG-UI. Backend connections are managed as **credentials** (admin-only) — each credential stores an encrypted auth token, REST API URL, and (optionally) an AG-UI URL template. Secrets never leave the server.

### Built-in Agents

Users can create built-in agents directly in the Nango UI. Each agent is configured with:

- An LLM model and provider (e.g. `openai/gpt-4o`)
- A bound credential for API key auth (required, no env fallback)
- System instructions, temperature, and token limits
- Tools from MCP servers, skills, or built-in capabilities (REST endpoints can be wrapped via an OpenAPI→MCP bridge such as MCPHub)
- Optional `is_supervisor` flag — at most one per user, see Orchestration below

Built-in agents run via CopilotKit's `BuiltInAgent` on the server side.

### Orchestration (Nango supervisor)

One built-in agent per user can be flagged the **supervisor** ("Nango"). The supervisor sees every other visible agent in its system prompt as a routable specialist catalog and uses one of these tools to delegate:

- `delegate_to_agent` — synchronous; the result feeds back into the chat
- `delegate_async` — fire-and-forget; the user gets a notification when the run finishes
- `create_schedule` / `list_schedules` / `update_schedule` / `delete_schedule` — recurring or one-shot triggers

Four user-selectable orchestration modes (`auto | tool-call | handoff | async`) inject a per-mode prompt directive into the supervisor's system prompt at dispatch time.

### Notifications, Schedules, and Run Forensics

- **Notifications** — async run completions, scheduled fires, and recovery messages land in a bell dropdown in the header (live SSE) and a full `/notifications` page.
- **Schedules** — one-shot or recurring trigger spec `(startAt, [intervalValue, intervalUnit], [endAt])`. Editor at `/schedule/[id]`. The in-process scheduler fires every tick through the same `runner.start({ mode: "async" })` path as user-initiated async delegation, so scheduled runs share the inbox.
- **Admin Runs** — `/admin/run` shows every dispatch (chat / delegate / scheduled) with status + initiator + entity filters; `/admin/run/[id]` shows the run's children + the last 1000 events from `entity_run_event`.

### Credential Management

All credentials are encrypted with AES-256-GCM before database storage. Credential types: `api_key`, `bearer_token`, `certificate`, `basic_auth`, `oauth_client`. Service categories: `llm`, `search`, `agent`, `other`.

### Skills

DB-resident reusable capabilities following the [Claude Skills](https://code.claude.com/docs/en/skills) convention. Each skill is a `skill` row plus zero-or-more `skill_file` rows (helper bytes stored as `bytea`). Authors of **built-in** skills write directory trees under `<repo>/skills/<name>/` (`SKILL.md` + `references/` / `scripts/` / `assets/` / `evals/`); `pnpm build:skills` bakes them into `dist/builtin-skills.json`, and `instrumentation.ts` reconciles the bundle into the DB at boot. **Custom** skills are created via `POST /api/skills` (or future `POST /api/skills/install` ZIP upload). The runtime injects only `name + description` into the agent's system prompt and exposes `get_skill` / `get_skill_file` tools for progressive disclosure — both pure DB reads. Editor at `/skills/[id]`. See `docs/skills.md`.

### Artifact System

AI agents can generate artifacts rendered in the main workspace area. Supported types: `code`, `chart`, `dashboard`, `image`, `html`, `ppt`, `report`.

## License

Private — all rights reserved.
