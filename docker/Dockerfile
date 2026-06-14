############################
# Builder — full install (incl. devDependencies for the build)
############################
FROM node:24-bookworm-slim AS builder
WORKDIR /app

# Install pnpm via corepack
RUN corepack enable pnpm

# Copy package files. pnpm 11+ reads `overrides` / `allowBuilds` from
# pnpm-workspace.yaml, NOT package.json, so the install layer must see
# it or `--frozen-lockfile` fails with ERR_PNPM_LOCKFILE_CONFIG_MISMATCH.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

# Copy source
COPY . .

# Build with standalone output
ENV NEXT_STANDALONE_OUTPUT="true"
RUN pnpm build

# Repair the standalone's nft-traced node_modules against the builder's
# full pnpm store. Next.js's nft tracer is unreliable on pnpm's isolated
# layout for `serverExternalPackages`: it creates a package's directory
# and copies its `package.json` but DROPS the entry files AND never
# follows that package's own dependencies — so the dep symlinks resolve
# to `.pnpm/<dep>@<ver>` dirs that don't exist. Observed crash chain
# (each fix exposed the next), all the same root cause:
#   - pino-pretty → readable-stream@2.3.8/readable.js          (dropped entry)
#   - readable-stream → process-nextick-args                   (untraced dep)
#   - …and that dep's deps, transitively.
# Plus a native variant: duckdb.node is traced but its $ORIGIN-loaded
# libduckdb.so (dlopen, invisible to nft) is not.
#
# Fix: take nft's package set as the seed (it is already the true runtime
# closure — ~275 pkgs / ~420 MB, and critically does NOT include the
# client-only deps that are bundled into .next and bloated the old
# full-tree image: react-icons, lucide, mermaid, echarts, …) and walk it
# to a fixpoint:
#   1. fill any files nft dropped from every package dir present
#      (`cp -Rn`: -R keeps symlinks so the pnpm layout still resolves;
#      -n only adds missing files, so it skips nft's inlined real dirs
#      and never hits the dir-vs-symlink overwrite error);
#   2. follow each package's dependency symlinks and pull in any
#      referenced `.pnpm/<dep>@<ver>` dir that is still missing;
#   repeat until no new dir appears.
# Bounded to real dependency edges (the `.pnpm/node_modules` hoist table
# of ALL packages is never completed and never walked), so the closure
# can only reach what the server actually requires at runtime.
# `cp ... 2>/dev/null || true` keeps the walk going past benign races;
# if a future build converges wrong (image oddly small/large), drop the
# `2>/dev/null` temporarily to surface the failing copy.
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

# Guard the size invariant so a broken build fails loudly instead of
# shipping a bad image. The repaired runtime closure is ~420 MB; the
# 200–800 MB band catches both directions of failure:
#   < 200 MB → nft dropped packages the walk couldn't recover (missing deps);
#   > 800 MB → the walk escaped its bound and pulled bundled client libs.
# On a legit large runtime dep being added, bump the band deliberately
# (and confirm via `du -sh /app/.next/standalone/node_modules`).
RUN set -eu; \
    size="$(du -sm /app/.next/standalone/node_modules | cut -f1)"; \
    echo "standalone runtime node_modules: ${size} MB"; \
    if [ "$size" -lt 200 ] || [ "$size" -gt 800 ]; then \
      echo "ERROR: standalone node_modules is ${size} MB, expected 200-800 MB (see docs/docker-deployment.md §6.5)"; \
      exit 1; \
    fi

############################
# Runner (production)
############################
FROM node:24-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

# Create non-root user
RUN adduser --system --uid 1001 --home /home/nextjs --shell /bin/bash nextjs

# Copy standalone build output. The standalone bundle ships its own
# nft-traced node_modules — application code is compiled into server.js
# and only the runtime-resolved `serverExternalPackages` closure is
# carried (forced in via `outputFileTracingIncludes` in next.config.ts
# to work around nft's pnpm-symlink entry-point gap). We intentionally
# do NOT copy the full prod node_modules here: that earlier workaround
# bloated the image to ~2.7 GB (70% dead code the bundled server never
# reads). See docs/docker-deployment.md for the regression history.
COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nogroup /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nogroup /app/.next/static ./.next/static

# Copy database migrations so the container can run them on startup
COPY --from=builder /app/src/lib/db/migrations ./src/lib/db/migrations

# Copy startup scripts (migration runner + entrypoint)
COPY --from=builder /app/docker/migrate.mjs ./docker/migrate.mjs
COPY --from=builder /app/docker/start.sh ./docker/start.sh
RUN chmod +x ./docker/start.sh

# Python runtime for subprocess sandbox mode. Matches the core deps
# in docker/sandbox/requirements.txt so run_code_in_sandbox works
# without a separate sandbox container (local-docker mode).
# python3-venv supplies pip's wheel-builder; --no-install-recommends
# keeps the layer small (~120 MB vs ~400 MB with full recommends).
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-pip python3-venv \
 && pip3 install --no-cache-dir --break-system-packages duckdb pandas numpy \
 && apt-get clean && rm -rf /var/lib/apt/lists/*

# Pre-create the runtime cache directory so the non-root user can
# write datasource Parquet snapshots at runtime (extract_dataset_by_sql).
# Default path: <cwd>/.cache/datasource/ — see lib/data-sources/cache-root.ts.
RUN mkdir -p .cache && chown nextjs:nogroup .cache

USER nextjs

ENV PORT=9300
ENV HOSTNAME="0.0.0.0"
EXPOSE 9300

CMD ["./docker/start.sh"]
