# Runbook: incidents

What to do when something breaks on a Ludy deployment that runs the `docker compose` stack (the pilot setup, issue #678, plan section 7.10). Each incident below has the same parts: the symptom, the alert that fires, the checks (commands to copy), the fix, how to confirm it, and who to tell.

How alerts reach the owner's phone (the prober, the outside uptime check on `/healthz`, the heartbeat monitor) is in [alerts.md](alerts.md). Backups and restores are in [backup-and-restore.md](backup-and-restore.md), credential keys in [context-key-rotation.md](context-key-rotation.md) and [credential-key.md](credential-key.md), database passwords, `INBOUND_SECRET` and webhook secrets in [secret-rotation.md](secret-rotation.md), releases and rollbacks in [deploy.md](deploy.md).

## Before you start

All commands run on the server in the stack directory (`/opt/crove`). Service names are those of the all-in-one layout: `crove` runs the API and the worker together. In the split layout (`compose.host.yml` with `api` and `worker`), use `api` for the web side and `worker` for background work.

| What | Command |
|---|---|
| What runs, and its health | `docker compose ps` |
| The last log lines of a service | `docker compose logs --tail 200 crove` (or `worker`, `api`, `auth`, `db`, `prober`) |
| One probe now, with every finding | `docker compose run --rm prober prober` (exit 0 healthy, 1 a limit exceeded, 2 the database could not be read, 3 an alert could not be delivered) |
| Readiness | `curl -s http://127.0.0.1:${PORT:-8080}/readyz` (`{"ready":false,"reason":...}` names `database`, `schema`, `jobs_schema` or `auth_grants`) |
| SQL, read only | `docker compose exec db psql -U postgres -c "<query>"` |

The queries in this runbook only read. The one write is the dead-letter retry in section 3, on the job queue's own table. No step changes a tenant table by hand: every change to an org's data goes through a command in the app (AGENTS.md, "One write path").

**Severity.** SEV1: users cannot sign in, or uploads and mail stop being processed, or data may have leaked. Tell the owner at once, whatever the hour. SEV2: one function is slow or degraded, or a few jobs failed. Tell the owner the same day. Every incident gets a short note in a GitHub issue afterwards: what broke, when, what fixed it.

**The status page.** With `STATUS_FILE` set (README, "Monitoring and alerts"), users see `PUBLIC_URL/status`, which says for five functions whether they work. Each line comes from these prober checks, so a red line tells you which section to read:

| Line on the page | Prober checks | Section |
|---|---|---|
| Cơ sở dữ liệu (database) | `probe` | 1, and [backup-and-restore.md](backup-and-restore.md) when the data is gone |
| Xử lý chứng từ tải lên (uploaded documents) | `heartbeat`, `job_age`, `dead_letters`, `jobs_schema` | 1, 3 |
| Nhận hóa đơn qua email (invoices by email) | `inbound`, `heartbeat` | 2, 1 |
| Cập nhật trực tiếp trên màn hình (live updates) | `outbox`, `notify_queue` | 2 |
| Đăng nhập (signing in) | `auth` | 4 |

## 1. Stuck worker

**Symptom.** Uploaded files stay "Đang đọc" (being read) for minutes, mail does not arrive in the Inbox, exports never finish. The app itself loads and signs in.

**Alert.** From the prober, one or both of:

- `heartbeat`: `last worker heartbeat was N s ago (limit 120 s): the worker is down`, or `no worker heartbeat recorded: the worker has never started`. The worker records a heartbeat every 30 s (`crove_kernel.worker_heartbeat`); the limit is `PROBER_MAX_HEARTBEAT_AGE_SECONDS`.
- `job_age`: `oldest queued job has waited N s (limit 900 s, M queued): workers are stuck or too few`. The limit is `PROBER_MAX_JOB_AGE_SECONDS`. The queues of the modules the deployment runs always count: the prober's `CROVE_MODULES`, which must be the API's and the worker's value (compose passes the same one; unset means every module) (#1894). A module the deployment leaves out counts only while a worker of the last 7 days works it (#1877, #1887): it keeps its queued jobs for when it is installed again, and they do not raise this alert once the workers that ran it have stopped cleanly (a stopping worker records no modules). A worker that died without a clean stop keeps its modules counted for 7 days, so a dead replica's queues still raise this alert while other replicas keep beating. If such a worker is gone for good and its module was left out on purpose, the alert clears once its heartbeat row is 7 days old, or at once when the database owner deletes the row (`crove_kernel.worker_heartbeat`, by `instance`). So when the only replica that runs a module stops cleanly and its replacement never beats (it fails on start), that module's queued jobs still raise this alert, as long as the module is in the prober's `CROVE_MODULES`. While a worker of an older release is running, every queue counts.

When the database cannot be read, the prober alerts `probe: the prober could not read crove_kernel.health(): ...` instead, and the heartbeat monitor pages once the pings stop: go to "The database" below.

**Checks.**

```bash
docker compose ps                                  # is crove (or worker) running, restarting, unhealthy?
docker compose logs --tail 200 crove | grep -E '\[(worker|heartbeat|pg-boss|relay|extract)\]'
docker compose exec db psql -U postgres -c "SELECT instance, beat_at, now() - beat_at AS age FROM crove_kernel.worker_heartbeat ORDER BY beat_at DESC;"
docker compose exec db psql -U postgres -c "SELECT name, state, count(*), min(start_after) AS oldest FROM crove_jobs.job WHERE state IN ('created', 'retry', 'active') GROUP BY 1, 2 ORDER BY 1, 2;"
```

- No `[worker] started` line since the last restart, or the container restarts in a loop: read the lines before the crash (a missing setting, a refused database login).
- A heartbeat that stopped while the container still runs: the process hangs. `[heartbeat]` lines say why a beat failed (usually the database).
- `[alert] worker event loop lagged over 5000 ms for N s ... exiting so it restarts`: the worker's watchdog (#894) found its event loop blocked for 30 s and exited, so the container restarts it. Once is a slow moment; again and again means a job that blocks the process: the lines before the alert name what was running.
- Many `active` jobs of one name that never finish: one job type is stuck (for example `kernel-file-extract` waiting on `crove-extract`). Check `docker compose ps crove-extract` and its logs.

**Fix.**

```bash
docker compose restart crove                       # or: docker compose restart worker
```

A restart is safe: jobs are in the database, and a job that was running is picked up again after its timeout. When `crove-extract` is the one stuck, `docker compose restart crove-extract`.

**Confirm.** The heartbeat query shows an age under 30 s, the job counts fall, `docker compose run --rm prober prober` exits 0, and the prober sends `[Crove] RESOLVED on <instance>`.

**Who to tell.** SEV1 when uploads stopped for users: the owner at once. Tell the design partner what was delayed; nothing is lost, files waiting are read once the worker runs.

### The database

When the `probe` finding fires or `/readyz` answers `"reason":"database"`:

```bash
docker compose ps db
docker compose logs --tail 200 db
df -h /var/lib/docker                              # a full disk stops PostgreSQL
```

Restart it with `docker compose restart db`, then the app (`docker compose restart crove`). When the disk is full, free space first (old images: `docker image prune`; old release directories are kept to `CROVE_KEEP_RELEASES`). When the data is damaged or lost, restore: [backup-and-restore.md](backup-and-restore.md). Always SEV1.

## 2. Outbox lag

**Symptom.** Screens do not refresh by themselves (a new proposal appears only after reloading), notifications come late, mail sits unprocessed.

**Alert.** From the prober:

- `outbox`: `oldest unpublished outbox event is N s old (limit 300 s, M pending): the relay is behind or stopped`.
- `inbound`: `oldest unrelayed inbound email is N s old (limit 300 s, M pending): the relay is behind or stopped`.
- `notify_queue`: `the NOTIFY queue is N% full (limit 50%): a listening session has stopped reading`.

The limit for both ages is `PROBER_MAX_OUTBOX_AGE_SECONDS`.

First check `pnpm ops:kill-switch status` (§7): while a `relay:<event type>` switch is engaged, the events it holds keep this alert firing by design, and the relay is not stuck.

The relay runs inside the worker: it listens for new events (`LISTEN crove_outbox`, plus a check every second), claims up to 100 at a time from `crove_kernel.outbox_pending` (and mail from `crove_kernel.inbound_pending`), and hands them to the job queue. A relay that stops is almost always a worker that stopped (section 1).

**Back-pressure.** Before the prober's limit, the worker steps in by itself (#894): every 10 s it reads the age of the oldest pending event, and while it is over `OUTBOX_LAG_PAUSE_SECONDS` (default 30 s) the worker stops fetching agent, bulk mail, archive and retention jobs, so the relay and the work people wait for get the database. It logs `[alert] back-pressure on: outbox lag N s ...` with the paused queues, and posts the same line to `ALERT_WEBHOOK_URL` as `[Crove] Worker on <instance>: back-pressure on ...` when the webhook is set on the worker. Once the lag is back under half the setting, the paused jobs run again (`back-pressure off`). Nothing is lost while paused: the jobs wait in the queue. A pause that keeps coming back means the relay cannot keep up: look for one org producing a flood of events (`SELECT e.org_id, e.type, count(*) FROM crove_kernel.outbox_pending p JOIN crove_kernel.outbox_event e ON e.org_id = p.org_id AND e.id = p.event_id GROUP BY 1, 2 ORDER BY 3 DESC LIMIT 10;`).

**Checks.**

```bash
docker compose logs --tail 200 crove | grep '\[relay\]'      # "[relay] listen connection lost", or the error of a failing batch
docker compose exec db psql -U postgres -c "SELECT count(*), min(e.created_at) AS oldest FROM crove_kernel.outbox_pending p JOIN crove_kernel.outbox_event e ON e.org_id = p.org_id AND e.id = p.event_id;"
docker compose exec db psql -U postgres -c "SELECT p.seq, e.type, e.created_at, p.attempts, p.last_error FROM crove_kernel.outbox_pending p JOIN crove_kernel.outbox_event e ON e.org_id = p.org_id AND e.id = p.event_id ORDER BY p.seq LIMIT 20;"
docker compose exec db psql -U postgres -c "SELECT count(*), min(received_at) FROM crove_kernel.inbound_pending;"
```

For `notify_queue`, look for a session that stopped reading, usually one left idle in a transaction:

```bash
docker compose exec db psql -U postgres -c "SELECT pid, application_name, state, now() - state_change AS for FROM pg_stat_activity WHERE state LIKE 'idle in transaction%' ORDER BY state_change;"
```

**Fix.** Restart the worker (`docker compose restart crove`). A batch that fails every time keeps its error in `last_error` and is retried for ever without losing the event: fix the cause the error names (the job queue schema, the database), and the relay catches up by itself. For the NOTIFY queue, end the session that holds it: `SELECT pg_terminate_backend(<pid>);` with the pid from the query above (a Ludy process reconnects by itself).

**Confirm.** The pending counts fall to 0 (or near it), the prober sends `RESOLVED`, screens update without reloading.

**Who to tell.** SEV2 while it is only slow; SEV1 when mail stays unprocessed for more than an hour. The owner, and the design partner if invoices sent by email were delayed.

## 3. Dead-letter jobs

**Symptom.** Often none a user notices: a background job (a sign-out in Supabase Auth, a report mail, an export) failed after its last retry.

Since #1720 a failed job of an org also shows in that org's Inbox, for its owners and admins: the card *Việc chạy nền bị lỗi* (*Background work that failed*) names the kind of work, when, and the first 8 characters of the job id, never what the job carried or its error. pg-boss copies every failed job to the queue `kernel-job.dlq`, whose worker raises that item (`[dead-letter] <queue> job <id>: Inbox item raised` in the worker log); a job of no org (a schedule, a sweep, raw inbound mail) raises none (`[dead-letter] ... a job of no org, so no Inbox item`). The failed job itself stays where this alert counts it either way. A closed org gets no item either (`the org refused it`). A failed `kernel-job.dlq` job means the item could not be raised (the database refused, or the copy carried no source queue): its `output` says why, and the original job is still listed.

**Alert.** `dead_letters`: `N job(s) failed after their last retry in the last W s (limit 0): see the worker log`. The limit is `PROBER_MAX_DEAD_LETTERS` (default 0: every failed job alerts once); the window is `PROBER_DEAD_LETTER_WINDOW_SECONDS` (default: the probe interval plus 60 s).

Some jobs never end up here, because they record their own failure instead: a document that could not be read is marked failed in the app with a message for the user (section 6), mail for an unknown address is dropped (`[inbound] ... dropped: <code>`), and a few jobs end with an `ALERT` line instead: `[signout] ALERT ... revoked in Crove only`, `[org-export] ALERT export of org ... failed after N attempts`, `[year-archive] ALERT ...`. Since #1993 such a line also reaches the alert webhook (`ALERT_WEBHOOK_URL`), once an hour per kind and process, as do the retention, evidence-hold and integrity `ALERT` lines; without a webhook it is in the log only. Search the log for `ALERT` too.

A failed `kernel-archive-write` or `kernel-archive-verify` job belongs to the WORM archive of audit events and journal entries. A `kernel-archive-verify` failure with `ARCHIVE_MISMATCH` in its error is a possible tampering, SEV1: follow [worm-archive.md](worm-archive.md), not the retry below.

A failed `finance-period-balance-verify` job (`PERIOD_BALANCE_MISMATCH` in its error and a `[period-balance] ALERT` line in the worker log) means the period balance deltas no longer match the journal lines (#1284). The job runs only when the finance module is installed (#1471). Only the posting definer appends deltas and both tables are append-only, so a difference is a write outside the posting path (the database owner, a restore, a trigger disabled): treat it as a possible tampering, SEV1, and compare with the WORM verifier's last run. The error names each org, account, month and entry, never an amount. An entry listed only as `missing` (lines without deltas) and dated before the release that added the deltas was posted by the old release during that deploy: a forward migration that runs the statement of `20261101160100_crove_finance_period_balance_backfill.sql` again fills it in. Do not retry the job before the cause is known.

**Checks.**

```bash
docker compose exec db psql -U postgres -c "SELECT id, name, retry_count, completed_on, left(output::text, 300) AS error FROM crove_jobs.job WHERE state = 'failed' ORDER BY completed_on DESC LIMIT 50;"
docker compose logs --tail 500 crove | grep -E 'ALERT|\[pg-boss\]'
```

The job's `name` says what failed and `output` holds the error.

**Fix.** First fix the cause the error names (a mail server that refused, a bucket that was not reachable, a bug: then open an issue with the error). Then:

- **Leave it** when the work no longer matters (a mail that is out of date). A failed job is deleted by the queue after its retention; nothing else depends on it.
- **Retry it** when the work still matters. The repository has no retry tool yet; this is the same statement pg-boss's own `retry` runs, for one job name and the ids from the query above:

  ```bash
  docker compose exec db psql -U postgres -c "UPDATE crove_jobs.job SET state = 'retry', retry_limit = retry_limit + 1, completed_on = NULL, start_after = GREATEST(start_after, now()) WHERE name = '<job name>' AND id = ANY('{<id>,<id>}'::uuid[]) AND state = 'failed';"
  ```

  Only jobs whose handlers are safe to run twice should be retried this way; every Ludy job is meant to be (idempotency keys and singleton keys), but read the error first.

**Confirm.** The job's state moves to `completed` (`SELECT state FROM crove_jobs.job WHERE id = '<id>';`), and the next probes send `RESOLVED` once the window has passed.

**Who to tell.** SEV2. The owner the same day, with the job name and the error. When it was a sign-out (`[signout] ALERT`), the user it was for: their session is closed in Ludy but may still be open in Supabase Auth.

## 4. Supabase Auth outage

**Symptom.** Nobody can sign in, sign up or recover a password; the sign-in page answers "Dịch vụ đăng nhập không phản hồi" (the proxy's 503 `AUTH_UNAVAILABLE`). People already signed in keep working until their access token expires (at most 15 minutes in the compose stack, `GOTRUE_JWT_EXP=900`), because the token cannot be refreshed; then they are signed out. Approvals and other R3 actions need a fresh second factor, which needs Supabase Auth, so they fail too.

**Alert.** The prober asks Supabase Auth's `/health` on every probe, the way signing in reaches it (the kernel's `/auth/v1` proxy, or `PUBLIC_AUTH_URL` when Auth is hosted elsewhere), and pages after `PROBER_AUTH_MISSES` (default 2) failed answers in a row (one, on the first probe after the prober starts, so a restart during an outage keeps the alert open): `[Crove] ALERT ... Supabase Auth did not answer its health check 2 time(s) in a row (HTTP 503): nobody can sign in`, then `RESOLVED` once it answers again (#1994). The status page shows "Đăng nhập" as down. Under Compose the check goes through the API's `/auth/v1` proxy, so an `auth` alert with `connection failed` may also mean the API itself is down: look at the outside uptime check on `/healthz` (alerts.md, section 2). The deploy's smoke test checks it too (`/auth/v1/health answers (Supabase Auth through the proxy)`). A database outage also takes Auth down: check section 1, "The database".

**Checks.**

```bash
docker compose ps auth                             # its own healthcheck: GET /health on port 9999 inside the network
docker compose logs --tail 200 auth
curl -s http://127.0.0.1:${PORT:-8080}/auth/v1/health     # through the kernel's proxy, the path every sign-in takes
curl -s http://127.0.0.1:${PORT:-8080}/readyz             # "auth_grants" means the grants step must run again
```

**Fix.**

```bash
docker compose restart auth
docker compose up -d auth-grants                   # when /readyz says auth_grants (after Auth recreated its tables)
```

After an upgrade, Supabase Auth migrates its own schema before it is healthy, which can take minutes (its start period is 5 minutes); wait before restarting it again. When a release broke it, roll back ([deploy.md](deploy.md)).

**Confirm.** `/auth/v1/health` answers, `/readyz` answers `{"ready":true}`, and a test sign-in works.

**Who to tell.** SEV1. The owner at once, then the design partner: what does not work (sign-in, approvals) and that their data is untouched.

## 5. Signing keys: JWKS refresh and the JWT secret

The kernel accepts access tokens of one family per deployment:

- **The compose stack (self-host):** HS256 tokens signed with `AUTH_JWT_SECRET`, the same secret Supabase Auth signs with (`GOTRUE_JWT_SECRET`).
- **A hosted Supabase Auth (`AUTH_JWKS_URL` set):** ES256 or RS256 tokens checked against the published keys, which the kernel caches in memory for 10 minutes.

**Symptom.** After a signing key was revoked or rotated, either everyone gets signed out (new keys, the kernel still has the old ones), or a revoked key still works for up to 10 minutes.

**Alert.** None; users report "signed out" or the owner rotated a key on purpose.

**Fix, JWKS (hosted Auth).** The cache lives in the API process, so a restart drops it and the next request fetches the current keys:

```bash
docker compose restart crove                       # or: docker compose restart api worker
```

Do it right after the key was revoked at the provider; until then a revoked key can pass for up to 10 minutes.

**Fix, rotating `AUTH_JWT_SECRET` (self-host).** Rotate it when it may have leaked. Every user is signed out: their tokens no longer verify, and the app signs them out on the first refused request.

1. Generate a new value on the server (`openssl rand -hex 32`, at least 32 characters) and replace `AUTH_JWT_SECRET` in `.env`; keep the new value in the owner's secret store.
2. Apply it to every service that reads it at once (Supabase Auth, `migrate`, `auth-grants` and the app):

   ```bash
   docker compose up -d
   ```

**Confirm.** A fresh sign-in works; `docker compose logs --tail 50 crove` shows no run of refused tokens after the first minute.

**Who to tell.** The owner before a planned rotation; the design partner that everyone must sign in again. When the reason is a leak, this is also section 9.

## 6. AI quota hit

**Symptom.** PDFs and photos are no longer read: after a few minutes the file shows "Không đọc được chứng từ sau nhiều lần thử; hãy kiểm tra cấu hình AI hoặc gửi tệp XML". E-invoice XML files keep working: they need no AI.

**Alert.** The prober counts the readings whose every attempt failed (the AI provider refused or did not answer, or the parser sandbox was down) and pages when more than `PROBER_MAX_EXTRACTION_FAILURES` (default 2) happen within `PROBER_EXTRACTION_WINDOW_SECONDS` (default 3600 s): `[Crove] ALERT ... 3 document reading(s) failed every attempt in the last 3600 s ...`, then `RESOLVED` once the window has none over the limit (#1998). A document that cannot be read (not an invoice, a scanned PDF, an unsupported format, AI switched off) never pages: its uploader is told. The AI provider may also email the account holder when credits run out.

**Checks.**

```bash
docker compose logs --tail 500 crove | grep '\[extract\]'    # "[extract] file <id> attempt N" with the provider's error
```

A rate limit (HTTP 429) or a server error is retried (3 attempts with backoff); an empty balance (often 402) or a refused key (401, 403) is not. Check the account at the provider (for the pilot, the DOS.AI dashboard, issue #312): credits, the key, and its rate limit.

**Fix.** Top up the credits or replace the key (`AI_API_KEY` in `.env`, then `docker compose up -d`). To stop spending at once, empty `AI_BASE_URL` and `AI_API_KEY` and apply: PDFs and photos then wait for "Chưa cấu hình AI" (AI not configured), XML keeps working. Files that failed meanwhile are read again from the app (re-extraction on the file), not by hand.

**Confirm.** A test PDF is read into a proposal.

**Who to tell.** SEV2. The owner (it is a spending question), and the design partner to send XML in the meantime.

## 7. Kill switches

**What exists today.**
- **Per org:** the kill switch on the Agents page stops that org's AI agents (all of them, one module's, or one agent). For the whole org or the finance module, it also stops the AI reading of new PDFs and photos; XML e-invoices are still read, and "Đọc lại" reads the held files once it is released (#886). Engaging it is open to the org's owners and admins (`kernel.agent.kill_switch.engage`, R1); releasing it needs an owner with a fresh second factor (`kernel.agent.kill_switch.release`, R3). A command refused by an engaged switch answers `KILL_SWITCH_ON`.
- **Deployment-wide (#886):** `pnpm ops:kill-switch`, for the operator, with the admin URL the migrations use.
  - `ai` stops AI document reading and every agent of every org, in the database too: an agent context is refused with `KILL_SWITCH_ON`.
  - `mail` holds the mail queue. Mail stays queued and goes out once released. Invite mail, which a person sends directly, is not held.
  - `relay:<event type>` (#1696), for example `relay:kernel.org.export_requested`, holds the outbox events of that one type in every org: the worker's relay leaves them in the outbox and keeps relaying every other type, so the jobs that type starts (an export, a publish, a booking mail) stop while the rest of the app runs. Releasing it sends the held events, oldest first, within a second; nothing is lost or sent twice. The key is the event type exactly as the outbox stores it (lowercase words joined by dots), one type per switch.
  - Every change keeps its time, who and why (the switch's own append-only history, its audit trail), and no `crove_*` login role can flip it.

**When to use it.** An agent posts, sends or proposes things it should not, or spends more than expected.

**How.** In the app, as an owner or admin of the org: Agents, then the kill switch, with a reason. Never by SQL: the switch is a command so that it is audited.

**The deployment-wide switch**, from the server (or anywhere with the admin URL):

```sh
ADMIN_DATABASE_URL=postgres://... pnpm ops:kill-switch status
ADMIN_DATABASE_URL=postgres://... pnpm ops:kill-switch ai on --reason "AI endpoint compromised" --by "<your name>"
ADMIN_DATABASE_URL=postgres://... pnpm ops:kill-switch ai off --by "<your name>"
ADMIN_DATABASE_URL=postgres://... pnpm ops:kill-switch mail on --reason "mail provider compromised" --by "<your name>"
ADMIN_DATABASE_URL=postgres://... pnpm ops:kill-switch relay:kernel.org.export_requested on --reason "export job crashes the worker" --by "<your name>"
ADMIN_DATABASE_URL=postgres://... pnpm ops:kill-switch relay:kernel.org.export_requested off --by "<your name>"
```

`status` lists `ai`, `mail` and every relay key ever used, each with its state and last change.

It takes effect at once, with no restart; a relay switch from the next relay pass (a batch already being relayed still goes out). A relay switch holds only events not yet relayed: jobs already queued for that type still run (stop those with the module or the worker, below). `status` shows how many events an engaged relay switch holds: 0 after a while usually means a mistyped type.

Keep a relay hold narrow. The first relay pass after an event of a held type arrives marks it as held, and later passes skip marked events without looking them up (#1713), so even a large held backlog (a type orgs produce in bulk, such as `kernel.file.ingested`) does not slow the relay for the other types. Engaging a switch on a large backlog takes a few slower passes while they mark it, about 10000 events a pass; releasing one while another type stays held puts its events back about 100 a pass, oldest first. Three types carry security steps, and the script refuses to engage them without `--force`:
- `kernel.session.revoked` carries the forced sign-out in Supabase Auth, which would wait in every org until released.
- `kernel.member.removed` and `kernel.member.role_changed` are the only path that revokes a removed or demoted member's Social review and report links and stops their CRM booking feed. While held, those links and feeds keep working.

Hold them only when relaying them is itself the incident, and release them first. Holding `kernel.proposal.created` or a notification type delays agents' review tasks and people's notices.

While a relay switch is engaged the held events still count in the prober's outbox age (§2, "Outbox lag"), so that alert keeps firing as a reminder to release it; the worker's back-pressure ignores them, so agents and bulk mail keep running. The flood query in §2 (back-pressure) lists the waiting events by org and type, held ones included. **Rehearsal (Phase 1 exit criterion 8, #1718).** `e2e/tests/kill-switches.spec.ts` rehearses the switches on the compose stack in the e2e job of every pull request:
- the org switch, engaged from the Agents page with a reason: an agent wake-up (a task given to its position) is refused (`kernel.agent.run.start` answers `kill_switch`, no run starts), then an owner with a fresh second factor releases it from the same page;
- `ai`, through the script's own checks and SQL (`parseArgs` and `runSwitch` in `tools/ops/kill-switch.mjs`, run through psql as the stack's `postgres` superuser): an agent wake-up is refused, and a new PDF in the Inbox shows "AI đang tạm dừng"; the switch's history keeps who engaged it and why, then who released it;
- `relay:crm.booking.requested` and `mail`: a visitor's booking waits unconfirmed while its request is held, `status` counts it as held, and once released it is confirmed; its confirmation mail stays queued past a mail sweep with nothing in Mailpit, and goes out to Mailpit once `mail` is released.

Every deployment switch is released after each test and after the file, pass or fail, so the shared stack is never left stopped. On a staging or production deployment, rehearse by hand: engage `ai`, check that an agent wake-up is refused and that a new PDF in the Inbox shows "AI đang tạm dừng", then release it.

**Other deployment-wide levers**, applied with `docker compose up -d` after editing `.env`:

| To stop | Setting |
|---|---|
| All AI calls | empty `AI_BASE_URL` and `AI_API_KEY` |
| A module (for example Social) | `CROVE_MODULES` without it (the same value for the API, the worker and the prober) |
| New accounts | `AUTH_DISABLE_SIGNUP=true` |
| Posting to one platform | empty its `CHANNEL_*` credentials |
| All background work | `docker compose stop crove` stops the whole app; in the split layout `docker compose stop worker` stops background work only |

**Confirm.** The Agents page shows the switch engaged; agent runs stop (no new runs in the agents' activity).

**Who to tell.** The org's owner, with the reason, and the owner of the deployment for any deployment-wide lever.

## 8. A lost device

A member's phone or laptop is lost or stolen while signed in.

**What the member does** (Settings, sessions): sign out the session on that device, or all their sessions (`kernel.session.revoke`). This closes them in Ludy at the next request and in Supabase Auth through the background job. Then change the password, and remove the second factor that lived on that device and add a new one (Settings, two-factor).

**What the org's owner does** when the member cannot: in Settings, the member's sessions, revoke them; this closes them in that org at once. If the device may be in someone else's hands for long, remove the member from the org (`kernel.member.remove`, R3) and invite them again once they have a new device.

**What the operator does** when the member lost their only second factor and cannot sign in: there is no admin tool in Ludy for resetting a factor yet, and Supabase Auth's admin API is not exposed through the kernel. The member signs up the factor again after the owner removes and re-invites them; tell the owner if that is not enough.

**Confirm.** The member's session list no longer shows the device; a request from it gets signed out.

**Who to tell.** The org's owner. When the device held an owner's or accountant's account, also the owner of the deployment: think about section 9.

## 9. Personal data breach: the 72-hour notice

Personal data of users or of the people in an org's documents may have been read, changed or lost by someone who should not have it: a leaked secret, a stolen device with an open session, a bug that showed one org's data to another, a lost backup.

What the law requires is not settled in this repository yet. Plan section 7.9 lists a "72 h breach notification runbook" among the PDPL items (Law 91/2025/QH15 and Decree 356/2025/ND-CP) that must be done, and reviewed by a lawyer, before the first external tenant (gate T16, issue #62); the deadline is to be reconfirmed against Decree 356. Until the lawyer's version replaces this section, follow the steps below and let the lawyer decide the notice itself.

1. **Contain** (the first hour): revoke what leaked, each with its procedure: `AUTH_JWT_SECRET` and hosted signing keys, section 5; the context key, [context-key-rotation.md](context-key-rotation.md); the credential key, [credential-key.md](credential-key.md); database passwords, `INBOUND_SECRET` and alert or heartbeat URLs, [secret-rotation.md](secret-rotation.md). Revoke the sessions (section 8) and engage a kill switch (section 7) where they help, and keep the system running unless keeping it up makes the leak worse.
2. **Keep the evidence:** do not delete logs or rows. Save `docker compose logs --since 72h > incident-<date>.log` and a backup ([backup-and-restore.md](backup-and-restore.md)), and write down what happened when, with times.
3. **Tell the owner at once**, whatever the hour: the 72 hours run from when the breach was found, not from when the owner heard of it.
4. **Find the scope:** which orgs, which kinds of data (names, tax codes, invoices, bank details), how many people, since when.
5. **The owner calls the lawyer** (issue #62), who decides what must be notified, to which authority and to whom. The notice drafts, to the authority and to the affected org, are in [breach-notice.vi.md](../legal/pdpl/breach-notice.vi.md). Send the notice within the deadline the lawyer confirms.
6. **Tell the affected orgs** as the lawyer advises.
7. **Afterwards:** an issue with the timeline, the cause and the fix.

**Who to tell.** The owner first, then the lawyer, then the affected orgs. Always SEV1.
