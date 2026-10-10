# syntax=docker/dockerfile:1.27.1
# ProA 2.0: one image serving REST /api/v1, MCP /mcp and the web UI.
# Build from the repository root:  docker build -f docker/Dockerfile .
# The server runs from TypeScript source via Node's type stripping; only the
# web UI is built.

ARG NODE_IMAGE=node:24.21.0-trixie-slim
ARG PNPM_VERSION=11.1.3

FROM ${NODE_IMAGE} AS base
ARG PNPM_VERSION
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    CI=true
RUN npm install --global --no-fund --no-audit pnpm@${PNPM_VERSION}
WORKDIR /app

# Download every locked package once (needs only the lockfile and settings).
FROM base AS fetch
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm fetch

# Full install and web build.
FROM fetch AS build
COPY . .
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --offline --frozen-lockfile
RUN pnpm --filter @proa/web build

# Production dependencies of the server and the CLI (incl. workspace
# packages). Starts from `base`: `pnpm fetch` fills node_modules/.pnpm with
# every locked package, which must not reach the runtime image.
FROM base AS prod
COPY . .
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod \
      --filter "@proa/server..." --filter "@proa/cli..."

FROM ${NODE_IMAGE} AS runtime
# PROA_OWNER_KEY_FILE: the server creates the owner key there on first start
# (mount a volume at /var/lib/proa to keep it); `proa` in the container reads it.
# PROA_HOST=0.0.0.0: the container must accept the published port. Local mode
# has no login, so the server refuses to start on a non-loopback address
# unless PROA_ALLOW_NON_LOOPBACK=1 is set at run time, which states that the
# port is published on 127.0.0.1 only (docker/compose.yaml does both):
#   docker run -p 127.0.0.1:7400:7400 -e PROA_ALLOW_NON_LOOPBACK=1 … proa:local
ENV NODE_ENV=production \
    PROA_HOST=0.0.0.0 \
    PROA_PORT=7400 \
    PROA_WEB_DIST=/app/apps/web/dist \
    PROA_OWNER_KEY_FILE=/var/lib/proa/owner-key
WORKDIR /app
COPY --from=prod /app/package.json ./package.json
COPY --from=prod /app/node_modules ./node_modules
COPY --from=prod /app/packages ./packages
COPY --from=prod /app/apps/server ./apps/server
COPY --from=prod /app/apps/cli ./apps/cli
COPY --from=prod /app/eval/corpus ./eval/corpus
COPY --from=prod /app/eval/value-chains ./eval/value-chains
COPY --from=build /app/apps/web/dist ./apps/web/dist
# `proa` CLI, e.g. `docker exec -i <container> proa mcp` (CONCEPT §6).
RUN printf '#!/bin/sh\nexec node /app/apps/cli/src/main.ts "$@"\n' > /usr/local/bin/proa \
    && chmod 755 /usr/local/bin/proa \
    && install -d -o node -g node -m 700 /var/lib/proa
USER node
EXPOSE 7400
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:7400/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "apps/server/src/main.ts"]
