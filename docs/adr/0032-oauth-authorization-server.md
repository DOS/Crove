# 0032. OAuth 2.1 authorization server for third-party apps and MCP clients

- Status: proposed (2026-10-16). The evidence favors one option but is not decisive: the chosen library's CIMD support is experimental, and the in-process mount is unproven. The acceptance tests below turn it into "accepted" before Phase 3 opens `/v1` and `/mcp`.
- Date: 2026-10-16
- Deciders: owner (JOY)
- Builds on: plan Decision 5 and ADR-0027 (users come from Supabase Auth only), ADR-0028 (sessions and revocation), plan Decision 14 ("an OAuth 2.1 authorization server for self-host, chosen in an ADR before Phase 3"), plan §4.11 (`/v1` and `/mcp` never accept a user's browser token) and §8.9 (grants per org, client and user)
- Tracking: issue #67; consumer: epic #68 (public API, webhooks, SDKs, MCP server)

## Context and problem statement

Phase 3 opens two surfaces to software that is not the Crove SPA: the public `/v1` API and the `/mcp` server. Both must accept only tokens from an OAuth 2.1 authorization server (AS), never a user's Supabase browser token (plan §4.11, §7.5). Third-party apps and MCP clients (Claude, ChatGPT, IDE agents and the like) get a token after the user consents, and Crove derives the org and the grant server-side (§8.9: `agent_grant` per org, client and user, one org and one `max_risk` per grant).

Constraints already decided elsewhere:

- One identity. Users sign in with Supabase Auth; the kernel maps `(issuer, subject)` to `user_account` and keeps org membership itself (ADR-0027). The AS must not become a second user store.
- The open-source core runs with `docker compose up` and no proprietary or paid service (Decision 4). Self-host is a hard requirement.
- Lean (principle 13): only Postgres and containers; a capability enters the kernel when it is a security invariant or has two consumers. `/v1` and `/mcp` are the two consumers here.
- No vendor self-migration (plan §15); Supabase Auth's own `auth` schema is the one accepted exception (ADR-0027).
- No in-house IdP (plan §15): the Phase 3 AS is an off-the-shelf component.
- Crove Cloud runs the same code with the hosted IdP as the user store, and Crove has no admin access to that IdP (ADR-0028).

The plan named three candidates (Zitadel, Ory Hydra, Keycloak). This ADR adds two more: Supabase Auth's own OAuth 2.1 server, which shipped since the plan was written, and "Crove issues its own tokens".

## Facts this ADR relies on

Checked on 2026-10-16 against official documentation, release listings and source. Anything not checked at the source is marked "unverified".

**MCP authorization, revision 2026-07-28** [1]

1. "Authorization servers **MUST** implement OAuth 2.1", and AS metadata is required: RFC 8414 or OpenID Connect Discovery, and "MCP clients **MUST** support both".
2. "Authorization servers and MCP clients **SHOULD** support OAuth Client ID Metadata Documents" (CIMD, draft-ietf-oauth-client-id-metadata-document). Dynamic Client Registration (DCR, RFC 7591) is "**MAY**" and "is deprecated and retained for backwards compatibility with authorization servers that do not support Client ID Metadata Documents".
3. Clients "**MUST** implement Resource Indicators for OAuth 2.0" (RFC 8707) and send `resource` "in both authorization requests and token requests", "regardless of whether authorization servers support it". MCP servers "**MUST** validate that access tokens were issued specifically for them as the intended audience" and "**MUST NOT** accept or transit any other tokens".
4. MCP servers "**MUST** implement OAuth 2.0 Protected Resource Metadata (RFC 9728)". Authorization servers "**SHOULD** include the `iss` parameter in authorization responses" (RFC 9207); a later revision is expected to make it a MUST.

**Supabase Auth OAuth 2.1 server** (Crove bundles `supabase/gotrue:v2.197.0`, the latest stable release, 2026-09-09)

5. Supabase's docs: "OAuth 2.1 server is in beta and available on all Supabase plans" [2]. The authorization code flow requires PKCE; the consent UI is the app's own page at "Site URL + Authorization Path"; access tokens are "standard Supabase JWTs that include `user_id`, `role`, and `client_id` claims" [3]. Documented scopes: `openid`, `email`, `profile`, `phone` [3].
6. Source at `v2.197.0` [4]: the server is off by default (`OAuthServerConfiguration.Enabled default:"false"`; settings `GOTRUE_OAUTH_SERVER_ENABLED`, `..._ALLOW_DYNAMIC_REGISTRATION`, `..._AUTHORIZATION_PATH`). Routes: `/oauth/authorize`, `/oauth/token`, `/oauth/userinfo`, `/oauth/clients/register` (DCR, public, rate limited), consent at `/oauth/authorizations/{id}/consent`, and a user grant list and revoke at `/user/oauth/grants`. The metadata response has no `revocation_endpoint`, no `introspection_endpoint` and no `authorization_response_iss_parameter_supported`: there is no RFC 7009 revocation, no RFC 7662 introspection and no RFC 9207 `iss` at that tag.
7. RFC 8707: `/oauth/authorize` validates `resource` and stores it on the authorization; the token endpoint compares it (read from JSON bodies only; the form-encoded branch does not read it). The issued access token's audience stays the user's audience (`Audience: jwt.ClaimStrings{params.User.Aud}`, normally `authenticated`), so the token is not bound to the resource. Supabase's guide suggests a Custom Access Token hook to "set the `aud` claim to the third-party API endpoint" [2]; the hook sees `client_id` but not the requested `resource`.
8. CIMD is not supported: client IDs are UUIDs, and the feature request "OAuth 2.1 server: support Client ID Metadata Documents (URL `client_id`) for MCP clients" is open (supabase/auth#2850, 2026-10-02). Other open OAuth-server issues at the time of writing: MFA verification deletes OAuth client sessions (#2801), loopback redirect URIs on ephemeral ports are rejected (#2703, fix PR #2871 open), and OAuth tokens do not inherit the approving session's AAL (PR #2869 open).

**Keycloak** (latest stable 26.8.1, 2026-10-13; Apache-2.0) [5]

9. Keycloak's MCP guide lists OAuth 2.1, RFC 8414, RFC 9207 and DCR as "Supported", and RFC 8707 and CIMD as "Experimental", behind `--features=cimd,resource-indicators`. With RFC 8707 on, Keycloak "issues an `aud` containing only that value"; without it, audience comes from client scopes with an audience mapper.
10. Sizing guide: "The base memory usage for a Pod including caches of Realm data and 10,000 cached sessions is 1250 MB of RAM" [6]. Keycloak keeps its own user store and its own login and consent pages (themes), and migrates its own schema (Liquibase; well known, not re-checked here).

**Zitadel** (latest stable v4.19.5, 2026-10-15; AGPL-3.0)

11. DCR (RFC 7591) was implemented in mid-2026: a maintainer wrote on zitadel#9810 (2026-08-10) "DCR already merged and to be released this week", and zitadel#12658 reports DCR in use on 4.17. CIMD is an open PR (zitadel#12860, rebased from #12316, adds allowed `client_id` URLs). RFC 8707 is an open feature request (zitadel#12710, 2026-09-08).
12. Zitadel has its own user store and its own org model. The v4 self-host setup runs the API plus a separate login UI container and PostgreSQL. Memory figures found (about 512 MB for the core, or about 130 MiB measured each for API and login UI) are from third-party write-ups: unverified.

**Ory Hydra** (latest release v26.2.0, 2026-03-20; Apache-2.0)

13. "Ory OAuth2 and OpenID Connect doesn't contain a database with end users"; "The Login Endpoint ... is an application written by you", which accepts the login challenge with a subject [7]. Consent is likewise the app's own endpoint. DCR is supported (`/oidc/dynamic_client_registration/enabled`) [8]; RFC 7009 revocation and RFC 7662 introspection are part of Hydra (well known, not re-checked here).
14. Audience uses Hydra's own `audience` parameter, validated against a per-client allow list [9]; the docs do not mention RFC 8707 `resource`. CIMD is requested in open issues (ory/hydra#4061, 2026-01-17; #4134, 2026-10-13). Hydra applies its own schema with `hydra migrate sql`. Its footprint as a single Go binary is small; no official figure was found (unverified).

**`oidc-provider`** (npm `oidc-provider` 9.12.2, 2026-09-05; MIT; by the author of `jose`, which the kernel already uses) [10] [11]

15. An OAuth 2.0 AS library for Node with OpenID Connect, OpenID Certified (Basic, Config, Back-Channel and RP-Initiated Logout, FAPI 1.0 and 2.0 profiles). Implemented: RFC 8414 metadata and OIDC Discovery, DCR (RFC 7591) and its management (RFC 7592), RFC 7009 revocation, RFC 7636 PKCE, RFC 7662 introspection, RFC 8252 native apps, RFC 8707 resource indicators, RFC 9207 `iss` in authorization responses, RFC 9449 DPoP, RFC 9068 JWT access tokens. CIMD (draft 02) is an "experimental feature", off by default, with `allowFetch` (domain allow lists, rate limits) and `allowClient` hooks and a bounded cache.
16. With `features.resourceIndicators`, "Issued Access Tokens shall always only contain scopes that are defined on the respective Resource Server". Users are not stored by the library: `findAccount` resolves an account id, and end-user interactions (login, consent) are the application's own pages.
17. Storage is a pluggable adapter; the built-in one is in memory, and "Production deployments MUST provide a custom adapter". Runtime dependencies: `koa`, `jose`, `debug`.
18. `oauth4webapi` is a client library ("Low-Level OAuth 2 / OpenID Connect Client API"), so an AS "built on oauth4webapi and jose" would be written by Crove.

## Decision drivers

1. MCP 2026-07-28 conformance: OAuth 2.1 with PKCE, CIMD first (DCR only as fallback), RFC 8707 audience binding, RFC 9207 `iss`.
2. One identity: Supabase Auth stays the only user store, in self-host and in Cloud.
3. Grants are Crove's: org, client, user and `max_risk` live in `agent_grant`, are revoked when membership ends, and take effect on the next request (the ADR-0028 standard).
4. OSS core runs locally with no proprietary service; license compatible with `AGPL-3.0-only`.
5. Small self-host: RAM, containers and an extra schema count. A self-hoster today runs three containers (Postgres, Supabase Auth, Crove).
6. Operational burden: upgrades, migrations, keys, backups.
7. Maturity of the protocol implementation (certification, release history).
8. One code path for self-host and Crove Cloud.

## Considered options

### Option A: Supabase Auth's OAuth 2.1 server (rejected for now; revisit)

Turn on `GOTRUE_OAUTH_SERVER_ENABLED` in the bundled Supabase Auth; Crove builds the consent page.

- Good: no new container, no new schema owner; users are native (one identity by construction); OAuth sessions are rows in `auth.sessions`, so the self-host `db` session check of ADR-0028 would cover them; MIT; free.
- Bad: beta (fact 5). No CIMD (fact 8), which MCP prefers. Tokens are not audience-bound (fact 7): the `aud` stays `authenticated`, the same audience the kernel accepts for browser tokens today, so a third-party token and a user's browser token differ only by `client_id`. A hook could set `aud`, but it cannot see `resource`. No RFC 7009, RFC 7662 or RFC 9207 (fact 6). Only the documented OIDC scopes, so Crove's grant model has no scope vocabulary there. Several open OAuth-server bugs that hit MCP clients directly (fact 8).
- Bad for Cloud: the AS would live in the hosted IdP, which Crove does not administer (ADR-0028). Client registration, consent path and policy for Crove's third-party clients would become changes in another product's identity project. Self-host and Cloud would diverge.
- Revisit when Supabase Auth leaves beta and ships CIMD, resource-bound `aud`, RFC 7009 revocation and RFC 9207 `iss`. Then it becomes the lowest-footprint option for self-host.

### Option B: embed `oidc-provider` in the kernel (chosen)

The kernel's `api` role mounts `oidc-provider` as the deployment's AS. Supabase Auth keeps signing users in; the AS has no user store and asks the Crove SPA (signed in with Supabase Auth) for login and consent.

- Good: every MCP 2026-07-28 requirement is implemented today (facts 15, 16), including RFC 8707 audience binding and RFC 9207; CIMD exists, though experimental. Certified, MIT, three runtime dependencies, one of which (`jose`) Crove already pins.
- Good: one identity by construction: the account id is `user_account.id`, resolved from a verified Supabase token through the existing kernel path. No shadow users, no second org model.
- Good: no new container and no extra RAM tier: it runs inside the existing Node process. Its storage is Crove's own committed migration (no vendor migrator), backed up with the rest of the database.
- Good: identical in self-host and Cloud: in Cloud the hosted IdP stays a pure user IdP; nothing about Crove's third-party clients lives there.
- Bad: Crove now holds AS signing keys and AS configuration, so a misconfiguration is Crove's bug, not a vendor's. Mitigated by the library's secure defaults and the acceptance tests below, and by keeping the configuration in one protected-path file.
- Bad: `oidc-provider` is a Koa application; mounting it under Hono on `@hono/node-server` (path prefix, raw body, CSP) is unproven in this repo.
- Bad: one maintainer (bus factor). The same is true of `jose`, already a core dependency; the fallback is Option C.
- Bad: CIMD is experimental, and the library ships draft updates as minor versions. Exact pins (the version policy) plus the feature's `ack` setting make a draft change a visible Renovate PR.

### Option C: Ory Hydra (fallback)

A separate Hydra container; Crove implements Hydra's login and consent endpoints.

- Good: no user store (fact 13), so the identity model fits as well as Option B. Apache-2.0, Go, small, mature, OpenID Certified (well known, not re-checked). Revocation and introspection exist.
- Bad: no RFC 8707 and no CIMD today (fact 14). Hydra's `audience` parameter is not what MCP clients send, so audience binding needs the consent handler to force the audience. DCR exists, but MCP deprecates it.
- Bad: one more container, and Hydra migrates its own schema (`hydra migrate sql`), a second vendor migrator next to Supabase Auth's. Slower release cadence (latest release 2026-03-20).
- Kept as the fallback if Option B fails its acceptance tests: the identity and grant design below carries over unchanged (Crove answers login and consent, Crove owns grants).

### Option D: Keycloak (rejected)

- Good: most complete enterprise IAM (SAML, LDAP, fine-grained admin); RFC 8707 and CIMD exist behind feature flags (fact 9); Apache-2.0.
- Bad: about 1.25 GB RAM per instance by its own sizing guide (fact 10), more than the rest of the self-host stack combined (unverified for that comparison: Crove's own stack has not been measured).
- Bad: its own user store. Users would have to be brokered from Supabase Auth, which needs Supabase Auth to act as an OIDC provider (Option A turned on anyway) or a custom federation provider, and then exist twice. Its own login and consent pages, themes and Liquibase migrations.
- Bad: CIMD and RFC 8707 are still experimental.

### Option E: Zitadel (rejected)

- Good: modern Go IAM with native multi-tenancy; AGPL-3.0 (compatible with Crove's license); DCR now shipped (fact 11).
- Bad: its own user store and its own organization model, which would duplicate Crove's orgs and memberships (the source of truth stays in Crove, so two org models drift). Two extra containers (API and login UI). CIMD and RFC 8707 not released (fact 11).

### Option F: a minimal AS written by Crove on `jose` / `oauth4webapi` (rejected)

- Good: smallest code surface in theory.
- Bad: Crove would implement the authorization endpoint, PKCE, code and refresh rotation, CIMD fetching with SSRF defenses, metadata and error semantics itself. That is the "in-house IdP" the plan excludes, and `oauth4webapi` is a client library (fact 18), so it saves little. Option B gives the same in-process shape with a certified implementation.

### Summary

| Criterion | A Supabase Auth | B `oidc-provider` | C Hydra | D Keycloak | E Zitadel |
|---|---|---|---|---|---|
| OAuth 2.1 + PKCE | Yes (beta) | Yes | Yes | Yes | Yes |
| CIMD (MCP SHOULD) | No (#2850 open) | Experimental | No (#4061 open) | Experimental | No (PR open) |
| DCR (MCP MAY, deprecated) | Yes | Yes | Yes | Yes | Yes (2026) |
| RFC 8707 audience binding | Stored, not bound | Yes | No (own `audience`) | Experimental | No (#12710) |
| RFC 7009 / RFC 7662 | No / No | Yes / Yes | Yes / Yes (not re-checked) | Yes / Yes (not re-checked) | Yes / Yes (not re-checked) |
| RFC 9207 `iss` | No | Yes | Not checked | Yes | Not checked |
| Consent UI | Crove builds | Crove builds | Crove builds | Keycloak theme | Zitadel login UI |
| One identity with Supabase Auth | Native | Native (no user store) | Native (no user store) | Brokered copy | Brokered copy |
| Org scoping of grants | Crove (`agent_grant`) | Crove | Crove | Crove, plus Keycloak's model | Crove, plus Zitadel orgs |
| License | MIT | MIT | Apache-2.0 | Apache-2.0 | AGPL-3.0 |
| Extra containers | 0 | 0 | 1 | 1 | 2 |
| RAM | 0 | In-process (to measure) | Small (unverified) | About 1.25 GB | Unverified |
| Extra schema, migrator | None | Crove's own migration | Hydra's migrator | Liquibase | Zitadel's migrator |
| Cloud | Lives in the hosted IdP | Same as self-host | Same as self-host | Same as self-host | Same as self-host |

## Decision

1. **Authorization server.** The kernel embeds `oidc-provider` (exact pin) as the deployment's OAuth 2.1 AS, served by the `api` role on the deployment's `PUBLIC_URL` (issuer `PUBLIC_URL`, with metadata at `/.well-known/oauth-authorization-server` and `/.well-known/openid-configuration`). It is off until Phase 3 and turned on with one setting (`OAUTH_SERVER=on`); boot fails when it is on without signing keys. Its configuration lives in one module under a protected path.
2. **Identity.** The AS stores no users. Its account id is `user_account.id`. Login and consent are SPA routes: the AS redirects to `/oauth/authorize/<interaction id>`, the SPA makes sure the user is signed in with Supabase Auth (existing flows, MFA rules of #126 included), and calls a kernel command with the user's Supabase token. The kernel verifies that token exactly as for any request (ADR-0028), then finishes the interaction. The AS's own session cookie is short-lived and authorizes nothing but the interaction; it is not a Crove session in the sense ADR-0028 rejected, and it never authorizes `/api`.
3. **Grants and org scoping.** Consent picks exactly one org and one `max_risk` (§8.9) and creates or updates an `agent_grant` row (tenant data, in the org's cell) through `kernel.execute()`, audited. One grant per (org, client, user). Positions on an external runtime (ADR-0029) bind a grant to `(org, client_id, agent_id)` the same way. Scope names and their mapping to risk levels belong to the MCP grants ADR (plan ADR 0019); the grant row, not the scope string, is the authority.
4. **Tokens.** Access tokens are RFC 9068 JWTs signed with the AS's own keys, 15 minutes by default, carrying `iss`, `aud` (exactly one resource), `sub` (the `user_account` id), `client_id`, `scope`, and Crove claims for the org and the grant id. Resources (RFC 8707) are the deployment's `/mcp` URL and its `/v1` URL; an unknown `resource` is `invalid_target`. Refresh tokens rotate and are stored, bound to the grant.
5. **Verification at `/v1` and `/mcp`.** The kernel verifies the token with `jose` against the AS keys: issuer, audience equal to the surface's own resource URL, expiry, and the presence of the grant claims. In the request transaction it then checks that the grant is active and still matches org, client and user, and that the user is still a member (the same fail-closed pattern as `auth_session`). Revoking a grant, ending a membership or pausing an agent takes effect on the next request; refresh tokens of a revoked grant are destroyed. Supabase tokens are rejected on `/v1` and `/mcp`; AS tokens are rejected on `/api` (different issuer and audience).
6. **Client registration.** CIMD on, as MCP prefers it. The metadata fetch goes through the egress and SSRF guard (plan ADR 0016): HTTPS only, public addresses only, size and time limits, plus a deployment allow list of client hosts (default: any public host). DCR off by default; a deployment may enable it for older MCP clients, rate limited, with unused registrations expiring. Confidential clients (third-party servers using `/v1`) are pre-registered by an org owner or staff through an audited command.
7. **Storage.** One committed, idempotent migration adds the AS tables in the control plane (§3.6): clients, authorization codes, refresh tokens, interactions and grants of the library, keyed so that no raw code or refresh token is stored (keys are hashes). Expired rows are purged by the existing housekeeping. `agent_grant` stays tenant data.
8. **Keys.** The AS signing keys (ES256) come from the deployment's secret store (`OAUTH_JWKS`); the published JWKS keeps a retired key until every token it signed has expired. Self-host generates a key set during setup; nothing is generated silently at boot.
9. **MCP discovery.** `/mcp` serves RFC 9728 Protected Resource Metadata pointing at the issuer and answers 401 with `WWW-Authenticate: Bearer resource_metadata=...` and the required `scope`, per the MCP spec.
10. **Supabase Auth's OAuth server stays off.** The compose stack does not set `GOTRUE_OAUTH_SERVER_ENABLED`. Because a Supabase OAuth token carries `aud = authenticated` and `role = authenticated` like a browser token (fact 7), the kernel rejects any Supabase token that carries a `client_id` claim on every surface, so turning that server on in some deployment's Supabase Auth cannot hand a third-party client a user's browser access to Crove.
11. **Crove Cloud.** Same component, same code. The hosted IdP signs users in to the Crove SPA and nothing else; Cloud-only client policy (which client hosts are trusted, review of registrations) plugs into the CIMD `allowFetch` / `allowClient` hooks and the allow list from item 6, configured in `crove-cloud`.

## Consequences

- No new container, no new user store and no new vendor migrator for self-host; the AS is a feature of the Crove image.
- `/v1` and `/mcp` get one token model, audience-bound per surface, and grants that revoke as fast as sessions do.
- Crove owns AS configuration and keys: key rotation joins the secret runbooks, and AS configuration changes are protected-path PRs with the security reviewer.
- The kernel gains a Koa-based dependency inside the `api` role. If the mount proves fragile, Option C (Hydra as a sidecar) replaces only the protocol engine: items 2, 3, 5 and 9 stay.
- Supabase Auth's OAuth server becomes a revisit trigger, not a dependency.
- The plan's "no in-house IdP" stays true: users and login stay in Supabase Auth, and the protocol engine is an off-the-shelf certified library.

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| CIMD draft changes break clients | Exact pin and the feature's `ack`; Renovate PR runs the MCP conformance test below; DCR can be turned on as a stopgap |
| SSRF through CIMD fetches | Fetch through the egress guard (public addresses only, HTTPS, size and time limits), allow list per deployment, fetch coalescing and cache bounds of the library |
| A third-party token used as a browser token, or the reverse | Different issuers and audiences (items 5, 10); route-level tests in both directions |
| Consent phishing (a client named like a known app) | Consent screen shows the client's host from its CIMD URL or registration, not only its display name; DCR off by default |
| Single-maintainer library | Same exposure as `jose`; Option C is the documented fallback |
| AS key leak | Keys in the secret store only; rotation keeps verification working; short access-token lifetime; refresh tokens bound to revocable grants |

## Acceptance tests (before Phase 3 opens `/v1` or `/mcp`; then status becomes accepted)

1. Mount: `oidc-provider` served under the Hono `api` role on Node 26, with discovery, authorization, token, revocation and introspection endpoints answering per spec, CSP intact on the SPA consent route.
2. MCP conformance: the official MCP TypeScript SDK client completes CIMD registration, the authorization code flow with PKCE (S256 only) and `resource`, checks `iss`, and calls `/mcp`; the token's `aud` is exactly the `/mcp` URL.
3. Audience: a token for `/v1` is refused at `/mcp` and the reverse; an unknown `resource` is `invalid_target`.
4. Token separation: a Supabase browser token is refused at `/v1` and `/mcp`; an AS token is refused at `/api/rpc`; a Supabase token with a `client_id` claim is refused everywhere.
5. Revocation: revoking the grant, removing the member and pausing a position agent each make the next `/mcp` request 401 and the next refresh fail.
6. SSRF: a CIMD URL resolving to a private, loopback or link-local address is refused before any connection.
7. Storage: no raw authorization code or refresh token appears in the database; purge removes expired rows.
8. Footprint: the `api` process RSS with the AS on and idle is measured and recorded in this ADR.

## References

1. MCP specification 2026-07-28, Authorization: https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization (read 2026-10-16 via `/specification/latest/`).
2. Supabase, OAuth 2.1 server, getting started: https://supabase.com/docs/guides/auth/oauth-server/getting-started
3. Supabase, OAuth 2.1 server overview: https://supabase.com/docs/guides/auth/oauth-server ; MCP authentication: https://supabase.com/docs/guides/auth/oauth-server/mcp-authentication
4. Supabase Auth source at tag `v2.197.0`: `internal/api/api.go` (routes), `internal/api/jwks.go` (metadata), `internal/api/oauthserver/authorize.go` and `handlers.go` (resource handling), `internal/tokens/service.go` (access token audience), `internal/conf/configuration.go` (`OAuthServerConfiguration`): https://github.com/supabase/auth/tree/v2.197.0 ; issues and PRs supabase/auth#2850, #2801, #2703, #2869, #2871.
5. Keycloak, Integrating with Model Context Protocol: https://www.keycloak.org/securing-apps/mcp-authz-server ; releases: https://github.com/keycloak/keycloak/releases
6. Keycloak, Concepts for sizing CPU and memory resources: https://www.keycloak.org/high-availability/single-cluster/concepts-memory-and-cpu-sizing
7. Ory Hydra, Login: https://www.ory.com/docs/hydra/concepts/login
8. Ory Hydra, OAuth2 clients: https://www.ory.com/docs/hydra/guides/oauth2-clients
9. Ory Hydra, Audiences: https://www.ory.com/docs/hydra/guides/audiences ; issues ory/hydra#4061, #4134.
10. `oidc-provider` README and configuration docs (9.12.2): https://github.com/panva/node-oidc-provider and https://github.com/panva/node-oidc-provider/blob/main/docs/README.md
11. `oauth4webapi` README: https://github.com/panva/oauth4webapi
12. Zitadel issues and PRs: zitadel/zitadel#9810, #12658, #12710, #12860; releases: https://github.com/zitadel/zitadel/releases
