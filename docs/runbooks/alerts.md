# Runbook: alerts that reach the owner's phone

How the owner of a Ludy deployment (the pilot setup, backlog item M1-9, issue #309) learns about an outage before the design partner calls. Three pieces, each set up once and tested once:

1. **The prober** posts to a Telegram chat (or a Slack channel) the owner reads on the phone when background work stops moving: the relay, the job queue, the worker, the NOTIFY queue, the database, Supabase Auth (sign-in), the WORM archive's nightly verification and its lag, a failed backup.
2. **An outside uptime check** requests `PUBLIC_URL/healthz` every 5 minutes from somewhere other than the server, and pages the owner when it fails: the API, the reverse proxy, the certificate or the whole host is down.
3. **A heartbeat monitor** (a dead man's switch) expects a ping from the prober every probe interval, and pages the owner when the pings stop: the prober itself stopped, the host is down, the database cannot be read, or the alert path is broken (a revoked bot token, a deleted chat).

| What breaks | Who tells the owner |
|---|---|
| The worker, the relay or the job queue stalls; jobs fail after their last retry | the prober |
| The database cannot be reached | the prober, and the heartbeat monitor once the pings stop |
| A nightly backup fails | the backup script, through the prober's webhook |
| A job that records its own failure gives up, or a sweep stops working (an `ALERT` line in the worker or API log: a sign-out left open in Supabase Auth, an org export or year archive that failed, a retention purge or blob sweep that stopped, evidence holds that fail, a stored file whose bytes no longer match) | the worker or API itself, through the same webhook (`ALERT_WEBHOOK_URL`), once an hour per kind and process (`SECURITY_ALERT_REPEAT_MINUTES`, #1993) |
| A nightly backup stops running (the timer disabled, the server off) | the backup heartbeat monitor (`BACKUP_HEARTBEAT_URL`, [backup-and-restore.md](backup-and-restore.md)) |
| The API, the reverse proxy or the TLS certificate fails | the uptime check |
| The whole server is down | the uptime check and the heartbeat monitor |
| The prober is stopped, or its alerts cannot be delivered | the heartbeat monitor |

Pick outside services that run on infrastructure other than the server: a monitor on the same host goes down with it. Any service that can request an https URL every 5 minutes and accepts heartbeat pings will do; Healthchecks.io, Better Stack and UptimeRobot have free tiers, and Uptime Kuma can be self-hosted on another machine. Have each one alert the owner through its phone app, SMS or the same Telegram chat.

## 1. The prober's alerts in Telegram

1. In Telegram, talk to `@BotFather`, send `/newbot` and follow the prompts. It answers with the bot token. Keep the token in the secret store with `.env`: whoever holds it can post as the bot. To replace it, or any webhook or heartbeat URL below: [secret-rotation.md](secret-rotation.md), section 3.
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

Without the Compose profile, run the prober from cron instead (README, "Monitoring and alerts"), with `CROVE_MODULES` set to the API's and the worker's value. Either way, `pnpm pilot:check` fails while `ALERT_WEBHOOK_URL` is unset or not https.

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

A second heartbeat watches the nightly backup: `BACKUP_HEARTBEAT_URL`, pinged after each complete backup run (period 1 day, grace 2 hours). Setting it up and testing it: [backup-and-restore.md](backup-and-restore.md), "Set up", step 6.

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

## Security alerts

Besides outages, the worker watches for signs of abuse (issue #996, plan §7.8 "Detective controls"). Every 5 minutes it asks the database for the signals below and, for each new one, logs `[security] ALERT <signal>: ...` and posts `[Crove] Security alert from <instance>: ...` to the same webhook as the prober (`ALERT_WEBHOOK_URL`, Telegram, Slack or Discord; set it on the worker too, as `docker-compose.yml` does). Without a webhook the alerts are in the worker's log only. The messages hold ids and counts, never an email, a person's name or a token; the schema-change alert also names the database role, the command and the first changed object (schema and object name, never the statement text).

| Signal | Fires when | What to do |
|---|---|---|
| `actor_many_orgs` | one user has successful or refused commands in more than `SECURITY_ALERT_ORG_THRESHOLD` orgs (default 20) within `SECURITY_ALERT_WINDOW_SECONDS` (default 300) | Look the user up (`SELECT email FROM crove_kernel.user_account WHERE id = '<id>'`, as staff) and at their audit rows. An accountant serving many clients can be legitimate: raise the threshold. Probing (mostly `NOT_A_MEMBER` refusals) or a stolen account: block it with `user-disable` ([user-disable.md](user-disable.md)). |
| `refusal_spike` | more than `SECURITY_ALERT_REFUSAL_THRESHOLD` (default 500) refused requests across the deployment within the window (the refusal tally, `NOT_A_MEMBER` and permission errors included) | Find the source: `SELECT actor_key, code, sum(refusals) FROM crove_kernel.refusal_tally WHERE last_at > now() - interval '10 minutes' GROUP BY 1, 2 ORDER BY 3 DESC`. A broken client or integration: tell its owner. Probing: block the account and, at the proxy, the address. |
| `privileged_grant` | an owner or admin role was given in an org, by a role change or an invite acceptance (creating an org is not a grant) | Usually routine. Confirm with the org's owner when it is unexpected, for example a grant right after an `actor_many_orgs` alert. |
| `out_of_pipeline_ddl` | a database session changed the schema (created, altered, dropped, commented, granted) outside the migration pipeline; one alert per session, whatever its age, for the first 10 sessions of a pass, then one `out_of_pipeline_ddl_more` for the rest | See "DDL outside the migration pipeline" below. |

A signal that lasts repeats after `SECURITY_ALERT_REPEAT_MINUTES` (default 60); a grant and a schema change alert once. Several workers alert once between them: the database remembers what was alerted (`crove_kernel.security_signal_seen`, read and written only by the worker's definer). An alert whose post failed is not retried until it repeats; the worker's log keeps the line.

### DDL outside the migration pipeline

Every schema change should come from a migration (`supabase/migrations`, applied by `migrate`). A change made by hand in `psql`, by a script or with a stolen database password is recorded and alerted (issue #1202):

- `migrate` installs two event triggers after the migrations, `crove_ddl_watch` (`ddl_command_end`) and `crove_ddl_watch_drop` (`sql_drop`), on `crove_kernel.ddl_watch()`. Creating an event trigger needs a superuser, so this is a step of the `migrate` one-shot job, which runs with `ADMIN_DATABASE_URL` on every `docker compose up` and every deploy; the migrations themselves may run as a role that is not a superuser. It logs `[migrate] DDL watch installed` or, where the admin role may not create event triggers, `[migrate] DDL watch skipped: ...` and the deployment runs without the watch. Each run recreates both triggers, so one that was disabled or dropped is back after the next `migrate`. It refuses (and `migrate` fails) when `crove_kernel.ddl_watch()` is owned by a role that is neither a superuser nor the admin role itself: every session's DDL runs that function.
- Each changed object becomes a row of `crove_kernel.ddl_event`: the time, the session's role and the role it switched to with `SET ROLE`, the command tag (`CREATE TABLE`, `ALTER TABLE`, `DROP INDEX`, `GRANT`, ...), the object's type, schema and name, the backend pid and start time and the client address. A `GRANT` or `REVOKE` names the object type only. The statement text is never kept, since it may hold a secret. No login role can read or write the table; the worker's `security_signals` reports the new rows and marks them alerted.
- Not recorded: the pipeline's own sessions (`migrate` and `auth-grants` list their backend in `crove_meta.pipeline_session` while they run, a table only the migration role and superusers may write); Supabase Auth's own migrations, and only their objects in the `auth` schema (the owner of that schema, `supabase_auth_admin`, when it is not a superuser and has not switched role: it may write the auth tables' rows anyway). Everything else that role does is recorded: a new schema, a table outside `auth`, default privileges, a `GRANT`. And what PostgreSQL never passes to event triggers: roles, databases, tablespaces and event triggers themselves.
- Who can silence it: a superuser (`event_triggers = off`, `DROP EVENT TRIGGER`) and the migration role (the role in `ADMIN_DATABASE_URL`, or whichever role applied the migrations), which owns `crove_meta.pipeline_session`, `crove_kernel.ddl_event` and `crove_kernel.ddl_watch()`: it can mark its own session, empty the records or replace the function. The only other roles that may run DDL at all are `supabase_auth_admin` and roles an operator created. So the watch catches mistakes and the stolen credentials of those roles; it is no defence against someone holding the superuser or migration password. Keep those out of every container but `db` and the one-shot `migrate` and `auth-grants` jobs.

When the alert comes (`N schema change(s) outside the migration pipeline, first by <role>: <command> <object> (ddl_event <id>)`):

1. Read what changed, as the database superuser:

   ```bash
   docker compose exec db psql -U postgres -c "SELECT id, occurred_at, session_role, set_role, command_tag, object_type, object_identity, client_addr FROM crove_kernel.ddl_event WHERE id >= <id> ORDER BY id"
   ```

2. Find who made it: the role, the client address and the time point to the person or the script. Planned maintenance by an operator is fine; note it in the operations log. Expected once on a fresh install and after some Supabase Auth upgrades: `supabase_auth_admin: GRANT TABLE` (Supabase Auth v2.197.0's migrations make 16 such grants; a `GRANT` names no schema, so it is recorded) at the time the `auth` container started. Any other change by `supabase_auth_admin` is not Supabase Auth's.
3. Unexpected, or a role that should never run DDL: treat it as an incident. Change that role's password ([secret-rotation.md](secret-rotation.md)), and undo the change with a forward migration, never by hand (a hand fix is recorded too). A disabled trigger on a ledger table (`ALTER TABLE ... DISABLE TRIGGER`) means the WORM archive should be verified now ([worm-archive.md](worm-archive.md), "Running the verifier by hand").

Check that the watch is on: `docker compose exec db psql -U postgres -c "SELECT evtname, evtenabled FROM pg_event_trigger"` lists both triggers with `A` (fires in every session).

**Hosted Supabase.** Its `postgres` role is not a superuser, but the supautils extension lets it create event triggers, so `migrate` installs the watch there too ([Supabase docs](https://supabase.com/docs/guides/database/postgres/event-triggers)). Such triggers are skipped for superuser sessions and Supabase's reserved roles ([Supabase blog](https://supabase.com/blog/event-triggers-wo-superuser)), so DDL by Supabase's own staff and maintenance roles is not recorded; DDL by `postgres` and every `crove_*` role is. Where a hosted PostgreSQL refuses event triggers to the admin role (permission denied), `migrate` logs the skip and completes; use the provider's audit log (pgaudit) instead.
