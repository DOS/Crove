# 0001. Repositories, migrations and the review gates: why a change an agent wrote can be trusted

- Status: Accepted. It records what the plan decided (§10 gates G1 to G6, Decisions 7 and 9, §3.5 and §5.5), ADR-0027 and `AGENTS.md`, and what is built on `main` as of 2026-10-30. It decides nothing new.
- Date: 2026-10-30
- Deciders: owner (JOY), through the plan; written down by the Claude Code session for issue #2048
- Builds on: ADR-0027 (open-source core and Crove Cloud); plan §3.5 (deploys), §5.5 (migrations), §10 (AI coding foundation); External-tenant gate row T15; `AGENTS.md`
- Issue: [#2048](https://github.com/DOS/Ludy/issues/2048)

## Context and problem statement

Almost all of Ludy's code is written by AI agents, several at a time, and agents merge their own pull requests: the owner does not code, run commands or merge. The repository is public and holds a multi-tenant accounting system. An agent can edit anything it can push, including the tests and the checks that would catch its change. So "reviewed" cannot mean "a person read it", and a change must not be able to loosen the gate that judges it.

This record answers, in one place, what an external security reviewer (#31) will ask:
- what lives in the public repository and what does not, and what keeps secrets out;
- how the schema changes, and how a change is checked before it is merged;
- which checks every pull request passes, and what more happens when it touches the code that holds security;
- what "reviewed" means for a merge, and how a security invariant is changed on purpose;
- how a release reaches a host.

## Decision drivers

- No secret, project reference, internal URL or customer data in a public repository, caught mechanically over the whole history.
- The schema holds tenant isolation and the ledger, so it changes one way only, is checked before merge, and is never edited after it is applied.
- A change is judged by the base branch's checks, not by its own.
- Agents merge, so the merge bar is written down, and as much of it as possible runs in CI instead of resting on memory.
- What weakens security is the owner's decision, not an agent's.

## Decision

### 1. Two repositories

[ADR-0027](0027-oss-core-and-crove-cloud.md) decided the split.
- `DOS/Ludy` is the open-source core under the AGPL. It has no DOS-only features, runs with `docker compose up`, and keeps every external dependency behind an adapter with a generic default.
- A private `crove-cloud` repository holds what is DOS's own: its configuration, DOS.AI defaults, org sync, managed connectors, infrastructure and the Cloud deployment. It depends on the core, never the reverse. Every pull request to it counts as protected (plan §10, G6).
- `AGENTS.md` states the rule for the public repository: no secrets, project references, internal URLs or real customer data. A runbook for a production step names a secret or a host by reference, never by value.

What holds the rule:
- **Secret scan** ([`gitleaks.yml`](../../.github/workflows/gitleaks.yml)). gitleaks, pinned by version and SHA-256, scans the full git history on every pull request and every push to `main`, with the defaults plus rules for Supabase identifiers ([`.gitleaks.toml`](../../.gitleaks.toml)). The blocklist of project references (G1) lives in the Actions secret `G1_BLOCKLIST`, not in the repository, and [`g1_config.py`](../../.github/scripts/g1_config.py) adds it to the scan's configuration. A fork or Dependabot pull request gets no secrets and scans without it; every other run must have it.
- **The Docs check job** ([`docs-check.yml`](../../.github/workflows/docs-check.yml)):
  - the path boundary ([`path-boundary.mjs`](../../tools/ci/path-boundary.mjs)) refuses OpenTofu or Terraform files, environment files other than examples, `crove-cloud/`, `cloud/` and `infra/` directories, and deploy workflows, with one reasoned exception (the pilot deploy, section 7);
  - the PII scan ([`pii-scan.mjs`](../../tools/ci/pii-scan.mjs)) refuses Vietnamese citizen IDs, mobile numbers, individual tax codes and email addresses outside reserved example domains in the PR's merged tree.
- **The pre-commit hook** ([`.githooks/pre-commit`](../../.githooks/pre-commit)) runs the docs check on staged documents and `gitleaks git --pre-commit --staged`. It scans the staged diff only, has no blocklist, and is skipped with a notice where gitleaks is not installed. CI is the hard gate.

### 2. Migrations

The schema changes only through committed files `supabase/migrations/<14-digit UTC>_crove_<module>_<desc>.sql`. The runner ([`migrate.ts`](../../packages/db/src/migrate.ts)) refuses a file whose name does not match.

**The runner** is built in, needs no Supabase CLI and works on any PostgreSQL 17.
- It records every applied file in `crove_meta.schema_migrations` (version, name, SHA-256, time) and applies the unapplied ones in version order, one transaction per file with the ledger insert inside it.
- A file whose SHA-256 differs from its ledger row stops the run ("edited after it was applied; add a new migration instead").
- A session advisory lock keeps two runs apart. It is polled, not waited for, so a concurrent index build cannot deadlock with it (#1791).
- A file marked `-- crove:concurrent-index` holds only `CREATE INDEX CONCURRENTLY IF NOT EXISTS` statements. It is applied outside a transaction and recorded once every index is valid.
- After every run it revokes EXECUTE on the functions of the module schemas from PUBLIC, then runs `hardeningViolations`: a `crove_*` function without the pinned `search_path = pg_catalog, pg_temp`, a Crove role that can create temporary objects, and the other items of External-tenant gate T17 fail the run. There is no bypass. The files are already committed by then, so the fix is a new forward migration.
- CI runs it as a non-superuser ([`migrate.db.test.ts`](../../packages/db/test/invariant/migrate.db.test.ts) uses a `NOSUPERUSER` role), and a separate job repeats the migrations and the guard on the Supabase Postgres image, where the migration role is not a superuser either. Nothing in the runner refuses a superuser.

**The lint** ([`migration-lint.mjs`](../../tools/ci/migration-lint.mjs), the Docs check step "Migration lint") reads each new or changed file and refuses:
- transaction control, `TRUNCATE`, `DROP SCHEMA`, `PREPARE`, `EXPLAIN` and `COPY`;
- a grant to `anon`, `authenticated` or PUBLIC, and an ownership change to any role but the two definer roles (and the runner itself);
- a function without a `REVOKE ... FROM PUBLIC` after it, and a policy created without being dropped first;
- a file touching a module schema other than its own, unless a reasoned waiver line says so;
- a change of the string-handling settings the lint's own lexer relies on;
- an index build or constraint on a hot table (the outbox, the job tables, the audit table) that would hold a write lock, outside a concurrent-index file;
- a contract change (a `DROP`, a rename, a column or type change) without `-- crove:contract adr=<id>` naming the ADR that records it, and DDL on a hot table outside the lock-retry block (both for files after a cut-off version);
- any change to a file already on the base branch.

The allowlist of old files is read from the base branch, so a pull request cannot exempt its own file.

**Order.** A new file's version must be above every file on the base branch ([`migration-order.mjs`](../../tools/ci/migration-order.mjs)). GitHub does not re-run pull request checks when `main` moves, so [`migration-recheck.yml`](../../.github/workflows/migration-recheck.yml) re-runs the Docs check of open pull requests whose migrations fell behind after every push to `main`. `pnpm migration:rebase` ([`migration-rebase.mjs`](../../tools/migration-rebase.mjs)) renames a branch's migrations to whole hours after `main`'s newest.

**Forward only.** An applied file is never edited: the runner, the lint and the protected paths each refuse it. A rollback restores images and compose files only. The schema stays where the newer release left it, so every migration must keep the previous release working: expand first, contract in a later release (plan §3.5).

### 3. The checks every pull request passes

The plan's CI gates table (§10) records each gate's detail and which parts are built. This is the list as it runs today.

| Gate | Checks on a pull request | What they hold |
|---|---|---|
| G1 scope | Secret scan; Docs check steps "Path boundary" and "PII scan" | Section 1. |
| G2 migration-lint | Docs check steps "Migration order" and "Migration lint"; the recheck workflow | Section 2. |
| G3 db-replay | "Database tests" in three parts, inside the required "Lint, typecheck, test"; "Migrations and hardening guard on the Supabase Postgres image" | Every migration replayed on PostgreSQL 17 with the built-in runner, then the generated RLS matrix, the EXECUTE matrix, the schema conformance rules, the catalog fingerprint that a second run must leave unchanged, the pgTAP files and the check that generated types are current. |
| G4 supabase-preview | None | Not built: it needs the private layer and a beta project. |
| G5 ci | "Lint, typecheck, unit tests"; "Unused files, exports and dependencies (knip)"; "Marketing site (image, axe, language, performance)"; the Docs check step "PII scan"; the first three gathered by the required "Lint, typecheck, test" | Lint, typecheck of every source and test file, unit tests, dead code, the parser dependency rule and the allowed-imports rule. No formatter and no 800-line limit yet. |
| license | Docs check step "License header (SPDX)" | The `SPDX-License-Identifier: AGPL-3.0-only` line in the first lines of every source file a pull request adds. |
| G6 protected | "Invariant suite (from base)"; "Security review (agent)" | Section 4. |
| e2e | "Playwright on docker compose" | Sign up, create an org, upload an e-invoice, approve, the lists and the export, on `docker compose up`. |
| Images | "Kernel image (boots, no parser packages)"; "crove-extract image (parse in the container, no egress)"; "Split api and worker on S3 (end to end)"; "Backup and restore drill" | The built images and the split deployment, as ADR-0018 describes them. |
| Code scanning | "Analyze (actions)", "Analyze (javascript-typescript)", "CodeQL" | GitHub's CodeQL, configured in GitHub, not in a workflow file of this repository. |

Other workflows: `ai-eval` runs the extraction eval on pull requests that change the extractor and passes without running when the AI secrets are missing, as on a fork; `nightly-canaries` runs the unit tests on Bun and the typecheck on the next TypeScript on a schedule and never blocks a pull request.

Every third-party action is pinned by its commit SHA with the version in a comment, and the service images by digest. No check enforces that yet: the security reviewer is told to flag an action that is not pinned (section 4).

Which checks are required is set in GitHub, not in a file. The plan records that the required ones are the Secret scan, the Docs check, "Lint, typecheck, test", "Playwright on docker compose" and "Invariant suite (from base)". "Security review (agent)" is not required. The review bots (DOS Code Review, CodeRabbit) and the Vercel preview are configured outside this repository.

### 4. Protected paths and the review flow (Decision 7)

A pull request that touches the code that holds security gets two more things: the invariant suite taken from the base branch, and a security review.

**What is protected** ([`protected-paths.mjs`](../../tools/ci/protected-paths.mjs)), by path only, never by content, because content can be hidden from a diff: the workflows, actions, git hooks and the deploy pipeline; the agent harness and policy files (`.claude/settings*`, hooks, agents, `.mcp.json`, `CLAUDE.md`, `AGENTS.md`); every package manifest, the lockfile, the workspace and test runner configs; the gate itself (`tools/ci/`, every `test/invariant/` directory and the pgTAP gate files); the command runtime, the database context guards, the migration runner, approval policy, identity, authentication and the HTTP edge; every migration; `LICENSE`, `CLA.md` and the agent autonomy table. The script is copied from the base branch before it runs, so a pull request cannot change what counts as protected for its own run.

**Invariant suite (from base)** ([`protected.yml`](../../.github/workflows/protected.yml)) runs on every pull request. For a protected one it:
1. deletes the PR's copy of the suite (every `test/invariant/` file, `vitest.invariant.config.ts`, the `_*.test.sql` files) and checks out the base branch's copy over the PR's tree;
2. checks that the files on disk are exactly the base list with the base content, and records each file's SHA-256, type and link count before any PR code runs;
3. installs and runs the suite against the PR's code on PostgreSQL 17, and compares the files with the records again after the install and after the run, so a file swapped for a symlink or a hard link fails (#1647, #1786);
4. fails on any failed or skipped test, and prints the failures in the job summary.

On every pull request, protected or not, it also fails when a `node_modules` path is committed, because that could shadow a dependency of the suite (#1644). A red result on a protected-path pull request means its code breaks an invariant as `main` defines it: fix the code, never the test in the same change.

**Security review (agent)** runs on protected-path pull requests. A security reviewer agent reads the policy from the base branch's `AGENTS.md`, not the PR's, reads the diff for security, tenancy, authorization and money, and posts inline comments and one `## Security review (agent)` comment with a verdict. Without the `ANTHROPIC_API_KEY` secret (owner action, #95) it passes with a notice, and the session that wrote the change runs its own independent security review instead. On a pull request from a fork it fails with "Maintainer security review required", because forks never get the secret. No step acts on the verdict.

**The gate cannot judge itself.** Everything above that reads policy reads it from the base branch: the protected path list, the invariant suite, the invariant summary script, the migration lint allowlist and the reviewer's policy. What runs from the pull request's own tree is the workflow file and the scripts under `tools/ci/` other than those, so a change to either is itself a protected-path change and is reviewed with extra care.

There is no `CODEOWNERS` file. Protection is these checks and the two-step rule below, not named reviewers.

### 5. Changing an invariant on purpose

The invariant suite runs from the base branch, so a change that is meant to alter one turns the job red by design. `AGENTS.md` names two ways out: the owner merges over the red check after the security review, or the change lands in two steps.
1. A first pull request changes only the invariant tests so that they accept both the old and the new behavior. It takes effect after it merges.
2. A second pull request makes the change, and may then require the new behavior.

Two examples: #2039 then #2040 (the prober's new `extraction_health` function: the test first accepted it when present, then required it), and #2031 then #2025 (the archive health definer). Weakening tenancy, authentication, approval or the ledger's rules on purpose is the owner's decision.

### 6. What "reviewed" means for a merge

The merge bar is in `AGENTS.md` and holds on the pull request's final head:
- every CI check is green (a neutral result or a quota notice from a review bot is not a failure, and not a review either);
- the branch is rebased on `origin/main` with no conflict, and a migration passes the order check;
- every review thread has a reply and is resolved;
- a protected-path pull request carries the security review, the agent's or the session's own while #95 is pending;
- the body has an `## Acceptance` section (what a user will see change, the evidence against each item of the issue, the review results, the risk left), and the pull request passed the acceptance gate: the coordinator's for protected paths and for the workers it started, the team lead's for its own and its subagents', otherwise the session's own.

Before a pull request is opened, the author runs the Codex CLI review (`codex review --base origin/main`) and a fresh-context reviewer with the diff and the issue, and fixes what blocks. A documentation-only pull request skips them: the Docs check and CI are its gate.

The author merges its own pull request, squash, with the expected head SHA, and removes its worktree. It never merges, pushes to or takes over another session's pull request unless the owner names it. One task is one issue, one worktree under `.claude/worktrees/`, one branch and one pull request, and the claim comment on the issue is the lock between agents that share one GitHub account.

Production, secret and credential steps are not run by a worker. It writes a runbook (exact commands, a check and a rollback for each, secrets named by reference), and the coordinator runs exactly the list the owner approved in the coordinator's own chat.

### 7. Releases

The pilot deploy lives in this repository on purpose ([`deploy.yml`](../../.github/workflows/deploy.yml), the one allowed exception of the path boundary), pending the owner's decision in #1234.
- A run builds the kernel and `crove-extract` images from the release commit and passes them on by digest. It runs only for commits of `main`, and waits for the required checks named in `DEPLOY_REQUIRED_CHECKS` (by default "Lint, typecheck, test" and "Playwright on docker compose").
- [`deploy.sh`](../../tools/deploy/deploy.sh) runs on the host: pull by digest, check the compose files, run `migrate` first (a failure leaves the running release as it was), start Supabase Auth and run `auth-grants`, start the other services, roll the worker before the API (the API before the worker when going to an older build), wait for `/readyz`, run the smoke test. A failure after the migration deploys the previous release again. Rollback restores images only.
- The deploy pipeline is a protected path: it runs on the production host with root-equivalent rights.
- The settings of the GitHub environment (deployment branches and tags, tag protection for `v*`, required reviewers) are the real boundary, since a check inside a workflow does not hold against someone who can push an edited workflow. They live in GitHub and are described in [deploy.md](../runbooks/deploy.md).

## What is not covered

- **Branch protection, rulesets, environment and tag rules live only in GitHub.** No file here can prove which checks are required or who may merge over a red one.
- **The security reviewer agent is not required, and nothing reads its verdict.** Until the key is set (#95) a session's own review stands in, and no workflow checks that it happened.
- **Nothing checks the rest of the merge bar.** No workflow checks the `## Acceptance` section, the Codex review, the fresh-context review or the acceptance gate. The pull request body is the record. The pull request template has no Acceptance section.
- **A pull request that edits `protected.yml` or `tools/ci/` runs its own copy** of those files (section 4), which is why the reviewer and the session read such a change with extra care.
- **Not built** (plan §10): the Cloud preview gate (G4), the CLA check, a lock for kernel migrations, zizmor, dependency review, Opengrep, the 800-line limit, the auto-close of old agent pull requests, the `db:new` and `db:retime` generators, the agent hooks under `tools/agent`, `.claude/agents` and `CODEOWNERS`.
- **Pinned actions are a convention**, not a check (section 3).
- **The local secret scan is partial** (section 1); CI scans the full history.
- **Stale plan text.** Plan §10 describes "reviewed" as automated reviewers plus a fresh-context subagent plus G6. `AGENTS.md` is current: the Codex review and a fresh-context reviewer, with the review bots as extra readers that may be out of quota.

## Evidence

- [`migration-lint.test.ts`](../../tools/test/migration-lint.test.ts) with its contract, concurrent-index and hot-table files, [`migration-order.test.ts`](../../tools/test/migration-order.test.ts), [`migration-rebase.test.ts`](../../tools/test/migration-rebase.test.ts) and [`migration-versions.test.ts`](../../tools/test/migration-versions.test.ts): the migration rules.
- [`migrate.db.test.ts`](../../packages/db/test/invariant/migrate.db.test.ts): the runner as a non-superuser, the hardening guard, and the catalog fingerprint that a second run must leave unchanged.
- [`protected-paths.test.ts`](../../tools/test/protected-paths.test.ts) and [`invariant-summary.test.ts`](../../tools/test/invariant-summary.test.ts): what counts as protected, and the job summary.
- [`path-boundary.test.ts`](../../tools/test/path-boundary.test.ts), [`pii-scan.test.ts`](../../tools/test/pii-scan.test.ts) and [`spdx-header.test.ts`](../../tools/test/spdx-header.test.ts): the Docs check steps of section 1.
- [`deploy.test.ts`](../../tools/test/deploy.test.ts): the deploy script's order, its refusal of an image without a digest, and its rollback.

## Consequences

- Good: a pull request cannot loosen the checks that judge it, and a change to the schema or to the security code is held against the base branch's own tests.
- Good: a leak into the public repository is caught over the whole history, not only in the new commit.
- Good: the schema has one history, applied one way, and a deploy fails closed when the hardening guard does.
- Cost: a change to an invariant takes two pull requests, or the owner's merge over a red check.
- Cost: part of the merge bar rests on the author's honesty and the coordinator's acceptance gate, until the reviewer secret (#95) is set and more of it moves into CI.

## Revisit when

- The reviewer secret is set (#95) and "Security review (agent)" becomes required.
- The branch protection and environment settings are described as code, or a check reads them.
- The Cloud preview gate (G4) exists, with the private layer.
- A check enforces pinned actions, as zizmor would, or a check reads the `## Acceptance` section.
