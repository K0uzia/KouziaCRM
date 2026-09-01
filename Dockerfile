# syntax=docker/dockerfile:1

# Étape 1 : dépendances (cache Docker tant que package-lock.json ne change pas)
FROM node:22-bookworm-slim AS deps
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends \
    openssl ca-certificates python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY apps/api/package.json ./apps/api/
COPY apps/web/package.json ./apps/web/
COPY packages/kouzia-forms/package.json ./packages/kouzia-forms/
COPY prisma ./prisma
COPY scripts ./scripts
RUN --mount=type=cache,target=/root/.npm \
    npm ci

# Étape 2 : build SPA + Prisma client
FROM deps AS builder
COPY . .
ENV DATABASE_URL="file:/app/data/kouziacrm.db"
RUN mkdir -p /app/data \
  && npx prisma generate \
  && npm run build -w @kouziacrm/web

# Étape 3 : image runtime légère (sans Vite, Tailwind, tests…)
FROM node:22-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV API_PORT=3000
ENV WEB_DIST=/app/apps/web/dist
ENV DATABASE_URL="file:/app/data/kouziacrm.db"
RUN apt-get update && apt-get install -y --no-install-recommends \
    openssl ca-certificates wget \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /app/data

COPY package.json package-lock.json ./
COPY apps/api/package.json ./apps/api/
COPY apps/web/package.json ./apps/web/
COPY packages/kouzia-forms/package.json ./packages/kouzia-forms/
COPY prisma ./prisma
COPY scripts ./scripts

# --ignore-scripts : pas de lightningcss (build web uniquement)
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev --ignore-scripts \
  && npm install --no-save tsx \
  && npx prisma generate

COPY --from=builder /app/apps/api/src ./apps/api/src
COPY --from=builder /app/apps/api/tsconfig.json ./apps/api/tsconfig.json
COPY --from=builder /app/apps/web/dist ./apps/web/dist
COPY --from=builder /app/packages/kouzia-forms/src ./packages/kouzia-forms/src
COPY --from=builder /app/packages/kouzia-forms/tsconfig.json ./packages/kouzia-forms/tsconfig.json

EXPOSE 3000
CMD ["sh", "-c", "npx prisma migrate deploy && npx tsx --tsconfig apps/api/tsconfig.json apps/api/src/index.ts"]
