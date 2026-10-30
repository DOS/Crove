# 0007. Tenancy and context: how a transaction learns whose data it may touch

- Status: Accepted. It records the design the plan already decided (§4.5, §7.1, §7.2) and what is built on `main` as of 2026-10-30. It decides nothing new.
- Date: 2026-10-30
- Deciders: owner (JOY), through the plan; written down by the Claude Code session for issue #2046
- Builds on: plan §4.5 (context and RLS), §7.1 (roles), §7.2 (RLS template); ADR-0028 (identity, sessions, context tokens, #1822); ADR-0029 (agents and their write allowlist); External-tenant gate rows T8, T10, T11 and T17
- Issue: [#2046](https://github.com/DOS/Ludy/issues/2046)

## Context and problem statement

Every org's data lives in the same PostgreSQL tables. What keeps one org's rows from another is row-level security (RLS) keyed on a context: the org, the actor and the actor's reach, set once per transaction. If the API process could set that context freely, a bug or an injected statement in the API would reach every org. The plan (§4.5) decided how the context is set and protected; this record is the single place an external reviewer (#31) or a contributor reads what holds today, where it is enforced, and which test pins it.

## Decision drivers

- A tenant row is reachable only inside a transaction whose context names its org. No context means no rows.
- The context cannot be forged or edited by the login role that runs application code, even with arbitrary SQL on its connection.
- One transaction carries one context: no switching org or actor half way through.
- The checks run in the database, so a mistake in TypeScript cannot skip them.
- The cost stays far inside the Phase 1 budget (p95 R1 command under 150 ms).

## Decision

### 1. Roles

Login roles own nothing. The migration runner owns every table and most definers; a definer may be handed only to `crove_definer_tenant` or `crove_auth_reader`, which the migration lint enforces ([`tools/ci/migration-lint.mjs`](../../tools/ci/migration-lint.mjs)). The kernel checks at boot that its login role owns no table and that RLS applies to it ([`assertRlsEnforced`](../../packages/db/src/index.ts#L193)).

| Role | Login | What it is for |
|---|---|---|
| `crove_app` | yes | The API. Member of `crove_tenant`. Enters user contexts only. |
| `crove_worker` | yes | Jobs. Member of `crove_tenant`. Enters system and agent contexts only. |
| `crove_prober` | yes, NOINHERIT | The health prober: a few count-only definers, no table ([`health_prober`](../../supabase/migrations/20261015234500_crove_kernel_health_prober.sql)). |
| `crove_reporter` | yes | The weekly usage report: count-only definers ([`usage_weekly`](../../supabase/migrations/20261019020000_crove_kernel_usage_weekly.sql)). |
| `crove_tenant` | no | Holds the table grants, filtered by the tenant policies. |
| `crove_definer_tenant` | no | Owns definers that must run under RLS ([`definer_tenant`](../../supabase/migrations/20261014090000_crove_kernel_definer_tenant.sql)). |
| `crove_auth_reader` | no | Owns the definers that read Supabase Auth's tables ([`auth_sessions`](../../supabase/migrations/20261015090000_crove_kernel_auth_sessions.sql)). |

The roles are created by the migrations ([`bootstrap`](../../supabase/migrations/20261013120000_crove_kernel_bootstrap.sql)). The plan's `crove_api`, `crove_ctx` and per-module `crove_m_*` roles were not built: the API's role is `crove_app`, the definers belong to the runner, and module tables share `crove_tenant` (ADR-0029's write allowlist limits agents per table instead).

### 2. Entering a context

A transaction gets its context from exactly one entry function, called first. Which login role may call which is the EXECUTE matrix ([`system_context_worker`](../../supabase/migrations/20261014130000_crove_kernel_system_context_worker.sql)), and the worker's entries also check `session_user` inside the function.

| Entry | Caller | Checks | Newest definition |
|---|---|---|---|
| `enter_context(user, org)` | `crove_app` | re-entry guard; the purge fence of an org being offboarded; membership of an `active` org (an `offboarding` org admits its owners only), else `NOT_A_MEMBER`; derives the role and the legal-entity scope | [`roles`](../../supabase/migrations/20261101060000_crove_kernel_roles.sql#L254) |
| `enter_user_context(org, token)` | `crove_app` | a context token the kernel signed (HMAC, 60 s, this org, session not revoked), then `enter_context` | [`context_token`](../../supabase/migrations/20261104230000_crove_kernel_context_token.sql#L137) |
| `enter_system_context(org)` | `crove_worker` | re-entry guard; `session_user` is the worker, else `SYSTEM_CONTEXT_WORKER_ONLY`; the purge fence; org `active` or `offboarding`, else `TENANT_NOT_ACTIVE` | [`org_purge`](../../supabase/migrations/20261028130000_crove_kernel_org_purge.sql#L475) |
| `enter_agent_context(org, agent, run)` | `crove_worker` | the worker's `session_user`; an active org, agent and position; a live run; the template's role; the org's and the global kill switches; the hard budget stop | [`global_kill_switch`](../../supabase/migrations/20261023130000_crove_kernel_global_kill_switch.sql#L52) |

The session itself (revoked, disabled user, MFA required) is checked by the runtime right before entering, in the same transaction, through `crove_kernel.session_check` ([`Runtime.checkSession`](../../packages/kernel-runtime/src/runtime.ts#L1360); ADR-0028). With a context token key configured, the API enters through `enter_user_context`, so the database itself refuses a revoked session (ADR-0028 section 9).

### 3. One context per transaction (T10)

PostgreSQL advisory locks are re-entrant, so a lock alone does not stop a second entry. [`context_reentry_guard()`](../../supabase/migrations/20261015170000_crove_kernel_sealed_context.sql#L208), the first step of every entry, refuses with `CONTEXT_REENTRY` when this backend already holds the transaction-level context lock (read from `pg_locks`), or when any context setting is already set, valid or not. It then takes the lock with `pg_try_advisory_xact_lock`, keyed by the backend pid, so sessions never wait on each other. A transaction-level advisory lock has no unlock call and works in READ ONLY transactions and on a standby. Plan §4.5 item 1 explains why no cheaper marker holds, and the cost measured in #105 and #1010 (about 75 µs per entry at 230 held locks, against a command p95 of 15.8 ms).

### 4. The sealed context (T11)

The entry writes the whole derived context as JSON to the transaction-local setting `crove.ctx`:

- user: `{v: 1, org, actor: 'user', user, role, le_scope, flags: []}`;
- system: the same with no user or role and `le_scope` `['*']`;
- agent: adds `agent`, `run`, `position`, `module`, `max_risk` and `tainted`.

`le_scope` is `'*'` for owners and admins, and for members and viewers who hold no role assignment or an org-wide one; otherwise it is the sorted list of the legal entities of their assignments, read in the entering transaction ([`roles`](../../supabase/migrations/20261101060000_crove_kernel_roles.sql#L246)). An agent's scope is its position's. A missing scope denies.

`crove.ctx_seal` holds HMAC-SHA256 over `'crove.ctx.v1'`, the backend pid, the transaction start in microseconds and the exact text of `crove.ctx` ([`ctx_mac`](../../supabase/migrations/20261015170000_crove_kernel_sealed_context.sql#L105)), built from the core `sha256()` so the schema runs on any PostgreSQL 17. The key is 32 random bytes in `crove_kernel.context_key`, owned by the runner, with RLS on, no policy and no grant to any role. No role may execute `ctx_mac` or `ctx_write`; they run only inside the entry functions, as their owner. The key rotates with `context_key_rotate()` ([runbook](../runbooks/context-key-rotation.md)).

Every policy and every context-dependent definer reads the context through [`ctx_verified()`](../../supabase/migrations/20261015170000_crove_kernel_sealed_context.sql#L142) and the helpers on top of it: `ctx_org_id`, `ctx_user_id`, `ctx_actor_type`, `ctx_le_scope`, `ctx_le_allowed`, `ctx_has_flag`, `ctx_has_permission`, `ctx_permission_entities`, and for agents `ctx_agent_id`, `ctx_run_id`, `ctx_position_id` and `ctx_run_tainted`. No context at all gives NULL: 0 rows, a failing `WITH CHECK`, and `NO_CONTEXT` from definers. A context or seal that is present but does not verify (edited with `set_config`, replayed from another transaction or connection, half reset) raises `CONTEXT_SEAL_INVALID`, so the statement fails loudly. The result is not cached, because a cache would itself be a writable setting. Not every definer needs a context: the entry functions write it, and `session_check` and `identity_resolve` check a verified identity and its session from their arguments, before a context exists ([`session_check_oauth_sessions`](../../supabase/migrations/20261018180000_crove_kernel_session_check_oauth_sessions.sql#L112)).

### 5. Row-level security (T8)

Every tenant table has `org_id` and `PRIMARY KEY (org_id, id)`, and foreign keys between tenant tables lead with `org_id`. [`apply_tenant_rls(table, append_only)`](../../supabase/migrations/20261019010000_crove_kernel_agent_write_allowlist.sql#L152) enables RLS, creates the policy `tenant_isolation` for `crove_tenant` with `org_id = (SELECT crove_kernel.ctx_org_id())` in both USING and WITH CHECK, grants SELECT and INSERT (append-only tables) or full CRUD to `crove_tenant` only, and installs the agent write guard. Tables of a legal entity add a RESTRICTIVE policy on `ctx_le_scope()` (for example [`legal_entity`](../../supabase/migrations/20261030001000_crove_kernel_legal_entity.sql)). The helpers are called as `(SELECT ...)`, so they run once per statement.

### 6. Functions and connections (T17)

Every function in a `crove_*` schema sets exactly `search_path = pg_catalog, pg_temp`, calls are schema-qualified, and no Crove role or member of one can create temporary objects. The migration runner checks this after every run and has no bypass (`hardeningViolations` in [`migrate.ts`](../../packages/db/src/migrate.ts)).

The runtime opens every transaction itself (`execute`, `executeOrgless`, and `query` as READ ONLY) and refuses transaction control inside handlers. Before a connection goes back to the pool it runs [`SESSION_RESET_SQL`](../../packages/db/src/index.ts#L49) (`CLOSE ALL; RESET ALL; RESET ROLE; UNLISTEN *` and `pg_advisory_unlock_all()`), and a connection that hit `CONTEXT_REENTRY` or `CONTEXT_SEAL_INVALID`, or came back inside a transaction, is destroyed instead (#117). Behind a transaction-mode pooler the reset protects only the direct connections. The plan's lint rule against `set_config`, `SET` and `sql.raw` outside a context package was not built: the database checks above are what hold.

## What is not covered

- **`crove_app` may still name another member.** The seal stops forged settings, not a call to `enter_context` with another existing member of the org: the API's login is trusted to name the user it authenticated. Context tokens (#1822 step 1) let the database check that the kernel signed the pair. Step 2 revokes `enter_context` from `crove_app` once the key is installed in production. Until then raw SQL on `crove_app` can act as any member (ADR-0028 section 9).
- **Within a token's 60 seconds,** the session, `aal` and MFA time it carries are not in the sealed context, so the database does not check fresh MFA for R3 itself (the kernel does), accepts a session it has not seen yet, and lets a token be reused.
- **Access is checked when entering, not on every call.** A membership or assignment change applies from the next transaction.
- **Seal residuals:** replay needs two transactions of one backend starting in the same microsecond; `ROLLBACK TO SAVEPOINT` may restore a context derived earlier in the same transaction (one `enter_context` already checked); the superuser, the database owner and a dump can read the key, as they can bypass RLS anyway.
- **No staff actor yet.** Operators have no context of their own; ADR-0038 (proposed, #1950) designs one.

## Evidence

The invariant suite runs these from the base branch on every protected-path PR:

- [`context.db.test.ts`](../../apps/kernel/test/invariant/context.db.test.ts): the re-entry guard, with savepoints, READ ONLY and the system context (T10).
- [`sealed-context.db.test.ts`](../../apps/kernel/test/invariant/sealed-context.db.test.ts): forgery, replay, the key out of every role's reach, the pool reset and key rotation (T11).
- [`context-token.db.test.ts`](../../apps/kernel/test/invariant/context-token.db.test.ts): forged, expired, other-org and revoked-session tokens (#1822).
- [`rls-matrix.db.test.ts`](../../apps/kernel/test/invariant/rls-matrix.db.test.ts): cross-org and legal-entity cases generated for every tenant table (T8).
- [`roles.db.test.ts`](../../apps/kernel/test/invariant/roles.db.test.ts): assignments drive `le_scope`, and a revoke never widens it.
- [`kernel-invariants.db.test.ts`](../../apps/kernel/test/invariant/kernel-invariants.db.test.ts): non-members refused, no rows without a context, no TEMP, and the worker-only system context in the EXECUTE matrix.
- [`agents.db.test.ts`](../../apps/kernel/test/invariant/agents.db.test.ts): the agent context (T18).
- [`conformance.db.test.ts`](../../packages/db/test/invariant/conformance.db.test.ts) and [`migrate.db.test.ts`](../../packages/db/test/invariant/migrate.db.test.ts): the tenant table conventions, the pinned `search_path` and no TEMP (T17).

## Consequences

- Good: a bug in TypeScript, or SQL injected into the API's connection, still cannot read another org or forge a context; it can at most act as a member of an org the API names, which step 2 of #1822 closes.
- Good: every guarantee has a test in the invariant suite, which a PR cannot loosen in the same change.
- Cost: every policy pays one seal check per statement (two `sha256()` calls and a one-row lookup), and every entry one read of `pg_locks`.
- A new tenant table must call `apply_tenant_rls`, and a new entry point must start with the guard and write through `ctx_write`; the RLS matrix and the conformance test fail otherwise.

## Revisit when

- Step 2 of #1822 lands: update the first residual.
- A staff actor is built (ADR-0038).
- The load test shows the `pg_locks` read as a bottleneck (plan §4.5 item 1 lists the options, an owner decision).
