# Runbook: pilot readiness

Before a consenting design partner puts real client data into a Crove deployment, every item below holds and the owner records the sign-off in issue #308. This checklist replaces the External-tenant gate for a partner under a signed pilot agreement only (backlog review 2026-10-17, decision D2 and M1-8); the full gate (GA gate) still applies before public self-serve sign-up.

## The preflight

Run it from a checkout whose `.env` is the deployment's `.env` (the file `docker compose` reads), after `pnpm install`:

```bash
pnpm pilot:check                                   # the settings in .env
pnpm pilot:check -- --url https://crove.example.com  # also probe the running instance
```

Without a checkout of the deployment's `.env` (another secret store, Kubernetes), export the same variables and run `node apps/kernel/src/main.ts pilot-check [--url <public URL>]`. Variables already set in the shell win over `.env`, as they do for `docker compose`. The preflight reads `.env` values literally, while `docker compose` expands `$NAME` inside them: keep `$` out of generated secrets (`openssl rand -hex 32` has none), or the checked value is not the deployed one.

Each line is `PASS`, `FAIL` or `MANUAL`. Exit codes: 0 every automatic check passed, 1 a check failed, 2 bad arguments. `MANUAL` lines are what only a person can confirm; the sections below say how.

`--url` probes four things on the running instance: `/healthz` over https (the certificate chain and host name are verified), plain http on port 80 (the connection is refused, or it redirects to https on the same host; a timeout fails as inconclusive), a sign-up nobody may make (below), and the confirmation setting the running Supabase Auth reports (`GET <auth URL>/settings`, the Auth URL taken from `/api/config`: `mailer_autoconfirm` must be `false`). The probe follows no redirect and only uses an Auth URL on the same origin as `--url` (the bundled Supabase Auth behind `/auth/v1`); a remote Auth URL fails and is checked by hand. The probe sees what the services really run with, so it catches a `.env` change that was never applied (`docker compose up -d` recreates the services whose settings changed).

The sign-up probe does not trust what the instance says about itself (`/api/config` reports the policy, `/settings` reports `disable_signup`). It sends `POST <auth URL>/signup` for a random address at the reserved domain `pilot-check.invalid` (RFC 2606: it never resolves, no allowlist holds it and no invite names it), with no password:

- `403 signup_not_allowed`: Crove's proxy refused it under `invite_only` or `allowlist`. `PASS`. Nothing was created or mailed; the request used one slot of the email budget of the address `pilot-check` runs from (section 5), for an hour.
- `signup_disabled`: the running Supabase Auth refuses every sign-up (`AUTH_DISABLE_SIGNUP=true`). `PASS`.
- Supabase Auth's own refusal of the body (400 or 422 with an error code, `validation_failed` on the pinned version): the request passed every sign-up gate, so anyone can create an account. `FAIL`. Supabase Auth refuses a sign-up without a password before it creates or mails anything (`e2e/tests/auth-signup-parity.spec.ts` checks this against the pinned image), so the probe leaves nothing behind here either.
- An accepted sign-up (2xx, which the pinned version never answers to this body): `FAIL`, naming the address; delete that account (step 4 of "Closed sign-up" in section 5).
- Anything else, such as 429 (the email budget or Supabase Auth's rate limit), 503, a timeout or an answer that is not Supabase Auth's (a 400 or 422 without its error code may come from a reverse proxy or firewall in front): `FAIL` with "could not tell whether sign-up is limited". The probe could not decide; run `pilot-check` again later, or check by hand that a sign-up for an address outside the policy gets `403 signup_not_allowed`.

## 1. TLS on every public endpoint; every secret changed from the defaults

**TLS.** Compose publishes Crove on loopback only; a TLS reverse proxy (Caddy, nginx, a cloud load balancer) serves it to others. Set `PUBLIC_URL` to the https URL and `TRUSTED_PROXY_HOPS` to the number of proxies in front. The pilot's server setup, with a ready Caddy configuration in `tools/deploy/caddy/`: [provision-pilot.md](provision-pilot.md).

- Checked by `pilot:check`: `PUBLIC_URL` is https and not a loopback host; `PUBLIC_AUTH_URL`, when set, is https; with `STORAGE=s3` and presigned transfers (the default), the bucket endpoint browsers reach (`S3_PUBLIC_ENDPOINT`, else `S3_ENDPOINT`) is https; `TRUSTED_PROXY_HOPS` is 1 to 5 (the kernel serves plain http, so a pilot always has a proxy in front).
- With `--url`: the certificate is valid for the host, and plain http does not serve the app.
- **Why `TRUSTED_PROXY_HOPS` matters (#564).** The kernel counts every per-client limit by the client's address: the email budget of the `/auth/v1` proxy (`AUTH_EMAIL_CLIENT_LIMIT_PER_HOUR`, default 5 an hour), Supabase Auth's sign-in, sign-up and recovery limits (it keys them on the `X-Real-IP` the proxy sets), and failed stream ticket redeems. With `TRUSTED_PROXY_HOPS=0` behind a reverse proxy, the kernel sees the proxy's address on every request, so all clients share one of each. A refused sign-up (section 5) keeps its email slot on purpose, so a handful of refused or mistyped sign-ups from anyone, deliberate or not, use up the confirmation and recovery emails of every user for up to an hour, and one client's wrong passwords hold up everyone's sign-in for a while. The kernel logs `requests carry X-Forwarded-For but TRUSTED_PROXY_HOPS=0` once when it sees this.
  - Set `TRUSTED_PROXY_HOPS` to the number of proxies in front that append to `X-Forwarded-For`: 1 for the Caddy setup in [provision-pilot.md](provision-pilot.md), 2 with a CDN in front of Caddy. The kernel then takes the client address from the entry the outermost trusted proxy appended.
  - The proxy nearest the kernel must overwrite or append to `X-Forwarded-For`, never pass a client's own value through alone, and must see the real client address (Caddy on the host network does; behind a published Docker port, IPv6 clients all show up as the bridge address).
  - Never set it higher than the real number of proxies: the kernel would then read an entry the client wrote itself, and every client could pick its own address and so its own budget.
  - Check it once: wrong-password sign-ins from two different networks (a phone off Wi-Fi) must not share Supabase Auth's rate limit, and the kernel log must not show the warning above.
- Not checked: the SMTP server's TLS (the kernel refuses SMTP credentials without STARTTLS or port 465) and the inbound mail worker's call to `/api/inbound/email` (point it at the https `PUBLIC_URL`; it carries `INBOUND_SECRET`).

**Secrets.** Generate each one, for example with `openssl rand -base64 32`, and keep them in the private secret store, never in git.

- Checked by `pilot:check`: `POSTGRES_PASSWORD`, `CROVE_APP_DB_PASSWORD`, `CROVE_WORKER_DB_PASSWORD`, `CROVE_PROBER_DB_PASSWORD`, `CROVE_REPORTER_DB_PASSWORD` and `AUTH_DB_PASSWORD` are set, at least 16 characters, and none is a value shipped in `.env.example` or the compose files (or contains `change-me`); `AUTH_JWT_SECRET` the same with at least 32 characters; `EXPORT_ENCRYPTION_KEY` is a valid 32-byte key; with `INBOUND_DOMAIN` set, `INBOUND_SECRET` is at least 32 characters; no optional secret (`S3_SECRET_ACCESS_KEY`, `SMTP_PASS`, `AI_API_KEY`, `CREDENTIAL_KEY`) is a sample value.
- An unset variable fails: `docker compose` then falls back to a value published in this repository.
- A changed database password takes effect at the next `migrate` run (`docker compose up` runs it), which sets the role passwords. Changing `POSTGRES_PASSWORD` after the database volume exists does not change the superuser password; change it in PostgreSQL too (`ALTER ROLE postgres PASSWORD ...`).
- The credential key (`CREDENTIAL_KEY` or the key file on the `keys` volume) is generated per deployment; back it up apart from the database (`credential-key.md`).

## 2. `AUTH_AUTOCONFIRM=false` and MFA step-up on

- Checked by `pilot:check`: `AUTH_AUTOCONFIRM=false` is set explicitly (an unset value makes `docker compose` skip confirmation), `SMTP_HOST` names a real server (not `smtp.example.com` or the local Mailpit), and `AUTH_STEP_UP` is unset or `required`.
- With `--url`: the running Supabase Auth reports `mailer_autoconfirm: false`.
- The kernel itself refuses to start on a public `PUBLIC_URL` with `AUTH_AUTOCONFIRM=true` or `AUTH_STEP_UP=off`, so a deployment that serves the app at all has passed this half already.
- By hand, once: sign up a test account, confirm it from the email, enable two-factor under Settings, and approve one proposal; the app asks for a fresh code.

## 3. RLS matrix green (T8) and the extraction sandbox on (T12)

**RLS matrix.** `MANUAL` in `pilot:check`. The generated cross-org RLS matrix (`apps/kernel/test/invariant/rls-matrix.db.test.ts`) runs in the CI `db` job and in the protected-path `Invariant suite`. Confirm both are green on the commit (or release tag) the deployment runs: open that commit's checks on GitHub, or run `pnpm test:db` on it against a scratch PostgreSQL 17 (`CROVE_TEST_ADMIN_URL`).

**Extraction sandbox.** `MANUAL` in `pilot:check`. No setting turns it off: the worker refuses to start without `EXTRACT_URL`, and no kernel, module or package code may import a PDF, XML or MIME parser (`tools/test/parser-imports.test.ts`). What remains is that the sandbox runs as designed:

```bash
docker compose ps crove-extract                                    # Up (healthy)
docker network inspect crove_extract --format '{{.Internal}}'      # true: no route out
```

With another orchestrator, `crove-extract` runs from its own image with no secrets, no published port and no egress, and only the worker reaches it.

## 4. Backups tested

`MANUAL` in `pilot:check`. Nightly backups and a timed restore drill are M1-7 (issue #307). Confirm a restore onto a scratch instance passed, and the RPO and RTO it measured, before sign-off.

## 5. Sign-up limited to invited users or an allowlisted domain

Two ways hold this item. Pick one and record which in issue #308.

**Invite-only sign-up (recommended for the pilot).** `AUTH_SIGNUP_POLICY=invite_only` with `AUTH_DISABLE_SIGNUP=false`. The kernel's `/auth/v1` proxy forwards a sign-up to Supabase Auth only when it carries the token of a valid member invite for exactly that email, which the web app sends when the invitee signs up after opening the accept link: pending, unexpired, in an active org, sent by someone who may still grant that role. Revoked, accepted and expired invites do not count, and the address must match the invited one exactly apart from letter case (`an+x@partner.vn` is not `an@partner.vn`). So the owner creates the org, sends the member invites, and each invitee opens the link from the invite email, signs up there with the invited address (on the same device, within an hour of opening the link), confirms it from the email and accepts the invite; no sign-up window is needed. An invitee who signs up from the plain sign-up page without opening the link is refused and told to open the link.

- Why the link and not just the invited address (#563): Supabase Auth keeps the password of the first unconfirmed sign-up for an address and does not change it on a later one. If knowing an invited address were enough, someone else could sign up first with their own password; the invitee would confirm that account from the email Supabase Auth sends and join the org on it, and the other person could then sign in as that member. Requiring the token means the first sign-up for an invited address comes from someone who opened its accept link. The link is mailed to the invited address and shown once to the inviter, so the inviter is the one other person who could use it.

- `AUTH_SIGNUP_POLICY=allowlist` with `AUTH_SIGNUP_ALLOWED_DOMAINS=partner.vn` (comma separated, exact domains: `sub.partner.vn` is not included) admits any address at those domains, plus anyone holding a valid invite (an outside accountant). An invited address needs its accept link under `allowlist` too, even at an allowed domain.
- Unset or `open`: the proxy checks nothing, as before; `AUTH_DISABLE_SIGNUP` alone decides.
- Every refused sign-up gets the same answer (403 `signup_not_allowed`, "Email này chưa được phép đăng ký tài khoản"), whatever the reason, and never reaches Supabase Auth. A refused attempt still uses one slot of the client's email budget (`AUTH_EMAIL_CLIENT_LIMIT_PER_HOUR`), which bounds how many addresses one client can try. The cost: several mistyped addresses from one office address (a shared NAT) can hold up that office's sign-up and recovery emails for up to an hour; raise the limit for the partner's sign-up day if needed. The bound holds only with email confirmation on (`AUTH_AUTOCONFIRM=false`, which a public deployment requires). Behind a reverse proxy it holds per client only with `TRUSTED_PROXY_HOPS` set (section 1); with `0`, the "office" is everyone.
- Known gap, guessing who holds an invite under `allowlist` (#564): at an allowed domain, a sign-up for an address with a pending invite is refused without its link, and one for any other address goes through, so the answer tells whether an address at the partner's domain has been invited. The email budget bounds the guesses per client address, but it counts IPv6 per /64, and one IPv6 customer often holds a /56 or /48 (256 to 65,536 /64s), so such a client can guess many more. Under `invite_only` every sign-up without a token is refused, so there is nothing to guess: another reason to prefer it. With `allowlist`, revoke invites that are not accepted soon, or limit `/auth/v1/signup` per /48 at the reverse proxy if the partner's domain is a concern.
- Known gap, email changes (#564): the policy decides who may create an account, not which address an account keeps. A signed-in user can change their email (`PUT /auth/v1/user`) to an address at any domain, once they confirm the new address (and the old one, while Supabase Auth's secure email change is on, its default). That gives no access by itself: membership comes only from an invite accepted by the confirmed address it was sent to. If the partner requires every account to stay at its domain, check the account list (step 4 of "Closed sign-up" below) before sign-off and from time to time.
- Create the owner's account before setting the policy (or use `allowlist` with the owner's domain): under `invite_only` nobody can sign up until an org exists to send invites.
- Addresses are checked as plain ASCII: an invite to an address with non-ASCII characters (an internationalized domain) cannot be used to sign up while the policy is restricted.
- While the policy is `invite_only` or `allowlist`, the proxy also refuses what could create an account from an identity it cannot read: phone and anonymous sign-ups, OAuth sign-in (`/authorize`, `/callback`), ID-token and Web3 grants (these answer 403 `signup_method_not_allowed`), and email codes (`/otp`) that may create an account (a client signing existing users in by code sends `create_user: false`). Password sign-in, refresh, password recovery and email confirmation work as before.
- The kernel refuses to start with `allowlist` and no domains, with domains under another policy, with a domain it cannot parse, or with a restricted policy and no bundled Supabase Auth behind the proxy (`AUTH_UPSTREAM_URL`; a remote Supabase Auth is restricted in its own settings). If the database cannot answer the invite check, the sign-up is refused with 503.
- Checked by `pilot:check`: `AUTH_SIGNUP_POLICY` is `invite_only`, or `allowlist` with `AUTH_SIGNUP_ALLOWED_DOMAINS`. With `--url`: a sign-up for a random address at a domain no allowlist holds gets `403 signup_not_allowed` from the running instance (the sign-up probe above; what `/api/config` reports is not enough, and the domains are never published).
- After the partner's users joined, check that only expected accounts exist (step 4 below).

**Closed sign-up.** `AUTH_DISABLE_SIGNUP=true` (`GOTRUE_DISABLE_SIGNUP` of the bundled Supabase Auth) refuses every new account while existing accounts sign in as usual. It still works with any `AUTH_SIGNUP_POLICY`.

- Checked by `pilot:check`: `AUTH_DISABLE_SIGNUP=true`. With `--url`: the sign-up probe gets `signup_disabled` from the running Supabase Auth (or `403 signup_not_allowed`, when a restricted policy refuses it first).
- A member invite needs the invitee to have an account (the invite binds to the signed-in, confirmed email), so with sign-up closed new accounts are created in a short sign-up window:
  1. Set `AUTH_DISABLE_SIGNUP=false` and run `docker compose up -d auth`.
  2. The partner's users create their accounts and confirm their emails; the org owner sends the member invites, and each invitee accepts while signed in.
  3. Set `AUTH_DISABLE_SIGNUP=true`, run `docker compose up -d auth`, then `pnpm pilot:check -- --url <public URL>`.
  4. Check that only expected accounts were created in the window:

     ```bash
     docker compose exec db psql -U postgres -c "SELECT email, created_at FROM auth.users ORDER BY created_at DESC LIMIT 20"
     ```

     An unexpected account means someone else used the window: note it in issue #308 and do not sign off until the owner decided what to do with it.
- Keep the window short: while it is open with the policy `open`, anyone who reaches `PUBLIC_URL` can create an account and an org (bounded by `ORG_CREATE_LIMIT_PER_DAY` and the email limits), and can also sign up first under an address that will be invited later, keeping their own password on that account (#563). Setting `AUTH_SIGNUP_POLICY=invite_only` for the window (`docker compose up -d crove`) means only someone with an invite's accept link can create an account, and only for the invited address. Invite-only does not protect an account created before the policy was set: an account that already exists for an invited address (from an `open` window, or at an allowed domain under `allowlist` before the invite) keeps whatever password its first sign-up chose. Before sending an invite, check step 4's account list for an unexpected account under that address, and if there is one, delete it before the invitee accepts (a password reset is not enough: sessions the other person already holds stay valid); the invitee then signs up again from the link.

## 6. Alerts reach the owner's phone

The owner learns about an outage before the partner calls (M1-9, issue #309): prober alerts in a Telegram chat or Slack channel the owner reads, an outside uptime check on `/healthz` every 5 minutes, and a heartbeat monitor for the prober itself. Setting them up and testing each one: [alerts.md](alerts.md).

- Checked by `pilot:check`: `ALERT_WEBHOOK_URL` is set and https, `PROBER_HEARTBEAT_URL` is https when set, and the prober accepts its settings (a Telegram webhook needs `ALERT_TELEGRAM_CHAT_ID`). The pass line says whether `COMPOSE_PROFILES` starts the prober.
- `MANUAL`: the outside uptime check exists and the test alert (`pnpm alert:test`) reached the phone; without `prober` in `COMPOSE_PROFILES`, that a cron job runs the prober; without `PROBER_HEARTBEAT_URL`, that the owner accepts that nothing pages when the prober itself stops.

## 7. Owner sign-off

The owner reviews the `pnpm pilot:check -- --url <public URL>` output with no `FAIL` line, confirms the `MANUAL` items above, and records the sign-off in issue #308 with the date, the deployed commit or tag and the output.
