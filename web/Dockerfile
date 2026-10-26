FROM node:22.18.0-bookworm-slim AS deps
WORKDIR /app/web
RUN corepack enable
COPY web/package.json web/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

FROM node:22.18.0-bookworm-slim AS builder
WORKDIR /app
RUN corepack enable
COPY --from=deps /app/web/node_modules ./web/node_modules
COPY web ./web
COPY db ./db
WORKDIR /app/web
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm build

FROM node:22.18.0-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
RUN groupadd --system --gid 1001 nodejs && useradd --system --uid 1001 --gid 1001 nextjs
COPY --from=builder --chown=nextjs:nodejs /app/web/.next/standalone ./web
COPY --from=builder --chown=nextjs:nodejs /app/web/.next/static ./web/.next/static
COPY --from=builder /app/db ./db
USER nextjs
EXPOSE 3000
CMD ["node", "web/server.js"]
