# 0028. Identity: Supabase Auth access tokens, sessions and revocation

- Status: accepted (2026-10-14, owner), with conditions: the acceptance tests below must pass before External-tenant gate T1 is green. Amended 2026-10-15 (owner): Crove Cloud uses Supabase Auth's default session behavior (`AUTH_SESSION_CHECK=jwt`, section 3); the DOS ID lifecycle events (DOS-28) become an optional later refinement
- Date: 2026-10-14, amended 2026-10-15
- Deciders: owner (JOY), after two blind reviews (Codex and Claude) that independently converged on design C
- Builds on: ADR-0027 decision 3 (auth uses Supabase Auth only) and plan Decision 5
- Tracking: issue #22 (implementation), plan Tracking Decision 16 and "External-tenant gate" row T1
- Amended: 2026-10-15, issue #126: a user with a verified MFA factor needs `aal2` for every request, not only for R3 (sections 3 and 8)
- Amended: 2026-10-16, issue #272: a Supabase Auth access token issued to an OAuth client is refused on every surface and in every session check mode (fact 11, sections 1 and 8)
- Amended: 2026-10-16, issue #277: the self-host `/auth/v1` proxy refuses the same tokens before they reach Supabase Auth (section 1)
- Amended: 2026-10-16, issue #276: in `db` mode the session check also refuses a session bound to an OAuth client (`auth.sessions.oauth_client_id`), whatever claims its token carries (sections 1, 3 and 8)
- Amended: 2026-10-29, issue #1822 step 2: `crove_app` may no longer call `enter_context`, the API requires the key, and the database checks the session a token names (section 9)
- Amended: 2026-10-29, issue #1822: the database enters a user's context only from a context token the kernel signs, and checks the session it names (section 9, added; sections 1 to 8 unchanged)

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
11. Supabase Auth's OAuth 2.1 server (beta, off unless `GOTRUE_OAUTH_SERVER_ENABLED` is set) issues access tokens to third-party OAuth clients through the same `GenerateAccessToken` as browser sessions: same signing key, `aud` from the user (normally `authenticated`), `role = authenticated`, a `session_id`, `aal` and `amr`. They differ only by `client_id` (the client's UUID, `json:"client_id,omitempty"`, so a browser token never carries it) and `scope` (the granted scopes, also `omitempty`). The authorization code exchange creates a session bound to the client (`auth.sessions.oauth_client_id`) whose `amr` first factor is `oauth_provider/authorization_code`; a refresh of that session requires the same client and keeps both `client_id` and the `amr`. Two paths issue a token for that session without `client_id`: an MFA verification on it (`updateMFASessionAndClaims` calls `GenerateAccessToken` without the client, and the `/factors` routes accept the client's token), which yields an `aal2` token that still carries the session's `amr` and `scope`; and a Custom Access Token hook, whose schema lists `client_id` as optional. Checked in the Supabase Auth source at tag `v2.197.0`, the version compose pins. [13]

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
- Rejected as the only revocation mechanism. A shorter lifetime stays as defense in depth (section 7). Amended 2026-10-15: on Crove Cloud the token lifetime does bound sign-outs that happen outside Crove (section 3), with Crove-side revocation, per-request membership and the R3 live check on top.

### Pure push (rejected alone)

DOS ID pushes sign-out, revocation, ban and deletion events to Crove, and Crove trusts a session until an event says otherwise.

- Good: no per-request call to Auth; revocation in seconds when events flow.
- Bad: a lost or delayed event keeps access open indefinitely; nothing bounds the delay. Supabase Auth has no sign-out hook [11], so the events come from DOS-side code that can fail silently.
- Rejected alone. The 2026-10-14 design C kept push for speed and added checkpoints and an evidence age limit so a lost event cannot keep access open past 60 s; since 2026-10-15 that is an optional later refinement (section 3).

### Crove-owned sessions through token exchange (rejected)

Exchange the Supabase token once for a Crove session (cookie or Crove-signed token) that Crove can revoke directly.

- Good: revocation fully under Crove's control.
- Bad: Crove issues sessions again (the superseded design): cookies, CSRF protection, refresh and key management in Crove.
- Bad: still needs sign-out in Supabase Auth to propagate to Crove sessions, so it needs the same upstream sync as design C.
- Rejected.

### Design C: local verification plus a Crove session status record, with one status interface and two adapters (chosen)

Described in Decision below. Self-host gets exact, next-request revocation from the shared database. Crove Cloud (amended 2026-10-15) keeps Supabase Auth's default token lifetime for sign-outs outside Crove, Crove's own immediate revocation and a live Auth check for R3, with no per-request Auth call and no DOS-side change.

## Decision

### 1. Token verification on every request

- Verify only with `jose`, never with Hono's JWT middleware. Pin algorithms: ES256/RS256 through JWKS when `AUTH_JWKS_URL` is set, otherwise HS256 with `AUTH_JWT_SECRET`. A deployment accepts one family, never both.
- `AUTH_ISSUER` becomes required: boot fails without it, and the issuer must match exactly. `AUTH_AUDIENCE` stays required (default `authenticated`).
- Required claims: `iss`, `aud`, `exp`, `sub`, `session_id`, and `role = authenticated` (pass `requiredClaims` to `jose` so a token without `exp` fails). Reject `is_anonymous = true`. Clock tolerance at most 30 seconds. A missing `aal` means `aal1`.
- `email` stays required and non-empty, as on `main`: Crove identifies and adds members by email. A Supabase Auth user who signs in with a phone number only (empty `email`) gets 401 until a later ADR supports phone-only accounts.
- JWKS cache: at most 10 minutes. The runbook covers forcing a refresh after a key revocation.
- Verification is local: no call to Supabase Auth on the request path, except the live check of R3 commands on Crove Cloud (section 5).
- Refuse any token issued to an OAuth client (issue #272): a `client_id` claim of any value, or an `amr` entry whose method starts with `oauth_provider/` (fact 11; the `amr` test is load-bearing: an MFA verification on the OAuth session, or a hook, issues tokens for it without `client_id`). The check runs right after the signature, before every other claim check and before any database work, so it holds in every session check mode (`db`, `jwt`, `off`) and on every surface that authenticates a user (all of `/api`). A browser never holds such a token, and the kernel would otherwise accept it exactly like the user's own SPA session: every query and R1/R2 command, with no scope or org binding. Third-party access goes through the Crove authorization server (ADR-0032), never through Supabase Auth's. A hook may drop both claims; in `db` mode the session check then still refuses the token by its session (section 3, issue #276).
- The self-host `/auth/v1` proxy applies the same rule (issue #277, the same `issuedToOAuthClient` predicate) before forwarding, because Supabase Auth itself accepts these tokens wherever it accepts a browser's. Of the paths the proxy forwards, Supabase Auth authenticates `/user` (`GET`, `PUT`), `/logout`, `/reauthenticate` and every `/factors` path (enroll, challenge, verify, unenroll) with the user's access token (`requireAuthentication` in its router, v2.197.0), so without the check an OAuth client could change the user's email or password, enroll or remove factors, request a reauthentication code or sign out every session of the user. The proxy decodes the `Authorization: Bearer` JWT payload without verifying it (Supabase Auth verifies; the proxy only refuses, so a forged or altered token gains nothing) and refuses with 401 in Supabase Auth's error shape, `{"code":401,"error_code":"OAUTH_CLIENT_TOKEN_REFUSED","msg":...}`, which auth-js reads as `error.code`. It checks every forwarded path, not only those, since a browser never sends such a token anywhere, and it checks before the email budget (#190), so a refused request takes no slot and nothing reaches Supabase Auth. A header that is not a bearer JWS with a JSON object payload is forwarded unchanged for Supabase Auth to reject. The token is never logged. The compose stack keeps Supabase Auth's OAuth server off and the proxy does not forward `/oauth/*`, so this matters for a deployment that turns that server on; Crove Cloud has no proxy and relies on its Supabase Auth project's settings. The proxy checks claims only: it does not read the session row, so a token whose hook dropped both claims still reaches Supabase Auth there (a known limit, tracked in #289).

### 2. Session status record and membership, in the request transaction

Every request, after the token verifies, runs one check inside the same transaction as `enter_context`, so nothing changes between check and use:

- **Crove session record.** `crove_kernel.auth_session`, keyed by `(user_id, session_id)`: `status` (`active` or `revoked`), `first_seen_at`, `revoked_at`, `revoked_by`, `reason`, and `evidence_at` (unused today; reserved for the optional events refinement in section 3). A `revoked` row rejects the request. Crove never deletes a revoked row while a token from that session could still be valid or refreshed; because a refresh keeps the `session_id` [12], a revoked row keeps rejecting every token that session issues, refreshed or not. `last_seen_at` is updated at most once a minute, never on every request.
- **Upstream status** through the `SessionStatusSource` interface (section 3): on self-host, is the session still alive in Supabase Auth, and is the user neither banned nor deleted. Crove Cloud has no per-request upstream status (section 3).
- **Crove user state.** `user_account.disabled_at` (section 4).
- **Membership.** `enter_context` reads `tenant_member` (and later `role_assignment`) as today. No claim and no cache decides membership; removal takes effect on the next request.

The `(issuer, subject) -> user_account` cache may stay because it holds no authorization; every check above runs in SQL in the request transaction.

### 3. Status source: one interface, two adapters

Setting `AUTH_SESSION_CHECK` selects the adapter: `db`, `jwt` or `off`. When it is not set, the default is `db` if `AUTH_UPSTREAM_URL` is set (the bundled Supabase Auth on the same database) and `jwt` otherwise, so an unset value never means "no check". `off` (Crove's own records only, no Supabase Auth at all) is accepted only on a local `PUBLIC_URL`; on any other URL boot fails, like the existing `AUTH_AUTOCONFIRM` guard. `jwt` on a non-local URL needs the Supabase Auth URL for the R3 live check (`PUBLIC_AUTH_URL`, or `AUTH_UPSTREAM_URL`); boot fails without it.

| Deployment | Adapter | Sign-out, ban or deletion outside Crove | Crove-side revoke, membership |
|---|---|---|---|
| Self-host with the bundled Supabase Auth on the same database (`AUTH_SESSION_CHECK=db`) | Direct read of `auth.sessions` and `auth.users` | Next request | Next request |
| Crove Cloud on DOS's Supabase Auth (`AUTH_SESSION_CHECK=jwt`) | Verified token plus Crove's records; live check for R3 | Refresh tokens destroyed at once; access ends when the access token expires (SLA: the project's JWT expiry); R3 refused at once | Next request |

**Self-host adapter (`db`).**

- A SECURITY DEFINER function, `crove_kernel.auth_session_valid(session_id uuid, subject uuid)`, owned by the NOLOGIN role `crove_auth_reader`, which can only SELECT `auth.sessions` and `auth.users`. It runs in the request transaction, inside `enter_context` or right before it.
- Valid means: the session row exists for that user; its `not_after`, when set, is in the future; the user exists, is not soft-deleted, and `banned_until` is null or past.
- The grant needs a step after Supabase Auth's first start, because `auth.sessions` and `auth.users` do not exist until Supabase Auth has run its own migrations, and in the compose stack `auth` starts only after `migrate` completes. The image gets a one-shot role `auth-grants`: it waits (up to 2 minutes) until both tables exist, grants SELECT on exactly those two tables to `crove_auth_reader`, and exits. It connects with the admin database URL (`ADMIN_DATABASE_URL`, as `migrate` does), because only the owner of the `auth` tables (`supabase_auth_admin`) or a superuser can grant on them. Compose runs `migrate`, then `auth`, then `auth-grants` (depends on `auth` healthy: Supabase Auth serves `/health` only after all its migrations ran, so the grant never lands mid-migration and misses a column a later migration adds, issue #276), then `crove` (depends on `auth-grants` completed successfully). It runs on every `docker compose up`, so the grant is re-applied if Supabase Auth ever recreates a table. Installs without compose run `auth-grants` once after Supabase Auth's first start (once its migrations are done), after each Supabase Auth upgrade and after each Crove upgrade, since a Crove release may read another Supabase Auth column (issue #276 added `auth.sessions.oauth_client_id`).
- Until the grant exists the check fails closed: requests get 503 and `/readyz` reports not ready with reason `auth_grants`.
- **Sessions bound to an OAuth client (issue #276).** The kernel refuses tokens issued to OAuth clients by their claims (section 1), but a Custom Access Token hook may drop `client_id` and rewrite `amr` (fact 11). The session row still tells the OAuth session apart: Supabase Auth's OAuth server creates it with `auth.sessions.oauth_client_id` set. In `db` mode, `session_check` and `identity_resolve` therefore refuse a session whose `oauth_client_id` is set, right after the session is found valid and before the MFA rule, any Crove session record or a new user account is written: 401 `OAUTH_CLIENT_TOKEN_REFUSED` (28000 `OAUTH_CLIENT_SESSION`), the same answer as the claim check, so the SPA signs out. The reader `crove_kernel.auth_session_oauth_bound` is owned by `crove_auth_reader` and reachable only through those two definers. The column is optional: Supabase Auth releases without the OAuth server (no `auth.oauth_clients`) have neither the column nor such sessions, so the reader answers false there and `auth-grants` neither waits for it nor grants it. Where the OAuth server exists but the column does not (a release that renamed or dropped it, or one from before sessions were bound to their client), OAuth sessions cannot be told apart: `auth_grants_ready` is false (503) and `auth-grants` waits for the column and then fails with `auth.sessions.oauth_client_id do not exist`, as for the other columns. When the column exists, `auth-grants` grants exactly `auth.sessions (oauth_client_id)` (never `scopes` or the refresh token columns) and `auth_grants_ready` requires that grant, so a Supabase Auth upgrade that adds the column after `auth-grants` ran fails closed with 503 until `auth-grants` runs again, never a skipped check. `jwt` and `off` read nothing from Supabase Auth and rely on the claim check alone.
- **MFA enrolled means MFA required (issue #126).** The same check reads whether the user has a verified factor in `auth.mfa_factors` (any factor type) through `crove_kernel.auth_user_has_verified_factor`, also owned by `crove_auth_reader`. If the user has one and the token is not `aal2`, every request is refused with 401 `MFA_REQUIRED`: reads, R1 and R2 commands, uploads, downloads and org-less calls alike, so a password or a recovery link alone gives no access to data. The SPA answers `MFA_REQUIRED` with the MFA challenge (issue #32), never with a sign-out, on RPC calls and on the plain fetch paths (upload, download, export) alike, which throw typed errors with the kernel's code (issue #180); until that screen ships it shows the server's message. `auth-grants` grants exactly `auth.mfa_factors (user_id, status)` and a SELECT policy, never the factor secrets; `auth_grants_ready` requires the table, that grant and the policy, so a missing grant fails closed with 503 like the rest. Supabase Auth creates `auth.mfa_factors` in a migration that runs before the one adding `auth.sessions.not_after`, so every supported version has it; `auth-grants` waits for it like the other two tables, and a missing `auth.mfa_factors` (for example a Supabase Auth upgrade that renamed or dropped it) makes `auth_grants_ready` false, so every request fails closed with 503 `AUTH_NOT_READY` and `/readyz` reports `auth_grants` instead of the rule being skipped (issue #180). A signed-out, expired, banned or deleted session still gets 401 `UNAUTHENTICATED` first. Two deliberate limits: `identity_resolve` still maps an `aal1` token to its account (it writes only the email and name the token itself carries, and grants no access), and `off` (local URLs only) reads nothing from Supabase Auth, so it does not enforce this rule.
- Rejected alternative: `ALTER DEFAULT PRIVILEGES FOR ROLE supabase_auth_admin IN SCHEMA auth GRANT SELECT ON TABLES TO crove_auth_reader` in `migrate`. It needs no extra step, but it grants read access to every current and future `auth` table, including refresh tokens, MFA factor secrets and one-time tokens, far more than the check needs.

**Crove Cloud adapter (`jwt`), owner decision 2026-10-15.**

- Crove Cloud keeps Supabase Auth's default session behavior. A sign-out elsewhere (any scope), a ban or a deletion destroys the session's refresh tokens at once [9]; the access tokens already issued stay valid until their `exp` [2]. Crove does not poll Supabase Auth and needs no DOS-side change.
- Every request: local verification (section 1), then `crove_kernel.session_check` with the Crove records only: a session revoked in Crove (globally or for the org in context) is 401, a disabled Crove user is 403, and `enter_context` checks membership. No call to Supabase Auth.
- R3 commands confirm the session live with Supabase Auth (section 5), so a signed-out, banned or deleted user cannot approve, invite or change roles even while the access token is still valid.
- **MFA enrolled (issue #126): requirement on the identity provider.** Crove cannot read the factors of a remote Supabase Auth, and an `aal1` access token does not say whether its user has a verified factor. For `jwt` to enforce the `db` rule (an `aal1` token of a user with a verified factor gets 401 `MFA_REQUIRED` on every request), the identity provider must state that fact in the access token it signs (for example a claim added by a custom access token hook), or not issue `aal1` tokens that reach Crove to such users. Until it does, `jwt` refuses those tokens only for R3 (`STEP_UP_REQUIRED`), and External-tenant gate T1 keeps this open for Crove Cloud.
- **SLA:** for a sign-out, ban or deletion that happens outside Crove, reads and non-R3 writes stop when the access token expires: at most the JWT expiry of DOS's Supabase Auth project (Supabase default one hour; 15 minutes recommended to DOS, section 7). Crove-side revocation, a Crove disable and membership removal take effect on the next request; R3 is refused at once.
- An Auth outage does not log anyone out (existing tokens keep working until they expire, as with Supabase itself); it stops new logins, token refresh and R3 (503).

**Later refinement, optional: DOS ID lifecycle events (DOS-28).** Trigger: a customer needs cross-app revocation faster than the JWT expiry. Then a fourth mode adds what the 2026-10-14 version of this ADR designed for Crove Cloud:

- DOS ID pushes `session.signed_out` (with scope), `session.revoked`, `user.banned` and `user.deleted` from a durable outbox with an HMAC signature (a Crove-specific, rotatable secret), a global sequence number, `event_id`, `occurred_at`, and retries with backoff. Supabase Auth has no sign-out hook [11], so DOS ID derives them on its side; it is a cross-repo DOS change that needs owner approval.
- Crove verifies signature and timestamp (±5 minutes), dedupes in `idp_event`, applies events in sequence order and fetches any gap before later events.
- Signed checkpoints at least every 15 seconds (or a batch status endpoint) feed `evidence_at`; a session whose evidence is older than 60 s is blocked (503 `AUTH_STATUS_STALE`), with one rate-limited `getUser` fallback per session per 60 s and a first-seen `getUser` check of new sessions. That bounds revocation to 60 s even when an event is lost.

### 4. Revoke session or device, disabled, banned and deleted users

- **Owner or admin revoke.** Crove adds commands, through `execute()` and audited: revoke one session or device of a member, and "revoke all sessions" of a user (the user themself, an org owner for a member of their org, or staff). The command sets the record to `revoked` in its transaction, so the next request with any token of that session is rejected (immediate, in both adapters).
- **Own revoke without an org** (issue #184). A user's own revoke needs no org header, so sign-out on the onboarding and invite pages also revokes in Crove: a user with an org runs the same command in the oldest of their orgs that can run it (audited there; an org whose owner revoked this session there, or one the user just left, is skipped, so no owner can block a global self revoke, issue #196); a user with no such org gets a Crove-only revoke from the org-less definer `session_revoke_orgless`, tied to the caller's live session and refused while any org could run the command (no org holds an audit row, the one exception to "audited" above; the `auth_session` row records who, when and why, and `keep_revoked` pins them once set). Revoking another user's sessions stays org-scoped.
- **Upstream sign-out.** The command then asks Supabase Auth to sign the session out, which destroys its refresh tokens [9]. The admin sign-out takes the target session's access token, not an id [10], so the `SessionRevoker` interface has per-deployment adapters: self-host signs a 60-second token for that `sub` and `session_id` with the deployment's JWT signing key and calls the admin sign-out (scope `local`, or `global` for "revoke all"). Crove Cloud has no admin access to DOS's Supabase Auth and keeps Crove-side revocation only (a DOS-side sign-out belongs to the optional events refinement), as does a self-host with asymmetric keys whose signing key the kernel does not hold. Correctness does not depend on this call: the revoked record already blocks the session in Crove. A failed call is retried and alerted.
- A Supabase Auth ban (`banned_until`) or a deleted user is rejected: in self-host by the `db` adapter on the next request; on Crove Cloud at once for R3 (live check) and otherwise when the access token expires, since it can no longer be refreshed.
- `user_account.disabled_at`, set by an audited staff command, is checked in `enter_context` and in org-less calls (`my_orgs`, org creation). It lets a self-hoster block a user in Crove without touching Supabase Auth, and lets Crove Cloud block an account it cannot ban in DOS's Supabase Auth.
- `user_account` rows are never deleted; offboarding removes memberships (plan §7.9).

### 5. R3: direct Auth check, `aal2` and fresh MFA

R3 covers posting, legal or money actions, membership and role changes (plan §4.7). For every R3 command run by a user:

- A live check against Supabase Auth at execution time, on top of the per-request check, after the role and step-up checks (so a refused role or a missing MFA never calls Auth). On Crove Cloud (`jwt`): `GET /user` with the token (and the project's publishable key); only a 200 whose `id` equals the token's `sub` passes; any other 4xx, or a 200 for another user, is 401; a network error, timeout, 429 or 5xx is 503. No cache. On self-host (`db`) the per-request check already reads `auth.sessions` and `auth.users`, the rows `GET /user` reads [5], in the same transaction, so it is the live check and no HTTP call is added. `off` (local only) has none.
- `aal = aal2` in the verified token, and an `amr` entry for a second factor (`totp`, `phone` or WebAuthn) whose `timestamp` is within the last 5 minutes [1] [8]. Otherwise 403 `STEP_UP_REQUIRED`: the SPA runs an MFA challenge and retries with the new token.
- R3 work that a job executes later (for example an approved proposal) re-checks before executing that the approver's session record is still `active`, that the approver is still a member holding the approval permission, and that the approval was recorded with `aal2` and fresh MFA. Otherwise the job stops and raises an Inbox item.
- Policy P11 is on by default. An org owner can turn it off for that org; the change is audited. A single-user self-host can do the same.
- The compose stack enables TOTP MFA in Supabase Auth, and the SPA gets enrollment and challenge screens (issue #32). Passkeys (WebAuthn) are preferred where Supabase Auth supports them.
- Audit rows for R3 commands record `aal`, `session_id` and the MFA timestamp used.
- Who may approve is a separate rule (plan §4.6): today `owner` and `admin`, the roles that may post (#71); once role assignments exist, the holders of the approval permission, with four-eyes and the approver-permission check (P10, P12, issue #75).

### 6. When Supabase Auth is down

- No new logins and no token refresh (Supabase Auth serves them). No R3: the direct check fails closed (503).
- Existing sessions keep working. Self-host: as long as the database is up, because the `db` adapter reads the shared database, not Auth. Crove Cloud: until each access token expires, since it cannot be refreshed while Auth is down.
- Alerts: Auth error rate, R3 live check failures (`AUTH_UNAVAILABLE`). Runbook in plan §7.10.

### 7. Access token lifetime

Choice: the self-host compose stack sets `GOTRUE_JWT_EXP=900` (15 minutes) as defense in depth, inside the 5 minutes to 1 hour range Supabase recommends [3]. Self-host revocation does not rely on it. Crove Cloud uses whatever DOS's Supabase Auth sets (Crove cannot change it), and that value is the Cloud SLA for sign-outs outside Crove (section 3); 15 minutes is recommended to DOS but not required.

### 8. Error mapping

| Condition | Answer |
|---|---|
| Missing or invalid token, wrong `iss` or `aud`, missing `exp`, `sub` or `session_id`, expired, anonymous, wrong algorithm, empty `email` | 401 |
| Valid signature, but the token was issued to an OAuth client (`client_id` claim, or an `oauth_provider/` `amr` method) | 401 `OAUTH_CLIENT_TOKEN_REFUSED`, before any database work; the SPA signs out as for any 401 (a browser never holds such a token) |
| Self-host (`db`): the session is bound to an OAuth client (`auth.sessions.oauth_client_id` set), whatever its token's claims | 401 `OAUTH_CLIENT_TOKEN_REFUSED`, before the MFA rule and before any Crove record is written (issue #276) |
| Crove session record `revoked`; self-host session row missing or past `not_after`; user banned or deleted upstream | 401 |
| Session revoked by the org's owner for that org only | 401 `SESSION_REVOKED_IN_ORG`: the SPA leaves that org and keeps the session (issue #247); `me.get` no longer lists the org for that session |
| R3 live check (`GET /user`, Crove Cloud): any 4xx other than 429, or a 200 for a different user id | 401 |
| User has a verified MFA factor and the token is not `aal2` (any request, not only R3; `db`, and `jwt` once the identity provider states the fact) | 401 `MFA_REQUIRED` |
| `user_account.disabled_at` set | 403 |
| Not a member of the org | 403 |
| R3 without `aal2` or without an MFA timestamp in the last 5 minutes | 403 `STEP_UP_REQUIRED` |
| Self-host before `auth-grants` has run | 503, `/readyz` reason `auth_grants` |
| R3 live check: network error, timeout, 429 or 5xx, or no Auth URL configured | 503 `AUTH_UNAVAILABLE` |

### 9. The database checks the session: context tokens (added 2026-10-29, issue #1822)

Sections 1 to 8 check the access token and the session in the kernel, then call `crove_kernel.enter_context(user, org)` on the API's login, `crove_app`. That function took the user from its caller and checked only membership, so raw SQL on `crove_app` (an injection, a leaked database credential) could seal a context as any member of any org. This section moves the binding into the database. Sections 1 to 8 stay as they are.

- **The token.** After the checks of sections 1 to 5 pass, the runtime signs a context token for the transaction it is about to open: `v1.<user>.<session|->.<org>.<aal1|aal2>.<mfa epoch|->.<exp epoch>.<signature>`, where the signature is HMAC-SHA256 (hex) of everything before it under the deployment's context token key. The kernel does not verify Supabase Auth tokens in PostgreSQL: hosted Supabase signs them with ES256 or RS256 keys from a JWKS that the database cannot fetch or verify, and the stream rebuilds actors outside a request, so the runtime is the one place that sees every verified actor.
- **The key.** 32 to 64 random bytes, `CROVE_CONTEXT_TOKEN_KEY` (base64), held by the kernel and installed in the database by the migration runner through `crove_kernel.context_token_key_install`. The runner first asks `context_token_key_matches` whether the database's current key signs a fixed message as its key does, and sends the key only when it does not (a first install or a rotation), as a bind parameter and never in a statement's text, in a transaction that turns parameter and statement logging off for itself where the runner may (a superuser). So the key never reaches `pg_stat_statements`, and a statement log only on a server that logs every parameter in a way the runner cannot turn off (pgaudit, for example), on the rotation run alone. The database keeps the key as its HMAC pads in `crove_kernel.context_token_key`, which no login role may read or write. The runbook (`docs/runbooks/context-token-key.md`) generates it on the server; the boot refuses the test suites' key on a public URL, and the API checks at boot, through `context_token_valid`, that its key is the database's current one.
- **Entering.** `crove_kernel.enter_user_context(org, token)`, granted to `crove_app` alone, refuses a token whose signature does not verify (`CONTEXT_TOKEN_INVALID`), one made for another org (`CONTEXT_TOKEN_ORG`), one past its expiry (`CONTEXT_TOKEN_EXPIRED`), and one naming a session revoked for good (`SESSION_REVOKED`) or in this org (`SESSION_REVOKED_IN_ORG`). Everything else is `enter_context`'s: membership, the org's state, the legal entity scope, the re-entry guard, the seal. The comparison of signatures runs over every byte, under the current and the previous key, whatever matched.
- **Lifetime and clock skew.** A token's expiry is the kernel's clock plus 60 seconds: it is signed right before the transaction opens. The database checks the expiry against its own clock and refuses a token once that clock is past it, and a token whose expiry lies more than 90 seconds ahead of it. So with the clocks in step a token is good for 60 seconds; a kernel clock up to 30 seconds ahead of the database's still works, a kernel clock behind it shortens the token's life by the difference (60 seconds behind or more and every token arrives expired), and anything outside that fails closed (`CONTEXT_TOKEN_EXPIRED`, every request refused and logged), never open.
- **Rotation.** Installing a new key keeps the one it replaces as the previous key and drops any older one. The previous key verifies tokens for 10 minutes after the new one was installed, so a process still running with it during a deploy's restarts keeps working; after that it verifies nothing, and the boot check takes the current key only, so a process left with the old key stops at its next start. Rotate by setting the new key on the migration job and the kernel together, running the migration job first.
- **Two steps** (AGENTS.md, changing an invariant on purpose). Step 1 (#1822 PR A) adds the token path and moves the tests to it; `enter_context` stays granted to `crove_app`, and a kernel without a key keeps today's path, so nothing changes for a deployment that has not set one. Step 2 (PR B) revokes `enter_context` from `crove_app` and makes the key required at boot, failing closed; it lands only after the key is installed in production.
- **Step 2.** `enter_context` is revoked from `crove_app` (kept, and called by `enter_user_context` alone, as its owner): a user's context is entered from a token or not at all, and a kernel without a key is refused (`FORBIDDEN`). The API does not start without a key (`CROVE_CONTEXT_TOKEN_KEY`, or the file `CROVE_CONTEXT_TOKEN_KEY_FILE` names, which the migrate step creates with a fresh key when it is missing; the compose stack keeps it on the `keys` volume). The token (v2) also carries the session check the kernel ran in the same transaction, `db`, `jwt` or `off`, or `-` for a runtime with no session source (tests and tools), which names no session. The database then checks the session as well (the design's step 4): a session a token names must be recorded in `auth_session` and active (`SESSION_INVALID` otherwise; the kernel's session check records it first), a `db`, `jwt` or `off` token must name one, and a `db` token's session must be live in Supabase Auth (`auth_session_valid`; `AUTH_GRANTS_MISSING` without the reader's grants). v1 tokens from step 1's kernels are still accepted, as tokens of no check, so a deploy's restarts and a rollback to step 1 keep working; a later release may drop them (the pgTAP gate file `_rls_matrix.test.sql` mints one, so it moves first). Every `SessionStatusSource` must record the session it passes (`session_check` does), or every user is signed out. With the `db` check the database asks Supabase Auth twice per request, in `session_check` and again in `enter_user_context`: a few catalog lookups, kept so the token's claim never stands alone.
- **Residuals.** The session, `aal` and MFA time travel in the token but are not part of the sealed context, so the database does not check P11 (fresh MFA for R3) itself; the kernel still does (section 5). A token of no check (`-`, a runtime without a session source, or a v1 token) names no session and so has none checked: the API always has a session source, and only the key makes such a token. Nothing makes a token single use: within its 60 seconds, raw SQL on `crove_app` that obtained a token (from a statement log, for example) can enter that one user's context in that one org again, while its session stays active. A later issue may close these.

## Consequences

- Good: self-host revokes on the next request with no Auth call on the request path; Crove Cloud needs no DOS-side change and no per-request Auth call, and a revoke in Crove (self, owner) is immediate in both. An Auth outage does not log out every Cloud user at once.
- Good: R3 needs a fresh second factor and a live Auth check, so a token that is valid but stale cannot approve money or role changes.
- Bad: on Crove Cloud a sign-out, ban or deletion outside Crove leaves reads and non-R3 writes open until the access token expires (the project's JWT expiry), as in any Supabase app. Accepted by the owner on 2026-10-15; the events refinement in section 3 closes it when a customer needs it.
- Bad: self-host gains a one-shot `auth-grants` step in the startup order (compose: `migrate` -> `auth` -> `auth-grants` -> `crove`); installs without compose must remember to run it.
- Bad: one more kernel table (`auth_session`).
- The earlier plan design for Crove-issued sessions (session JWTs and refresh tokens, a Crove `session` table, OIDC callbacks under `/auth/*`, the `dos-id` and `generic-oidc` adapters, `/.well-known/jwks.json`) stays superseded. `auth_session` records status only; Crove issues no tokens. `user_account` keeps `(issuer, subject)`, so a later identity adapter can replace Supabase Auth.

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| `auth.sessions` and `auth.users` are internal Supabase Auth (GoTrue) tables that Supabase Auth migrates | Supabase documents the `auth.sessions` lookup [3]; compose pins the Supabase Auth image version; a CI contract test runs the `db` adapter against that version (sign-out, `not_after`, ban, delete); a schema change breaks the check closed, not open |
| A sign-out outside Crove leaves a copied access token working until it expires (Crove Cloud) | R3 checked live; owner and self revoke in Crove are immediate; 15-minute JWT expiry recommended to DOS; the events refinement (section 3) when a customer needs faster cross-app revocation |
| A stolen phone that holds the TOTP app (attacker has the second factor) | Prefer passkeys; password re-entry for R3 (decided with the approval screen); owner "revoke all sessions" for the user; R3 audit shows `session_id` and device |
| A read, export or download path skips the check | Every surface (API, SPA data calls, exports, file downloads, SSE later) goes through the same middleware and `enter_context`; a test enumerates routes and fails on any route without it |
| R3 live checks during an Auth outage | No retry loop: one call per R3 command, 5-second timeout, 503 to the user; R3 is rare and human-initiated |
| A JWKS cache trusts a revoked signing key | JWKS cache at most 10 minutes; runbook to force a refresh |

## Acceptance tests (conditions before gate T1 is green)

Unit (kernel auth):

- 401 for a token with no `iss` or a wrong one, no `aud` or a wrong one, no `exp`, an expired `exp`, no `sub`, no `session_id`, `role` other than `authenticated`, `is_anonymous = true`, `alg: none`, and an HS256 token when JWKS is configured.
- Boot fails without `AUTH_ISSUER`, with `AUTH_SESSION_CHECK=off` on a public URL, and with `jwt` on a public URL without an Auth URL; an unset `AUTH_SESSION_CHECK` resolves to `db` or `jwt` as described above.
- A token with an empty `email` (phone-only user): 401.
- A token issued to an OAuth client (`client_id` of any value, including empty or null, or an `oauth_provider/` `amr` method, as an object or a bare string): 401 `OAUTH_CLIENT_TOKEN_REFUSED`; a forged one still gets `UNAUTHENTICATED`; the browser `amr` methods pass.
- The `/auth/v1` proxy (issue #277, `http.test.ts`, in front of a fake Supabase Auth): the same tokens, with any bearer scheme casing, get 401 `OAUTH_CLIENT_TOKEN_REFUSED` on `/user`, `/logout`, `/reauthenticate`, every `/factors` path and `/token`, never reach upstream, take no email slot and are not logged; browser tokens and the anon key are forwarded unchanged; malformed tokens (not a JWT, a non-object or non-JSON payload, two or five parts, trailing text) and other schemes are forwarded unchanged.

Self-host (`db` adapter, Supabase Auth image pinned as in compose):

- Fresh install: `docker compose up` on empty volumes; `auth-grants` completes; the first sign-up, sign-in and API call succeed with the `db` check active (not skipped). Before `auth-grants` has run: requests get 503 and `/readyz` reports `auth_grants`.
- Old JWT after sign-out: sign in, call the API (200), sign out; the same token gets 401 on the next request.
- Banned user: ban in Supabase Auth, next request 401. Deleted user: 401. `user_account.disabled_at` set: 403.
- MFA enrolled (issue #126): for a user with a verified factor, an `aal1` token gets 401 `MFA_REQUIRED` on a read query, an R1 command, an upload and an org-less call, and writes nothing; an `aal2` token of the same session passes; a user without factors, or with only an unverified factor, keeps `aal1` access; removing the factor restores it on the next request. Without the `auth.mfa_factors` grant or its policy, or without the table itself (#180): 503 until the table is back and `auth-grants` runs again.

Crove Cloud (`jwt` adapter, through the HTTP API with a stand-in for Supabase Auth's `GET /user`):

- Valid tokens are accepted with no call to Supabase Auth outside R3; `/readyz` is ready without an `auth` schema.
- R3 live check: a 200 for the token's user passes (token and publishable key sent, no cache); 400, 401, 403, 404 or a 200 for another user gives 401; 429, 5xx or a dropped connection gives 503; nothing is written in either case, and non-R3 requests keep working during the outage.
- No call to Auth when the role or the step-up check refuses first; an idempotent R3 replay is confirmed live too; an actor without a bound live check gets 503; boot fails for hosted Supabase without the publishable key.

Both adapters:

- Owner revoke is immediate: after an owner revokes a member's session, the next request with that token, and with a token refreshed from that session, gets 401; the upstream sign-out is called (or retried and alerted).
- Removed member: the next request in that org gets 403.
- Auth outage: new logins and R3 fail with 503; existing sessions keep working (self-host while the DB is up; Cloud until the access token expires).
- R3 without fresh MFA is refused: an `aal1` token gets 403 `STEP_UP_REQUIRED`; an `aal2` token whose MFA `amr` timestamp is older than 5 minutes gets 403 `STEP_UP_REQUIRED`; an `aal2` token with fresh MFA executes, and the audit row records `aal`, `session_id` and the MFA timestamp. A job that executes approved R3 work stops when the approver's session was revoked in between.
- Every read, export and download route is covered by the check (route enumeration test).
- Tokens issued to OAuth clients (issue #272, `oauth-client-tokens.db.test.ts`, in `db`, `jwt` and `off`): a token signed like a browser token but with `client_id`, an OAuth-server token, and one without `client_id` (as an MFA verification on the OAuth session or a hook issues it) are refused with 401 `OAUTH_CLIENT_TOKEN_REFUSED` on a read query, an R1 command, an org-less command and `me.get`, and change nothing; a first sign-in through an OAuth client creates no user account; the same user's browser token keeps working.
- Sessions bound to an OAuth client (issue #276, `oauth-bound-sessions.db.test.ts`, `db`): a browser-shaped token (no `client_id`, no `scope`, a password `amr`) whose `session_id` names an OAuth-bound session is refused with 401 `OAUTH_CLIENT_TOKEN_REFUSED` on a read query, an R1 command, an org-less command and `me.get`, and changes nothing; an enrolled user's `aal1` and `aal2` tokens on it get the same answer (not `MFA_REQUIRED`); a first sign-in on it creates no user account; binding a recorded session refuses it on the next request; the user's browser session keeps working. Without the reader's grant on the column: 503 and `/readyz` `auth_grants` until `auth-grants` runs again. Without the column and without `auth.oauth_clients` (an older Supabase Auth): `auth-grants` succeeds without it and sessions keep working; with `auth.oauth_clients` but no column: 503 and `auth-grants` fails naming the column; an upgrade that adds it fails closed with 503 until `auth-grants` runs again.
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
13. Supabase Auth source at tag `v2.197.0`: `internal/api/token.go` (`updateMFASessionAndClaims`), `internal/tokens/service.go` (`AccessTokenClaims` with `client_id` and `scope`, `GenerateAccessToken`, the refresh client check, the Custom Access Token hook schema), `internal/api/oauthserver/handlers.go` (the authorization code exchange sets `OAuthClientID` and the `oauth_provider/authorization_code` method), `internal/models/factor.go` and `internal/models/sessions.go` (`oauth_client_id`, `CalculateAALAndAMR`): https://github.com/supabase/auth/tree/v2.197.0
