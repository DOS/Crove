# AGENTS.md

Crove is the open-source Business OS (AGPL). It must run with `docker compose up` and no DOS service. Anything DOS-specific belongs in the private Crove Cloud layer, never here.

## Worktrees (several agents work on this repo at once)

- Never edit in the main checkout (`D:\Projects\Crove` or wherever the repo is cloned). Do every task in its own worktree, on its own branch, created from a freshly fetched `origin/main`:
  - Claude Code: `.claude/worktrees/<task-name>`
  - Codex: `.codex/worktrees/<task-name>`
  - Cursor: `.cursor/worktrees/<task-name>`
- Never create worktrees in `.worktrees`, sibling directories, global `_worktrees` folders or temp directories.
- Before starting, check `git worktree list` and open PRs. If a worktree or branch already belongs to another task or agent, do not edit it or take over its branch; create a new one. A locked worktree belongs to an active agent.
- Never `git checkout`, `reset --hard`, `clean` or bare `git stash` in a path another agent may use. Set aside work with a WIP commit instead.
- Rebase on `origin/main` right before merging; other agents merge often. Resolve conflicts by keeping both sides unless one side is clearly superseded.
- Remove your worktree after your PR is merged, only if `git status` is clean, with `git worktree remove` (never force).

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
