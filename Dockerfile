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
# exceljs depends on saxes, an XML reader it loads only to read a workbook (patches/exceljs.patch makes that
# load lazy); the kernel only writes workbooks, so saxes, its xmlchars and every link to them are removed, as is
# exceljs's dist (browser and ES5 builds, which bundle or load saxes; Node loads lib/). The image check fails if
# any XML reader is left (apps/kernel/test/container/image-check.mjs, #1719).
FROM base AS kernel
RUN pnpm install --frozen-lockfile --prod --filter-prod "@crove/kernel-server..." \
 && rm -rf apps/extract apps/app apps/web packages/ui \
 && rm -rf node_modules/.pnpm/saxes@* node_modules/.pnpm/xmlchars@* \
      node_modules/.pnpm/node_modules/saxes node_modules/.pnpm/node_modules/xmlchars \
      node_modules/.pnpm/exceljs@*/node_modules/saxes node_modules/.pnpm/exceljs@*/node_modules/exceljs/dist

FROM node:26-slim@sha256:193fe51b64e77981119c98c2002c9e32a70e2f006fb4d25068ce0558998917f0
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    STORAGE_DIR=/data/files \
    ARCHIVE_DIR=/data/archive \
    WEB_DIST=/app/apps/app/dist \
    MIGRATIONS_DIR=/app/supabase/migrations
WORKDIR /app
COPY --from=kernel --chown=node:node /app /app
COPY --from=web --chown=node:node /app/apps/app/dist /app/apps/app/dist
RUN mkdir -p /data/files /data/keys /data/context-token /data/status /data/archive && chown node:node /data/files /data/keys /data/context-token /data/status /data/archive && chmod 700 /data/keys /data/context-token
# The build id GET /version reports (#892): the release workflow passes the git SHA. Last, so a new SHA rebuilds no
# layer above.
ARG CROVE_BUILD=
ENV CROVE_BUILD=$CROVE_BUILD
USER node
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --retries=6 CMD node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["node", "apps/kernel/src/main.ts"]
CMD ["all"]
