# syntax=docker/dockerfile:1

# Debian, not Alpine: musl forces a full source build of better-sqlite3.
FROM node:24-bookworm-slim AS deps

WORKDIR /app

RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./

# Keep NODE_ENV unset here: tsx is a devDependency and is the project's runtime.
RUN npm ci

FROM node:24-bookworm-slim

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json tsconfig.json vitest.config.ts ./
COPY src ./src
COPY tools ./tools
COPY test ./test
COPY docker-entrypoint.sh /usr/local/bin/entrypoint

RUN sed -i 's/\r$//' /usr/local/bin/entrypoint && chmod +x /usr/local/bin/entrypoint

ENV DB_PATH=/app/data/ingestion.db \
    INGEST_ROOT=/app/data \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false

RUN mkdir -p /app/data
VOLUME ["/app/data"]

ENTRYPOINT ["entrypoint"]
CMD ["help"]
