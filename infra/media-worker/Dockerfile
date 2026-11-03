# syntax=docker/dockerfile:1
# Isolated media worker (R-023). Build from the repository root:
#   docker build -f infra/media-worker/Dockerfile -t rmn-media-worker .
# Behind a TLS-inspecting proxy, pass its CA as a build secret (never baked into the image):
#   docker build --secret id=ca,src=/path/to/ca.pem ...
ARG BASE=node:22-bookworm-slim
FROM ${BASE}
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg util-linux ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/finance-core/package.json packages/finance-core/
COPY apps/api/package.json apps/api/
COPY apps/player/package.json apps/player/
COPY apps/rider/package.json apps/rider/
COPY apps/portal/package.json apps/portal/
RUN --mount=type=secret,id=ca,required=false \
    if [ -f /run/secrets/ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/ca; fi; \
    npm ci --ignore-scripts --no-audit --no-fund --workspace @rmn/api --include-workspace-root && npm cache clean --force
COPY tsconfig.base.json ./
COPY packages/finance-core packages/finance-core
COPY apps/api/tsconfig.json apps/api/
COPY apps/api/src apps/api/src
WORKDIR /app/apps/api
# Unprivileged user; the compose service also drops all capabilities and mounts the filesystem read-only.
USER node
ENV NODE_ENV=production
CMD ["node", "--import", "tsx", "src/jobs/media-worker.ts"]
