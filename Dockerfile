# syntax=docker/dockerfile:1

# Multi-stage build producing a small runtime image from Next.js "standalone"
# output. The runner stage carries no source, no devDependencies and no npm —
# only the traced server and the node_modules subset it actually imports.
#
# Architecture: no --platform pin, so the image is built for the host.
# On an Apple Silicon machine that yields linux/arm64, which must match the
# Fargate task definition in Phase 2 (cpuArchitecture: ARM64). A mismatch
# produces an exec format error at task start, not at build time.

FROM node:22-alpine AS base
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

# ---- dependencies -----------------------------------------------------------
FROM base AS deps
COPY package.json package-lock.json ./
RUN npm ci

# ---- build ------------------------------------------------------------------
FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

# ---- runtime ----------------------------------------------------------------
FROM base AS runner
ENV NODE_ENV=production
# The standalone server binds to localhost unless HOSTNAME is set, which makes
# the container unreachable from the ALB even though it starts cleanly.
ENV HOSTNAME=0.0.0.0
ENV PORT=3000

RUN addgroup --system --gid 1001 nodejs \
 && adduser --system --uid 1001 --ingroup nodejs nextjs

# `public` must exist in the build context; the COPY below fails otherwise.
COPY --from=builder --chown=nextjs:nodejs /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

USER nextjs
EXPOSE 3000

CMD ["node", "server.js"]
