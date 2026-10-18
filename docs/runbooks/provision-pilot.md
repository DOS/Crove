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

As root on a fresh server:

```bash
apt-get update && apt-get -y full-upgrade
apt-get -y install unattended-upgrades ufw curl ca-certificates git
dpkg-reconfigure -f noninteractive unattended-upgrades     # security updates every day

# An admin account with your SSH key, then no password logins and no root login over SSH.
adduser --disabled-password --gecos '' admin && usermod -aG sudo admin
install -d -m 700 -o admin -g admin /home/admin/.ssh
cp ~/.ssh/authorized_keys /home/admin/.ssh/ && chown admin:admin /home/admin/.ssh/authorized_keys
printf 'PasswordAuthentication no\nKbdInteractiveAuthentication no\nPermitRootLogin no\n' > /etc/ssh/sshd_config.d/10-crove.conf
systemctl reload ssh                                       # log in as admin in a second session before closing this one

# Only SSH and the reverse proxy are reachable from outside.
ufw default deny incoming && ufw default allow outgoing
ufw allow 22/tcp && ufw allow 80/tcp && ufw allow 443/tcp && ufw allow 443/udp
ufw enable
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

# Rotate container logs, or a busy service fills the disk.
printf '{\n  "log-driver": "local"\n}\n' > /etc/docker/daemon.json && systemctl restart docker
```

Then the deploy user, its SSH key for the workflow, the stack directory `/opt/crove` and the host key: steps 1 to 3 and 7 of [deploy.md](deploy.md), "One-time setup of the host".

## 4. The files bucket

Create the bucket in the region of the server, private, with versioning on **before the first write** (ADR-0013: Crove refuses a write that comes back without an object version). Give Crove its own access key, limited to this bucket:

- on the objects: `s3:GetObject`, `s3:GetObjectVersion`, `s3:PutObject`, `s3:DeleteObject`;
- on the bucket: `s3:ListBucket`.

Crove never deletes object versions, so two lifecycle rules free the space its deletes leave behind, and a third removes abandoned browser uploads. With the AWS CLI (any S3-compatible store: add `--endpoint-url https://<endpoint>`), as an account that may configure the bucket, not with Crove's key:

```bash
aws s3api put-bucket-versioning --bucket <bucket> --versioning-configuration Status=Enabled

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
| `org/` | documents and attachments, the evidence | none: Crove never deletes them, and their versions are the record. Add a retention hold here (Object Lock or a retention policy) once the retention period of plan §7.9 is decided |
| `staging/` | browser uploads before the server checks them (5 minutes) | expire after a day, with their old versions and delete markers |
| `inbound/` | raw inbound mail until it is filed (the worker deletes it after 30 days at most) | delete old versions 7 days after Crove deleted the object |
| `export/` | sealed org exports (`EXPORT_RETENTION_DAYS`, then the worker deletes them) | the same, 7 days |

The CORS rule lets the browser post files straight to the bucket (`S3_PRESIGNED_URLS=true`, the default) and download them. MinIO has no per-bucket CORS: it answers every origin unless `MINIO_API_CORS_ALLOW_ORIGIN` narrows it to `https://<your domain>`. On Cloudflare R2, which has neither versioning nor presigned POST, set `S3_VERSIONING=off` and `S3_PRESIGNED_URLS=false` instead and skip the CORS rule (`.env.example` explains the trade-off).

The backup bucket is separate: see [backup-and-restore.md](backup-and-restore.md).

## 5. Mail

Supabase Auth sends the confirmation, recovery and invite emails through `SMTP_HOST`. At the provider, verify the domain you send from, and publish the DNS records it gives you:

- SPF (a TXT record that names the provider), DKIM (the provider's key records), and DMARC (`_dmarc.<domain>`, starting with `v=DMARC1; p=none; rua=mailto:<your address>`, then `quarantine` once reports look right);
- port 587 with STARTTLS, or 465 with TLS. With credentials on a port other than 465, Crove's own mailer (member invites) refuses a server that does not offer STARTTLS.

Send one recovery email to an address at a large mail provider and check that it lands in the inbox, not in spam, before the partner signs up.

Inbound email (invoices sent to `<org token>@<INBOUND_DOMAIN>`) needs an MX record and a mail worker that posts each message to `/api/inbound/email` with `INBOUND_SECRET` (#53).

## 6. DNS

Point the pilot's host name at the server: an `A` record to its IPv4 address, and an `AAAA` record only if IPv6 reaches the server end to end. Wait until `dig +short <your domain>` answers with the server's address from outside, before the first start: the reverse proxy asks Let's Encrypt for the certificate as soon as it starts.

## 7. The env file

Write `/opt/crove/.env` (owner the deploy user, mode 600) from `.env.example`. Generate every secret on the server, for example `openssl rand -hex 32` (no `$` in it, which docker compose would expand), and keep a copy in the owner's secret store, never in git. The settings that differ from the defaults for the pilot:

| Setting | Value |
|---|---|
| `PUBLIC_URL` | `https://<your domain>` |
| `CROVE_DOMAIN` | `<your domain>` (the reverse proxy's certificate) |
| `TRUSTED_PROXY_HOPS` | `1` (the reverse proxy below) |
| `COMPOSE_FILE` | `docker-compose.yml:docker-compose.override.yml:compose.host.yml` |
| `COMPOSE_PROFILES` | `prober` |
| Every `*_PASSWORD`, `AUTH_JWT_SECRET`, `EXPORT_ENCRYPTION_KEY` (`openssl rand -base64 32`) | generated, never a sample value |
| `AUTH_AUTOCONFIRM` | `false` |
| `AUTH_DISABLE_SIGNUP` | `true` (open it only for the partner's sign-up window, [pilot-readiness.md](pilot-readiness.md)) |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` | the provider's, `SMTP_FROM` on the verified domain |
| `STORAGE` and `S3_*` | `s3`, the endpoint, region, bucket and Crove's key from section 4 |
| `INBOUND_DOMAIN`, `INBOUND_SECRET` | per #53 |
| `ALERT_WEBHOOK_URL` and the other `ALERT_*` | the owner's Telegram or Slack (README, "Monitoring and alerts"; #309) |
| `AI_*` | per #312; empty until then (e-invoice XML works without it) |

The kernel refuses to start on a public `PUBLIC_URL` with unsafe settings: a sample `AUTH_JWT_SECRET`, `AUTH_AUTOCONFIRM=true`, `AUTH_SESSION_CHECK=off`, `AUTH_STEP_UP=off`, presigned transfers to a plain-http bucket endpoint, an email budget a few client addresses could use up, or no `EXPORT_ENCRYPTION_KEY`. Those are the production config guards of the acceptance criteria; `pnpm pilot:check` (section 10) checks the rest.

## 8. The TLS reverse proxy

`tools/deploy/caddy/` holds a reverse proxy for this layout: Caddy on ports 80 and 443 in front of the app on loopback. Copy both files into the stack directory:

```bash
cp tools/deploy/caddy/compose.host.yml tools/deploy/caddy/Caddyfile /opt/crove/
```

- Caddy gets and renews a Let's Encrypt certificate for `CROVE_DOMAIN` and redirects plain http to https. The certificates live in the `caddy-data` volume; keep it, or every restart asks Let's Encrypt again (which rate-limits repeated requests for the same name).
- It runs on the host's network so it sees each client's real address, and it replaces any `X-Forwarded-For` a client sends with that address. With `TRUSTED_PROXY_HOPS=1` the kernel's per-client limits (sign-in, sign-up, recovery, email) then count each client separately. Behind a published port instead, Docker shows the proxy its bridge address for IPv6 clients, and every one of them would share one budget.
- It does not compress responses: the app's event stream must reach the browser unbuffered. The kernel sets the security headers itself, HSTS among them.
- Its admin API is off (on the host's network it would be open to every local process), so a changed `Caddyfile` takes effect with `docker compose restart caddy`.
- The same file drops Mailpit's loopback port, which the pilot does not need.

Another proxy works too (nginx, a cloud load balancer): forward to `127.0.0.1:${PORT}`, overwrite `X-Forwarded-For` with the client address (or append to it), and set `TRUSTED_PROXY_HOPS` to the number of proxies that append. A proxy in front of Caddy (a CDN) adds one hop.

## 9. First deploy

Set up the `pilot` environment and its secrets on GitHub and push a `v*` tag ([deploy.md](deploy.md)). The deploy starts the database, migrates, starts Supabase Auth, the reverse proxy and the app, waits for `/readyz` and runs the smoke test; with `DEPLOY_PUBLIC_URL` set it runs the smoke test again through the reverse proxy.

Afterwards, on the server, `docker compose ps` in `/opt/crove` lists every service running, and from outside:

```bash
curl -sI http://<your domain>/healthz        # 308 to https
curl -s https://<your domain>/readyz         # {"ready":true}
```

## 10. After the first deploy

1. `pnpm pilot:check -- --url https://<your domain>` from a checkout holding the deployment's `.env`, until no line says `FAIL` ([pilot-readiness.md](pilot-readiness.md)).
2. Nightly backups and the restore drill: [backup-and-restore.md](backup-and-restore.md).
3. Alerts to the owner's phone, an outside uptime check and a test alert: README, "Monitoring and alerts", and issue #309.
4. Note in issue #306 the server's size and region, the date, and the release it runs.
