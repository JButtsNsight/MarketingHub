# syntax=docker/dockerfile:1
#
# MarketingHub web — multi-stage build.
#
# Builder: node:24-alpine compiles the Next.js 15 app with `output: "standalone"`
# (see next.config.mjs), which emits a self-contained server bundle carrying only
# the node_modules it actually imports.
#
# Runtime: gcr.io/distroless/nodejs24 — no shell, no package manager, minimal
# attack surface (same pattern as lena-admin). We run as the image's built-in
# non-root user. The distroless nodejs image's ENTRYPOINT is `node`, so CMD is
# just the script path.

# ---- deps: install production+build deps against the lockfile ----
FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

# ---- builder: produce the standalone server ----
FROM node:24-alpine AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build && npm run build:worker

# ---- runner: distroless Node 24, non-root ----
# debian13 is the maintained distroless line; the debian12 variants were frozen
# upstream in Feb 2026 (tags aliased deprecated-public-image-*) and stopped
# receiving Node security patches (stuck at 24.14.0 with known CVEs).
FROM gcr.io/distroless/nodejs24-debian13:nonroot AS runner
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0

# Standalone output layout: server.js + its traced node_modules at the root,
# static assets under .next/static, and the public/ dir alongside.
COPY --from=builder /app/public ./public
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
# SMS dispatcher worker: same image, separate entrypoint. The worker ECS
# service overrides the command to ["worker.cjs"] (ENTRYPOINT is `node`).
COPY --from=builder /app/.worker/worker.cjs ./worker.cjs

EXPOSE 3000

# distroless/nodejs ENTRYPOINT is `node`; pass the standalone entrypoint.
CMD ["server.js"]
