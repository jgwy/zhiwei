FROM node:24.20.0-bookworm-slim AS base
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

FROM base AS deps
COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY apps/memory-mcp/package.json apps/memory-mcp/package.json
COPY apps/science-mcp/package.json apps/science-mcp/package.json
COPY packages/core/package.json packages/core/package.json
COPY packages/model-gateway/package.json packages/model-gateway/package.json
COPY packages/skills/package.json packages/skills/package.json
COPY packages/eval/package.json packages/eval/package.json
RUN npm ci

FROM deps AS server-builder
COPY . .
RUN npm run generate:skills && npm run build:server

FROM deps AS builder
COPY . .
RUN npm run generate:skills && npm run build --workspace @zhiwei/web

FROM base AS production-deps
COPY --from=deps /app/package.json /app/package-lock.json ./
COPY --from=deps /app/apps/worker/package.json apps/worker/package.json
COPY --from=deps /app/apps/memory-mcp/package.json apps/memory-mcp/package.json
COPY --from=deps /app/apps/science-mcp/package.json apps/science-mcp/package.json
COPY --from=deps /app/packages/core/package.json packages/core/package.json
COPY --from=deps /app/packages/model-gateway/package.json packages/model-gateway/package.json
COPY --from=deps /app/packages/skills/package.json packages/skills/package.json
RUN npm ci --omit=dev --workspace @zhiwei/worker --workspace @zhiwei/memory-mcp --workspace @zhiwei/science-mcp --include-workspace-root=false

FROM base AS runner
ENV NODE_ENV=production
COPY --from=production-deps /app/node_modules ./node_modules
COPY --from=production-deps /app/package.json ./package.json
COPY --from=production-deps /app/apps ./apps
COPY --from=production-deps /app/packages ./packages
COPY --from=server-builder /app/dist ./dist

FROM base AS web
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
COPY --from=builder /app/apps/web/.next/standalone ./
COPY --from=builder /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=builder /app/apps/web/public ./apps/web/public
EXPOSE 3000
CMD ["node", "apps/web/server.js"]

# Development image: source code is mounted by docker-compose.dev.yml and
# Next.js runs in dev mode so changes are picked up without rebuilding.
FROM deps AS web-dev
WORKDIR /app
ENV NODE_ENV=development NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
EXPOSE 3000
CMD ["npm", "run", "dev", "--workspace", "@zhiwei/web", "--", "--hostname", "0.0.0.0"]
