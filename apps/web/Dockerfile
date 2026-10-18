# Crove marketing site (apps/web): the Next.js standalone server. Build from the repository root:
#   docker build -f apps/web/Dockerfile -t crove-web .
# Base images are pinned by digest like the root Dockerfile (Node 26.11.1 here); see "Updating pinned images" in
# AGENTS.md. The build downloads the fonts (next/font and the social preview images), so it needs network access.
FROM node:26-slim@sha256:193fe51b64e77981119c98c2002c9e32a70e2f006fb4d25068ce0558998917f0 AS build
WORKDIR /app
ENV CI=true \
    NEXT_TELEMETRY_DISABLED=1 \
    NEXT_STANDALONE=true
# pnpm 10 is plain JavaScript; it downloads the pnpm version pinned in package.json (packageManager).
RUN npm install -g pnpm@10.34.7 --no-fund --no-audit
COPY . .
RUN pnpm install --frozen-lockfile --filter "@crove/web..." \
 && pnpm --filter @crove/web build

FROM node:26-slim@sha256:193fe51b64e77981119c98c2002c9e32a70e2f006fb4d25068ce0558998917f0
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0
WORKDIR /app
# The standalone output keeps the workspace layout: the server sits at apps/web/server.js and expects the static
# assets and public files next to it.
COPY --from=build --chown=node:node /app/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=build --chown=node:node /app/apps/web/public ./apps/web/public
USER node
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --retries=6 CMD node -e "fetch('http://127.0.0.1:3000/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "apps/web/server.js"]
