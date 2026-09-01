# syntax=docker/dockerfile:1

FROM node:22-bookworm-slim AS builder
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY apps/api/package.json ./apps/api/
COPY apps/web/package.json ./apps/web/
COPY prisma ./prisma
COPY scripts ./scripts
RUN npm ci
COPY . .
ENV DATABASE_URL="file:/app/data/kouziacrm.db"
RUN mkdir -p /app/data && npx prisma generate && npm run build -w @kouziacrm/web

FROM node:22-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV API_PORT=3000
ENV WEB_DIST=/app/apps/web/dist
ENV DATABASE_URL="file:/app/data/kouziacrm.db"
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /app/data
COPY --from=builder /app/package.json /app/package-lock.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/apps ./apps
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/scripts ./scripts
EXPOSE 3000
CMD ["sh", "-c", "npx prisma migrate deploy && npx tsx --tsconfig apps/api/tsconfig.json apps/api/src/index.ts"]
