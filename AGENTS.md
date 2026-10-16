# AGENTS.md

Crove is the open-source Business OS (AGPL). It must run with `docker compose up` and no DOS service. Anything DOS-specific belongs in the private Crove Cloud layer, never here.

## Picking up work (GitHub Project "Crove")

- Work comes from the board https://github.com/orgs/DOS/projects/8 (issues in DOS/Crove). One task = one issue = one worktree = one PR. Split work by feature, not by layer: a task goes end to end (migration, server, contract, UI, tests).
- Pick the highest-priority open issue (`priority:P1` first) in the earliest milestone, skipping issues already `In progress` and issues labelled `owner-action` (the owner's job).
- Any number of agents may run; nobody owns a fixed area. When priorities tie, prefer an issue with the same area label (`kernel`, `security`, `auth`, `finance`, `web`, `infra`, `tooling`, `cloud`) as your previous task, so each agent naturally stays in one area and the owner can see who works where.
- To claim it: set Status to `In progress` and comment `Claimed by <session or agent name>, branch <branch>`. All agents share one GitHub account, so the comment is the lock. Never take over a claimed issue.
- The PR body says `Closes #<n>`; merging moves the issue to Done. If a task needs work in another area (for example UI for a new kernel API), open a follow-up issue instead of growing the PR.
- New migrations: rebase on `origin/main` right before merging and keep your migration timestamp greater than every file on `main`.

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

## Protected paths (Decision 7)

- **What is protected** (plan §10, G6; the list is `tools/ci/protected-paths.mjs`, matched on paths only): `.github/workflows/**`, `.github/CODEOWNERS`, git hooks, `.gitattributes`, `.gitmodules`; agent harness and policy (`.claude/settings*`, `.claude/hooks/**`, `.claude/agents/**`, `.mcp.json`, `CLAUDE.md`, `AGENTS.md`); dependencies and test runners (every `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `.npmrc`, `vitest*.config.ts`, `vitest*.workspace.ts`, and in any directory `playwright*.config.ts`, `global-setup.ts`, `global-teardown.ts`); the gate itself (`tools/ci/**`, every `test/invariant/` directory); the command runtime (`packages/kernel-runtime/src/**`); database context guards and the migration runner (`packages/db/src/index.ts`, `packages/db/src/context/**`, `packages/db/src/migrate.ts`); approval policy and identity (`packages/kernel/src/approval.ts`, `identity.ts`); authentication and the HTTP edge (`apps/kernel/src/auth*.ts`, `sessions*.ts`, `http.ts`, any `auth/` directory); every change under `supabase/migrations/`; `_*.test.sql`; `LICENSE`, `CLA.md`, `agent-autonomy.md`.
- **The invariant suite** is every file under a `test/invariant/` directory (today `apps/kernel/test/invariant/` and `packages/db/test/invariant/`): RLS isolation, the EXECUTE matrix and system context, approval policy (four-eyes P10, eligibility P12, revisions), ledger immutability and append-only tables, ledger checks that see every line whatever the caller can see (#76, `ledger-visibility.db.test.ts`), the definer `search_path` hijack test, role grants, token assurance level and fresh MFA (P11), session status per ADR-0028 (`sessions.db.test.ts`), `aal2` required for users with a verified MFA factor (#126, `mfa-required.db.test.ts`), the context re-entry guard (T10, `context.db.test.ts`), the sealed context (T11, `sealed-context.db.test.ts`), inbound address rotation and tombstones (#37, `inbound-rotation.db.test.ts`), member invites (consent, email binding and confirmed email, single use, revocation when the inviter loses the right, owners' invites kept from admins; #35, #134, `invites.db.test.ts`), the per-client email budget in front of Supabase Auth (#190, `auth-email-limit.db.test.ts`), plus org creation through `execute()` (T4), no TEMP for Crove roles or their members and the pinned `search_path` guard, including functions outside `crove_*` that Crove objects reach (T17, #100), and the migration runner as a non-superuser (`migrate.db.test.ts`). Keep each directory self-contained: no imports or fixtures from outside it (the e-invoice fixture has its own copy in `fixtures/`). New security tests go there; product flows stay in the ordinary `*.db.test.ts` files.
- **What runs** (`.github/workflows/protected.yml`, on every PR):
  - `Invariant suite (from base)`: detects protected paths with the base branch's copy of the script; if any changed, deletes the PR's `test/invariant/` files and `vitest.invariant.config.ts`, checks out the base branch's copy over the PR's tree and runs it against the PR's code on PostgreSQL 17. It fails if any invariant test fails or is skipped. The ordinary `ci` job still runs the PR's own copy.
  - `Security review (agent)`: on protected-path PRs, the security reviewer agent reviews security, tenancy, authorization and money and posts one `## Security review (agent)` comment (verdict plus findings by severity) and inline comments. Without the `ANTHROPIC_API_KEY` secret (owner action, #95) it passes with the notice "Security review pending owner setup"; until then the session runs its own independent security review on protected-path PRs. On a fork PR that touches protected paths (forks never get the secret) it fails with "Maintainer security review required". The reviewer reads the policy from the base branch (`git show <base>:AGENTS.md`).
  - With no protected path changed, both jobs pass in seconds and say so in the job summary.
- **Reading the result:** open the job summary. It lists the protected files, whether the base or the PR copy of the suite ran, and which invariant files the PR changed (those changes take effect only after merge). A red invariant job means the PR's code breaks an invariant as `main` defines it: fix the code, do not edit the test in the same PR. Changing an invariant on purpose turns this job red by design (the base copy still expects the old behavior); that is an owner decision: say so in the PR, and the owner merges over the red check after the security review, or the change lands in two steps with a test that accepts both behaviors first. Blocking findings from the reviewer are fixed before merge, like any must-fix review item.
- A PR that edits `protected.yml` or `tools/ci/` runs its own edited workflow, so the reviewer and the session check those changes with extra care.

## Commands

- `pnpm install` · `pnpm lint` · `pnpm typecheck` · `pnpm test` (unit) · `pnpm test:db` (needs `CROVE_TEST_ADMIN_URL`)
- Shared dev PostgreSQL: `migrate.db.test.ts` creates cluster-wide `t100_test_runner_*` roles and drops them afterwards; a run killed before that leaves them behind, and every later migrate on the cluster then fails the T17 check with `role t100_test_runner_..._proxy can create temporary objects`. The next run of that test drops leftovers older than 10 minutes; to clear them at once (with no run of it in progress): `psql "$CROVE_TEST_ADMIN_URL" -c "DO \$\$ DECLARE r text; BEGIN FOR r IN SELECT rolname FROM pg_roles WHERE rolname LIKE 't100\_test\_runner\_%' LOOP EXECUTE format('DROP OWNED BY %I', r); EXECUTE format('DROP ROLE %I', r); END LOOP; END \$\$"`
- `pnpm db:migrate` applies `supabase/migrations` with the built-in runner
- `docker compose up --build` runs the full stack on http://localhost:8080

## Updating pinned images

Every container image is pinned by digest as `image:tag@sha256:<digest>`: `docker-compose.yml`, the `FROM` lines of `Dockerfile`, `apps/extract/Dockerfile` and `apps/web/Dockerfile`, and the `services` and `docker run` images in `.github/workflows/`. The tag is for people; Docker pulls the digest, so a re-pushed tag cannot change what runs.

- **Bump:** run `docker buildx imagetools inspect <image>:<tag>` and copy the top-level `Digest` (the multi-arch index, not a per-platform manifest). Replace it in every file that uses the image (`git grep '<image>:'`), and change the tag in the same edit when the version moves.
- **Release age:** pin a build at least one day old, as `minimumReleaseAge` does for npm. The Docker Hub tag API (`https://hub.docker.com/v2/repositories/<namespace>/<name>/tags/<tag>`, namespace `library` for official images) shows `tag_last_pushed`; when the newest build is younger, pin the previous one (its exact version tag still points to it). Today `node:26-slim` is pinned to the Node 26.11.1 build for this reason.
- **Bots:** Renovate and Dependabot both update `tag@digest` pins (tag and digest together) once one is configured; none is yet.

## Rules

- **One write path.** Every state change is a command executed through `Runtime.execute()` (`packages/kernel-runtime`). No other code writes tenant tables.
- **Schema only via migrations** in `supabase/migrations/<14-digit UTC>_crove_<module>_<desc>.sql`. Idempotent statements, never edit an applied file, never DDL at runtime. Every function sets `search_path = pg_catalog, pg_temp`, never `''`. The hardening guard the runner applies after every run (`hardeningViolations`) has no bypass flag or warn mode, and must not get one: a deploy that fails it is fixed with a forward migration, never skipped.
- **Tenancy:** every tenant table has `org_id`, `PRIMARY KEY (org_id, id)` and RLS via `crove_kernel.apply_tenant_rls`. Login roles own nothing.
- **Money** is NUMERIC in SQL and a decimal string everywhere else; arithmetic through `decimal.js` (`@crove/l10n-vn` money helpers). Never JS numbers for amounts.
- **AI** calls only in `packages/agent`, through an OpenAI-compatible endpoint. AI output is tainted: deterministic checks decide, humans approve.
- **Public repo:** no secrets, Supabase project refs, internal URLs or real customer data. gitleaks + G1 run in CI and in the pre-commit hook.
- Code, comments and commit messages in English. No em dashes.
- Docs-only PRs need no agent review: `pnpm docs:check` and CI (`Docs check` job) must pass.
