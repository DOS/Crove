# 0028. Identity: Supabase Auth access tokens, sessions and revocation

- Status: accepted (2026-10-14, owner), with conditions: the acceptance tests below must pass before External-tenant gate T1 is green
- Date: 2026-10-14
- Deciders: owner (JOY), after two blind reviews (Codex and Claude) that independently converged on design C
- Builds on: ADR-0027 decision 3 (auth uses Supabase Auth only) and plan Decision 5
- Tracking: issue #22 (implementation), plan Tracking Decision 16 and "External-tenant gate" row T1

## Context and problem statement

Crove does not issue its own sessions. The SPA signs in with Supabase Auth (`@supabase/auth-js`, PKCE) and sends the Supabase access token as a Bearer token. The kernel verifies the token, maps `(issuer, subject)` to `user_account` and keeps org membership in Crove (ADR-0027). Self-host runs the bundled Supabase Auth on the same PostgreSQL database as Crove. Crove Cloud points the same code at DOS's Supabase Auth, where Crove has no database access.

What `main` does today (`apps/kernel/src/auth.ts`, `apps/kernel/src/config.ts`):

- Verifies the signature with `jose`: HS256 with `AUTH_JWT_SECRET`, or ES256/RS256 from `AUTH_JWKS_URL`. Verifies the audience (`AUTH_AUDIENCE`, default `authenticated`).
- Checks the issuer only when `AUTH_ISSUER` is set; the setting is optional.
- Checks `exp` only when the token carries it: `jose` validates `exp` when present but does not require it unless told to.
- Requires `sub`, `email` and `role = authenticated`. Since #71 it reads `aal` (missing or unknown counts as `aal1`) and carries it on the user actor, but nothing enforces it yet. Ignores `session_id`, `amr` and `is_anonymous`.
- Caches the `(issuer, subject) -> user_account` mapping for 5 minutes. This cache holds no authorization decision.
- Re-checks org membership in `enter_context` on every request. This is correct and stays.
- Has no revocation check. After sign-out, a ban or a deletion, a copied access token keeps working until it expires (the compose stack sets `GOTRUE_JWT_EXP=3600`, one hour).

Supabase Auth facts this ADR relies on (checked against Supabase documentation and the Supabase Auth source on 2026-10-14):

1. The JWT fields reference lists these claims as required, that is present on every access token: `iss`, `aud`, `exp`, `iat`, `sub`, `role`, `aal` (`aal1` single factor, `aal2` multi-factor), `session_id` ("Unique session identifier"), `email`, `phone` and `is_anonymous`. `amr`, `app_metadata` and `user_metadata` are optional. `amr` is a list of objects with a `method` and a `timestamp`, for example `[{"method": "password", "timestamp": 1640991600}]`. The authenticated-user example carries `"phone": ""`, so a claim can be present but empty. [1]
2. "There is no way to revoke a user's access token jwt until it expires." Supabase recommends a shorter JWT expiry for that reason. [2] On sign-out, "all refresh tokens and potentially other database objects related to the affected sessions are destroyed", and "Access Tokens of revoked sessions remain valid until their expiry time". Sign-out has three scopes: `global` (all sessions of the user), `local` (the current session) and `others`. [9]
3. "When a user signs out, the sessions affected by the sign-out are removed from the database entirely." To detect it, "you can check that the `session_id` claim in the JWT corresponds to a row in the `auth.sessions` table. If such a row does not exist, it means that the user has signed out." [3]
4. Access tokens are "usually between 5 minutes and 1 hour"; "most applications should use the default expiration time of 1 hour", and values below 5 minutes should not be used in most situations. Time-boxed sessions and inactivity timeouts are enforced when a session is next refreshed, not proactively. [3]
5. `getUser()` "performs a network request to the Supabase Auth server", and its result "can be used to base authorization rules on". [4] In the Supabase Auth server, `GET /user` runs the `requireAuthentication` middleware, which loads the user from `sub` and the session from `session_id`, and answers 403 with `user_not_found`, `session_not_found` or `user_banned` when one of them fails. [5] [6]
6. With asymmetric signing keys, "JWT validation is fast and does not involve Auth server". Keys are published at `/auth/v1/.well-known/jwks.json`. HS256 shared secrets are "not recommended for production applications". Components that cache the JWKS may keep trusting a revoked key until their cache expires. [7]
7. "JWTs without an `aal` claim are at the `aal1` level." The `amr` entries "are ordered most recent method first", and an application can "compare the `method` and `timestamp` to enforce stricter rules". Unenrolling a factor downgrades `aal2` to `aal1` only after the refresh interval has lapsed. [8]
8. The admin sign-out (`auth.admin.signOut(jwt, scope)`) takes the target session's access token ("A valid, logged-in JWT"), not a user id or a session id. [10]
9. Supabase Auth has six auth hooks: Before User Created, Custom Access Token, Send SMS, Send Email, MFA Verification Attempt and Password Verification Attempt. None fires on sign-out or session revocation. [11]
10. A refresh keeps the session: `RefreshTokenGrant` loads the session from the refresh token and issues the new access token with `SessionID: &session.ID`, so every token a session ever issues carries the same `session_id`. [12]

## Decision drivers

- Fail closed: sign-out, ban, deletion, removal from the org and an owner's "revoke session" must stop access within a stated time, also for API calls made with a copied token, and also when an event is lost.
- Crove Cloud must not depend on Supabase Auth for every request: an Auth outage must not log everyone out, and the per-request load on Auth must not grow with traffic.
- One code path for self-host and Crove Cloud; only the status adapter and configuration differ.
- No Supabase service other than Auth (ADR-0027). No Crove database access to DOS (plan principle 15).
- R3 actions (posting, legal or money actions, membership and role changes) need a fresh second factor (plan policy P11).
- The per-request check must be cheap: a local signature check plus indexed reads in the request transaction.

## Considered options

### Option A: check the session with Supabase Auth on every request (rejected)

The design proposed earlier on 2026-10-14. Self-host looks up `auth.sessions` in the request transaction; Crove Cloud calls `GET /auth/v1/user` with the token and caches a positive answer for at most 30 seconds.

- Good: reuses Supabase Auth's own checks for session, deletion and ban; revocation delay at most 30 s on Cloud.
- Bad: Crove Cloud depends on Auth for every request once the cache window passes. The reviews estimated about 1,700 Auth calls per second at 5,000 tenants, subject to Supabase Auth rate limits that are not measured (issue #34).
- Bad: when Auth is down, every Cloud user is logged out after 30 s (fail closed turns an Auth incident into a full Crove outage).
- Rejected for Crove Cloud. Its self-host half (reading `auth.sessions` in the request transaction) is kept in design C.

### Option B: short-lived access tokens only (rejected)

Set the access token lifetime to a few minutes and add no per-request check.

- Good: no per-request check, no coupling to Auth internals.
- Bad: up to the token lifetime of reads after revocation (about 10 minutes with the settings discussed), and Crove Cloud cannot set the lifetime (DOS's Supabase Auth owns it). Supabase advises against very short lifetimes [3].
- Rejected as a revocation mechanism. A shorter lifetime stays as defense in depth (Decision 7).

### Pure push (rejected alone)

DOS ID pushes sign-out, revocation, ban and deletion events to Crove, and Crove trusts a session until an event says otherwise.

- Good: no per-request call to Auth; revocation in seconds when events flow.
- Bad: a lost or delayed event keeps access open indefinitely; nothing bounds the delay. Supabase Auth has no sign-out hook [11], so the events come from DOS-side code that can fail silently.
- Rejected alone. Design C keeps push for speed and adds checkpoints and an evidence age limit so a lost event cannot keep access open past 60 s.

### Crove-owned sessions through token exchange (rejected)

Exchange the Supabase token once for a Crove session (cookie or Crove-signed token) that Crove can revoke directly.

- Good: revocation fully under Crove's control.
- Bad: Crove issues sessions again (the superseded design): cookies, CSRF protection, refresh and key management in Crove.
- Bad: still needs sign-out in Supabase Auth to propagate to Crove sessions, so it needs the same upstream sync as design C.
- Rejected.

### Design C: local verification plus a Crove session status record, with one status interface and two adapters (chosen)

Described in Decision below. Self-host gets exact, next-request revocation from the shared database; Crove Cloud gets push-speed revocation with a hard 60 s bound and no per-request Auth call.

## Decision

### 1. Token verification on every request

- Verify only with `jose`, never with Hono's JWT middleware. Pin algorithms: ES256/RS256 through JWKS when `AUTH_JWKS_URL` is set, otherwise HS256 with `AUTH_JWT_SECRET`. A deployment accepts one family, never both.
- `AUTH_ISSUER` becomes required: boot fails without it, and the issuer must match exactly. `AUTH_AUDIENCE` stays required (default `authenticated`).
- Required claims: `iss`, `aud`, `exp`, `sub`, `session_id`, and `role = authenticated` (pass `requiredClaims` to `jose` so a token without `exp` fails). Reject `is_anonymous = true`. Clock tolerance at most 30 seconds. A missing `aal` means `aal1`.
- `email` stays required and non-empty, as on `main`: Crove identifies and adds members by email. A Supabase Auth user who signs in with a phone number only (empty `email`) gets 401 until a later ADR supports phone-only accounts.
- JWKS cache: at most 10 minutes. The runbook covers forcing a refresh after a key revocation.
- Verification is local: no call to Supabase Auth on the request path, except the first-seen check of a new session on Crove Cloud (section 3) and R3 (section 5).

### 2. Session status record and membership, in the request transaction

Every request, after the token verifies, runs one check inside the same transaction as `enter_context`, so nothing changes between check and use:

- **Crove session record.** `crove_kernel.auth_session`, keyed by `(user_id, session_id)`: `status` (`active` or `revoked`), `first_seen_at`, `revoked_at`, `revoked_by`, `reason`, and on Crove Cloud `evidence_at` (the time of the newest proof that the session was valid). A `revoked` row rejects the request. Crove never deletes a revoked row while a token from that session could still be valid or refreshed; because a refresh keeps the `session_id` [12], a revoked row keeps rejecting every token that session issues, refreshed or not. `last_seen_at` is updated at most once a minute, never on every request.
- **Upstream status** through the `SessionStatusSource` interface (section 3): is the session still alive in Supabase Auth, and is the user neither banned nor deleted.
- **Crove user state.** `user_account.disabled_at` (section 4).
- **Membership.** `enter_context` reads `tenant_member` (and later `role_assignment`) as today. No claim and no cache decides membership; removal takes effect on the next request.

The `(issuer, subject) -> user_account` cache may stay because it holds no authorization; every check above runs in SQL in the request transaction.

### 3. Status source: one interface, two adapters

Setting `AUTH_SESSION_CHECK` selects the adapter: `db`, `events` or `off`. When it is not set, the default is `db` if `AUTH_UPSTREAM_URL` is set (the bundled Supabase Auth on the same database) and `events` otherwise, so an unset value never means "no check". `off` is accepted only on a local `PUBLIC_URL`; on any other URL boot fails, like the existing `AUTH_AUTOCONFIRM` guard.

| Deployment | Adapter | Revocation delay |
|---|---|---|
| Self-host with the bundled Supabase Auth on the same database (`AUTH_SESSION_CHECK=db`) | Direct read of `auth.sessions` and `auth.users` | Next request |
| Crove Cloud on DOS's Supabase Auth (`AUTH_SESSION_CHECK=events`) | Lifecycle events from DOS ID plus checkpoints, with an evidence age limit | Target under 5 s; design bound 60 s, also when events are lost |

**Self-host adapter (`db`).**

- A SECURITY DEFINER function, `crove_kernel.auth_session_valid(session_id uuid, subject uuid)`, owned by the NOLOGIN role `crove_auth_reader`, which can only SELECT `auth.sessions` and `auth.users`. It runs in the request transaction, inside `enter_context` or right before it.
- Valid means: the session row exists for that user; its `not_after`, when set, is in the future; the user exists, is not soft-deleted, and `banned_until` is null or past.
- The grant needs a step after Supabase Auth's first start, because `auth.sessions` and `auth.users` do not exist until Supabase Auth has run its own migrations, and in the compose stack `auth` starts only after `migrate` completes. The image gets a one-shot role `auth-grants`: it waits (up to 2 minutes) until both tables exist, grants SELECT on exactly those two tables to `crove_auth_reader`, and exits. It connects with the admin database URL (`ADMIN_DATABASE_URL`, as `migrate` does), because only the owner of the `auth` tables (`supabase_auth_admin`) or a superuser can grant on them. Compose runs `migrate`, then `auth`, then `auth-grants` (depends on `auth` started), then `crove` (depends on `auth-grants` completed successfully). It runs on every `docker compose up`, so the grant is re-applied if Supabase Auth ever recreates a table. Installs without compose run `auth-grants` once after Supabase Auth's first start and after each Supabase Auth upgrade.
- Until the grant exists the check fails closed: requests get 503 and `/readyz` reports not ready with reason `auth_grants`.
- Rejected alternative: `ALTER DEFAULT PRIVILEGES FOR ROLE supabase_auth_admin IN SCHEMA auth GRANT SELECT ON TABLES TO crove_auth_reader` in `migrate`. It needs no extra step, but it grants read access to every current and future `auth` table, including refresh tokens, MFA factor secrets and one-time tokens, far more than the check needs.

**Crove Cloud adapter (`events`).**

- **Events.** DOS ID pushes session and user lifecycle events for Crove: `session.signed_out` (with scope), `session.revoked`, `user.banned`, `user.deleted`. Supabase Auth has no sign-out hook [11], so DOS ID derives them on its side. Delivery uses a durable outbox with an HMAC signature (a Crove-specific, rotatable secret), a global sequence number, `event_id`, `occurred_at`, and retries with backoff. This extends the planned DOS-27 org and member events (plan §11, item DOS-28). It is a DOS-side change: a cross-repo PR that needs owner approval.
- **Apply.** Crove verifies signature and timestamp (±5 minutes), dedupes in `idp_event`, and applies events in sequence order: a revoked or signed-out session gets `status = revoked`; a banned or deleted user gets every session revoked and `user_account.upstream_blocked_at` set. A gap in the sequence is not skipped: Crove fetches the missing range (replay or the batch status endpoint) before it applies later events.
- **Checkpoints.** DOS ID sends a signed checkpoint at least every 15 seconds: "every event up to sequence N has been delivered", with its issue time. When Crove has applied every event up to N, the checkpoint time becomes the evidence time for all sessions not revoked. Equivalent alternative, chosen in the implementation PR: a batch status endpoint that returns the status of a list of session ids.
- **Evidence age limit.** A session's evidence is the newer of its own `evidence_at` and the last applied checkpoint. Crove blocks reads and writes for a session whose evidence is older than 60 s (503, `AUTH_STATUS_STALE`). So a lost event can keep a revoked session alive for at most 60 s: either the checkpoint certifies a sequence that includes the event (and Crove must have it) or the checkpoint stops advancing and evidence goes stale.
- **Fallback.** When the checkpoint is late, Crove refreshes a session's evidence with one `getUser` call for that session (at most one call per session per 60 s, single flight, rate-limited). If the fallback cannot keep up or Auth does not answer, requests for that session fail closed.
- **First-seen check.** A `session_id` Crove has not seen before is verified once against Auth with `getUser` [4] before the request proceeds. Only a 200 whose body `id` equals the token's `sub` creates the `active` record (with `evidence_at` = now). Any other 4xx is 401; a network error, timeout, 5xx or 429 is 503.
- A deployment with a remote Supabase Auth and no event producer runs the `events` adapter on the fallback alone: one `getUser` per active session per 60 s. That suits small installs, not Crove Cloud's scale.

### 4. Revoke session or device, disabled, banned and deleted users

- **Owner or admin revoke.** Crove adds commands, through `execute()` and audited: revoke one session or device of a member, and "revoke all sessions" of a user (the user themself, an org owner for a member of their org, or staff). The command sets the record to `revoked` in its transaction, so the next request with any token of that session is rejected (immediate, in both adapters).
- **Upstream sign-out.** The command then asks Supabase Auth to sign the session out, which destroys its refresh tokens [9]. The admin sign-out takes the target session's access token, not an id [10], so the `SessionRevoker` interface has per-deployment adapters: self-host signs a 60-second token for that `sub` and `session_id` with the deployment's JWT signing key and calls the admin sign-out (scope `local`, or `global` for "revoke all"); Crove Cloud asks DOS ID to run the sign-out (part of the DOS-side change, §11 of the plan). A self-host with asymmetric keys whose signing key the kernel does not hold keeps Crove-side revocation only. Correctness does not depend on this call: the revoked record already blocks the session in Crove. A failed call is retried and alerted.
- A Supabase Auth ban (`banned_until`) or a deleted user is rejected: in self-host by the `db` adapter on the next request, on Crove Cloud by the `user.banned` and `user.deleted` events, bounded by the 60 s evidence limit.
- `user_account.disabled_at`, set by an audited staff command, is checked in `enter_context` and in org-less calls (`my_orgs`, org creation). It lets a self-hoster block a user in Crove without touching Supabase Auth, and lets Crove Cloud block an account it cannot ban in DOS's Supabase Auth.
- `user_account` rows are never deleted; offboarding removes memberships (plan §7.9).

### 5. R3: direct Auth check, `aal2` and fresh MFA

R3 covers posting, legal or money actions, membership and role changes (plan §4.7). For every R3 command run by a user:

- A direct check against Supabase Auth at execution time (`getUser` with the token), on top of the per-request check. Answers map as in the first-seen check; no cache.
- `aal = aal2` in the verified token, and an `amr` entry for a second factor (`totp`, `phone` or WebAuthn) whose `timestamp` is within the last 5 minutes [1] [8]. Otherwise 403 `STEP_UP_REQUIRED`: the SPA runs an MFA challenge and retries with the new token.
- R3 work that a job executes later (for example an approved proposal) re-checks before executing that the approver's session record is still `active`, that the approver is still a member holding the approval permission, and that the approval was recorded with `aal2` and fresh MFA. Otherwise the job stops and raises an Inbox item.
- Policy P11 is on by default. An org owner can turn it off for that org; the change is audited. A single-user self-host can do the same.
- The compose stack enables TOTP MFA in Supabase Auth, and the SPA gets enrollment and challenge screens (issue #32). Passkeys (WebAuthn) are preferred where Supabase Auth supports them.
- Audit rows for R3 commands record `aal`, `session_id` and the MFA timestamp used.
- Who may approve is a separate rule (plan §4.6): today `owner` and `admin`, the roles that may post (#71); once role assignments exist, the holders of the approval permission, with four-eyes and the approver-permission check (P10, P12, issue #75).

### 6. When Supabase Auth is down

- No new logins and no token refresh (Supabase Auth serves them). No R3: the direct check fails closed (503).
- New sessions cannot pass the first-seen check (Crove Cloud): 503.
- Existing sessions with fresh evidence keep working. Self-host: as long as the database is up, because the `db` adapter reads the shared database, not Auth. Crove Cloud: while events and checkpoints from DOS ID keep the evidence under 60 s; if they also stop and the `getUser` fallback fails, requests fail closed once evidence is older than 60 s.
- Alerts: Auth error rate, checkpoint lag over 30 s, fallback call rate, `AUTH_STATUS_STALE` responses. Runbook in plan §7.10.

### 7. Access token lifetime

Choice: the self-host compose stack sets `GOTRUE_JWT_EXP=900` (15 minutes) as defense in depth, inside the 5 minutes to 1 hour range Supabase recommends [3]. Revocation does not rely on it. Crove Cloud uses whatever DOS's Supabase Auth sets (Crove cannot change it); 15 minutes is recommended to DOS but not required.

### 8. Error mapping

| Condition | Answer |
|---|---|
| Missing or invalid token, wrong `iss` or `aud`, missing `exp`, `sub` or `session_id`, expired, anonymous, wrong algorithm, empty `email` | 401 |
| Crove session record `revoked`; self-host session row missing or past `not_after`; user banned or deleted upstream | 401 |
| First-seen or R3 `getUser`: any 4xx, or a 200 for a different user id | 401 |
| `user_account.disabled_at` set | 403 |
| Not a member of the org | 403 |
| R3 without `aal2` or without an MFA timestamp in the last 5 minutes | 403 `STEP_UP_REQUIRED` |
| Self-host before `auth-grants` has run | 503, `/readyz` reason `auth_grants` |
| Crove Cloud evidence older than 60 s and the fallback unavailable | 503 `AUTH_STATUS_STALE` |
| `getUser` network error, timeout, 5xx or 429 (first-seen, fallback or R3) | 503 |

## Consequences

- Good: self-host revokes on the next request with no Auth call on the request path; Crove Cloud revokes within seconds when events flow and within 60 s when they do not, with no per-request Auth call; an owner's revoke is immediate in both. An Auth outage no longer logs out every Cloud user at once.
- Good: R3 needs a fresh second factor and a direct Auth check, so a token that is valid but stale cannot approve money or role changes.
- Bad: self-host gains a one-shot `auth-grants` step in the startup order (compose: `migrate` -> `auth` -> `auth-grants` -> `crove`); installs without compose must remember to run it.
- Bad: Crove Cloud depends on a DOS-side event producer (session and user lifecycle events with checkpoints, extending DOS-27) that does not exist yet. Until it ships, Crove Cloud cannot accept an external tenant (gate T1).
- Bad: one more kernel table (`auth_session`) and an event consumer in Crove Cloud.
- The earlier plan design for Crove-issued sessions (session JWTs and refresh tokens, a Crove `session` table, OIDC callbacks under `/auth/*`, the `dos-id` and `generic-oidc` adapters, `/.well-known/jwks.json`) stays superseded. `auth_session` records status only; Crove issues no tokens. `user_account` keeps `(issuer, subject)`, so a later identity adapter can replace Supabase Auth.

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| `auth.sessions` and `auth.users` are internal Supabase Auth (GoTrue) tables that Supabase Auth migrates | Supabase documents the `auth.sessions` lookup [3]; compose pins the Supabase Auth image version; a CI contract test runs the `db` adapter against that version (sign-out, `not_after`, ban, delete); a schema change breaks the check closed, not open |
| The DOS-side event producer is late, loses events or stops | SLO for event delivery and checkpoint lag; HMAC and sequence numbers; gaps fetched before later events apply; per-session `getUser` fallback when the checkpoint is late; fail closed after 60 s without evidence |
| A stolen phone that holds the TOTP app (attacker has the second factor) | Prefer passkeys; password re-entry for R3 (decided with the approval screen); owner "revoke all sessions" for the user; R3 audit shows `session_id` and device |
| A read, export or download path skips the check | Every surface (API, SPA data calls, exports, file downloads, SSE later) goes through the same middleware and `enter_context`; a test enumerates routes and fails on any route without it |
| The `getUser` fallback floods Auth during a DOS-side outage | Single flight, at most one call per session per 60 s, global rate limit; beyond it, fail closed and alert |
| A JWKS cache trusts a revoked signing key | JWKS cache at most 10 minutes; runbook to force a refresh |

## Acceptance tests (conditions before gate T1 is green)

Unit (kernel auth):

- 401 for a token with no `iss` or a wrong one, no `aud` or a wrong one, no `exp`, an expired `exp`, no `sub`, no `session_id`, `role` other than `authenticated`, `is_anonymous = true`, `alg: none`, and an HS256 token when JWKS is configured.
- Boot fails without `AUTH_ISSUER`, and with `AUTH_SESSION_CHECK=off` on a public URL; an unset `AUTH_SESSION_CHECK` resolves to `db` or `events` as described above.
- A token with an empty `email` (phone-only user): 401.

Self-host (`db` adapter, Supabase Auth image pinned as in compose):

- Fresh install: `docker compose up` on empty volumes; `auth-grants` completes; the first sign-up, sign-in and API call succeed with the `db` check active (not skipped). Before `auth-grants` has run: requests get 503 and `/readyz` reports `auth_grants`.
- Old JWT after sign-out: sign in, call the API (200), sign out; the same token gets 401 on the next request.
- Banned user: ban in Supabase Auth, next request 401. Deleted user: 401. `user_account.disabled_at` set: 403.

Crove Cloud (`events` adapter, contract test against a Supabase Auth container and a test event producer in CI):

- Old JWT after sign-out with events delivered: rejected within 5 s.
- Old JWT after sign-out with the event dropped: rejected within 60 s (checkpoint gap or stale evidence), never later.
- Banned and deleted users: rejected within 5 s with events, within 60 s with events dropped.
- New session: verified once with `getUser`; a 400 or a 200 for another user id gives 401.

Both adapters:

- Owner revoke is immediate: after an owner revokes a member's session, the next request with that token, and with a token refreshed from that session, gets 401; the upstream sign-out is called (or retried and alerted).
- Removed member: the next request in that org gets 403.
- Auth outage: new logins and R3 fail with 503; existing sessions keep working (self-host while the DB is up; Cloud until evidence is older than 60 s, then 503).
- R3 without fresh MFA is refused: an `aal1` token gets 403 `STEP_UP_REQUIRED`; an `aal2` token whose MFA `amr` timestamp is older than 5 minutes gets 403 `STEP_UP_REQUIRED`; an `aal2` token with fresh MFA executes, and the audit row records `aal`, `session_id` and the MFA timestamp. A job that executes approved R3 work stops when the approver's session was revoked in between.
- Every read, export and download route is covered by the check (route enumeration test).
- `member` and `viewer` cannot approve (covered since #71).

## References

1. Supabase, JWT claims reference: https://supabase.com/docs/guides/auth/jwt-fields
2. Supabase JavaScript reference, `signOut()`: https://supabase.com/docs/reference/javascript/auth-signout
3. Supabase, User sessions: https://supabase.com/docs/guides/auth/sessions
4. Supabase JavaScript reference, `getUser()`: https://supabase.com/docs/reference/javascript/auth-getuser
5. Supabase Auth source, `requireAuthentication` and `maybeLoadUserOrSession`: https://github.com/supabase/auth/blob/master/internal/api/auth.go (route wiring in `internal/api/api.go`)
6. Supabase, Auth error codes (`session_not_found`, `user_banned`, `user_not_found`, `insufficient_aal`): https://supabase.com/docs/guides/auth/debugging/error-codes
7. Supabase, JWT signing keys: https://supabase.com/docs/guides/auth/signing-keys
8. Supabase, Multi-factor authentication: https://supabase.com/docs/guides/auth/auth-mfa
9. Supabase, Signing out: https://supabase.com/docs/guides/auth/signout
10. Supabase JavaScript reference, `auth.admin.signOut()`: https://supabase.com/docs/reference/javascript/auth-admin-signout and the Swift reference, which documents the `jwt` parameter as the target user's access token and the `local`, `global` and `others` scopes: https://supabase.com/docs/reference/swift/auth-admin-signout
11. Supabase, Auth Hooks: https://supabase.com/docs/guides/auth/auth-hooks
12. Supabase Auth source, `RefreshTokenGrant` and `GenerateAccessToken`: https://github.com/supabase/auth/blob/master/internal/tokens/service.go
