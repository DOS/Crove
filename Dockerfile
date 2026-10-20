# Crove kernel + web app in one image. Roles: migrate | api | worker | all (default).
# The image holds no PDF, XML or MIME parser (plan §7.6, External-tenant gate T12): files are parsed in
# crove-extract (apps/extract/Dockerfile). tools/test/parser-imports.test.ts checks the dependency tree.
# Base images are pinned by digest (Node 26.11.1 here); see "Updating pinned images" in AGENTS.md.
FROM node:26-slim@sha256:193fe51b64e77981119c98c2002c9e32a70e2f006fb4d25068ce0558998917f0 AS base
WORKDIR /app
ENV CI=true
# pnpm 10 is plain JavaScript; it downloads the pnpm version pinned in package.json (packageManager).
RUN npm install -g pnpm@10.34.7 --no-fund --no-audit
COPY . .

# The web app is built with its development dependencies; only its static output reaches the image.
FROM base AS web
RUN pnpm install --frozen-lockfile --filter "@crove/app..." \
 && pnpm --filter @crove/app build

# The kernel with production dependencies only. --filter-prod follows dependencies, never devDependencies, when
# it selects workspace projects: with --filter, crove-extract (a devDependency the database tests start) would be
# selected too and its parsers installed. Neither they nor the source of the other apps reach the image.
FROM base AS kernel
RUN pnpm install --frozen-lockfile --prod --filter-prod "@crove/kernel-server..." \
 && rm -rf apps/extract apps/app apps/web packages/ui

FROM node:26-slim@sha256:193fe51b64e77981119c98c2002c9e32a70e2f006fb4d25068ce0558998917f0
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    STORAGE_DIR=/data/files \
    WEB_DIST=/app/apps/app/dist \
    MIGRATIONS_DIR=/app/supabase/migrations
WORKDIR /app
COPY --from=kernel --chown=node:node /app /app
COPY --from=web --chown=node:node /app/apps/app/dist /app/apps/app/dist
RUN mkdir -p /data/files /data/keys /data/status && chown node:node /data/files /data/keys /data/status && chmod 700 /data/keys
USER node
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --retries=6 CMD node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["node", "apps/kernel/src/main.ts"]
CMD ["all"]
