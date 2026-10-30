# 0027. Open-source core vs Crove Cloud, and auth on Supabase Auth

- Status: accepted (decision 4, the app shell, and decision 5, the brand, decided by the owner on 2026-10-14)
- Date: 2026-10-13
- Deciders: owner (JOY)
- Supersedes: ADR-0026 decision 3's 4-6 week time-box (now a one-week MVP, open source first) and decision 4 (DOS ID via OIDC first); the "self-host deferred" row of the Phase 0 deferral table

## Context

The plan mixed two products: an open-source Business OS for any developer, and Crove OS run by DOS. That put DOS ID, DOS.AI and DOS org sync on the core's critical path and deferred self-hosting. An OSS product that cannot run on a laptop without DOS services is not usable by other developers.

For login, the options were OIDC only (self-hosters must bring an IdP), a library such as Better Auth inside the kernel, or Supabase Auth (GoTrue). DOS ID is itself Supabase Auth, and its project signs access tokens with ES256 and publishes a JWKS. The full self-hosted Supabase stack is about ten containers and several GB of RAM, and most of it (PostgREST, Realtime, Edge Functions) is not used or conflicts with the single write path.

A stack review on 2026-10-13 (docs/recommendations) found the Next.js app shell used mostly as a client SPA, and recommended Vite + TanStack Router.

## Decision

1. `DOS/Ludy` is the open-source core. It contains no DOS-only features and must run with `docker compose up` on a laptop: Postgres 17, Supabase Auth, Crove (api + worker + UI), and Mailpit for local email. Every external dependency sits behind an adapter with a generic default.
2. A private `crove-cloud` repo holds Crove OS for DOS: DOS configuration, DOS.AI defaults and credits, DOS org sync, managed connectors, infrastructure and the `app.crove.com` deployment. It depends on the core; the core never depends on it.
3. Auth uses Supabase Auth only (no other Supabase services). The web app uses the Supabase Auth client; the kernel verifies access tokens (JWKS or the deployment's JWT secret), maps them to `user_account` and keeps org membership in Crove. Crove Cloud points the same code at DOS's Supabase Auth.
4. The app shell is a Vite + TanStack Router SPA served by the kernel on the same origin, and Next.js stays for the landing page. Decided by the owner on 2026-10-14 after a Codex review and two blind reviews; fallback: React Router v8.
5. Brand: the open-source core and the hosted product share one name, Crove ("Crove" and "Crove Cloud"), endorsed by the DOS house brand ("Crove by DOS", sign-in with DOS ID on Cloud), the way Android sits under Google. Apps carry the brand ("Crove CRM", "Crove Books"). Domains: `crove.com` for the landing page and docs, `app.crove.com` for Crove Cloud. Decided by the owner on 2026-10-14 after a naming review; rejected: a DOS-branded product (a sibling of dos.me and dos.ai), a brand on the owner's other domains, and new coined names (no candidate was clearly better, and almost every short coined `.com` is taken).

## Consequences

- Self-host works from day one; Crove Cloud is configuration plus a thin private layer.
- Email + password, magic link, social and OIDC providers, MFA and password reset come from Supabase Auth instead of custom code.
- Supabase Auth owns and migrates its `auth` schema. This is an accepted exception to "no vendor self-migration": it touches only `auth`, never `crove_*`.
- Core auth is coupled to the Supabase Auth API. Swapping it later means a new identity adapter; `user_account` keeps `(issuer, subject)` so users survive the swap.
- Open spike: whether Supabase Auth runs on the plain `postgres:17` image or needs Supabase's Postgres image.
- Cloud-only parts of the plan body (DOS prerequisites, Cloud topology, costs) move to `crove-cloud` when it is created.
- One neutral name lets developers adopt the core without buying into DOS, while Cloud still sells through DOS ID and DOS.AI.

## Update 2026-10-30: domains

The owner renamed the product to Ludy on 2026-10-28 (#1682) and moved the domains on 2026-10-30: the landing page is served on `ludy.vn` (canonical) and `ludy.so`, and the hosted app moves to `app.ludy.vn`. The names `crove.com` and `app.crove.com` in decision 5 are kept as the historical record.
