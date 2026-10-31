# Self-hosting Ludy

How to run your own Ludy on one server, from a checkout of this repository: the requirements, the settings, TLS,
mail, file storage, who may sign up, the AI endpoint, backups, upgrades and the preflight check. Everything here is
the open-source stack (`docker compose`); no outside Ludy service is involved.

For a first look on your own machine, the README's quick start (`docker compose up`, then http://localhost:8080) is
enough. This guide is for an instance other people use.

## 1. Requirements

| | One firm, up to about 20 client companies |
|---|---|
| CPU, memory | 4 vCPU, 8 GB. PostgreSQL, Supabase Auth, the Ludy kernel and `crove-extract` (the file parsing sandbox, up to 1 GB on its own) |
| Disk | 40 GB SSD with files in an S3 bucket, more with local files (`STORAGE=local`): the database, Docker images, logs and local backup runs |
| OS | any current Linux with Docker Engine 24 or newer and the compose plugin v2.24 or newer (`docker compose version`) |
| Network | a domain name pointing at the server, ports 80 and 443 open (TLS); every other port stays closed |
| Mail | an SMTP account allowed to send from your domain (sign-up confirmation, password reset, member invites) |
| Optional | an S3-compatible bucket for files, a second one elsewhere for backups, an OpenAI-compatible AI endpoint for PDFs and photos |

Docker publishes ports past most host firewalls. The compose file publishes the app and Mailpit on `127.0.0.1` only;
keep it that way and let the reverse proxy (section 4) be the only thing listening on public ports.

On Ubuntu, Docker's own repository carries current releases:
[docs.docker.com/engine/install/ubuntu](https://docs.docker.com/engine/install/ubuntu/).
[provision-pilot.md](../runbooks/provision-pilot.md), sections 2 and 3, has a hardened base setup (unattended
security updates, SSH keys only, a firewall, container log rotation) you can follow as is.

## 2. Get the code

Run a release tag, not `main`:

```bash
git clone https://github.com/DOS/Ludy.git /opt/crove
cd /opt/crove
git tag --list 'v*' --sort=-v:refname | head -5      # the newest releases
git checkout <tag>                                   # for example v0.3.0
```

The stack builds its two images (`crove:local` and `crove-extract:local`) from this checkout the first time it starts.

## 3. Settings (`.env`)

Every setting has a comment in [`.env.example`](../../.env.example); the README's "Configuration" table explains the
features. Start from the example and replace every secret with a random value:

```bash
cp .env.example .env && chmod 600 .env
for key in POSTGRES_PASSWORD CROVE_APP_DB_PASSWORD CROVE_WORKER_DB_PASSWORD CROVE_PROBER_DB_PASSWORD \
           CROVE_REPORTER_DB_PASSWORD AUTH_DB_PASSWORD AUTH_JWT_SECRET; do
  sed -i "s|^$key=.*|$key=$(openssl rand -hex 32)|" .env
done
sed -i "s|^EXPORT_ENCRYPTION_KEY=.*|EXPORT_ENCRYPTION_KEY=$(openssl rand -base64 32)|" .env
grep -v '^#' .env | grep -c change-me              # 0: no sample secret left
```

Keep a copy of `.env` in your password manager, never in git. Without it a backup cannot be restored (section 8).

Then set, at least:

| Setting | Value |
|---|---|
| `PUBLIC_URL` | `https://<your domain>`, the address users open |
| `CROVE_DOMAIN` | `<your domain>`, for the TLS certificate (section 4) |
| `TRUSTED_PROXY_HOPS` | `1` behind the reverse proxy of section 4. With `0` every client shares the proxy's address, and one person's failed sign-ins lock out everyone |
| `AUTH_AUTOCONFIRM` | `false`: users confirm their email (needs SMTP, section 5) |
| `AUTH_STEP_UP` | `required` (the default): approvals and membership changes ask for a fresh two-factor code |
| Sign-up | section 6 |

The kernel refuses to start on a public `PUBLIC_URL` with an unsafe setting (a sample `AUTH_JWT_SECRET`,
`AUTH_AUTOCONFIRM=true`, step-up off, no `EXPORT_ENCRYPTION_KEY`, among others) and says which one in its log.

## 4. TLS reverse proxy

[`tools/deploy/caddy/`](../../tools/deploy/caddy/) holds a Caddy service for this layout: ports 80 and 443 on the host,
a Let's Encrypt certificate for `CROVE_DOMAIN`, plain http redirected to https, and the client's address passed on in
`X-Forwarded-For` for `TRUSTED_PROXY_HOPS=1`. Copy both files next to `docker-compose.yml` and add them to the stack:

```bash
cp tools/deploy/caddy/compose.host.yml tools/deploy/caddy/Caddyfile .
echo 'COMPOSE_FILE=docker-compose.yml:compose.host.yml' >> .env
```

This keeps the one-container layout, which is fine for your own use. A deployment other people reach (a pilot) runs the API and the worker apart and only the finance module: add `tools/deploy/compose.pilot.yml` as well ([deploy.md](../runbooks/deploy.md), "The pilot layout"); `pnpm pilot:check` fails a public deployment without it.

Point the domain's `A` record (and `AAAA` only if IPv6 reaches the server) at the server and wait until
`dig +short <your domain>` answers with its address before the first start: Caddy asks for the certificate at once,
and Let's Encrypt limits repeated failures. The certificates live in the `caddy-data` volume; keep it.

Another proxy works too (nginx, a cloud load balancer): forward to `127.0.0.1:${PORT}` (8080), set or append the
client address in `X-Forwarded-For`, set `TRUSTED_PROXY_HOPS` to the number of proxies that append it, do not buffer
`text/event-stream` responses and allow idle reads of at least 30 seconds (the app's live updates). Details:
[provision-pilot.md](../runbooks/provision-pilot.md), section 8.

## 5. Mail (SMTP)

Supabase Auth sends the confirmation and password-reset emails, and Ludy sends member invites, through the same
server:

| Setting | Value |
|---|---|
| `SMTP_HOST`, `SMTP_PORT` | your provider's; 587 with STARTTLS or 465 with TLS |
| `SMTP_USER`, `SMTP_PASS` | your provider's credentials |
| `SMTP_FROM` | an address on a domain the provider verified (SPF, DKIM and DMARC published) |
| `AUTH_RATE_LIMIT_EMAIL_SENT` | the emails per hour your provider allows (default 100) |

The compose file also runs Mailpit, which catches mail during local tests; `compose.host.yml` closes its port. Send
one password reset to an address at a large mail provider and check that it lands in the inbox, not in spam.

Invoices by email (one address per organization) need an inbound mail relay: `INBOUND_DOMAIN`, `INBOUND_SECRET`, and
[`tools/inbound-mail/worker.js`](../../tools/inbound-mail/worker.js) for Cloudflare Email Routing, set up in
[provision-pilot.md](../runbooks/provision-pilot.md), section 5, "Inbound email". Uploads work without it.

## 6. Who may sign up

Anyone who can reach `PUBLIC_URL` can sign up while `AUTH_SIGNUP_POLICY=open` and `AUTH_DISABLE_SIGNUP=false` (the
defaults), and every account can use your AI budget. Choose one:

| You want | Settings |
|---|---|
| Only people you invite | `AUTH_SIGNUP_POLICY=invite_only`: an email with a valid member invite signs up from the invite's link |
| Only your company's addresses, plus invites | `AUTH_SIGNUP_POLICY=allowlist`, `AUTH_SIGNUP_ALLOWED_DOMAINS=<your domain>,...` |
| Nobody new | `AUTH_DISABLE_SIGNUP=true`, after creating your own account |

Whoever creates an organization owns it, and owners invite the others from Settings, Members.
[pilot-readiness.md](../runbooks/pilot-readiness.md), section 5, has the details and the limits on refused sign-ups.

## 7. Files and the AI endpoint

**Files.** `STORAGE=local` (the default) keeps uploaded documents in the `files` Docker volume: nothing to set up,
and the backup copies it. `STORAGE=s3` puts them in an S3-compatible bucket (AWS S3, MinIO, Google Cloud Storage with
HMAC keys, Cloudflare R2): set the `S3_*` variables, turn on bucket versioning before the first write, and add the
lifecycle and CORS rules of [provision-pilot.md](../runbooks/provision-pilot.md), section 4. Cloudflare R2 needs
`S3_PRESIGNED_URLS=false` and `S3_VERSIONING=off` (README, "Configuration", "File storage").

**AI.** Vietnamese e-invoice XML is read without any model. PDFs and photos need an OpenAI-compatible endpoint:
`AI_BASE_URL`, `AI_API_KEY`, `AI_MODEL` (OpenAI, Ollama, vLLM and others). Before you turn one on, or change the
model, run its conformance and extraction suites from a checkout with Node 26 and pnpm (README, "AI endpoint
conformance and evals"):

```bash
pnpm install
AI_BASE_URL=<url> AI_MODEL=<model> AI_API_KEY=<key> pnpm ai:conformance
AI_BASE_URL=<url> AI_MODEL=<model> AI_API_KEY=<key> pnpm ai:eval
```

Documents go to that endpoint; pick one you are allowed to send your clients' invoices to.

## 8. Start, then check

```bash
docker compose up -d --build
docker compose ps                                     # every service up; migrate and auth-grants exited 0
curl -s http://127.0.0.1:8080/readyz                  # {"ready":true}
curl -sI http://<your domain>/healthz                 # 308 to https
curl -s https://<your domain>/readyz                  # {"ready":true}
tools/deploy/deploy.sh smoke https://<your domain>    # the deploy smoke test: health, config, auth, the sign-in page
```

The first start builds the images (several minutes), creates the database, applies every migration (`migrate`), lets
Supabase Auth create its tables and grants Ludy read access to them (`auth-grants`). Then open `PUBLIC_URL`, create
your account, confirm the email, turn on two-factor sign-in under Settings, and create your organization.

**The preflight.** From a checkout that holds the deployment's `.env` (the server's own checkout works, with Node 26
and pnpm), run:

```bash
pnpm install
pnpm pilot:check -- --url https://<your domain>
```

It fails on a secret left at a sample value, a public URL without https, `TRUSTED_PROXY_HOPS` not counting the
proxy, unconfirmed sign-ups, step-up off, sign-up open to anyone, alerts that reach nobody and backups that never
leave the server, and it probes the certificate, plain http and the sign-up policy of the running instance. It ends
with a list of what only a person can confirm. Fix every `FAIL`; [pilot-readiness.md](../runbooks/pilot-readiness.md)
explains each line. The alert and backup lines are sections 9 and 10.

## 9. Monitoring

The `prober` profile checks every few minutes that background work moves (the outbox, the job queue, the worker's
heartbeat) and sends an alert when it does not: set `CROVE_PROBER_DB_PASSWORD` (done in section 3) and
`ALERT_WEBHOOK_URL` (a Slack, Discord or Telegram webhook, or your own), then:

```bash
echo 'COMPOSE_PROFILES=prober' >> .env
docker compose up -d
docker compose run --rm prober prober --test-alert     # you should receive "[Crove] Test alert from ..."
```

Add an outside uptime check on `https://<your domain>/healthz`, since the prober cannot report a whole-server outage.
README, "Monitoring and alerts", and [alerts.md](../runbooks/alerts.md) cover the formats, the status page
(`STATUS_FILE`) and a heartbeat monitor.

## 10. Backups and restore

`tools/backup/backup.sh` makes one run: a `pg_dump` of the whole database (users, sessions and two-factor secrets
included), the roles, and every stored file, each checked against its sha256. It writes the run to `BACKUP_DIR` and
copies it, sealed with `BACKUP_ENCRYPTION_KEY`, to a second S3-compatible bucket, which must be somewhere else than
the server and the files bucket. Fill the "Backups" block of `.env`, then from the checkout:

```bash
sed -i "s|^BACKUP_ENCRYPTION_KEY=.*|BACKUP_ENCRYPTION_KEY=$(openssl rand -base64 32)|" .env   # keep a copy apart
tools/backup/backup.sh
```

Run it nightly with a systemd timer or cron, and practise a restore before you rely on it:
[backup-and-restore.md](../runbooks/backup-and-restore.md) has the timer, `tools/backup/restore.sh`, the restore drill
and what to check after a restore. Set `CROVE_DIR` to this checkout when you run the scripts from elsewhere.

Not in a backup, so keep them in your password manager: `.env` (database passwords, `AUTH_JWT_SECRET`,
`EXPORT_ENCRYPTION_KEY`, `BACKUP_ENCRYPTION_KEY`) and the credential key of connected social channels
([credential-key.md](../runbooks/credential-key.md)). To replace the database passwords, `INBOUND_SECRET` or the alert
webhook: [secret-rotation.md](../runbooks/secret-rotation.md).

## 11. Upgrades and migrations

Take a backup, then move the checkout to the new release and start the stack again:

```bash
tools/backup/backup.sh
git fetch --tags && git checkout <new tag>
docker compose up -d --build
curl -s http://127.0.0.1:8080/readyz                  # {"ready":true} once the new release serves
```

`up` rebuilds the images, runs `migrate` again before the app starts (it applies only the migrations the database
does not have yet, and the app waits for it), then `auth-grants`, then restarts the app. Read the release notes for
settings a release adds or renames. Migrations only move forward: to go back to an older release, restore the backup
taken before the upgrade ([backup-and-restore.md](../runbooks/backup-and-restore.md)) instead of checking out the old
tag on the new database.

[deploy.md](../runbooks/deploy.md) describes a stricter procedure (prebuilt images pinned by digest, a smoke test and
an automatic rollback) with `tools/deploy/deploy.sh`; it expects images from a registry, so it fits once you build
and publish your own.

## 12. When something is wrong

| Symptom | Look at |
|---|---|
| A service keeps restarting | `docker compose logs --tail 100 <service>`; the kernel names the setting it refuses |
| `/readyz` answers 503 | its body says which part is not ready: a migration missing (`docker compose logs migrate`) or Supabase Auth's grants (`docker compose up auth-grants`) |
| Nobody receives mail | the `SMTP_*` settings, `docker compose logs auth`, and the provider's sending log |
| Everyone is rate limited at once | `TRUSTED_PROXY_HOPS` does not count your reverse proxy (section 3) |
| Uploaded PDFs stay unread | `AI_*` unset or failing (`docker compose logs crove`); XML needs no AI |

[incidents.md](../runbooks/incidents.md) has the steps for the problems the status page and the prober report.
