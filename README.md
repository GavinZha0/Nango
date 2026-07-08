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
connect a database, ask a question, get a chart, save it, schedule it, share it.

Nango's design is centered around two product pillars: **AI Engine** (intelligent collaboration) and **Artifact Engine** (artifact management), which work in tandem:

* **Multi-source intelligence & unified protocol**: Connect to external agent platforms (agno, Mastra, Dify) or build custom in-app agents on raw LLMs (OpenAI, DeepSeek, Ollama, etc.), normalizing all streams to the **AG-UI** protocol on the server to keep API keys away from the browser.
* **Supervisor-specialist orchestration**: One built-in agent can act as the Supervisor (Nango itself) to orchestrate and delegate tasks to specialist agents using synchronous calls, tool routing, conversational handoffs, or fire-and-forget async runs.
* **Extensible tool ecosystem**: Native bindings for **MCP (Model Context Protocol)** servers, database-resident **Skills (scripts)**, **SSH hosts**, and governed **Data Sources**.
* **Credential lifecycle & security**: All third-party secrets (API keys, DB credentials, SSH private keys) are encrypted with **AES-256-GCM** on a versioned keyring, decrypted strictly server-side, and support zero-downtime key rotation.
* **Governed data access & execution safety**: Enforce read-only flags and table-level allow/deny lists. SQL queries are parsed and validated before reaching the database, and results are cached as Columnar Parquet files for secure sharing and sandbox execution.
* **Schedules, async runs & unified history**: Trigger agent runs on one-shot or recurring schedules, with async execution results pushed to a live notification inbox. All backend and built-in chat histories are persisted in PostgreSQL, with an admin forensics page to trace run execution timelines.
* **Artifact library & save-from-chat**: Keep a folder-tree library to catalog AI-generated outputs (charts, code, HTML, PPT, reports), allowing users to save outputs from chat with full lineage trace back to the original workflow.
* **Dashboard composition**: Combine multiple saved artifacts into responsive grid-layout dashboards and publish them with a stable URL.
* **Workflow-driven refresh & re-creation**: Artifacts are backed by replayable workflows. Users can apply filters (time range, dimension slice) to charts, refresh them with live data by re-running the workflow, or use AI inside an editor to tweak the underlying query and save it as a new version.

---

![Nango architecture diagram](public/image/nango-ui.png)

## Quick Start (Docker)

The fastest path to a running Nango. Requires only **Docker** (≥ 20.10) and
**Docker Compose** v2.

### 1. Clone

```bash
git clone https://github.com/GavinZha0/Nango.git
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

---

## Architecture Overview

![Nango architecture diagram](docs/diagrams/architecture-diagram.png)

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
