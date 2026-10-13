# Crove kernel + web app in one image. Roles: migrate | api | worker | all (default).
FROM node:26-slim AS build
WORKDIR /app
ENV CI=true
# pnpm 10 is plain JavaScript; it downloads the pnpm version pinned in package.json (packageManager).
RUN npm install -g pnpm@10.34.7 --no-fund --no-audit
COPY . .
RUN pnpm install --frozen-lockfile --filter "@crove/kernel-server..." --filter "@crove/app..." \
 && pnpm --filter @crove/app build

FROM node:26-slim
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    STORAGE_DIR=/data/files \
    WEB_DIST=/app/apps/app/dist \
    MIGRATIONS_DIR=/app/supabase/migrations
WORKDIR /app
COPY --from=build --chown=node:node /app /app
RUN mkdir -p /data/files && chown node:node /data/files
USER node
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --retries=6 CMD node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["node", "apps/kernel/src/main.ts"]
CMD ["all"]
