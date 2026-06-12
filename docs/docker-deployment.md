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

## 3. Upgrade checklist

When bumping any of the tools below, run the corresponding checklist
**before** rebuilding the image.

### 3.1 Bumping pnpm (e.g. 11.x → 12.x)

- [ ] Read the pnpm release notes for "config moved" / "lockfile schema"
      / `--frozen-lockfile` behaviour changes.
- [ ] Check whether `pnpm-workspace.yaml` (or `.npmrc`, or some other
      file) gained new entries that the Dockerfile needs to `COPY`
      before `pnpm install`.
- [ ] Verify `corepack` accepts the new version: the `packageManager`
      field in `package.json` is the authority.
- [ ] Run a full local `pnpm install --frozen-lockfile` to surface any
      `LOCKFILE_CONFIG_MISMATCH` before the Docker build does.

### 3.2 Bumping Next.js (especially major versions)

- [ ] Read the migration guide for moved / renamed config keys (Next 16
      moved `experimental.outputFileTracingIncludes` to the top level,
      Next 15 moved `experimental.serverComponentsExternalPackages` to
      `serverExternalPackages`, etc.).
- [ ] Build logs surface schema-change warnings as `⚠ Invalid
      next.config.ts options detected` — these are not silent, **read
      every warning**.
- [ ] Re-verify `output: "standalone"` still produces a working bundle
      for `serverExternalPackages` deps; nft behaviour evolves between
      majors. The builder `.pnpm`-closure repair step (§6.5) compensates
      for nft gaps — if a new major changes the standalone layout
      (e.g. `.next/standalone/node_modules/.pnpm` path), update that
      step's `sstore` path too.
- [ ] The closure size is now **auto-asserted in the build** (a `RUN`
      after the repair fails the build if `.next/standalone/node_modules`
      is outside 200–800 MB). If a bump legitimately adds a large runtime
      dep and trips it, re-band the guard deliberately; if it trips
      unexpectedly, the repair walk under- or over-reached — investigate
      before widening. Spot-check the shipped value with
      `docker run --rm --entrypoint sh nango:latest -c 'du -sh /app/node_modules'`
      (~0.4 GB).

### 3.3 Bumping PostgreSQL major version

- [ ] Read upstream `docker-library/postgres` notes for layout / mount
      changes — PR #1259 (PG 18 layout) is the canonical example.
- [ ] If the volume layout changed, plan the migration: fresh init vs
      `pg_dump`/restore vs `pg_upgrade --link`. Don't change the image
      tag without that plan.
- [ ] Verify required SQL features still exist (this project depends on
      `uuidv7()`, which is PG 18+ only).

### 3.4 Bumping Node base image (e.g. 24 → 26)

- [ ] Compare `node:<N>-bookworm-slim` digests between builder and
      runner stages — both must stay on the same major.
- [ ] Re-run `pnpm install` locally with the new Node major to catch
      native-bindings churn (the `serverExternalPackages` list in
      `next.config.ts` exists exactly because of these).
- [ ] Re-check that the Postgres / runner / sandbox / SSH stack still
      builds — native deps `pg-native`, `vertica-nodejs`, `ssh2`
      sometimes need rebuilds.

---

## 4. Verification

After any change to `docker/Dockerfile`, `docker-compose.yaml`,
`next.config.ts`, or anything that affects the install / build:

```bash
docker compose down -v           # full wipe — only when DB data is throwaway
docker compose up --build        # full rebuild
docker compose logs -f nango-app # follow until "Ready in" line
curl -sI http://localhost:9300/  # expect a 2xx / 3xx response
```

For partial validation without re-creating the DB volume:

```bash
docker compose down              # no -v — keeps nango-db-data
docker compose up --build
```

### `--build` is NOT `--no-cache`

`docker compose up --build` re-runs `docker build`, but Docker still
uses **layer cache** for every step whose inputs haven't changed.
That sounds reasonable but bites in two specific cases:

1. **Dockerfile edits that change a `RUN` flag** (e.g. adding
   `--config.node-linker=hoisted` to an existing
   `RUN pnpm install ...`) DO invalidate the cache for that layer
   and everything downstream — Docker does this correctly.
2. **Edits to files copied via `COPY . .`** ALSO invalidate the cache
   from that COPY onwards, which is usually fine.

But there are situations where the cache "should" invalidate and
doesn't:

- Running `docker compose up --build` when the image is already
  tagged `nango:latest` and the daemon "knows" it has a valid build
  — sometimes the bake resolution short-circuits and the whole
  build returns in 0.0s. The fingerprint is a build log that goes
  `✔ nango:latest Built 0.0s` instead of the usual
  `[+] Building N/M` step-by-step output.
- Cross-platform / arm64 vs amd64 weirdness when Docker desktop
  swaps architectures behind your back.

When in doubt, force a clean rebuild:

```bash
docker compose down
docker compose build --no-cache nango-app   # nukes layer cache
docker compose up
```

Or, more brutally, delete the tagged image first:

```bash
docker compose down
docker rmi nango:latest
docker compose up --build
```

The healthcheck on `nango-app` polls `http://127.0.0.1:9300/` every
10 s with a 30 s `start_period`; container marked unhealthy ⇒
`depends_on` dependents block. Inspect the live status with
`docker compose ps`.

---

## 5. Why this document exists

Every failure listed in §6 was caused by upgrading one tool while
leaving its config peers untouched. The fingerprints are stable and
recognisable; the fixes are mechanical once the diagnosis is made. But
diagnosis is the slow part — a misleading error message can eat an
hour. The checklists in §3 turn "diagnose at outage time" into "audit
at upgrade time", which is roughly 10× cheaper.

If you hit a new failure that doesn't match anything in §6, add it
there with the same shape (fingerprint, cause, fix) before moving on.
The list is more valuable the more it grows.

---

## 6. Failure modes we have hit

Each failure below has a unique error fingerprint, a one-line cause,
and the corresponding fix. The history matters because the same
mistakes will recur the next time someone upgrades a tool.

### 6.1 `pnpm-workspace.yaml` not copied — pnpm 10 → 11 migration

**Fingerprint:**

```
[ERR_PNPM_LOCKFILE_CONFIG_MISMATCH] Cannot proceed with the frozen
installation. The current "overrides" configuration doesn't match the
value found in the lockfile.
```

**Cause:** pnpm 11+ reads `overrides` and `allowBuilds` from
`pnpm-workspace.yaml`, not from `package.json#pnpm`. The pnpm 10→11
upgrade commit moved the block to the new location but the Dockerfile
still only copied `package.json` + `pnpm-lock.yaml` — so inside the
builder image, the lockfile referenced overrides that didn't exist on
disk and `--frozen-lockfile` rejected the mismatch.

**Fix:** `COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./` —
the workspace file MUST be present before `pnpm install`.

### 6.2 `pino-pretty` not in standalone build

**Fingerprint:**

```
Error: An error occurred while loading instrumentation hook:
unable to determine transport target for "pino-pretty"
```

**Cause:** `pino` transports are loaded inside a worker thread via
dynamic `require()`. Next.js `output: "standalone"` uses `nft`
(node-file-trace) to copy only the reachable subset of `node_modules`
into `.next/standalone`. **`nft` cannot trace dynamic requires**, so
`pino-pretty` got dropped from the standalone tree — and crashed the
server at startup when `NANGO_LOG_PRETTY=true` made the logger try to
load it.

**Fix (two layers):**

1. `next.config.ts` ships `pino-pretty` explicitly via
   `outputFileTracingIncludes` so the standalone is bullet-proof.
2. `NANGO_LOG_PRETTY` now defaults to `false` (JSON-only) so prod
   containers never accidentally enable the pretty transport.

### 6.3 `next.config.ts` schema position changed — Next.js 15 → 16

**Fingerprint:**

```
Type error: Object literal may only specify known properties, and
'outputFileTracingIncludes' does not exist in type 'ExperimentalConfig'.
```

Plus a build-time warning:

```
⚠ `experimental.outputFileTracingIncludes` has been moved to
`outputFileTracingIncludes`.
```

**Cause:** Next.js 16 promoted several config keys out of
`experimental`. We added `outputFileTracingIncludes` under
`experimental` (Next.js 14 / 15 syntax) and tsc rejected it.

**Fix:** Top-level placement in `next.config.ts`. The official Next.js
warning calls out the move explicitly — read the build logs.

### 6.4 PostgreSQL 18 volume layout change

**Fingerprint:**

```
Error: in 18+, these Docker images are configured to store database
data in a format which is compatible with "pg_ctlcluster" (specifically,
using major-version-specific directory names).
[...]
Counter to that, there appears to be PostgreSQL data in:
  /var/lib/postgresql/data (unused mount/volume)
```

**Cause:** `postgres:18-alpine` (per upstream
[docker-library/postgres PR #1259](https://github.com/docker-library/postgres/pull/1259))
moved the data dir layout from `/var/lib/postgresql/data` (legacy ≤17)
to per-major-version subdirectories under `/var/lib/postgresql/<N>/...`.
We were still mounting at the legacy path, so the new entrypoint saw
data in the "wrong" place and refused to start.

**Fix:** Mount the parent directory:

```yaml
volumes:
  - nango-db-data:/var/lib/postgresql      # NOT /var/lib/postgresql/data
```

This is **non-trivial for existing deployments** — data in the legacy
path is not auto-migrated. Two options:

1. **Fresh start** (acceptable in dev / before-production): `docker
   compose down -v` to wipe the volume, then `up --build` reinitialises.
2. **Migrate** (production with data to preserve): temporarily pin to
   `postgres:17-alpine`, `pg_dump`, switch image + mount, `psql` restore.
   Note that this project depends on PG 18's `uuidv7()` for
   `notification.id`, so 17 is only acceptable as a transient dump
   source, not as a runtime target.

### 6.5 pnpm symlink layout vs Next.js standalone nft

**Fingerprint:**

```
Failed to load external module @copilotkit/runtime-XXXX/v2:
Error: Cannot find module
'/app/node_modules/.pnpm/node_modules/readable-stream/readable.js'.
Please verify that the package.json has a valid "main" entry
```

**Cause:** This is a wider issue than any single package. pnpm's
default `node_modules` layout uses symlinks pointing into
`.pnpm/<pkg>@<ver>/node_modules/<pkg>`, plus a `.pnpm/node_modules/`
"public hoist" directory for libraries that assume a flat npm-style
tree (e.g. `readable-stream`, pulled in by LangChain / OpenAI /
CopilotKit transitive deps).

Next.js standalone's `nft` tracer copies the reachable file set, but
its handling of pnpm's two-level (symlink + public hoist) layout is
fragile. When `serverExternalPackages` marks `@copilotkit/runtime` as
runtime-resolved (rather than bundled), the tracer is supposed to
include the full transitive closure in the standalone tree. In
practice it can land `package.json` for a hoisted dep WITHOUT the
entry-point file the `main` field references — Node then throws
`Cannot find module .../readable.js` at startup.

**Fix:** Keep the standalone bundle's own nft-traced `node_modules`
(NO full-tree COPY) and **repair it in the builder** against the full
pnpm store. nft's traced package set is already the true runtime closure
(~275 pkgs / ~420 MB, and critically does NOT include the client-only
deps bundled into `.next` that bloated the old full-tree image —
react-icons, lucide, mermaid, echarts, …). The problem is nft mishandles
pnpm's isolated layout for `serverExternalPackages` in two ways:

1. **Truncated package + untraced deps.** It creates `.pnpm/<pkg>@<ver>/`
   and copies its `package.json` but DROPS the entry files, and never
   follows that package's own dependencies — so the dep symlinks inside
   point to `.pnpm/<dep>@<ver>` dirs that were never created. This
   surfaces as a *chain* of crashes (each fix exposes the next dep):
   `pino-pretty → readable-stream@2.3.8/readable.js` (dropped entry) →
   `readable-stream → process-nextick-args` (untraced dep) → that dep's
   deps, transitively.
2. **Native `dlopen` sidecar.** DuckDB's `duckdb.node` loads
   `libduckdb.so` from `$ORIGIN` at the C level — invisible to nft, so
   the 107 MB `.so` is dropped: `libduckdb.so: cannot open shared object
   file`.

`outputFileTracingIncludes` does NOT fix either — its globs only resolve
top-level `node_modules/<pkg>` symlinks, so the `pino-pretty` include
works but a deep `.pnpm/**/...` glob silently matches nothing.

The repair takes nft's set as the **seed** and walks it to a fixpoint in
the builder (where both the full store and the traced tree coexist):

```dockerfile
# After `pnpm build`, in the builder:
RUN set -eu; \
    store="/app/node_modules/.pnpm"; \
    sstore="/app/.next/standalone/node_modules/.pnpm"; \
    while :; do \
      before="$(find "$sstore" -mindepth 1 -maxdepth 1 | wc -l)"; \
      for d in "$sstore"/*@*/; do \
        name="$(basename "$d")"; \
        if [ -d "$store/$name" ]; then cp -Rn "$store/$name/." "$d" 2>/dev/null || true; fi; \
      done; \
      find "$sstore" -type l | while read -r l; do \
        comp="$(readlink "$l" | sed -n 's#.*/\([^/][^/]*\)/node_modules/.*#\1#p')"; \
        if [ -n "$comp" ] && [ ! -e "$sstore/$comp" ] && [ -d "$store/$comp" ]; then \
          cp -Rn "$store/$comp" "$sstore/" 2>/dev/null || true; \
        fi; \
      done; \
      after="$(find "$sstore" -mindepth 1 -maxdepth 1 | wc -l)"; \
      [ "$before" = "$after" ] && break; \
    done
```

Why each detail matters:

- **`cp -Rn`** — `-R` without `-L` keeps the pnpm symlink layout intact
  (so `externalRequire`'s baked module paths still resolve); `-n`
  (no-clobber) only adds files MISSING from the standalone tree, so it
  restores dropped entries (`readable.js`) yet skips nft's inlined real
  dirs — avoiding `cp: cannot overwrite directory … with non-directory`
  when the store has a symlink (`pino-pretty`) where nft wrote a dir.
- **Pass 2 follows dependency symlinks** (`.pnpm/<pkg>@<ver>/node_modules/<dep>`)
  to discover and copy missing `.pnpm/<dep>@<ver>` dirs, then loops —
  this is what pulls in `process-nextick-args` & friends.
- **`*@*/` and skipping the hoist table** — Pass 1 completes only real
  package dirs (they contain `@`), never `.pnpm/node_modules` (pnpm's
  flat hoist of ALL ~941 packages). The walk follows only real
  dependency edges, so the closure is bounded to what the server
  actually requires — it can NOT reach the bundled client libs.
- **DuckDB is covered for free** — `@duckdb+node-bindings-linux-<arch>@<ver>`
  is one of the seed dirs, so Pass 1's `cp -Rn` brings its `libduckdb.so`
  alongside the traced `duckdb.node`. Arch/version-agnostic.

A follow-up `RUN` **asserts the size invariant** (200–800 MB on
`.next/standalone/node_modules`) so a future nft regression or an
out-of-bounds walk fails the build instead of shipping a broken/bloated
image. The `cp` errors inside the walk are swallowed (`2>/dev/null`) to
ride past benign races — if convergence ever looks wrong, drop that
redirect to surface the failing copy.

Result: working image at **1.32 GB** (measured; vs the old
reliable-but-bloated 2.69 GB full/prod-tree COPY — a ~51% cut), build
~125 s. Every non-duckdb `.node` (`@next/swc`, `@rolldown`,
`@tailwindcss/oxide`, `lightningcss`, `fsevents`) is build-time-only and
never ships. See §7 for the full size-reduction saga.

**Diagnosing a still-missed package:** if startup throws `Cannot find
module .../<x>` or `<lib>.so: cannot open shared object file` even after
the repair, the fixpoint didn't reach it:

- **JS module missing** → a dependency edge the walk couldn't follow
  (e.g. an `optionalDependency` with no symlink, or a dynamic
  `require('name')` resolved via the hoist table). Confirm the
  `.pnpm/<x>@<ver>` dir exists in the standalone tree; if not, the seed
  never referenced it — add the requiring package to
  `serverExternalPackages` so nft seeds it.
- **Native `.so`/`.dylib` missing** → another `dlopen` sidecar in a
  package the walk DID copy. Confirm its `.pnpm/<pkg>@<ver>` dir is
  present; the `cp -Rn` should bring the sidecar — if a build-time
  `.gitignore`/`.dockerignore` rule stripped it, that is the cause.
- **`<x>` should have been bundled but a dynamic `require` defeated
  Turbopack** (e.g. `ssh2`, `@modelcontextprotocol/sdk`, `ai`/`@ai-sdk/*`)
  → add `<x>` to `serverExternalPackages` so Node resolves it from
  `node_modules` at runtime (nft then seeds it and the walk completes it).

**Superseded interim fix (kept for history):** commit `0717f64`
bypassed `nft` by COPYing the full prod `node_modules` (a dedicated
`prod-deps` stage running `pnpm install --prod --ignore-scripts`,
then `rm -rf /app/node_modules` before the COPY because BuildKit
refuses to overwrite the nft-traced real-directory tree with pnpm's
real-file symlinks). It worked but ballooned the image to ~2.7 GB —
roughly 70% dead code the bundled `server.js` never reads (e.g.
`@react-icons/all-files` ~214 MB pulled transitively by `@rjsf/shadcn`
but already bundled into `.next`; four `lucide-react` versions ~166 MB).
The `outputFileTracingIncludes` approach above replaces it.

#### Five alternatives we tried and rejected

We tried every variation of "force pnpm to use the flat `hoisted`
linker so nft can trace correctly" before falling back to "bypass
nft". The first four all failed because **pnpm 11 with a
`pnpm-workspace.yaml` present ignores `node-linker` from every
source EXCEPT the workspace file itself**. That fact is documented
at the top of this project's own `pnpm-workspace.yaml`:

```yaml
# As of pnpm 11, settings (other than auth/registry) live HERE rather
# than in package.json#pnpm or .npmrc. See https://pnpm.io/11.x/migration.
```

Future debuggers (including LLM agents) should treat this comment
as the authoritative source of "where pnpm 11 settings have to
live" and not waste time on the following dead ends:

- `ENV NPM_CONFIG_NODE_LINKER=hoisted` — uppercase env var,
  silently ignored.
- `RUN pnpm install --frozen-lockfile --config.node-linker=hoisted`
  — documented CLI form, silently ignored.
- `echo "node-linker=hoisted" > .npmrc` (inline in Dockerfile) —
  `.npmrc` is overridden by the workspace file, silently ignored.
- Committing `nodeLinker: hoisted` to `pnpm-workspace.yaml` —
  would actually work, but also flips local development to hoisted.

The fingerprint that **none of the above took effect** is that the
runtime error still references `/app/node_modules/.pnpm/...`. If
hoisted had activated, the `.pnpm/` directory would not exist at
all.

**Fifth alternative — `nodeLinker: hoisted` via Docker-only inline
echo**: append `nodeLinker: hoisted` to `pnpm-workspace.yaml` via
`RUN echo >> pnpm-workspace.yaml` in BOTH the builder and prod-deps
stages (so the host file stays isolated, only the image is
hoisted). On paper this is the elegant fix — kills the `.pnpm/`
nesting redundancy that bloats production image. **Empirically it
fails** with a different error at runtime:

```
Failed to load external module pino-2e79642258e38174:
Cannot find module 'pino-2e79642258e38174'
Failed to load external module pg-63e85fc611dc39f8:
Cannot find package 'pg-63e85fc611dc39f8'
```

Next.js standalone's Turbopack `externalRequire` mechanism bakes
package identifiers as hashes computed against the build-time
node_modules layout. When the builder uses hoisted, those hashes
diverge from what the runtime resolver can find — even though both
builder and runner agree on hoisted, somewhere the build emits
hashes the runtime can't translate back to the real package name.
This is a Turbopack-side bug / under-tested edge case; we don't
have a workaround. The hoisted approach is theoretically sound and
DOES work for the linker / install step; the failure happens
strictly in Next.js's build output. Two AIs independently
recommended this path before empirical testing showed it crashes.

### 6.6 Two migration runners drift — host `drizzle-kit` vs container `migrate.mjs`

**Fingerprint:**

```
# Host `pnpm db:migrate` after the container already migrated the same DB:
PostgresError: relation "<table>" already exists
# (drizzle-kit re-runs 0000_baseline_v3 because its bookkeeping table is empty)
```

**Cause:** the project had **two** migration appliers tracking applied
migrations in **two different tables**, with no awareness of each other:

| Runner | Used by | Bookkeeping table | Columns |
|---|---|---|---|
| `drizzle-kit migrate` | host `pnpm db:migrate` | `drizzle.__drizzle_migrations` | `id, hash, created_at` |
| `docker/migrate.mjs` | container `start.sh` | `public.__migrations` | `id, name, applied_at` |

Whichever ran first recorded the baseline in its own table; the other
started, saw its table empty, and re-applied `0000_baseline_v3.sql`
against an already-populated DB → collision. The two tables also use
different schemas, columns, and "applied" semantics (drizzle uses a
`max(created_at)` watermark; `migrate.mjs` used a filename set), so they
could never be kept in sync without manual `INSERT`s.

**Fix:** **one runner, one table.** Point host `db:migrate` at the same
lightweight runner the container already uses, so both share
`public.__migrations`:

```jsonc
// package.json
"db:migrate": "node --env-file-if-exists=.env docker/migrate.mjs"
```

- `drizzle-kit generate` is **kept** — it only reads the schema to emit
  SQL + snapshots and never touches the tracking table.
- `--env-file-if-exists=.env` replaces `drizzle.config.ts`'s
  `dotenv.config()` so host runs still read `.env`. We deliberately do
  **not** `import "dotenv"` inside `migrate.mjs`: `dotenv` is a
  devDependency and is absent from the standalone runtime closure (same
  class of trap as §6.2 / §6.5), so a static import would crash
  container startup. In the container, env comes from docker-compose and
  no `--env-file` flag is passed.
- `migrate.mjs`'s default `POSTGRES_PORT` was changed `5432 → 5433` to
  match the host-side compose port mapping (`getPostgresUrl` in
  `src/lib/db/postgres-url.ts`). The container is unaffected because
  compose sets `POSTGRES_PORT=5432` explicitly.

No data backfill is needed: `public.__migrations` already exists in
every running deployment, so the first post-change run on either side
simply reads it and skips already-applied files. The previously
hand-inserted `drizzle.__drizzle_migrations` row is now vestigial
(never read) and can be left or dropped.

---

## 7. Image size: 2.7 GB → 1.3 GB

**Root cause**: `dependencies` in `package.json` ≠ runtime needs.
Next.js bundles client libraries into `.next` at build time, but
they remain in `node_modules` (~1.4 GB of dead weight). The true
runtime closure is ~275 packages / ~420 MB.

**Solution**: fixpoint repair in the Dockerfile builder stage (§6.5).
Seed from nft's traced package set, then loop `cp -Rn` + follow
dependency symlinks until no new `.pnpm/<dep>` dir appears.

**Result**: 2.69 GB → 1.32 GB (~51% smaller).

| Approach tried | Why it failed |
|---|---|
| `pnpm install --prod` | Wrong axis — waste is bundled prod deps, not devDeps |
| `nodeLinker: hoisted` | Turbopack hashes `.pnpm` layout; different layout → runtime crash |
| `outputFileTracingIncludes` globs | Only resolves top-level symlinks, not deep `.pnpm` paths |
| One-shot `cp -R` | Can't overwrite dir with symlink (`cp` fails) |
| Single `cp -Rn` | Misses untraced transitive deps; need iterative walk |

**If revisiting**: don't chase `--prod` / dedupe / `nodeLinker`. The
lever is "runtime closure vs prod closure" — standalone already
computes it. Verify with:
```
docker run --rm --entrypoint sh nango:latest -c \
  'du -sh /app/node_modules; find /app/node_modules/.pnpm -mindepth 1 -maxdepth 1 | wc -l'
```
