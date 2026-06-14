# Docker Deployment — Build Pipeline + Upgrade Checklist

> Cross-references: see [`docs/incidents.md`](./incidents.md) for the
> project-wide incident timeline. Detailed Docker incidents live in §6
> and the case study in §7 of this file.

This document covers the Docker build pipeline for `docker compose up`,
the env vars it consumes, the failure modes we have hit so far, and the
upgrade checklists for the tools the pipeline depends on (Node, pnpm,
Next.js, PostgreSQL).

The recurring theme of every failure in this layer has been the same:
**upgrading one tool in isolation while leaving its configuration peers
untouched.** The checklists in §3 exist so we audit those peers ahead of
time instead of debugging them in production.

---

## 1. Pipeline overview

`docker-compose.yaml` starts two services:

| Service | Image | Purpose |
|---|---|---|
| `nango-db` | `postgres:18-alpine` | Stateful — owns the named volume `nango-db-data` |
| `nango-app` | `nango:latest` (built from `docker/Dockerfile`) | Stateless — Next.js standalone server on port 9300 |

The app image is multi-stage:

```
docker/Dockerfile
├── builder stage  (node:24-bookworm-slim)
│   ├── corepack enable pnpm   (default isolated linker — NOT hoisted, see §6.5)
│   ├── COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
│   ├── pnpm install --frozen-lockfile
│   ├── COPY . .
│   ├── NEXT_STANDALONE_OUTPUT=true
│   ├── pnpm build   (next.config.ts switches to output: "standalone")
│   └── repair .next/standalone/.../.pnpm closure   ← see §6.5 / §7
│
└── runner stage   (node:24-bookworm-slim)
    ├── adduser nextjs (uid 1001, non-root)
    ├── COPY --from=builder /app/public ./public
    ├── COPY --from=builder /app/.next/standalone ./
    ├── COPY --from=builder /app/.next/static ./.next/static
    ├── COPY --from=builder /app/src/lib/db/migrations ./...
    └── CMD docker/start.sh   (runs migrate.mjs, then server.js)
```

The DB container runs the official Postgres image; the entrypoint
creates the user / db on first start, applies migrations on every start
via `docker/migrate.mjs`, then `node server.js` launches Next.js.

---

## 2. Environment variables

The full reference lives in `.env.example`. Quick summary of what is
actually **required** vs **defaulted** by `docker-compose.yaml`:

| Variable | Status | Default | Notes |
|---|---|---|---|
| `CREDENTIAL_ENCRYPTION_KEYRING` | **Required** | — | `:?` in compose; container refuses to start without it |
| `CREDENTIAL_ENCRYPTION_ACTIVE_KEY_ID` | **Required** | — | Same |
| `BETTER_AUTH_SECRET` | Optional but you should change it | `local-dev-secret-...` | Sessions can be forged with the default |
| `APP_PORT` | Optional | `9300` | Host-side port for `nango-app` |
| `BETTER_AUTH_URL` | Optional | `http://localhost:${APP_PORT}` | Only override behind a reverse proxy / HTTPS / custom domain |
| `NO_HTTPS` | Optional | `1` | Disables secure cookies for plain-HTTP local dev |
| `POSTGRES_USER` / `_PASSWORD` / `_DB` | Optional | `nango` / `nango` / `nango` | |
| `POSTGRES_PORT` | Optional | `5433` | Host-side port for `nango-db`; container side is fixed `5432` |
| `NANGO_LOG_PRETTY` | Optional | `false` | Set `true` in local `.env` if you want colourised dev logs |
| `NANGO_LOG_LEVEL` | Optional | `info` | |
| `NANGO_LOG_ENABLED` | Optional | `true` | Master kill switch |

`POSTGRES_HOST` is **hardcoded** in compose to `nango-db` (the service
name). Don't override; even if your `.env` sets
`POSTGRES_HOST=localhost` for non-Docker development, the compose file
ignores it.

---

## 3. Upgrade Guidelines

When upgrading dependencies, follow these checks:
- **pnpm**: Review release notes for lockfile schema changes. Ensure `pnpm-workspace.yaml` is copied in the Dockerfile if required. Test locally with `--frozen-lockfile`.
- **Next.js**: Read migration guides for config key changes. Watch build logs for schema warnings. Verify the standalone output bundle and the `.pnpm` closure repair step.
- **PostgreSQL**: Check upstream image release notes for volume layout changes. Plan data migration if necessary.
- **Node Base Image**: Ensure builder and runner stages share the same major version. Verify native bindings build correctly.

## 4. Verification

After changing Docker configurations:
- Use `docker compose up --build` to rebuild.
- If layer caching causes issues (e.g., after changing copied files), force a clean rebuild by removing the cache or deleting the tagged image first (`docker compose build --no-cache`).

## 5. Architectural Quirks

### Next.js Standalone vs. pnpm Symlinks
Next.js `output: "standalone"` uses `nft` to trace dependencies. However, `nft` often mishandles pnpm's symlink layout and drops necessary entry files or native sidecars (like `duckdb.node`).
To fix this, the Dockerfile includes a custom "fixpoint repair" script during the builder stage. It walks the `nft` traced package set, follows pnpm symlinks, and copies missing files from the full `node_modules` store to the standalone bundle. This reduces the image size significantly while preventing runtime crashes.

### Single Migration Runner
The container and the host share a single migration tracking table (`public.__migrations`) updated via `docker/migrate.mjs` to prevent collisions.
