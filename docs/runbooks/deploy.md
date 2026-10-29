# Runbook: deploy and roll back

How a release reaches a Ludy instance that runs the `docker compose` stack on one server (the pilot setup, backlog item M1-6), what the smoke test checks, and how to roll back. Issue #56. The pieces:

- `tools/deploy/deploy.sh` runs on the host: it pulls the images, migrates, rolls the services, waits for readiness, runs the smoke test and rolls back on failure.
- `.github/workflows/deploy.yml` builds the images of a release, pushes them to GitHub Container Registry (GHCR) and runs the script over SSH.

Until an environment has its secrets, a run still builds and pushes the release images, and its deploy job passes with the notice "Deploy not configured" without contacting any server.

## What triggers a deploy

| Trigger | Environment | Release name |
|---|---|---|
| A tag `v*` pushed on a commit of `main` | `pilot` | the tag, for example `v0.3.0` |
| A push to `dev` | `beta` | `dev-<first 12 characters of the commit>` |
| Run the workflow by hand ("Run workflow"), action `deploy` | the one you pick | the tag (or `dev`, for beta only) the run starts from |
| Run the workflow by hand, action `rollback` | the one you pick | the release that ran before the current one |

- `pilot` deploys only `v*` tags whose commit is on `main`; any other tag fails the run before anything is built.
- There is no `dev` branch yet: today every PR merges to `main`, and plan §3.5 creates `dev` together with a beta instance. Until both exist, `beta` stays unused.
- The commit must have passed CI: the run waits up to 30 minutes for the check runs named in the variable `DEPLOY_REQUIRED_CHECKS` (one name per line; default `Lint, typecheck, test` and `Playwright on docker compose`) and stops if one did not succeed.
- One deploy per environment runs at a time; a second one waits. GitHub keeps only one waiting run per environment: when a third arrives, the one that was waiting is cancelled. Check the Actions list after queuing a rollback behind a running deploy.
- `pilot` runs only commits of `main`, for a rollback too: start a manual run from `main` or from a `v*` tag.

## What a deploy does

The workflow builds `ghcr.io/<owner>/<repo>` (the kernel image, `Dockerfile`, with the release commit as its `CROVE_BUILD`) and `ghcr.io/<owner>/<repo>-extract` (`apps/extract/Dockerfile`) from the release commit, tags them with the release name and passes them on **by digest**, so the host runs exactly what was built. It uploads `deploy.sh` and the release's `docker-compose.yml` to the host and runs, in this order:

1. Pull both images by digest. The registry login uses the run's read-only token, sent over stdin into a throwaway Docker config that is deleted right after the pull: no credential stays on the host.
2. Check that the compose files load with the env file (`docker compose config`). Nothing has changed yet.
3. Start the database and run `migrate` with the new image (the migrations, then the DDL watch's event triggers, [alerts.md](alerts.md)). If it fails, the services are left as they were and the run exits 1: the old release keeps running.
4. Start Supabase Auth (it applies its own migrations before it is healthy) and run `auth-grants`.
5. Start the other services (`crove-extract`, Mailpit, anything from `compose.host.yml`).
6. Roll the app. With separate `worker` and `api` services, the **worker first**: it must still be running after `CROVE_WORKER_SETTLE` seconds (15), then the API. With the all-in-one `crove` service (the pilot), that one container.
7. Wait for `/readyz` (`CROVE_READY_TIMEOUT`, 300 seconds): it answers 200 only when every migration in the image is in the ledger and the session check can read Supabase Auth's tables.
8. Start the prober (when its profile is on), then run the smoke test on the loopback port.
9. On success, record the release as current. On a failure in steps 4 to 8, deploy the release that ran before again (same steps without the migration), run the smoke test on it, and exit 1.

When `DEPLOY_PUBLIC_URL` is set, the workflow then runs the same smoke test through the public URL (DNS, TLS, reverse proxy). If that fails, it rolls back with `deploy.sh rollback` and the run fails.

Exit codes of `deploy.sh`: 0 done; 1 the deploy failed and the previous release serves again (or nothing was changed); 2 bad usage or configuration (missing env file, a deploy already running, no previous release to roll back to); 3 the deploy failed **and** the rollback failed: someone must look at the server.

## What the smoke test checks

`deploy.sh smoke <base url> [build id]` (it needs only bash and curl, so you can run it from any machine):

| Check | Why |
|---|---|
| `/healthz` answers `{"ok":true}` | the process serves |
| `/readyz` answers `{"ready":true}` | the schema is complete and Supabase Auth's grants are in place |
| with a build id: `/version` answers that `build` and `"migrationsMissing":[]` | the new image answers, not an old container that is still running, and its migrations are all in the ledger |
| `/api/config` answers with `authUrl` | the API and its configuration load |
| `/auth/v1/health` answers | Supabase Auth is reachable through the kernel's proxy, the path every sign-in takes |
| `/login` serves the app shell and its first script bundle loads | the sign-in page loads in a browser |

The workflow passes the release commit as the build id, to `deploy.sh deploy --build` (the smoke test on the host, recorded in the release's `release.env`) and to the smoke test through the public URL. A rollback checks the build of the release it returns to when that release was deployed with one; a release from before `/version` has none and skips the check.

With the smoke account set up (below), the workflow's smoke test through the public URL adds one more check:

| Check | Why |
|---|---|
| signs in with the smoke account's password, uploads one synthetic e-invoice XML into the smoke org, waits up to 2 minutes for the worker to turn it into a proposal, then rejects that proposal | sign-in, upload, the worker and `crove-extract` work end to end on the new release |

Without the account's secrets this check is skipped and the log says `smoke skipped: sign-in and upload`. It needs `jq` (GitHub's runners have it). The deploy's own smoke test on the host never runs it: a rollback must not depend on the smoke account, or a broken account would fail the rollback too. So it runs only through `DEPLOY_PUBLIC_URL`, and when it fails, the workflow rolls back like for any failed public check. The full flow (sign up, upload, approve, export) is still the Playwright suite, which must be green on the commit before the deploy starts.

### Smoke account

Off until the owner creates it (#690). Once per environment:

1. Create an account for it, such as `smoke@<your domain>`, with a long random password (`openssl rand -base64 24`), the way any user joins (sign-up while it is open, or an invite). Do not enroll a second factor: the check signs in with the password alone.
2. Signed in as that account, create its own org, for example `Ludy smoke test`, and note the org's slug (the part after `/o/` in the app's address). Nobody else joins it, and the account belongs to no other org: each deploy uploads a document into it and rejects the proposal.
3. In the GitHub environment (`pilot` or `beta`, section "Settings of each GitHub environment"), add the secrets `SMOKE_EMAIL` and `SMOKE_PASSWORD` and the variable `SMOKE_ORG` (the slug). `DEPLOY_PUBLIC_URL` must be set too.

The synthetic e-invoice has a made-up seller and buyer whose tax codes fail the checksum, and a new number each run, so it is never a duplicate. The smoke org counts in the weekly usage report like any org: one active org, one uploaded document and one rejected proposal per deploy. Read the report with `--by-org` and leave out the smoke org's row (its name) when you count the pilot's usage. To stop the check, delete the two secrets.

## Migrations are forward only

A rollback restores the **images and compose files** of the previous release. It never touches the schema: the database stays at the newer release's migrations. This is safe only because every migration keeps the release before it working:

- Add before you use, and remove only after nothing uses it (expand, then contract in a later release; plan §3.5, "Contract changes").
- A broken migration is fixed by a new migration, never by editing or reverting the applied file (AGENTS.md, "Schema only via migrations").
- The older release's `/readyz` still passes on the newer schema: it checks that its own migrations are in the ledger, not that there are no others.
- Exception: #1822 step 2 (`20261120000000_crove_kernel_context_token_required.sql`) revokes `enter_context` from `crove_app`. A rollback to a release from before step 1 is refused on every user request, and one to step 1 needs `CROVE_CONTEXT_TOKEN_KEY` in the env file first ([context-token-key.md](context-token-key.md), "Rolling back past step 2").

## One-time setup of the host

The host is one Linux server with Docker Engine and the compose plugin **v2.24 or newer** (the deploy uses `!reset`), plus bash, curl and tar.

1. Create a deploy user (for example `crove-deploy`) in the `docker` group. Membership of `docker` is equivalent to root on that machine, so this user and its key are as sensitive as root.
2. Create an SSH key pair for the workflow (`ssh-keygen -t ed25519 -N '' -f deploy_key`). Put the public key in the deploy user's `~/.ssh/authorized_keys` with the `restrict` option (no port, agent or X11 forwarding, no terminal): `restrict ssh-ed25519 AAAA... crove-deploy`.
3. Create the stack directory, owned by the deploy user, mode 700: `/opt/crove` by default (`DEPLOY_DIR`).
4. Write the env file there as `.env` (or at `DEPLOY_ENV_FILE`), mode 600: start from `.env.example`, change every secret, and set at least `PUBLIC_URL` (the https address), `AUTH_AUTOCONFIRM=false` with a real SMTP server, `EXPORT_ENCRYPTION_KEY` and `TRUSTED_PROXY_HOPS=1` behind the reverse proxy. The pilot readiness checklist (M1-8) lists the rest.
5. Optional: `compose.host.yml` in the same directory (for example, to drop Mailpit's loopback port, which the default compose file publishes for local use: `services: { mailpit: { ports: !reset [] } }`) for local changes the release files must not overwrite (a reverse proxy service, split `api` and `worker` services, extra volumes). Services it adds that run the Ludy images use `image: ${CROVE_IMAGE}` and `${CROVE_EXTRACT_IMAGE}`, which the deploy sets to the release's digests. `COMPOSE_PROFILES=prober` in the env file turns the prober on.
6. Put a TLS reverse proxy in front of `127.0.0.1:${PORT}` (the compose file publishes the port on loopback only). `tools/deploy/caddy/` holds one for this layout (a `compose.host.yml` and a `Caddyfile`); the whole server setup, from a fresh machine to the first deploy, is in [provision-pilot.md](provision-pilot.md).
7. Read the host key for the workflow from a trusted session on the server (`ssh-keyscan -t ed25519 localhost` on the host itself, then replace `localhost` with the address the runner uses; for a port other than 22 the line starts with `[address]:port`). Do not take it from a scan over the network you are trying to protect.

The first deploy creates `releases/`, `.deploy/` and the active compose files. After it, plain `docker compose` in the stack directory sees the same stack: `docker-compose.yml` is the running release's file and `docker-compose.override.yml` pins its images. With a `compose.host.yml`, add `COMPOSE_FILE=docker-compose.yml:docker-compose.override.yml:compose.host.yml` to the env file so that plain `docker compose` includes it too (the deploy passes the files itself). The nightly backup ([backup-and-restore.md](backup-and-restore.md)) runs `tools/backup` from a checkout with `CROVE_DIR` set to this directory.

## Settings of each GitHub environment

Create the environment (`pilot`, later `beta`) under Settings, Environments. A run that references it before it exists creates it without protection rules, so set these up first. The workflow refuses a pilot run whose commit is not on `main`, but a check inside a workflow does not hold against someone who can push an edited workflow; these settings are the real boundary, so they are required:

- **Deployment branches and tags** (required): "Selected branches and tags", with the tag rule `v*` and the branch `main` for `pilot` (the branch is for rollback runs started from `main`), and the branch `dev` (and, if you want, the tag rule `v*`) for `beta`.
- **Tag protection** (required): a repository ruleset that lets only maintainers create, update or delete tags matching `v*`. Pushing such a tag is a production deploy.
- **Required reviewers** (recommended): the owner approves each pilot deploy and rollback with one click.

| Name | Kind | Required | Value |
|---|---|---|---|
| `DEPLOY_HOST` | secret | yes | the server's host name or IP address |
| `DEPLOY_USER` | secret | yes | the deploy user, for example `crove-deploy` |
| `DEPLOY_SSH_KEY` | secret | yes | the private key from step 2 (the whole file) |
| `DEPLOY_KNOWN_HOSTS` | secret | yes | the host key line(s) from step 7 |
| `DEPLOY_PORT` | variable | no | SSH port, default `22` |
| `DEPLOY_DIR` | variable | no | stack directory on the host, default `/opt/crove` |
| `DEPLOY_ENV_FILE` | variable | no | env file on the host, default `<DEPLOY_DIR>/.env` |
| `DEPLOY_PUBLIC_URL` | variable | no | the public origin, for example `https://crove.example.com`, for the smoke test through the proxy |
| `DEPLOY_REQUIRED_CHECKS` | variable | no | check runs that must be green on the commit, one per line |
| `SMOKE_EMAIL`, `SMOKE_PASSWORD` | secret | no | the smoke account (section "Smoke account"); without them the public smoke test does not sign in |
| `SMOKE_ORG` | variable | with the two above | the smoke org's slug |

The images go to the repository's GHCR packages with the run's own token, so no registry secret is needed. The deploy job's token can only read packages; only the build job, which never talks to the host, can push.

## Pre-deploy checks

Some migrations tighten a rule on data that already exists. Before tagging the first release that contains one, run its read-only check against the environment's database (`psql` as any role that can read the tables, inside a `READ ONLY` transaction). If a check lists anything, **stop**: do not tag the release, and raise it on the migration's issue. Nothing here changes data.

### Amounts the book currency cannot hold (#1282, `20261030002100_crove_finance_currency_scale.sql`)

From this migration on, `post_journal_entry()` refuses an amount with more decimals than the org's book currency uses (VND has none). An entry posted earlier with a fraction of a dong could then never be reversed or replaced, since its mirror carries the same fraction, and a purchase document with one could not be posted again. The check lists journal lines with more decimals than their org's book currency, and purchase documents and lines with fractional VND amounts (a purchase document's amounts are in VND, #918). It must return no rows:

The check runs before the release's migrations, so `crove_kernel.currency` does not exist yet; every org books in VND until a command sets another `base_currency`, so the journal part uses the VND rule:

```sql
BEGIN READ ONLY;
SELECT 'journal_line' AS source, l.org_id, l.entry_id AS id, l.line_no, 'VND' AS currency, l.debit, l.credit
FROM crove_finance.journal_line l
WHERE l.debit <> pg_catalog.round(l.debit, 0) OR l.credit <> pg_catalog.round(l.credit, 0)
UNION ALL
SELECT 'purchase_document', d.org_id, d.id, NULL, 'VND', d.subtotal, d.total
FROM crove_finance.purchase_document d
WHERE d.subtotal <> pg_catalog.round(d.subtotal, 0) OR d.vat_amount <> pg_catalog.round(d.vat_amount, 0)
   OR d.total <> pg_catalog.round(d.total, 0)
UNION ALL
SELECT 'purchase_line', p.org_id, p.document_id, p.line_no, 'VND', p.amount, p.vat_amount
FROM crove_finance.purchase_line p
WHERE p.amount <> pg_catalog.round(p.amount, 0) OR p.vat_amount <> pg_catalog.round(p.vat_amount, 0);
ROLLBACK;
```

After the migration has run, the journal part can use each org's book currency instead: select `t.base_currency AS currency` in place of `'VND' AS currency`, and use `JOIN crove_kernel.tenant t ON t.org_id = l.org_id LEFT JOIN crove_kernel.currency c ON c.code = t.base_currency WHERE c.code IS NULL OR l.debit <> pg_catalog.round(l.debit, c.minor_units) OR l.credit <> pg_catalog.round(l.credit, c.minor_units)`. That post-migration form is the one `apps/kernel/test/finance-currency-scale.db.test.ts` runs.

### Every org has a default legal entity (#1280, `20261102140000_crove_finance_legal_entity_scope.sql` and `20261102150000_crove_finance_legal_entity_books.sql`)

These migrations put every finance row, and every org's period lock row, in its org's default legal entity, then make `legal_entity_id` NOT NULL. An org without a default entity would leave its rows NULL, `SET NOT NULL` would fail, and the deploy would stop on the old release. `20261030001000_crove_kernel_legal_entity.sql` created one for every org and `create_or_replay_org` creates one with every new org, so the check should be empty. It must return no rows:

```sql
BEGIN READ ONLY;
SELECT t.org_id, t.slug, t.status
FROM crove_kernel.tenant t
WHERE NOT EXISTS (SELECT 1 FROM crove_kernel.legal_entity e WHERE e.org_id = t.org_id AND e.is_default);
ROLLBACK;
```

Both migrations rewrite or alter the finance tables under ACCESS EXCLUSIVE locks until they commit (a few hundred milliseconds for a few thousand journal lines in testing). On a large ledger, deploy them in a quiet window.

### No large relay hold pending (#1782, `20261104020000_crove_kernel_relay_hold_mark.sql`)

This migration adds `outbox_pending.held_type` and builds an index on the pending queue. Its header says the index is built under a SHARE lock, but that is wrong: `ADD COLUMN` takes an ACCESS EXCLUSIVE lock on `crove_kernel.outbox_pending` and keeps it until the migration commits. So the index is built under that lock, and for that time everything that touches the pending queue waits: `crove_kernel.emit()` (every command that emits an event), the relay's claim and its back-pressure lag (`outbox_lag_seconds`), the prober's `crove_kernel.health()`, the org purge and `pnpm ops:kill-switch status`. The build takes about as long as an index on the queue's rows: well under a second for a few thousand, longer for a held backlog of hundreds of thousands. Before tagging the first release that contains it, check that no `relay:<event type>` kill switch is holding a large backlog (`pnpm ops:kill-switch status`, [incidents.md](incidents.md) §7), and release or let drain any that is. Where the column `crove_kernel.outbox_pending.held_type` already exists, the migration has run there and there is nothing to check. The pending queue should be short (a few thousand rows at most):

```sql
BEGIN READ ONLY;
SELECT pg_catalog.count(*) AS pending FROM crove_kernel.outbox_pending;
ROLLBACK;
```

## Deploy a release

1. Merge to `main` and wait for CI. Run the [pre-deploy checks](#pre-deploy-checks) of every migration the release adds that has one.
2. Tag the commit and push the tag: `git tag v0.3.0 <commit>` then `git push origin v0.3.0`. (Or create a release with that tag in the GitHub interface.)
3. The `deploy` workflow runs. Its summary shows the image digests, the result on the host and the public smoke test.

To deploy an existing tag again, run the workflow by hand from that tag (Actions, deploy, Run workflow, "Use workflow from" the tag, action `deploy`).

## Roll back

From GitHub: Actions, deploy, Run workflow from `main`, pick the environment and the action `rollback`. It redeploys the release that ran before the current one, with its images (pulled again by digest if they are no longer on the host) and compose file, and runs the smoke test. Running it again returns to the release you left.

From a shell on the server, the same in one command:

```
bash /opt/crove/.deploy/deploy.sh rollback --dir /opt/crove
```

This one has no registry credentials, so it needs the previous images on the host: do not run `docker image prune -a` (or `docker system prune -a`) there, which removes them. Plain `docker image prune` (dangling images only) is safe.

`bash /opt/crove/.deploy/deploy.sh status --dir /opt/crove` shows the current and previous releases and the last lines of `.deploy/history.log`. The host keeps the last 5 release directories (`CROVE_KEEP_RELEASES`); a rollback reaches only the one before the current. To go further back, run the workflow by hand from an older tag: it builds that tag again (new digests) and deploys it like any release, migrations included (they are already applied, so nothing changes in the schema).

## When a deploy fails

- **Exit 1 at the pull, compose check or migration:** nothing was restarted. Read the run log; for a failed migration, fix it with a new migration and release again.
- **Exit 1 after the rollout:** the previous release serves again. The log shows which step or smoke check failed (`smoke failed: ...`, `not ready after ...`, the worker's last log lines).
- **Exit 3:** the deploy and the rollback both failed. On the server: `docker compose ps` and `docker compose logs --tail 100 crove auth` in the stack directory, and `/readyz` (`curl -s http://127.0.0.1:8080/readyz`) for the reason (`database`, `schema`, `auth_grants`).
- **The run was cancelled or the connection dropped:** the script on the host ignores the hangup and finishes, so the result is in `.deploy/history.log` (`deploy.sh status`). A run stopped by a signal is logged there as "interrupted"; check `docker compose ps` and deploy or roll back again.
- **"another deploy (pid N) is running":** a deploy holds the lock `.deploy/lock`. A lock whose process is gone is removed by the next run.
