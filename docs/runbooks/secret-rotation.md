# Runbook: rotate passwords and secrets

How to replace the database login passwords, `INBOUND_SECRET` and the secrets in the alert and heartbeat URLs of a deployment that runs the `docker compose` stack (plan §7.10, "credential rotation", issue #1203). The other keys have their own runbooks: the context key in [context-key-rotation.md](context-key-rotation.md), the credential key in [credential-key.md](credential-key.md), and `AUTH_JWT_SECRET` in [incidents.md](incidents.md), section 5.

## When to rotate

- A value may have leaked: a copy of `.env` left the server, a value was pasted into a ticket or a chat, a laptop that held it was lost.
- Someone who knew a value loses that access (an operator leaves, a contractor's job ends).
- On a schedule, if your policy asks for one. Nothing in Crove expires these values.

A leak is also a security incident: contain it with this runbook, then follow [incidents.md](incidents.md), section 9.

## Before you start

- Work on the server in the stack directory (`/opt/crove`), as in [incidents.md](incidents.md). Service names are those of the all-in-one layout (`crove`); in the split layout, `api` and `worker` take the same settings, and `docker compose up -d` restarts both.
- Generate every new value on the server with `openssl rand -hex 32`: 64 characters with no `$`, which docker compose would expand, and no quote, which the SQL below would break on.
- Put the new value in `.env` with this shell function, so it never appears in a command's arguments (which other users of the server can list with `ps`) or in the shell history. It replaces the line `NAME=...` (which must exist, as it does in a `.env` made from `.env.example`) and keeps the file's owner and mode:

  ```bash
  rotate() ( umask 077; V="$(openssl rand -hex 32)" awk -v k="$1" -F= '$1 == k { print k "=" ENVIRON["V"]; next } { print }' .env > .env.new && cat .env.new > .env && rm .env.new )
  ```

  Then copy the new value from `.env` into the owner's secret store. The commands below that read a value back from `.env` (`grep ... | cut -d= -f2-`) expect it unquoted, as `rotate` writes it. Keep the old value in the secret store until the last step of the procedure, so you can go back.
- `docker compose up -d` applies `.env`: it runs `migrate` first, then recreates every service whose settings changed. The app is unavailable while it restarts (about 15 s on the test stack below), so rotate at a quiet time and tell the design partner beforehand when it is planned.

## 1. Database login passwords

| Setting | Login role | Used by |
|---|---|---|
| `CROVE_APP_DB_PASSWORD` | `crove_app` | the app (`crove`, or `api` and `worker`), `migrate`, `auth-grants` |
| `CROVE_WORKER_DB_PASSWORD` | `crove_worker` | the worker (`crove`, or `worker`) |
| `CROVE_PROBER_DB_PASSWORD` | `crove_prober` | the prober |
| `CROVE_REPORTER_DB_PASSWORD` | `crove_reporter` | the weekly usage report (`usage`) |
| `AUTH_DB_PASSWORD` | `supabase_auth_admin` | Supabase Auth (`auth`) |
| `POSTGRES_PASSWORD` | `postgres` | `migrate` and `auth-grants` (`ADMIN_DATABASE_URL`), `pnpm ops:kill-switch` |

How it works: `migrate` sets the password of the first five roles from `.env` on every run (`ALTER ROLE ... PASSWORD`, the value never logged). PostgreSQL keeps one password per role: a connection already open stays open, and every new connection with the old password is refused with `password authentication failed`. So the rotation is one `docker compose up -d`, which sets the new passwords and restarts every service that uses them. `POSTGRES_PASSWORD` is different: the database image reads it only when it creates an empty database, so you change it in the database yourself (section 1.2).

Connections from inside the `db` container over its socket or `127.0.0.1` need no password (the image's `pg_hba.conf` trusts them). The `psql` commands in [incidents.md](incidents.md) and the backup script use them, so they keep working whatever you change here.

### 1.1 The Crove roles and Supabase Auth

1. Replace the values you rotate (one, several or all five) in `.env`, for example:

   ```bash
   rotate CROVE_APP_DB_PASSWORD
   rotate CROVE_WORKER_DB_PASSWORD
   rotate CROVE_PROBER_DB_PASSWORD
   rotate CROVE_REPORTER_DB_PASSWORD
   rotate AUTH_DB_PASSWORD
   ```

   Copy the new values into the secret store.
2. Apply them:

   ```bash
   docker compose up -d
   ```

   `migrate` sets the passwords, then `auth`, `crove` and the prober (when `COMPOSE_PROFILES` has `prober`) restart with them. `docker compose run` jobs (the usage report, the backup's heartbeat) read `.env` on each run and need nothing.
3. Update every copy outside this `.env`: a prober run from cron with its own `PROBER_DATABASE_URL`, a `REPORTER_DATABASE_URL` in a checkout's `.env` for `pnpm usage:report`, a monitoring tool that logs in as one of these roles.
4. Check:

   ```bash
   curl -s http://127.0.0.1:${PORT:-8080}/readyz            # {"ready":true}: crove_app works
   docker compose run --rm prober prober                     # exit 0, "[prober] ok: ...": crove_prober works, and the worker's heartbeat is recent
   docker compose run --rm usage usage-report > /dev/null && echo ok   # crove_reporter works
   curl -s http://127.0.0.1:${PORT:-8080}/auth/v1/health     # Supabase Auth is back; then sign in once in the app
   docker compose logs --since 10m | grep -c 'password authentication failed'   # 0
   ```

   To test one role's new password by hand, over the network (`-h db`) so the password is checked, with the value read from `.env` on stdin:

   ```bash
   grep '^CROVE_APP_DB_PASSWORD=' .env | cut -d= -f2- | docker compose exec -T db sh -c 'read -r PGPASSWORD; export PGPASSWORD; psql -h db -U crove_app -d postgres -Atc "SELECT current_user"'
   ```

   It prints `crove_app`; with the old value it fails with `password authentication failed for user "crove_app"`.
5. Remove the old values from the secret store.

**Going back.** Put the old values back in `.env` and run `docker compose up -d` again: `migrate` sets them like any other.

### 1.2 The `postgres` role (the migration runner)

1. Replace the value in `.env`:

   ```bash
   rotate POSTGRES_PASSWORD
   ```

2. Set it in the database, over the trusted socket, with the value read from `.env` on stdin:

   ```bash
   grep '^POSTGRES_PASSWORD=' .env | cut -d= -f2- | sed "s/.*/ALTER ROLE postgres PASSWORD '&';/" | docker compose exec -T db psql -U postgres -v ON_ERROR_STOP=1 -q
   ```

   From here, `ADMIN_DATABASE_URL` with the old password is refused.
3. Apply it, so `migrate` and `auth-grants` use the new password:

   ```bash
   docker compose up -d
   ```

   The `db` service's settings changed, so Docker recreates the database container (the data stays on its volume). The app's connections drop and reconnect by themselves; on the test stack `/readyz` failed for about one second.
4. Check that both one-shot services succeeded, and update `ADMIN_DATABASE_URL` wherever an operator keeps it (for `pnpm ops:kill-switch` or `pnpm db:migrate` from a checkout):

   ```bash
   docker compose ps -a migrate auth-grants        # both "Exited (0)"
   curl -s http://127.0.0.1:${PORT:-8080}/readyz   # {"ready":true}
   ```

5. Remove the old value from the secret store.

The `postgres` password unlocks everything, the context key included ([context-key-rotation.md](context-key-rotation.md)): when it leaked, rotate the context key too.

## 2. `INBOUND_SECRET`

The mail worker (`tools/inbound-mail/worker.js` on Cloudflare Email Routing, [provision-pilot.md](provision-pilot.md), "Inbound email") sends `INBOUND_SECRET` with every message, and the kernel accepts exactly one value. Two facts make a rotation safe for mail:

- When the values differ, the kernel answers 401 and the worker throws instead of rejecting the message, so Email Routing does not accept it and the sending server tries again later. Mail is delayed, not lost and not bounced.
- The secret only guards `POST /api/inbound/email`. Messages already accepted are stored and filed by the worker whatever the secret is, and nothing stored is derived from it.

So the only cost is the window between switching the mail worker and the kernel restarting. Switch the mail worker first and restart the kernel right after: the window is then the restart itself (about 10 s on the test stack). Restarting the kernel first would add the time it takes to edit the worker in the dashboard. A rotation with no window needs the kernel to accept the previous value too: issue #1214.

1. Generate the new value into `.env`, without applying it yet:

   ```bash
   rotate INBOUND_SECRET
   grep '^INBOUND_SECRET=' .env      # copy the value into the secret store, next to the old one
   ```

2. Have `docker compose up -d` ready in a terminal on the server.
3. In the Cloudflare dashboard, **Workers & Pages**, `crove-inbound-mail`, **Settings**, **Variables and Secrets**: edit `INBOUND_SECRET` (type Secret), paste the new value and **Deploy**. With wrangler: `wrangler secret put INBOUND_SECRET`. From this moment the kernel refuses the worker's messages.
4. At once, on the server:

   ```bash
   docker compose up -d
   ```

5. Check:
   - `curl -s http://127.0.0.1:${PORT:-8080}/readyz` answers `{"ready":true}`.
   - Send a message with an e-invoice XML attached to an org's "Địa chỉ nhận hóa đơn qua email" (its **Settings**): it shows in that org's **Inbox** within a minute, and `docker compose logs --since 5m crove | grep '\[inbound\]'` shows it.
   - In the worker's **Logs**, `Crove did not accept the message: 401 UNAUTHENTICATED` appears only during the window; Email Routing's **Activity log** shows the messages of the window delivered once their senders retried (most servers retry within minutes).
6. Remove the old value from the secret store.

**Going back.** If step 4 fails, put the old value back on the worker (step 3 with the old value): the kernel still runs with it. If the kernel already runs with the new value, fix the worker instead.

**Another mail relay.** The same order holds for any relay that calls `/api/inbound/email`, as long as it treats a 401 as a temporary failure, like `worker.js` does. A relay that bounces on 401 loses the mail of the window: stop its inbound route during the switch instead.

## 3. Alert and heartbeat URLs

The secret is part of the URL:

| Setting | The secret | Used by |
|---|---|---|
| `ALERT_WEBHOOK_URL` | the Telegram bot token, or the Slack or Discord webhook | the prober, the worker's security and back-pressure alerts (`crove`, or `worker`), `usage-report --post`, the backup's failure alert |
| `PROBER_HEARTBEAT_URL` | the heartbeat check's ping URL | the prober |
| `BACKUP_HEARTBEAT_URL` | the backup heartbeat check's ping URL | the backup script, through `docker compose run prober prober --backup-ok` |

Whoever holds the webhook can post into the alert chat (or, for Telegram, act as the bot); whoever holds a ping URL can keep its check green while the deployment is down. Create the new secret before revoking the old one, so alerts never stop, except for Telegram, where revoking is what issues the new token.

1. Get the new value:
   - **Telegram:** in `@BotFather`, `/revoke`, pick the bot. It answers with a new token, and the old one stops working at once, so go straight on to step 2: an alert sent before step 3 fails, that probe skips its heartbeat ping, and the heartbeat monitor may page. `ALERT_TELEGRAM_CHAT_ID` does not change.
   - **Slack:** add a new incoming webhook for the same channel (the Slack app's **Incoming Webhooks** page). Keep the old one until step 5.
   - **Discord:** in the channel's **Settings**, **Integrations**, **Webhooks**, create a new webhook and copy its URL. Keep the old one until step 5.
   - **A heartbeat check** (Healthchecks.io, Uptime Kuma, Better Stack): create a new check with the same period, grace and alerts ([alerts.md](alerts.md), section 3) and copy its ping URL.
2. Replace the value in `.env` with an editor (`nano .env`; the vendor issues the URL, so `rotate` does not apply), and copy it into the secret store.
3. Apply it:

   ```bash
   docker compose up -d
   ```

   It recreates `crove` and the prober with the new value; `docker compose run` jobs read it on their next run.
4. Check:

   ```bash
   docker compose run --rm prober prober --test-alert   # exit 0; the phone shows "[Crove] Test alert from <instance>"
   docker compose run --rm prober prober                # "[prober] heartbeat sent to heartbeat monitor at <host>"; the new check shows the ping
   # the worker has the new webhook too: the two hashes match
   grep '^ALERT_WEBHOOK_URL=' .env | cut -d= -f2- | sed -e "s/^[\"']//" -e "s/[\"']\$//" | tr -d '\n' | sha256sum | cut -c1-12
   docker compose exec -T crove sh -c 'printf %s "$ALERT_WEBHOOK_URL" | sha256sum | cut -c1-12'
   ```

   For `BACKUP_HEARTBEAT_URL`, run `tools/backup/backup.sh` once, or wait for the night's run, and check that the new check got its ping.
5. Revoke the old value: delete the old Slack or Discord webhook, and delete (or pause) the old heartbeat check, which pages once its pings stop. Then remove the old value from the secret store.

## What was verified

Tried on 2026-10-23 on a local compose stack of `main` (commit `8d5ca026`), in its own compose project with throwaway values, `INBOUND_DOMAIN` set, the prober profile on, and a small HTTP receiver standing in for the alert webhook and the heartbeat monitor (`ALERT_WEBHOOK_FORMAT=generic`). The stack and its volumes were removed afterwards.

- **Login passwords (1.1):** all five rotated in one `docker compose up -d`. Afterwards each old password was refused over the network (`password authentication failed`) and each new one accepted; `/readyz` was ready, the worker's heartbeat was recent, `prober` and `usage-report` exited 0, a sign-up and a password sign-in through `/auth/v1` worked, and the logs had no authentication failure. `/readyz` and `/auth/v1/health` were unavailable for about 14 s while the services restarted.
- **`postgres` (1.2):** after the `ALTER ROLE`, the old password was refused and the new one accepted; `docker compose up -d` recreated `db`, `migrate` and `auth-grants` exited 0 with the new `ADMIN_DATABASE_URL`, and `/readyz` failed for about 1 s. The stdin form of the check in 1.1, step 4, and the `ALTER ROLE` pipe were tried again on a separate throwaway PostgreSQL 17: no password appeared in the server log or in `pg_stat_activity`. The `rotate` function was tried on a copy of a `.env`: it replaced only the named lines with 64 hex characters and left every other line as it was.
- **`INBOUND_SECRET` (2):** messages were relayed with `relay()` from `tools/inbound-mail/worker.js` itself, one per second, from switching the worker's value until well after the restart. Between the switch and the kernel's restart, each one got 401 and the worker threw (the retry path); during the restart, a connection error (the same path); from the restart on (about 11 s after the switch), each one was accepted. Relaying the 8 refused messages again, as their senders would, got all 8 accepted: 41 messages accepted in all, and 41 `kernel-inbound-email` jobs queued. The old value then got 401.
- **Webhook and heartbeat URLs (3):** after `docker compose up -d`, the `crove` and prober containers held the new `ALERT_WEBHOOK_URL` (hashes matched), and the test alert, a probe's heartbeat ping and `usage-report --post` all reached only the new URLs.

Not verified here: Cloudflare Email Routing itself (that a thrown worker makes the sender retry is how `worker.js` is designed and tested, `tools/test/inbound-mail-worker.test.ts`, not something this test observed at Cloudflare: check the Activity log the first time), the Telegram, Slack, Discord and heartbeat vendors' own screens, the backup heartbeat, and the split layout.
