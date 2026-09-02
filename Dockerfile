FROM node:22-bookworm-slim AS base
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

FROM base AS deps
COPY package.json package-lock.json* ./
COPY apps/web/package.json apps/web/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY apps/memory-mcp/package.json apps/memory-mcp/package.json
COPY apps/science-mcp/package.json apps/science-mcp/package.json
COPY packages/core/package.json packages/core/package.json
COPY packages/model-gateway/package.json packages/model-gateway/package.json
COPY packages/skills/package.json packages/skills/package.json
COPY packages/eval/package.json packages/eval/package.json
RUN npm install

FROM deps AS builder
COPY . .
RUN npm run generate:skills && npm run build --workspace @zhiwei/web

FROM deps AS runner
COPY . .
RUN npm run generate:skills

FROM node:22-bookworm-slim AS web
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
COPY --from=builder /app/apps/web/.next/standalone ./
COPY --from=builder /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=builder /app/apps/web/public ./apps/web/public
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
