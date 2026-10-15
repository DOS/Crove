# crove-extract: the file parsing sandbox (plan §7.6, External-tenant gate T12). Build from the repository root:
#   docker build -f apps/extract/Dockerfile -t crove-extract .
# Parsing libraries only (fast-xml-parser, unpdf, postal-mime): no database client, no AI or storage SDK, no
# credentials. Bytes in, JSON out; only the worker calls it. docker-compose.yml runs it on an internal network
# with no egress, a read-only root file system, no capabilities, 1 vCPU and 1 GiB.
FROM node:26-slim AS build
WORKDIR /app
ENV CI=true
# pnpm 10 is plain JavaScript; it downloads the pnpm version pinned in package.json (packageManager).
RUN npm install -g pnpm@10.34.7 --no-fund --no-audit
COPY . .
# Only crove-extract and its workspace dependencies, production dependencies only.
RUN pnpm install --frozen-lockfile --prod --filter "@crove/extract..." \
 && rm -rf apps/extract/test packages/extract-contract/test packages/l10n-vn/test

FROM node:26-slim
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8090
WORKDIR /app
# Owned by root and read only for the service user: the service cannot change its own code.
COPY --from=build /app/package.json /app/package.json
COPY --from=build /app/node_modules /app/node_modules
COPY --from=build /app/packages/extract-contract /app/packages/extract-contract
COPY --from=build /app/packages/l10n-vn /app/packages/l10n-vn
COPY --from=build /app/apps/extract /app/apps/extract
USER node
EXPOSE 8090
HEALTHCHECK --interval=10s --timeout=3s --retries=6 CMD node -e "fetch('http://127.0.0.1:8090/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# No inspector: SIGUSR1 must not open a debugger port on the service.
ENTRYPOINT ["node", "--disable-sigusr1", "apps/extract/src/main.ts"]
