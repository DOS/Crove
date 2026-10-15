# Contributing to Crove

Crove is the open-source Business OS (AGPL-3.0-only). Thank you for your interest.

## Outside contributions are not accepted yet

Pull requests from outside contributors are not accepted until the [Contributor License Agreement](./CLA.md) is final (it is currently a draft pending legal review) and CLA enforcement is enabled. Issues, bug reports and discussion are welcome now. Vulnerabilities go through [SECURITY.md](./SECURITY.md), never public issues.

## Run it

Node 26 and pnpm (the pinned version is downloaded automatically).

```bash
pnpm install
docker compose up -d db auth auth-grants mailpit   # or point .env at your own PostgreSQL 17
pnpm db:migrate
pnpm dev                                            # kernel on :8080, web app on :5173
pnpm lint && pnpm typecheck && pnpm test            # unit tests
CROVE_TEST_ADMIN_URL=postgres://postgres:...@localhost:5432/postgres pnpm test:db
```

`docker compose up --build` runs the full stack on http://localhost:8080 with no external service. See the [README](./README.md) for configuration.

## Rules (summary of AGENTS.md)

[AGENTS.md](./AGENTS.md) is the source of truth and applies to humans and agents alike. In short:

- **One write path.** Every state change is a command executed through `Runtime.execute()`. No other code writes tenant tables.
- **Schema only via migrations** in `supabase/migrations/<14-digit UTC>_crove_<module>_<desc>.sql`: idempotent, never edit an applied file, never DDL at runtime, every function sets `search_path = pg_catalog, pg_temp`.
- **Tenancy:** every tenant table has `org_id`, `PRIMARY KEY (org_id, id)` and RLS via `crove_kernel.apply_tenant_rls`.
- **Money** is NUMERIC in SQL and a decimal string elsewhere; arithmetic through `decimal.js`. Never JS numbers for amounts.
- **AI** calls only in `packages/agent`, through an OpenAI-compatible endpoint. AI output is tainted: deterministic checks decide, humans approve.
- **Public repo:** no secrets, project refs, internal URLs or real customer data. gitleaks and the G1 scan run in CI and in the pre-commit hook.
- The core must run locally with no DOS service. Anything vendor-specific belongs in a separate, private layer.
- Code, comments and commit messages in English. No em dashes.
- Protected paths (workflows, dependencies, migrations, auth, the runtime, invariant tests, `LICENSE`, `CLA.md`) get extra checks and a security review.

## Pull request flow

1. Pick or open an issue; one task is one issue, one branch, one PR, end to end (migration, server, contract, UI, tests).
2. Work in a git worktree on a branch from a freshly fetched `origin/main`.
3. Keep the PR focused; open a follow-up issue instead of growing it. The PR body says `Closes #<n>` (or `Refs #<n>`).
4. Run `pnpm lint`, `pnpm typecheck`, `pnpm test` (and `pnpm test:db` for database changes). Docs-only changes: `pnpm docs:check`.
5. Rebase on `origin/main` before merging. Squash merge once CI is green and review items are resolved.

## Contributor License Agreement

Contributors keep the copyright in their work and grant the project owner a license to use, sublicense and relicense it (see [CLA.md](./CLA.md)). A signed CLA, individual or corporate, will be required for every outside contribution once the CLA is final.

## Trademarks

The Crove name and logo are covered by [TRADEMARKS.md](./TRADEMARKS.md).
