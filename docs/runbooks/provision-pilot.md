# Runbook: provision the pilot server

How to set up the one server that runs the pilot (backlog item M1-5, issue #306): the same `docker compose` stack self-hosters run, behind a TLS reverse proxy, with files in an S3-compatible bucket and mail through a transactional provider. It ends where [deploy.md](deploy.md) takes over (releases, rollback) and [pilot-readiness.md](pilot-readiness.md) checks the result.

## Before you start

| Input | Who | Issue |
|---|---|---|
| Hosting approved (one server, monthly cap) | owner | #52 |
| Where the data may live (Vietnam or a nearby region) | owner | #122 |
| The domain, its DNS, and inbound email routing | owner | #53 |
| An SMTP provider account that may send from the domain | owner | |
| An S3-compatible store: one bucket for files, a second one (another account or provider if possible) for backups | owner | #307 |
| The AI endpoint for PDFs and photos (e-invoice XML needs none) | owner | #312 |

## 1. The server

| | Pilot (5 to 20 orgs) |
|---|---|
| CPU, memory | 4 vCPU, 8 GB (PostgreSQL, Supabase Auth, the kernel, and `crove-extract`, which alone may take 1 GB) |
| Disk | 80 GB SSD: the database, Docker images, logs and local backup runs; the files live in the bucket |
| OS | Ubuntu Server 24.04 LTS (any current Linux with Docker Engine works; the commands below are for Ubuntu) |
| Region | as decided in #122 |
| Network | a fixed public IPv4 address; IPv6 too if the provider routes it |

## 2. Base setup

As root on a fresh server (`sudo -i` from the provider's default user, such as `ubuntu`, works too):

```bash
apt-get update && apt-get -y full-upgrade
apt-get -y install unattended-upgrades ufw curl ca-certificates git
dpkg-reconfigure -f noninteractive unattended-upgrades     # security updates every day

# An admin account with the SSH keys of the account you logged in with (root, or the default user you ran sudo from),
# then no password logins and no root login over SSH. The password adduser asks for is for sudo only.
adduser --gecos '' admin && usermod -aG sudo admin
install -d -m 700 -o admin -g admin /home/admin/.ssh
install -m 600 -o admin -g admin "$(getent passwd "${SUDO_USER:-root}" | cut -d: -f6)/.ssh/authorized_keys" /home/admin/.ssh/authorized_keys
printf 'PasswordAuthentication no\nKbdInteractiveAuthentication no\nPermitRootLogin no\n' > /etc/ssh/sshd_config.d/10-crove.conf
systemctl reload ssh                                       # log in as admin in a second session before closing this one

# Only SSH and the reverse proxy are reachable from outside.
ufw default deny incoming && ufw default allow outgoing
ufw allow 22/tcp && ufw allow 80/tcp && ufw allow 443/tcp && ufw allow 443/udp
ufw --force enable                                         # SSH is allowed above, so this session stays open
```

Ports that Docker publishes bypass ufw. The compose file publishes the app (`127.0.0.1:${PORT}`) and Mailpit on loopback only, and the reverse proxy below runs on the host's network so ufw still applies to it. Never publish another port on `0.0.0.0`.

## 3. Docker Engine

Install Docker Engine and the compose plugin from Docker's own repository, which carries current releases (the deploy and `compose.host.yml` use `!reset`, which needs compose v2.24 or newer):

```bash
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" > /etc/apt/sources.list.d/docker.list
apt-get update && apt-get -y install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
docker compose version                                     # v2.24 or newer

# Rotate container logs, or a busy service fills the disk. If /etc/docker/daemon.json already exists, add the key to it.
test -e /etc/docker/daemon.json || printf '{\n  "log-driver": "local"\n}\n' > /etc/docker/daemon.json
systemctl restart docker
```

Then the deploy user, its SSH key for the workflow, the stack directory `/opt/crove` and the host key: steps 1 to 3 and 7 of [deploy.md](deploy.md), "One-time setup of the host".

## 4. The files bucket

Create the bucket in the region of the server, private, with versioning on **before the first write** (ADR-0013: Ludy refuses a write that comes back without an object version) and **Object Lock enabled**, so that the worker can hold the original file of every posted invoice for 10 years (`EVIDENCE_LOCK_DAYS`, [evidence-holds.md](evidence-holds.md)). Do not set a default retention on the bucket: Ludy holds only posted files. Give Ludy its own access key, limited to this bucket:

- on the objects: `s3:GetObject`, `s3:GetObjectVersion`, `s3:PutObject`, `s3:DeleteObject`, `s3:GetObjectRetention`, `s3:PutObjectRetention` (never `s3:BypassGovernanceRetention`);
- on the bucket: `s3:ListBucket`, `s3:ListBucketVersions`, `s3:GetBucketObjectLockConfiguration`. `s3:ListBucketVersions` also serves the WORM archive bucket when `ARCHIVE_STORE=s3` uses this key: its nightly verifier reads each key's versions (#2020, [worm-archive.md](worm-archive.md)), and fails with `AccessDenied` without it.

Ludy never deletes object versions, so two lifecycle rules free the space its deletes leave behind, and a third removes abandoned browser uploads. With the AWS CLI (any S3-compatible store: add `--endpoint-url https://<endpoint>`), as an account that may configure the bucket, not with Ludy's key:

```bash
aws s3api put-bucket-versioning --bucket <bucket> --versioning-configuration Status=Enabled
# Object Lock for the evidence holds (a new bucket: create-bucket ... --object-lock-enabled-for-bucket; MinIO: mc mb --with-lock).
aws s3api put-object-lock-configuration --bucket <bucket> --object-lock-configuration '{"ObjectLockEnabled":"Enabled"}'

cat > lifecycle.json <<'EOF'
{
  "Rules": [
    { "ID": "crove-staging", "Status": "Enabled", "Filter": { "Prefix": "staging/" },
      "Expiration": { "Days": 1 }, "NoncurrentVersionExpiration": { "NoncurrentDays": 1 },
      "AbortIncompleteMultipartUpload": { "DaysAfterInitiation": 1 } },
    { "ID": "crove-staging-markers", "Status": "Enabled", "Filter": { "Prefix": "staging/" },
      "Expiration": { "ExpiredObjectDeleteMarker": true } },
    { "ID": "crove-inbound-deleted", "Status": "Enabled", "Filter": { "Prefix": "inbound/" },
      "NoncurrentVersionExpiration": { "NoncurrentDays": 7 }, "Expiration": { "ExpiredObjectDeleteMarker": true } },
    { "ID": "crove-export-deleted", "Status": "Enabled", "Filter": { "Prefix": "export/" },
      "NoncurrentVersionExpiration": { "NoncurrentDays": 7 }, "Expiration": { "ExpiredObjectDeleteMarker": true } }
  ]
}
EOF
aws s3api put-bucket-lifecycle-configuration --bucket <bucket> --lifecycle-configuration file://lifecycle.json

cat > cors.json <<'EOF'
{ "CORSRules": [ { "AllowedOrigins": ["https://<your domain>"], "AllowedMethods": ["POST", "GET"],
                   "AllowedHeaders": ["*"], "MaxAgeSeconds": 3600 } ] }
EOF
aws s3api put-bucket-cors --bucket <bucket> --cors-configuration file://cors.json
```

| Prefix | What it holds | The rule |
|---|---|---|
| `org/` | documents and attachments, the evidence | none: Ludy never deletes them, and their versions are the record. The worker holds the original file of every posted invoice with Object Lock in GOVERNANCE mode for `EVIDENCE_LOCK_DAYS` from its posting (#1009, [evidence-holds.md](evidence-holds.md)) |
| `staging/` | browser uploads before the server checks them (5 minutes) | expire after a day, with their old versions and delete markers |
| `inbound/` | raw inbound mail until it is filed (the worker deletes it after 30 days at most) | delete old versions 7 days after Ludy deleted the object |
| `export/` | sealed org exports (`EXPORT_RETENTION_DAYS`, then the worker deletes them) | the same, 7 days |

The CORS rule lets the browser post files straight to the bucket (`S3_PRESIGNED_URLS=true`, the default) and download them. MinIO has no per-bucket CORS: it answers every origin unless `MINIO_API_CORS_ALLOW_ORIGIN` narrows it to `https://<your domain>`. On Cloudflare R2, which has neither versioning nor presigned POST, set `S3_VERSIONING=off` and `S3_PRESIGNED_URLS=false` instead and skip the CORS rule (`.env.example` explains the trade-off).

The backup bucket is separate: see [backup-and-restore.md](backup-and-restore.md).

## 5. Mail

Supabase Auth sends the confirmation, recovery and invite emails through `SMTP_HOST`. At the provider, verify the domain you send from, and publish the DNS records it gives you:

- SPF (a TXT record that names the provider), DKIM (the provider's key records), and DMARC (`_dmarc.<domain>`, starting with `v=DMARC1; p=none; rua=mailto:<your address>`, then `quarantine` once reports look right);
- port 587 with STARTTLS, or 465 with TLS. With credentials on a port other than 465, Ludy's own mailer (member invites) refuses a server that does not offer STARTTLS.

Send one recovery email to an address at a large mail provider and check that it lands in the inbox, not in spam, before the partner signs up.

### Inbound email

Invoices sent to `<org token>@<INBOUND_DOMAIN>` reach Ludy through a mail worker that posts each message, as raw MIME, to `https://<your domain>/api/inbound/email` with `INBOUND_SECRET` (#53). [`tools/inbound-mail/worker.js`](../../tools/inbound-mail/worker.js) is that worker for Cloudflare Email Routing, one file with no dependencies. About 10 minutes once the domain is on Cloudflare (#53):

1. Pick `INBOUND_DOMAIN`. Email Routing takes over the MX records of the name it runs on, so if the domain already receives mail elsewhere (Google Workspace, Microsoft 365), use a subdomain such as `hoadon.<your domain>`.
2. Generate the secret on the server and put it in `/opt/crove/.env` with the domain (section 7), then redeploy so the kernel picks them up:
   ```bash
   openssl rand -hex 32        # INBOUND_SECRET, at least 32 characters; keep a copy in the owner's secret store
   ```
3. In the Cloudflare dashboard, **Workers & Pages**, **Create**, **Create Worker**: name it `crove-inbound-mail`, deploy it, then **Edit code**, replace the sample with the whole content of `tools/inbound-mail/worker.js` and **Deploy**.
4. In the worker's **Settings**, **Variables and Secrets**, add:
   - `KERNEL_URL`, type Text: `https://<your domain>` (the `PUBLIC_URL`; the worker refuses plain http);
   - `INBOUND_SECRET`, type Secret: the value from step 2.
5. On the zone of `INBOUND_DOMAIN`, **Email**, **Email Routing**: enable it (for a subdomain, add it under **Settings**, subdomains) and let Cloudflare add the MX and SPF records it proposes.
6. **Routing rules**, **Catch-all address**: action **Send to a Worker**, destination `crove-inbound-mail`, status enabled. The catch-all is what takes every org's `<token>@` address, and the `bounce+<token>@` addresses Ludy's own mails use as their Return-Path (#539).
7. Check, from outside:
   ```bash
   dig +short MX <INBOUND_DOMAIN>     # Cloudflare's route*.mx.cloudflare.net servers
   ```
   In the app, open an org's **Settings** and copy "Địa chỉ nhận hóa đơn qua email". Send it a message with an e-invoice XML or a PDF attached from any mailbox: within a minute the document shows in that org's **Inbox**. A message to a made-up address on the domain comes back to its sender as "Unknown recipient".

What the worker does with Ludy's answer: accepted, done; the address is unknown, the message empty or larger than 40 MB, it rejects the message with that reason; a wrong secret, a redirect (a `KERNEL_URL` that is not the https address) or Ludy being down or busy, it fails, and Email Routing's **Activity log** and the worker's **Logs** show the error. When messages are accepted but not filed, the prober's alert "oldest unrelayed inbound email ... the relay is behind or stopped" fires (README, "Monitoring and alerts"): the kernel's worker or `crove-extract` is the problem then, not the mail relay.

## 6. DNS

Point the pilot's host name at the server: an `A` record to its IPv4 address, and an `AAAA` record only if IPv6 reaches the server end to end. Wait until `dig +short <your domain>` answers with the server's address from outside, before the first start: the reverse proxy asks Let's Encrypt for the certificate as soon as it starts.

## 7. The env file

Write `/opt/crove/.env` (owner the deploy user, mode 600) from `.env.example`. Generate every secret on the server, for example `openssl rand -hex 32` (no `$` in it, which docker compose would expand), and keep a copy in the owner's secret store, never in git. The settings that differ from the defaults for the pilot:

| Setting | Value |
|---|---|
| `PUBLIC_URL` | `https://<your domain>` |
| `CROVE_DOMAIN` | `<your domain>` (the reverse proxy's certificate) |
| `TRUSTED_PROXY_HOPS` | `1` (the reverse proxy below) |
| `COMPOSE_FILE` | `docker-compose.yml:compose.pilot.yml:docker-compose.override.yml:compose.host.yml` (the split API and worker, [deploy.md](deploy.md), "The pilot layout") |
| `CROVE_MODULES` | `finance` (the pilot runs one module; empty would run every module, Social's public routes among them) |
| `COMPOSE_PROFILES` | `prober` |
| Every `*_PASSWORD`, `AUTH_JWT_SECRET`, `EXPORT_ENCRYPTION_KEY` (`openssl rand -base64 32`) | generated, never a sample value |
| `AUTH_AUTOCONFIRM` | `false` |
| `AUTH_DISABLE_SIGNUP` | `true` (open it only for the partner's sign-up window, [pilot-readiness.md](pilot-readiness.md)); or `false` with `AUTH_SIGNUP_POLICY=invite_only` |
| `AUTH_SIGNUP_POLICY`, `AUTH_SIGNUP_ALLOWED_DOMAINS` | `invite_only` (no window needed), or unset with sign-up closed ([pilot-readiness.md](pilot-readiness.md), section 5) |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` | the provider's, `SMTP_FROM` on the verified domain |
| `STORAGE` and `S3_*` | `s3`, the endpoint, region, bucket and Ludy's key from section 4 |
| `INBOUND_DOMAIN`, `INBOUND_SECRET` | section 5, "Inbound email" (#53) |
| `ALERT_WEBHOOK_URL` and the other `ALERT_*` | the owner's Telegram or Slack (README, "Monitoring and alerts"; #309) |
| `AI_*` | per #312; empty until then (e-invoice XML works without it). With `AI_API_KEY` set, set `AI_PRICE_INPUT_PER_MTOK` or `AI_PRICE_OUTPUT_PER_MTOK` too, or the AI cost cap counts nothing |
| `BACKUP_*` | [backup-and-restore.md](backup-and-restore.md); `BACKUP_ENCRYPTION_KEY` (`openssl rand -base64 32`, its own key) is required |

The kernel refuses to start on a public `PUBLIC_URL` with unsafe settings: a sample `AUTH_JWT_SECRET`, a database URL with a password shipped in `.env.example` or the compose files, `AUTH_AUTOCONFIRM=true`, `AUTH_SESSION_CHECK=off`, `AUTH_STEP_UP=off`, presigned transfers to a plain-http bucket endpoint, an email budget a few client addresses could use up, or no `EXPORT_ENCRYPTION_KEY`. Those are the production config guards of the acceptance criteria; `pnpm pilot:check` (section 10) checks the rest.

## 8. The TLS reverse proxy

`tools/deploy/caddy/` holds a reverse proxy for this layout: Caddy on ports 80 and 443 in front of the app on loopback. Copy both files into the stack directory from a checkout. The server needs one anyway, since the nightly backup runs from it ([backup-and-restore.md](backup-and-restore.md)):

```bash
git clone --depth 1 --branch main https://github.com/DOS/Ludy.git /opt/crove-src   # or the release tag you deploy
cp /opt/crove-src/tools/deploy/caddy/compose.host.yml /opt/crove-src/tools/deploy/caddy/Caddyfile /opt/crove/
```

Or copy the two files from your own checkout with `scp`. The split API and worker (`compose.pilot.yml`, [deploy.md](deploy.md), "The pilot layout") need no copy: every release ships the file, and listing it in `COMPOSE_FILE` chooses the layout.

- Caddy gets and renews a Let's Encrypt certificate for `CROVE_DOMAIN` and redirects plain http to https. The certificates live in the `caddy-data` volume; keep it, or every restart asks Let's Encrypt again (which rate-limits repeated requests for the same name).
- It runs on the host's network so it sees each client's real address, and it replaces any `X-Forwarded-For` a client sends with that address. With `TRUSTED_PROXY_HOPS=1` the kernel's per-client limits (sign-in, sign-up, recovery, email) then count each client separately. Behind a published port instead, Docker shows the proxy its bridge address for IPv6 clients, and every one of them would share one budget.
- It does not compress responses: the app's event stream must reach the browser unbuffered. The kernel sets the security headers itself, HSTS among them.
- Its admin API is off (on the host's network it would be open to every local process), so a changed `Caddyfile` takes effect with `docker compose restart caddy`.
- The same file drops Mailpit's loopback port, which the pilot does not need.

Another proxy works too (nginx, a cloud load balancer): forward to `127.0.0.1:${PORT}`, overwrite `X-Forwarded-For` with the client address (or append to it), and set `TRUSTED_PROXY_HOPS` to the number of proxies that append. A proxy in front of Caddy (a CDN) adds one hop.

## 9. First deploy

Set up the `pilot` environment and its secrets on GitHub and push a `v*` tag ([deploy.md](deploy.md)). The deploy starts the database, migrates, starts Supabase Auth, the reverse proxy and the app, waits for `/readyz` and runs the smoke test; with `DEPLOY_PUBLIC_URL` set it runs the smoke test again through the reverse proxy.

Afterwards, on the server, `docker compose ps` in `/opt/crove` lists every service running (`api` and `worker`, and no `crove`), and from outside:

```bash
curl -sI http://<your domain>/healthz        # 308 to https
curl -s https://<your domain>/readyz         # {"ready":true}
```

## 10. After the first deploy

1. `pnpm pilot:check -- --url https://<your domain>` from a checkout holding the deployment's `.env`, until no line says `FAIL` ([pilot-readiness.md](pilot-readiness.md)).
2. Nightly backups and the restore drill: [backup-and-restore.md](backup-and-restore.md).
3. Alerts to the owner's phone, an outside uptime check and a test alert: README, "Monitoring and alerts", and issue #309.
4. Note in issue #306 the server's size and region, the date, and the release it runs.
