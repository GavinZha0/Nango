############################
# Builder
############################
FROM node:24-bookworm-slim AS builder
WORKDIR /app

# Install pnpm via corepack
RUN corepack enable pnpm

# Copy package files first for better layer caching
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# Copy source
COPY . .

# Build with standalone output
ENV NEXT_STANDALONE_OUTPUT="true"
RUN pnpm build

############################
# Runner (production)
############################
FROM node:24-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

# Create non-root user
RUN adduser --system --uid 1001 --home /home/nextjs --shell /bin/bash nextjs

# Copy standalone build output
COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nogroup /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nogroup /app/.next/static ./.next/static

# Copy database migrations so the container can run them on startup
COPY --from=builder /app/src/lib/db/migrations ./src/lib/db/migrations

# Copy startup scripts (migration runner + entrypoint)
COPY --from=builder /app/docker/migrate.mjs ./docker/migrate.mjs
COPY --from=builder /app/docker/start.sh ./docker/start.sh
RUN chmod +x ./docker/start.sh

USER nextjs

ENV PORT=3000
ENV HOSTNAME="0.0.0.0"
EXPOSE 3000

CMD ["./docker/start.sh"]
