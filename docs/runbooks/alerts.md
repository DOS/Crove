# Runbook: alerts that reach the owner's phone

How the owner of a Crove deployment (the pilot setup, backlog item M1-9, issue #309) learns about an outage before the design partner calls. Three pieces, each set up once and tested once:

1. **The prober** posts to a Telegram chat (or a Slack channel) the owner reads on the phone when background work stops moving: the relay, the job queue, the worker, the NOTIFY queue, the database, a failed backup.
2. **An outside uptime check** requests `PUBLIC_URL/healthz` every 5 minutes from somewhere other than the server, and pages the owner when it fails: the API, the reverse proxy, the certificate or the whole host is down.
3. **A heartbeat monitor** (a dead man's switch) expects a ping from the prober every probe interval, and pages the owner when the pings stop: the prober itself stopped, the host is down, the database cannot be read, or the alert path is broken (a revoked bot token, a deleted chat).

| What breaks | Who tells the owner |
|---|---|
| The worker, the relay or the job queue stalls; jobs fail after their last retry | the prober |
| The database cannot be reached | the prober, and the heartbeat monitor once the pings stop |
| A nightly backup fails | the backup script, through the prober's webhook |
| The API, the reverse proxy or the TLS certificate fails | the uptime check |
| The whole server is down | the uptime check and the heartbeat monitor |
| The prober is stopped, or its alerts cannot be delivered | the heartbeat monitor |

Pick outside services that run on infrastructure other than the server: a monitor on the same host goes down with it. Any service that can request an https URL every 5 minutes and accepts heartbeat pings will do; Healthchecks.io, Better Stack and UptimeRobot have free tiers, and Uptime Kuma can be self-hosted on another machine. Have each one alert the owner through its phone app, SMS or the same Telegram chat.

## 1. The prober's alerts in Telegram

1. In Telegram, talk to `@BotFather`, send `/newbot` and follow the prompts. It answers with the bot token. Keep the token in the secret store with `.env`: whoever holds it can post as the bot.
2. Create a group for alerts (or use the private chat with the bot), add the bot, and send any message in it.
3. Find the chat id: open `https://api.telegram.org/bot<token>/getUpdates` in a browser and read `"chat":{"id":...}` from the message you just sent. Group ids are negative. Close the tab afterwards: the address contains the token.
4. In the deployment's `.env`:

   ```bash
   ALERT_WEBHOOK_URL=https://api.telegram.org/bot<token>/sendMessage
   ALERT_TELEGRAM_CHAT_ID=-100...        # the chat id from step 3
   COMPOSE_PROFILES=prober               # the deploy pipeline and `docker compose up` start the prober
   ```

   Slack instead: create an incoming webhook for the channel and set `ALERT_WEBHOOK_URL` to it (no chat id). The other formats are in the README, "Monitoring and alerts".
5. Apply it with `docker compose up -d` (or the next deploy), then send a test alert:

   ```bash
   docker compose run --rm prober prober --test-alert   # or `pnpm alert:test` from a checkout holding the .env
   ```

   The phone shows `[Crove] Test alert from <instance>: alert delivery works.` Exit code 3 means the alert was not delivered; the output names the reason (for example `Bad Request: chat not found`).
6. Turn on notifications for the chat on the phone, and check that a muted group or the phone's focus mode does not hide them.

Without the Compose profile, run the prober from cron instead (README, "Monitoring and alerts"). Either way, `pnpm pilot:check` fails while `ALERT_WEBHOOK_URL` is unset or not https.

## 2. The outside uptime check on `/healthz`

`/healthz` answers `{"ok":true}` while the API process serves; it does not touch the database (the prober covers that), so it stays cheap to request every few minutes.

At the uptime service, create one check:

| Setting | Value |
|---|---|
| Type | HTTP(S) |
| URL | `https://<your domain>/healthz` (the deployment's `PUBLIC_URL` plus `/healthz`) |
| Interval | 5 minutes |
| Expect | status 200 (and, where the service can match the body, `"ok":true`) |
| Certificate | alert when it expires within 14 days, if the service offers it |
| Alerts | the owner's phone: the service's app, SMS, or the Telegram chat from step 1 |

Then test it once: stop the API (`docker compose stop crove`, or `api` in the split layout) for longer than one interval, check that the phone gets the alert, and start it again (`docker compose start crove`). Do it outside the partner's working hours.

## 3. The heartbeat monitor

The prober pings `PROBER_HEARTBEAT_URL` with a GET after every probe that read the database and delivered every notification it owed (exit code 0 or 1). It does not ping when the database cannot be read (exit 2) or an alert could not be delivered (exit 3), nor for `--test-alert` and backup alerts. A failed ping is logged by host only and does not change the exit code; the monitor notices the missing ping by itself.

1. At the monitor, create a heartbeat (Healthchecks.io calls it a check, Uptime Kuma a push monitor, Better Stack a heartbeat) with:
   - period: `PROBER_INTERVAL_SECONDS` (default 300 s, 5 minutes); with cron, the cron interval;
   - grace: 10 minutes, so one slow probe does not page anyone;
   - alerts: the owner's phone, as above.
2. Copy its ping URL into `.env` and apply it:

   ```bash
   PROBER_HEARTBEAT_URL=https://<monitor>/ping/<check id>
   ```

   The URL is the check's secret (anyone who has it can keep the check green), so keep it with the other secrets. `pnpm pilot:check` fails when it is not https.
3. After `docker compose up -d prober`, the prober logs `[prober] heartbeat sent to heartbeat monitor at <host>` after each probe, and the monitor shows the pings.
4. Test it once: `docker compose stop prober`, wait for the period plus the grace, check that the phone gets the alert, then `docker compose start prober`.

## 4. Record it

When the three tests above reached the phone, note it in issue #309 with the date, then confirm the `MANUAL` alert lines of `pnpm pilot:check` for the pilot sign-off ([pilot-readiness.md](pilot-readiness.md)).

## Weekly usage summary

Optional, and not part of the pilot sign-off: the same chat can get a summary of last week's usage every Monday (issue #344), so the owner sees how the pilot goes without running the report. `usage-report --post` prints the weekly usage report (README, "Weekly usage report") and posts the last complete week's deployment totals, with the week before in brackets, to `ALERT_WEBHOOK_URL`:

```text
[Crove] Weekly usage on crove.example.com: 2026-W42, from 2026-10-12 (Asia/Ho_Chi_Minh). In brackets: 2026-W41.
- active orgs: 2 [1]
- active users: 3 [2]
- documents uploaded: 10 [7]
...
```

It reads usage as `crove_reporter` (set `CROVE_REPORTER_DB_PASSWORD`, applied by `migrate`), never through the prober, and posts no org name or id.

1. Run it once by hand after step 1 above works:

   ```bash
   docker compose run --rm usage usage-report --post
   ```

   The table goes to the terminal, `[usage-report] summary posted to telegram webhook at api.telegram.org` follows, and the chat shows the summary. Exit code 2 means nothing was read or posted (most often `--post needs ALERT_WEBHOOK_URL`); 3 means the report was read but the post failed, with the vendor's short reason.
2. Schedule it on the host with cron (`crontab -e` as the user that runs the stack). Cron uses the server's clock, usually UTC: `0 1 * * 1` is Monday 08:00 in Vietnam (UTC+7). The weeks themselves follow `--time-zone` (default `Asia/Ho_Chi_Minh`), so run it after Monday 00:00 there:

   ```bash
   0 1 * * 1 cd /opt/crove && docker compose run --rm usage usage-report --post > /dev/null 2>> /var/log/crove-usage.log
   ```

   Use the directory that holds the deployment's `docker-compose.yml` and `.env`. The table is dropped (`> /dev/null`); the log keeps the one-line result of each run. To also keep the numbers, send stdout to a file instead, for example `--csv --post > /var/log/crove-usage-$(date +\%F).csv` (cron needs the `%` escaped).
3. A missed Monday is not caught up by itself: run step 1 by hand, or look at the log. A post that fails is not retried; the next Monday's run posts as usual.
