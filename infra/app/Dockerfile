# syntax=docker/dockerfile:1
# Production image: API + business portal + tablet player + rider app (built web apps), plus ffmpeg so the same image
# runs the background jobs (media processing, backups, validation, allocations) as separate Railway services.
#   docker build -f infra/app/Dockerfile -t rmn-app .
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
# Behind a TLS-inspecting proxy only: --build-arg EXTRA_CA_PEM_B64="$(base64 -w0 ca.pem)" (a public CA certificate,
# used for npm during the build and then deleted). Railway builds need nothing.
ARG EXTRA_CA_PEM_B64=
RUN if [ -n "$EXTRA_CA_PEM_B64" ]; then echo "$EXTRA_CA_PEM_B64" | base64 -d > /tmp/extra-ca.pem && export NODE_EXTRA_CA_CERTS=/tmp/extra-ca.pem; fi; \
    npm ci --no-audit --no-fund && npm cache clean --force && rm -f /tmp/extra-ca.pem
COPY tsconfig.base.json ./
COPY packages/finance-core packages/finance-core
COPY apps/api apps/api
COPY apps/player apps/player
COPY apps/rider apps/rider
COPY apps/portal apps/portal
RUN npm run build:web
# Scratch space for upload chunks and ffmpeg work; media itself lives in the bucket (MEDIA_STORE=s3).
RUN mkdir -p /app/apps/api/var/media && chown -R node:node /app/apps/api/var
USER node
WORKDIR /app/apps/api
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8080
EXPOSE 8080
CMD ["node", "--import", "tsx", "src/server.ts"]
