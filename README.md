<div align="center">
  <img src="public/logo.png" alt="Nango" width="120" />

  <h1>Nango</h1>

  <p><strong>An AI-native collaboration workspace for small teams — built for data analysis.</strong></p>

  <p>
    Chat with <strong>Nango</strong>, your AI teammate. Turn one-shot answers into
    refreshable, shareable data products the whole team can build on.
  </p>

  <p>
    <img alt="Next.js"     src="https://img.shields.io/badge/Next.js-16-black?logo=next.js" />
    <img alt="React"       src="https://img.shields.io/badge/React-19-149eca?logo=react" />
    <img alt="TypeScript"  src="https://img.shields.io/badge/TypeScript-5-3178c6?logo=typescript" />
    <img alt="PostgreSQL"  src="https://img.shields.io/badge/PostgreSQL-18-336791?logo=postgresql" />
    <img alt="Drizzle ORM" src="https://img.shields.io/badge/Drizzle-ORM-C5F74F" />
    <img alt="Tailwind"    src="https://img.shields.io/badge/Tailwind-4-38bdf8?logo=tailwindcss" />
    <img alt="CopilotKit"  src="https://img.shields.io/badge/CopilotKit-AG--UI-7c3aed" />
    <img alt="License"     src="https://img.shields.io/badge/License-MIT-blue" />
  </p>

  <p>
    <a href="https://github.com/GavinZha0/nango/actions/workflows/lint-and-type-check.yml"><img alt="Lint" src="https://github.com/GavinZha0/nango/actions/workflows/lint-and-type-check.yml/badge.svg?branch=main" /></a>
    <a href="https://github.com/GavinZha0/nango/actions/workflows/e2e-tests.yml"><img alt="E2E" src="https://github.com/GavinZha0/nango/actions/workflows/e2e-tests.yml/badge.svg?branch=main" /></a>
    <a href="https://github.com/GavinZha0/nango/actions/workflows/release-please.yml"><img alt="Release" src="https://github.com/GavinZha0/nango/actions/workflows/release-please.yml/badge.svg" /></a>
    <a href="https://github.com/GavinZha0/nango/pkgs/container/nango"><img alt="GHCR" src="https://img.shields.io/badge/ghcr.io-nango-2496ed?logo=docker&logoColor=white" /></a>
    <a href="https://github.com/GavinZha0/nango/releases"><img alt="Release version" src="https://img.shields.io/github/v/release/GavinZha0/nango?include_prereleases&sort=semver&color=green" /></a>
  </p>

  <p>
    <a href="#quick-start-docker"><strong>Quick Start</strong></a> ·
    <a href="#development-setup">Development</a> ·
    <a href="#architecture-overview">Architecture</a> ·
    <a href="#recommended-companions">Companions</a> ·
    <a href="#documentation">Docs</a>
  </p>
</div>

---

## What is Nango (南瓜)?

Nango is a small-team **AI collaboration platform**. Instead of a one-off chatbot,
it positions an AI agent — also named **Nango** — as a *colleague* who sits in
the team workspace, talks to users, picks up tasks, and works with the team to
get things done. The product's current focus is the **data analysis** workflow:
connect a database, ask a question, get a chart, save it, schedule it,
share it.

Nango is built around **two product pillars**:

| Pillar | What it does | Status |
|---|---|---|
| **AI Engine** — the AI teammate | Chat-driven agents that connect to data, run SQL, write code, call tools, and orchestrate sub-agents. | Production-ready |
| **Artifact Engine** — the team's deliverables | Persist what the AI produced into a tree of artifacts, compose them into shareable dashboards, and *refresh* them later. | In active development |

Together they answer the question that pure chat tools cannot:
*"how do my team and I keep using what we just made with AI tomorrow?"*

> **Runtime boundary.** Nango runs as a **single long-running Node process**
> (Docker / VM / bare metal), targeting personal and small-team use. Heavy or
> distributed agent work is delegated to external platforms; Nango stays lean
> and stays in the team's hands.

---

## Pillar 1 — AI Engine

The AI side of Nango. Two complementary ways to bring intelligence into your workspace,
plus everything around them to make it useful.

### 1.1 Two ways to plug in intelligence

Nango distinguishes **agent platforms** (mature multi-agent systems you connect to)
from **LLM providers** (raw model endpoints you build agents *on top of*).
They serve different purposes and are kept separate by design.

**Connect external agent platforms** &nbsp;·&nbsp; *currently supported:*

| Platform | Style |
|---|---|
| **[agno](https://github.com/agno-agi/agno)** | Python-based agent framework |
| **[Mastra](https://mastra.ai)** | TypeScript agent framework |
| **[Dify](https://dify.ai)** | LLM application platform |
| **OpenAI-Compatible agent platforms** | FastGPT, AnythingLLM, Coze, … (per-platform adapter) |

The list is intentionally short. Each platform has its own request shape and
session model, so Nango ships a dedicated adapter per platform rather than a
generic bridge. Every adapter normalises the upstream REST / SSE stream into
the **AG-UI** protocol on the fly — the browser only ever sees AG-UI and
secrets never leave the server. New adapters are welcome via PR.

**Build your own agents on top of LLM providers** &nbsp;·&nbsp; *broad provider coverage:*

| Category | Providers |
|---|---|
| **Hosted LLM APIs** | OpenAI, DeepSeek, Groq, xAI, OpenRouter, and any OpenAI-compatible endpoint |
| **Self-hosted / local** | **Ollama**, **vLLM**, and any OpenAI-compatible local server |

These are configured as credentials and used by **built-in agents** that you
create in the Nango UI: pick a model, write a system prompt, attach tools,
done. This is the right path whenever you have a *raw model endpoint* (a
hosted API, a model you host yourself, a local Ollama) rather than a full
agent platform.

### 1.2 What you can build with it

| Capability | Details |
|---|---|
| **Supervisor agent** | One built-in agent per user can be marked the *supervisor* — Nango itself. Other agents become its delegable specialists. Four orchestration modes cover synchronous calls, tool-style routing, conversational handoff, and fire-and-forget async work. |
| **Tools & extensions** | First-class bindings for **MCP servers**, **Skills** (reusable, self-documenting capabilities), **Data sources** (governed SQL access), and **SSH** servers, plus a small built-in tool set for code, chart, and dataset operations. Wrap any REST API as an MCP server to expose it to an agent. |
| **Governed data access** | A data source row = "agent can read this DB under this policy" (read-only flag, table allow / deny list). SQL is parsed and validated *before* it touches the cache, then results are cached as columnar files for cheap re-reads. |
| **Schedules & async** | One-shot or recurring schedules trigger the same agents on a timer. Async runs and scheduled fires drop into a live notification inbox so the team sees what completed while they were away. |
| **Unified chat history** | Built-in *and* external-platform agent threads share one Postgres-side source of truth. Refresh the page, switch agents, come back tomorrow — your conversation is still there. |
| **Credentials & rotation** | All third-party secrets stored with AES-256-GCM encryption against a keyring; the active key is rotatable with zero downtime. Admin-only CRUD. |
| **Roles for collaboration** | Three roles: **admin** (everything), **editor** (AI resource builder), **user** (consumer). The first sign-up is auto-admin; later sign-ups default to `user`. Soft-delete only; ownership of resources is preserved. |
| **Observability & forensics** | Structured logs with automatic secret redaction; an admin run-forensics page shows the full dispatch tree and event timeline for every run. Optional Langfuse tracing for LLM calls. |

---

## Pillar 2 — Artifact Management & Re-creation

This is the *team* half of the product: turning AI output into shared,
living deliverables. **Partially implemented and actively evolving.**

| Capability | What it gives you | Status |
|---|---|---|
| **Artifact library** | A folder-tree library under per-type system categories (charts, dashboards, code, images, HTML, PPT, reports). Behaves like a file system for AI output. | Landed |
| **Save-from-chat** | One-click save any chart, code, or report from the conversation into the artifact library, with origin trace back to the chat turn. | Landed |
| **Dashboard composition** | Compose multiple artifacts into a grid-layout dashboard page. Publish to the team with visibility control. | In progress |
| **Workflow-backed refresh** | Each savable artifact is paired with a frozen workflow — a captured, replayable description of how its data was produced. Refresh re-runs the workflow against live data: same artifact, fresh numbers. | In progress |
| **Interactive filters** | Time range, dimension slicing, parameter prompts on saved charts — without going back to the agent. | Planned |
| **Rich renderers** | First-class chart renderer, paginated PPT, report rendering, sandboxed HTML embedding. | Planned (placeholders today) |
| **Re-creation flows** | Open any artifact in an editor, ask the AI to tweak it ("change to monthly buckets"), save as a new version or fork. | Planned |

A single workflow can power **many** artifacts (1-to-N), so the same
underlying query can appear as a chart on one dashboard, a table on
another, and a weekly report exported via a third — all driven by one
refreshable data pipeline.

---

## A Day with Nango — typical data analysis flow

1. **Admin** sets up a data source (Postgres / MySQL / Vertica / …) with a
   read-only credential and a table allow-list.
2. **User** asks Nango: *"How did East-China orders trend last week?"*
3. Nango routes the task (or handles it itself), fetches the data, charts
   the result, and shows it inline in the chat.
4. User likes it — **Save** captures the chart as an artifact and freezes
   the workflow behind it.
5. User drops it onto a **dashboard**, hits **publish** — teammates see it
   at a stable URL.
6. The dashboard refreshes on its own (or on a schedule); team members can
   apply filters; Nango can be asked to *modify* the underlying workflow
   without starting over.
7. Every run is durable and replayable for admin audit and replay.

---

## Quick Start (Docker)

The fastest path to a running Nango. Requires only **Docker** (≥ 20.10) and
**Docker Compose** v2.

### 1. Clone

```bash
git clone <your-fork-or-this-repo>.git
cd nango
```

### 2. Create `.env`

```bash
cp .env.example .env
```

You **must** set two encryption variables before the app will start:

```bash
# Generate one 32-byte key in hex
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
# → e.g. c60f15a2dd1bdecd92bca72728ec8104c0570832e9d8827592bfa865ba35fc5a
```

Put it into `.env`:

```dotenv
CREDENTIAL_ENCRYPTION_ACTIVE_KEY_ID=k1
CREDENTIAL_ENCRYPTION_KEYRING=k1=<the-64-hex-you-just-generated>

# Also set a long random session secret (32+ chars)
BETTER_AUTH_SECRET=<another-long-random-string>
NO_HTTPS=1
```

> **Changing the port** — only set `APP_PORT` (default `9300`). The auth
> URL is derived from it automatically. Override `BETTER_AUTH_URL`
> directly only when you front Nango with a reverse proxy or custom
> domain (e.g. `BETTER_AUTH_URL=https://nango.example.com`).

> Why two secrets? `BETTER_AUTH_SECRET` signs user sessions; the keyring
> encrypts the **third-party credentials** stored in your database. They are
> intentionally separate so leaking one does not compromise the other.

### 3. Bring everything up

Pull the published multi-arch image from GitHub Container Registry:

```bash
docker compose up -d
```

Or build locally from source (developer mode):

```bash
docker compose up -d --build
```

To upgrade to a newer published image:

```bash
docker compose pull && docker compose up -d
```

This starts:

| Container | Purpose | Port |
|---|---|---|
| `nango-app` | Nango Next.js server (auto-runs DB migrations on boot) | `9300` |
| `nango-db`  | PostgreSQL 18 | `5433` → `5432` |

Then open **http://localhost:9300**.

The **first user to sign up becomes the admin** automatically. From the
admin user-management page, you can promote teammates to `editor`
(resource builders) or keep them as `user` (consumers).

### 4. Manage the stack

```bash
docker compose logs -f nango-app   # tail app logs
docker compose down                # stop everything (data is preserved)
docker compose down -v             # stop AND wipe the DB volume
```

Compatible with **Podman**: replace `docker` with `podman` in every command.

---

## Development Setup

For contributing or running against a hot-reloading dev server.

### Prerequisites

| Tool | Version |
|---|---|
| Node.js | **≥ 24** (LTS) |
| pnpm    | **10.32.1** (pinned via `packageManager`; `corepack enable` is enough) |
| Docker  | needed for the bundled Postgres **and** the Python sandbox image used by code-execution tools |
| PostgreSQL | 18 (or use the bundled `pnpm docker:db`) |

### Get it running

```bash
corepack enable          # picks up the pinned pnpm from package.json
pnpm install

cp .env.example .env     # set CREDENTIAL_ENCRYPTION_KEYRING,
                         # CREDENTIAL_ENCRYPTION_ACTIVE_KEY_ID,
                         # and BETTER_AUTH_SECRET — see Quick Start above

pnpm docker:db           # Postgres 18 on localhost:5433
pnpm db:migrate          # apply schema

pnpm dev                 # Next.js with Turbopack on http://localhost:9300
```

If you point at an existing Postgres instead of the bundled one, set
`POSTGRES_URL` (or the discrete `POSTGRES_USER` / `POSTGRES_PASSWORD` /
`POSTGRES_HOST` / `POSTGRES_PORT` / `POSTGRES_DB` variables).

All other scripts (lint, test, type-check, db tooling, sandbox image build,
docker compose helpers) live in [`package.json`](package.json) — run
`pnpm run` to list them.

---

## Architecture Overview

![Nango architecture diagram](docs/diagrams/architecture-diagram.png)

> Source: [`docs/diagrams/architecture-diagram.html`](docs/diagrams/architecture-diagram.html) —
> open in a browser for an interactive view with PNG / PDF export.
> Full design notes live under [`docs/`](docs).

---

## Recommended Companions

The following independent open-source components are recommended to round out a production setup.

### MCPHub — the unified hub for MCP servers

[**MCPHub**](https://github.com/samanhappy/mcphub) is a unified hub for
centrally managing and dynamically orchestrating multiple MCP (Model Context
Protocol) servers and APIs into separate endpoints with flexible routing
strategies.


More companions will be added here as integrations land.

---

## Documentation

Long-form design notes, subsystem references, and architecture decisions
live under [`docs/`](docs). Start with `docs/architecture.md` for the
whole-system view, then drill into the subsystem you care about.

---

## Contributing

Contributions are welcome. Before opening a PR:

1. Skim the relevant design notes under [`docs/`](docs) for the subsystem
   you are touching.
2. Run lint, type-check, and tests (see `package.json`).
3. For schema changes, generate a Drizzle migration and commit **both**
   the SQL file and the snapshot.

---

## License

[MIT](LICENSE) © Nango contributors.

<p align="right"><sub>Nango is intentionally small, opinionated, and team-shaped. We hope it makes your AI feel like a colleague rather than a vending machine.</sub></p>
