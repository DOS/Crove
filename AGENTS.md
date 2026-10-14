# AGENTS.md

Crove is the open-source Business OS (AGPL). It must run with `docker compose up` and no DOS service. Anything DOS-specific belongs in the private Crove Cloud layer, never here.

## Commands

- `pnpm install` · `pnpm lint` · `pnpm typecheck` · `pnpm test` (unit) · `pnpm test:db` (needs `CROVE_TEST_ADMIN_URL`)
- `pnpm db:migrate` applies `supabase/migrations` with the built-in runner
- `docker compose up --build` runs the full stack on http://localhost:8080

## Rules

- **One write path.** Every state change is a command executed through `Runtime.execute()` (`packages/kernel-runtime`). No other code writes tenant tables.
- **Schema only via migrations** in `supabase/migrations/<14-digit UTC>_crove_<module>_<desc>.sql`. Idempotent statements, never edit an applied file, never DDL at runtime. Every function sets `search_path = pg_catalog, pg_temp`, never `''`.
- **Tenancy:** every tenant table has `org_id`, `PRIMARY KEY (org_id, id)` and RLS via `crove_kernel.apply_tenant_rls`. Login roles own nothing.
- **Money** is NUMERIC in SQL and a decimal string everywhere else; arithmetic through `decimal.js` (`@crove/l10n-vn` money helpers). Never JS numbers for amounts.
- **AI** calls only in `packages/agent`, through an OpenAI-compatible endpoint. AI output is tainted: deterministic checks decide, humans approve.
- **Public repo:** no secrets, Supabase project refs, internal URLs or real customer data. gitleaks + G1 run in CI and in the pre-commit hook.
- Code, comments and commit messages in English. No em dashes.
- Docs-only PRs need no agent review: `pnpm docs:check` and CI (`Docs check` job) must pass.
