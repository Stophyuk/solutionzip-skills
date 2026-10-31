# syntax=docker/dockerfile:1
# Dockerfile — goes at the repo root; deploy/docker-compose.yml builds it on the box. Next.js with output: "standalone"
# in next.config. Uses pnpm; switch the install lines for npm or yarn.
# The repo's .dockerignore must list .env* (and node_modules, .next, .git): `COPY . .` would otherwise bake local
# secrets into a layer.
ARG NODE_IMAGE=node:24-bookworm-slim

FROM ${NODE_IMAGE} AS deps
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH NEXT_TELEMETRY_DISABLED=1 CI=1
# pin the pnpm your lockfile was written with
RUN npm i -g pnpm@10 && pnpm config set store-dir /pnpm/store
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm install --frozen-lockfile

FROM deps AS builder
# NEXT_PUBLIC_* are inlined at build time; secrets never come through build args (they stay in the image history)
ARG NEXT_PUBLIC_SUPABASE_URL
ARG NEXT_PUBLIC_SUPABASE_ANON_KEY
ENV NEXT_PUBLIC_SUPABASE_URL=$NEXT_PUBLIC_SUPABASE_URL \
    NEXT_PUBLIC_SUPABASE_ANON_KEY=$NEXT_PUBLIC_SUPABASE_ANON_KEY \
    NODE_OPTIONS=--max-old-space-size=2048
COPY . .
# The Server Actions key comes as a BuildKit secret (never a build arg, never a layer). With it fixed, the action IDs
# stay the same from one deploy to the next, so a form left open across a deploy can still submit instead of failing
# with "Failed to find Server Action". Absent (a local build), Next makes a new key per build.
RUN --mount=type=secret,id=actions_key,env=NEXT_SERVER_ACTIONS_ENCRYPTION_KEY pnpm build

FROM ${NODE_IMAGE} AS runner
ENV NODE_ENV=production HOSTNAME=0.0.0.0 PORT=3000 NEXT_TELEMETRY_DISABLED=1
RUN groupadd -g 1001 nodejs && useradd -u 1001 -g nodejs -M -s /usr/sbin/nologin nextjs
WORKDIR /app
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public ./public
# Files the app reads at request time through process.cwd() (fonts, MDX content …) are not traced into standalone —
# copy them here, e.g.:
# COPY --from=builder --chown=nextjs:nodejs /app/content ./content
USER nextjs
EXPOSE 3000
# `up --wait` in deploy.sh waits for this. Any answer below 500 counts (redirects are not followed) — a cheap check
# that the server is up, independent of which routes exist.
HEALTHCHECK --interval=30s --timeout=5s --start-period=25s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/',{redirect:'manual'}).then(r=>process.exit(r.status<500?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.js"]
