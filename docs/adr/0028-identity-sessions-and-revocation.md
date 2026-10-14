# 0028. Identity: Supabase Auth access tokens, sessions and revocation

- Status: proposed
- Date: 2026-10-14
- Deciders: owner (JOY)
- Builds on: ADR-0027 decision 3 (auth uses Supabase Auth only) and plan Decision 5
- Tracking: issue #22 (implementation), plan Tracking "External-tenant gate" row T1

## Context and problem statement

Crove does not issue its own sessions. The SPA signs in with Supabase Auth (`@supabase/auth-js`, PKCE) and sends the Supabase access token as a Bearer token. The kernel verifies the token, maps `(issuer, subject)` to `user_account` and keeps org membership in Crove (ADR-0027). Self-host runs the bundled Supabase Auth on the same PostgreSQL database as Crove. Crove Cloud points the same code at DOS's Supabase Auth, where Crove has no database access.

What `main` does today (`apps/kernel/src/auth.ts`, `apps/kernel/src/config.ts`):

- Verifies the signature with `jose`: HS256 with `AUTH_JWT_SECRET`, or ES256/RS256 from `AUTH_JWKS_URL`. Verifies the audience (`AUTH_AUDIENCE`, default `authenticated`).
- Checks the issuer only when `AUTH_ISSUER` is set; the setting is optional.
- Checks `exp` only when the token carries it: `jose` validates `exp` when present but does not require it unless told to.
- Requires `sub`, `email` and `role = authenticated`. Ignores `session_id`, `aal` and `is_anonymous`.
- Caches the `(issuer, subject) -> user_account` mapping for 5 minutes. This cache holds no authorization decision.
- Re-checks org membership in `enter_context` on every request. This is correct and stays.
- Has no revocation check. After sign-out, a ban or a deletion, a copied access token keeps working until it expires (the compose stack sets `GOTRUE_JWT_EXP=3600`, one hour).

Supabase Auth facts this ADR relies on (checked against Supabase documentation and the Supabase Auth source on 2026-10-14):

1. The JWT fields reference lists these claims as required, that is present on every access token: `iss`, `aud`, `exp`, `iat`, `sub`, `role`, `aal` (`aal1` single factor, `aal2` multi-factor), `session_id`, `email`, `phone` and `is_anonymous`. `amr`, `app_metadata` and `user_metadata` are optional. The page's authenticated-user example carries `"phone": ""`, so a claim can be present but empty. [1]
2. "There is no way to revoke a user's access token jwt until it expires." Supabase recommends a shorter JWT expiry for that reason. [2]
3. "When a user signs out, the sessions affected by the sign-out are removed from the database entirely." To detect it, "you can check that the `session_id` claim in the JWT corresponds to a row in the `auth.sessions` table. If such a row does not exist, it means that the user has signed out." [3]
4. Access tokens are "usually between 5 minutes and 1 hour". Time-boxed sessions and inactivity timeouts are enforced when a session is next refreshed, not proactively. [3]
5. `getUser()` "performs a network request to the Supabase Auth server", and its result "can be used to base authorization rules on". [4] In the Supabase Auth server, `GET /user` runs the `requireAuthentication` middleware, which loads the user from `sub` and the session from `session_id`, and answers 403 with `user_not_found`, `session_not_found` or `user_banned` when one of them fails. [5] [6]
6. With asymmetric signing keys, "JWT validation is fast and does not involve Auth server". Keys are published at `/auth/v1/.well-known/jwks.json`. HS256 shared secrets are "not recommended for production applications". Components that cache the JWKS may keep trusting a revoked key until their cache expires. [7]
7. "JWTs without an `aal` claim are at the `aal1` level." Unenrolling a factor downgrades `aal2` to `aal1` only after the refresh interval has lapsed. [8]

## Decision drivers

- Fail closed: sign-out, ban or deletion must stop access within a stated time, also for API calls made with a copied token.
- One code path for self-host and Crove Cloud; only configuration differs.
- No Supabase service other than Auth (ADR-0027).
- R3 approvals (financial, legal, irreversible) need a second factor (plan policy P11).
- The check runs on every request, so it must be cheap.

## Considered options for revocation

### (a) Look up the session in Crove's database

Check that `session_id` exists in `auth.sessions` for the token's `sub`, and that the user in `auth.users` is not banned or deleted, inside the request's database transaction.

- Good: exact and immediate; revocation takes effect on the next request.
- Good: no extra network hop; runs in the same transaction as `enter_context`, so nothing changes between check and use.
- Bad: works only when Crove's database hosts that Supabase Auth (self-host with the bundled Auth).
- Bad: couples Crove to two Supabase Auth internal tables. Supabase Auth owns and migrates the `auth` schema (ADR-0027), so an upgrade could change them.
- Bad: needs a narrow read grant on `auth` tables to a Crove definer role.

### (b) Ask the Supabase Auth server, with a short cache

Call `GET {auth}/user` with the token (and the project's public API key, as `@supabase/auth-js` does) and cache a positive answer briefly.

- Good: works against any Supabase Auth, including DOS's Supabase Auth for Crove Cloud, where Crove has no database access.
- Good: reuses Supabase Auth's own checks for session, deletion and ban; no coupling to internal tables.
- Bad: one HTTP call per session per cache window; the revocation delay equals the cache lifetime.
- Bad: if Supabase Auth is down, Crove requests fail once cached entries expire (fail closed).
- Bad: subject to Supabase Auth rate limits, not measured yet (issue #34).

### (c) Short access-token lifetime only

- Good: no per-request check.
- Bad: the revocation delay equals the token lifetime, and Crove Cloud cannot set it (DOS's Supabase Auth owns that setting).
- Bad: more refresh traffic, and access stays open until expiry.

Rejected as the only mechanism.

## Decision

### 1. Token verification on every request

- Verify only with `jose`, never with Hono's JWT middleware. Pin algorithms: ES256/RS256 through JWKS when `AUTH_JWKS_URL` is set, otherwise HS256 with `AUTH_JWT_SECRET`. A deployment accepts one family, never both.
- `AUTH_ISSUER` becomes required: boot fails without it, and the issuer must match exactly. `AUTH_AUDIENCE` stays required (default `authenticated`).
- Required claims: `iss`, `aud`, `exp`, `sub`, `session_id`, and `role = authenticated` (pass `requiredClaims` to `jose` so a token without `exp` fails). Reject `is_anonymous = true`. Clock tolerance at most 30 seconds. A missing `aal` means `aal1`.
- `email` stays required and non-empty, as on `main`: Crove identifies and adds members by email. A Supabase Auth user who signs in with a phone number only (empty `email`) gets 401 until a later ADR supports phone-only accounts.
- JWKS cache: at most 10 minutes. The runbook covers forcing a refresh after a key revocation.

### 2. Revocation, fail closed

Setting `AUTH_SESSION_CHECK` selects the mechanism: `db`, `remote` or `off`. When it is not set, the default is `db` if `AUTH_UPSTREAM_URL` is set (the bundled Supabase Auth on the same database) and `remote` otherwise, so an unset value never means "no check". `off` is accepted only on a local `PUBLIC_URL`; on any other URL boot fails, like the existing `AUTH_AUTOCONFIRM` guard.

| Deployment | Mechanism | Revocation delay |
|---|---|---|
| Self-host with the bundled Supabase Auth on the same database (`AUTH_SESSION_CHECK=db`, default when `AUTH_UPSTREAM_URL` is set) | Option (a) | Next request |
| Crove Cloud, and any deployment whose Supabase Auth runs elsewhere (`AUTH_SESSION_CHECK=remote`) | Option (b) | At most 30 seconds |

Option (a) details:

- A SECURITY DEFINER function, for example `crove_kernel.auth_session_valid(session_id uuid, subject uuid)`, owned by a NOLOGIN role that can only SELECT `auth.sessions` and `auth.users`. It runs in the request transaction, inside `enter_context` or right before it.
- Valid means: the session row exists for that user; its `not_after`, when set, is in the future; the user exists, is not soft-deleted, and `banned_until` is null or past.
- The grant needs a step after Supabase Auth's first start, because `auth.sessions` and `auth.users` do not exist until Supabase Auth has run its own migrations, and in the compose stack `auth` starts only after `migrate` completes. The image gets a one-shot role `auth-grants`: it waits (up to 2 minutes) until both tables exist, grants SELECT on exactly those two tables to `crove_auth_reader`, and exits. Compose runs `migrate`, then `auth`, then `auth-grants` (depends on `auth` started), then `crove` (depends on `auth-grants` completed successfully). It runs on every `docker compose up`, so the grant is re-applied if Supabase Auth ever recreates a table. Installs without compose run `auth-grants` once after Supabase Auth's first start and after each Supabase Auth upgrade.
- Until the grant exists the check fails closed: requests get 503 and `/readyz` reports not ready with reason `auth_grants`.
- Rejected alternative: `ALTER DEFAULT PRIVILEGES FOR ROLE supabase_auth_admin IN SCHEMA auth GRANT SELECT ON TABLES TO crove_auth_reader` in `migrate`. It needs no extra step, but it grants read access to every current and future `auth` table, including refresh tokens, MFA factor secrets and one-time tokens, far more than the check needs.

Option (b) details:

- Cache key: `session_id` plus the SHA-256 of the token. Keep a positive answer for 30 seconds at most, never past the token's `exp`. One request in flight per session (single flight).
- Only a 200 response whose body `id` equals the token's `sub` counts as valid; that is the only answer that is cached.
- Any other 4xx (for example 400 `bad_jwt` or `validation_failed`, 401, 403 `session_not_found`, `user_not_found` or `user_banned`, 404) becomes a Crove 401 and evicts the entry.
- A network error, a timeout, any 5xx or a 429, with no fresh cache entry: answer 503 and deny the request.
- Any other status, or a 200 whose `id` does not match, is treated as invalid (401).

Both mechanisms:

- Always run the check live, skipping the cache, for R3 approvals, membership and role changes, org creation and owner-level settings.
- Option (c) is not used alone. The compose stack keeps `GOTRUE_JWT_EXP=3600` as a backstop.
- SPA logout calls Supabase sign-out, which removes the session row; the next request with the old token fails the check.

### 3. Disabled, banned and deleted users

- A Supabase Auth ban (`banned_until`) or a deleted user is rejected by either mechanism above.
- Crove adds `user_account.disabled_at`, set by an audited staff command and checked in `enter_context` and in org-less calls (`my_orgs`, org creation). It lets a self-hoster block a user in Crove without touching Supabase Auth, and lets Crove Cloud block an account it cannot ban in DOS's Supabase Auth.
- `user_account` rows are never deleted; offboarding removes memberships (plan §7.9).

### 4. Membership on every request

Unchanged and required: `enter_context` reads `tenant_member` (and later `role_assignment`) from the database in the request transaction. No claim and no cache decides membership. The `(issuer, subject) -> user_account` cache may stay because it holds no authorization; the `disabled_at` check runs in SQL.

### 5. Step-up for R3 approvals

- `kernel.proposal.approve` and every R3 command run by a user require `aal = aal2` in the verified token and a live revocation check.
- An optional recency rule (the `amr` entry for the second factor within N minutes) is decided with the approval screen; it is off by default.
- Policy P11 is on by default. An org owner can turn it off for that org; the change is audited. A single-user self-host can do the same.
- The compose stack enables TOTP MFA in Supabase Auth, and the SPA gets enrollment and challenge screens (issue #32).
- Audit rows for R3 commands record `aal` and `session_id`.
- Who may approve is a separate rule (plan §4.6, issue #20): only an `owner`, or a user an owner granted the approval permission.

## Consequences

- Good: sign-out, ban or deletion stops access on the next request in self-host and within 30 seconds on Crove Cloud. R3 needs a second factor. Boot refuses configurations that would fail open.
- Bad: self-host gains a one-shot `auth-grants` step in the startup order (compose: `migrate` -> `auth` -> `auth-grants` -> `crove`); installs without compose must remember to run it.
- Bad: Crove Cloud depends on DOS's Supabase Auth for every request after the cache window. An Auth outage makes Crove Cloud answer 503 (plan §7.10 runbook, §14 risk). Rate limits are measured before the first external tenant (issue #34).
- Bad: self-host reads two Supabase Auth internal tables. Supabase documents this lookup as the way to detect sign-out, the compose stack pins the Supabase Auth image, and the database tests run against that version. A schema change breaks the check closed, not open.
- The earlier plan design for Crove-issued sessions (session JWTs and refresh tokens, a `session` table, OIDC callbacks under `/auth/*`, the `dos-id` and `generic-oidc` adapters, `/.well-known/jwks.json`) is superseded. `user_account` keeps `(issuer, subject)`, so a later identity adapter can replace Supabase Auth.
- Crove Cloud may not accept an external tenant until this ADR is accepted and implemented (plan Tracking, External-tenant gate row T1).

## Tests required

Unit (kernel auth):

- 401 for a token with no `iss` or a wrong one, no `aud` or a wrong one, no `exp`, an expired `exp`, no `sub`, no `session_id`, `role` other than `authenticated`, `is_anonymous = true`, `alg: none`, and an HS256 token when JWKS is configured.
- Boot fails without `AUTH_ISSUER`, and with `AUTH_SESSION_CHECK=off` on a public URL; an unset `AUTH_SESSION_CHECK` resolves to `db` or `remote` as described above.
- A token with an empty `email` (phone-only user): 401.

Database and integration, self-host mode (Supabase Auth image pinned as in compose):

- Fresh install: `docker compose up` on empty volumes; `auth-grants` completes; the first sign-up, sign-in and API call succeed with the `db` check active (not skipped).
- Before `auth-grants` has run: requests get 503 and `/readyz` reports `auth_grants`.
- Sign in and call the API: 200. Sign out. The same token gets 401 on the next request.
- Ban the user in Supabase Auth: 401. Delete the user: 401. Set `user_account.disabled_at`: 401 or 403.
- Remove the membership: the next request in that org gets 403.

Remote mode (contract test against a Supabase Auth container in CI with `AUTH_SESSION_CHECK=remote`):

- After sign-out, the token is rejected within the cache lifetime plus one second; an R3 approval with that token is rejected immediately.
- Supabase Auth unreachable, timing out, or answering 5xx or 429: 503 and no data returned.
- Supabase Auth answering 400, or a 200 for a different user id: 401.

R3 approvals:

- `aal1` token: 403 `STEP_UP_REQUIRED`. `aal2` token: executed, and the audit row records `aal` and `session_id`.
- `member` and `viewer` cannot approve (issue #20).

## References

1. Supabase, JWT claims reference: https://supabase.com/docs/guides/auth/jwt-fields
2. Supabase JavaScript reference, `signOut()`: https://supabase.com/docs/reference/javascript/auth-signout
3. Supabase, User sessions: https://supabase.com/docs/guides/auth/sessions
4. Supabase JavaScript reference, `getUser()`: https://supabase.com/docs/reference/javascript/auth-getuser
5. Supabase Auth source, `requireAuthentication` and `maybeLoadUserOrSession`: https://github.com/supabase/auth/blob/master/internal/api/auth.go (route wiring in `internal/api/api.go`)
6. Supabase, Auth error codes (`session_not_found`, `user_banned`, `user_not_found`, `insufficient_aal`): https://supabase.com/docs/guides/auth/debugging/error-codes
7. Supabase, JWT signing keys: https://supabase.com/docs/guides/auth/signing-keys
8. Supabase, Multi-factor authentication: https://supabase.com/docs/guides/auth/auth-mfa
