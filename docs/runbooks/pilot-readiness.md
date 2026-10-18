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

`--url` probes three things on the running instance: `/healthz` over https (the certificate chain and host name are verified), plain http on port 80 (the connection is refused, or it redirects to https on the same host; a timeout fails as inconclusive), and the settings the running Supabase Auth reports (`GET <auth URL>/settings`, the Auth URL taken from `/api/config`): `disable_signup` must be `true` and `mailer_autoconfirm` `false`. The probe follows no redirect and only reads an Auth URL on the same origin as `--url` (the bundled Supabase Auth behind `/auth/v1`); a remote Auth URL fails and is checked by hand. The probe sees what the auth service really runs with, so it catches a `.env` change that was never applied (`docker compose up -d` recreates the services whose settings changed).

## 1. TLS on every public endpoint; every secret changed from the defaults

**TLS.** Compose publishes Crove on loopback only; a TLS reverse proxy (Caddy, nginx, a cloud load balancer) serves it to others. Set `PUBLIC_URL` to the https URL and `TRUSTED_PROXY_HOPS` to the number of proxies in front. The pilot's server setup, with a ready Caddy configuration in `tools/deploy/caddy/`: [provision-pilot.md](provision-pilot.md).

- Checked by `pilot:check`: `PUBLIC_URL` is https and not a loopback host; `PUBLIC_AUTH_URL`, when set, is https; with `STORAGE=s3` and presigned transfers (the default), the bucket endpoint browsers reach (`S3_PUBLIC_ENDPOINT`, else `S3_ENDPOINT`) is https.
- With `--url`: the certificate is valid for the host, and plain http does not serve the app.
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

What exists today is a closed sign-up: `AUTH_DISABLE_SIGNUP=true` (`GOTRUE_DISABLE_SIGNUP` of the bundled Supabase Auth), which refuses every new account while existing accounts sign in as usual. There is no invite-only or domain-allowlist sign-up yet.

- Checked by `pilot:check`: `AUTH_DISABLE_SIGNUP=true`. With `--url`: the running Supabase Auth reports `disable_signup: true`.
- A member invite needs the invitee to have an account (the invite binds to the signed-in, confirmed email), so new accounts are created in a short sign-up window:
  1. Set `AUTH_DISABLE_SIGNUP=false` and run `docker compose up -d auth`.
  2. The partner's users create their accounts and confirm their emails; the org owner sends the member invites, and each invitee accepts while signed in.
  3. Set `AUTH_DISABLE_SIGNUP=true`, run `docker compose up -d auth`, then `pnpm pilot:check -- --url <public URL>`.
  4. Check that only expected accounts were created in the window:

     ```bash
     docker compose exec db psql -U postgres -c "SELECT email, created_at FROM auth.users ORDER BY created_at DESC LIMIT 20"
     ```

     An unexpected account means someone else used the window: note it in issue #308 and do not sign off until the owner decided what to do with it.
- Keep the window short: while it is open, anyone who reaches `PUBLIC_URL` can create an account and an org (bounded by `ORG_CREATE_LIMIT_PER_DAY` and the email limits).

## 6. Owner sign-off

The owner reviews the `pnpm pilot:check -- --url <public URL>` output with no `FAIL` line, confirms the `MANUAL` items above, and records the sign-off in issue #308 with the date, the deployed commit or tag and the output.
