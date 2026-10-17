# Runbook: backups and restore

How a Crove instance that runs the `docker compose` stack on one server (the pilot setup, backlog item M1-7) is backed up every night, how it is restored, and how the restore is tested. Issue #307.

| Target | Value | Why |
|---|---|---|
| RPO (data that may be lost) | 24 h | One backup a night. The files bucket's versioning keeps files written since then; the database changes of the last day can be lost. |
| RTO (time to serve again) | 4 h | Restoring the backup takes minutes (see [the drill](#the-restore-drill-2026-10-17)); the rest is a new server, DNS and the checks after a restore. |

These targets are for the pilot. Plan §7.9 sets tighter ones for Crove Cloud (point-in-time recovery, a WORM stream); they need managed PostgreSQL or WAL archiving and are not part of this setup.

## What holds state, and what the backup takes

| State | Where | In the backup | Notes |
|---|---|---|---|
| The database: every Crove schema, Supabase Auth's `auth` schema (users, password hashes, sessions, MFA factors), the `crove_jobs` queue (pg-boss), the migration ledger `crove_meta.schema_migrations` | `db-data` volume | `db.dump`, a `pg_dump --format=custom` of the whole database, made as the superuser so row level security hides nothing | The ledger stamps travel as they are; see [After a restore](#after-a-restore). |
| Roles (`crove_app`, `crove_worker`, `crove_prober`, `supabase_auth_admin`, the definer roles), their memberships and settings | the cluster | `roles.sql` (`pg_dumpall --roles-only --no-role-passwords`) | No password hashes: `migrate` sets the passwords from `.env` after a restore. |
| The context key (`crove_kernel.context_key`) | a table | **No.** Its rows are left out (`--exclude-table-data`) | Every restore must make a new key anyway ([context-key-rotation.md](context-key-rotation.md)); `restore.sh` does. A stolen backup therefore holds no key that works against the live database. |
| Files: uploaded invoices, inbound mail not yet filed, org exports | the `files` volume (`STORAGE=local`) or the bucket (`STORAGE=s3`, versioned) | `files/`: every blob, the current version of each object; not `staging/` (abandoned uploads) or temporary files | Org files are content addressed (`org/<org_id>/<sha256>`), and every file row records the blob's sha256, so the backup checks each one. |
| The credential key (seals channel tokens) | the `keys` volume, or `CREDENTIAL_KEY` | **No** | Keep it apart from the database backups ([credential-key.md](credential-key.md)): the two together open every channel token. |
| `.env`: passwords, `AUTH_JWT_SECRET`, `EXPORT_ENCRYPTION_KEY` (and `_PREVIOUS`), `INBOUND_SECRET`, `CREDENTIAL_KEY`, S3 and SMTP keys | the server | **No** | Keep it in your secret store. Without `EXPORT_ENCRYPTION_KEY` the org exports in a restored bucket do not open. |

A run is a directory named by its UTC start time, for example `20261017T020000Z/`:

| File | Content |
|---|---|
| `db.dump`, `roles.sql` | the database and the roles |
| `counts.tsv` | the row count of every table, read in the same snapshot as the dump (pg_dump runs on a snapshot exported by the transaction that counts) |
| `file-refs.tsv` | every file row's storage key, sha256 and generation, from the same snapshot |
| `files/`, `files.sha256` | the blobs and their sha256 |
| `meta.env` | finish time, storage mode, schema version (the newest migration), PostgreSQL version, compose project |
| `SHA256SUMS` | the sha256 of every file above except `files/` (covered by `files.sha256`), written last |

A run fails, and is kept as `<run id>.partial` until the next one deletes it, when the dump or the copy fails, when a file row's blob is missing from the copy or has another sha256, or when an org blob's bytes do not match its name.

## Schedule, retention and the second location

- `tools/backup/backup.sh` makes one run. Run it nightly on the host (below); a lock directory keeps two runs apart.
- Each run is written to `BACKUP_DIR` on the server, then copied to `BACKUP_S3_*`, an S3-compatible bucket in another place than the server and than the files bucket (another provider or account). The copy is checked: the `SHA256SUMS` read back must match, and the object count too. `SHA256SUMS` is uploaded last, so a run without it in the bucket is incomplete and restore refuses it.
- Retention: runs older than `BACKUP_KEEP_DAYS` (30) are deleted from the bucket, and older than `BACKUP_LOCAL_KEEP_DAYS` (default the same; 7 in `.env.example`) from `BACKUP_DIR`. Logs are in `BACKUP_DIR/logs/`.
- Every run is a full copy. At pilot scale (5 to 20 orgs, invoices of kilobytes) a run is a few megabytes; the bucket holds about 30 times the file store.
- A run holds password hashes, refresh tokens and MFA secrets (the `auth` schema). The scripts run with `umask 077` and keep `BACKUP_DIR` at mode 700, so only the user that runs them can read it; run them as root or as a dedicated user in the `docker` group. The S3 keys reach the MinIO client container as `MC_HOST_*` environment variables, never on a command line.
- The script does not encrypt the run. Whoever can read the backup bucket can read the books, so: a private bucket with encryption at rest, keys that reach only `BACKUP_S3_PREFIX` (list, read, write, delete), and, if the provider has it, versioning or object lock so a stolen server key cannot erase the history.
- With no `BACKUP_S3_ENDPOINT` the runs stay in `BACKUP_DIR` only. That is for development: a copy on the same disk is not a backup.

## Set up (once per server)

1. Fill the "Backups" block of `.env` (see `.env.example`): `BACKUP_DIR`, `BACKUP_KEEP_DAYS`, `BACKUP_LOCAL_KEEP_DAYS`, `BACKUP_S3_ENDPOINT`, `BACKUP_S3_BUCKET`, `BACKUP_S3_PREFIX`, `BACKUP_S3_ACCESS_KEY_ID`, `BACKUP_S3_SECRET_ACCESS_KEY`. With `STORAGE=s3` the script reads the stack's own `S3_*` settings to copy the files bucket; those keys must allow listing and reading it.
2. The host needs bash, Docker with the compose plugin, tar, sha256sum and coreutils; the S3 work runs in a throwaway container of the pinned MinIO client image, so nothing else is installed.
3. Run it once by hand from the checkout and read the end of the output (`complete`, `uploaded`, `done`):

   ```sh
   tools/backup/backup.sh
   ```

4. Install a timer. systemd (`/etc/systemd/system/crove-backup.service` and `crove-backup.timer`):

   ```ini
   [Unit]
   Description=Crove nightly backup
   After=docker.service

   [Service]
   Type=oneshot
   WorkingDirectory=/opt/crove
   ExecStart=/opt/crove/tools/backup/backup.sh
   ```

   ```ini
   [Unit]
   Description=Run the Crove backup every night

   [Timer]
   OnCalendar=*-*-* 02:00:00
   RandomizedDelaySec=15min
   Persistent=true

   [Install]
   WantedBy=timers.target
   ```

   Then `systemctl daemon-reload && systemctl enable --now crove-backup.timer`; `systemctl list-timers crove-backup.timer` shows the next run. Or cron: `0 2 * * * cd /opt/crove && tools/backup/backup.sh >> /var/log/crove-backup.log 2>&1`.
5. Test the alert: run it once with a bucket that does not exist, `BACKUP_S3_BUCKET=no-such-bucket tools/backup/backup.sh`. It must exit 1 and the alert must reach your channel.
6. Store the credential key (`docker compose cp crove:/data/keys/credential.key .`, or your `CREDENTIAL_KEY`) and `.env` in your secret store, apart from the backups. Do it again after a key rotation.

## When a backup fails

A failed run exits 1, writes `[backup] FAILED: <step> failed (exit <code>, backup.sh line <n>); run <id>, log <file>` to stderr and to its log, and runs `docker compose run --rm --no-deps prober prober --backup-failed "<reason>"`. That sends `[Crove] ALERT on <instance>: the backup failed.` with the reason to `ALERT_WEBHOOK_URL`, in the format the other alerts use (README, "Monitoring and alerts"); without a webhook it is printed. `BACKUP_ALERT=off` skips the alert. A missing setting (say `BACKUP_S3_BUCKET` with `BACKUP_S3_ENDPOINT` set) fails the same way before anything is dumped, and any other stop of the script (a shell error, a signal) is reported and alerted from its exit handler. A run whose copy in the bucket does not read back whole is deleted from the bucket, so `s3:latest` never picks it.

Read the log, fix the cause, and run `tools/backup/backup.sh` again by hand. The next run deletes the `.partial` directory of the failed one.

What no alert covers: a backup that never runs (the timer disabled, the server off). The outside uptime check (M1-9) catches the server; the monthly test below catches the rest. `ls "$BACKUP_DIR"` shows the newest run at a glance.

## Restore

`tools/backup/restore.sh <run>` restores a run onto the compose stack named by the current directory's `.env`, `COMPOSE_PROJECT_NAME` and `COMPOSE_FILE`, and checks it. `<run>` is a run directory, `s3:<run id>` or `s3:latest` (the newest complete run in `BACKUP_S3_*`). It refuses a database that already holds Crove: restore into empty volumes only. It also refuses when its own `STORAGE` (or, with `s3`, `S3_BUCKET`) differs from what the target compose project resolves (`docker compose config`): the blobs would otherwise go where the target does not read them, for a scratch stack possibly the production bucket, bringing back erased blobs.

It runs these steps and stops at the first failure with `[restore] FAILED: <reason>`:

1. Checks the run against `SHA256SUMS` and `files.sha256` (downloaded first for `s3:`).
2. Starts `RESTORE_PRESTART` (default `db`), loads `roles.sql`, then `pg_restore --create` (the database's own settings and grants come back too, such as TEMPORARY revoked from PUBLIC).
3. Compares the row count of every table with `counts.tsv`; checks that no journal entry is stamped in the future of the new cluster ([ledger-after-restore.md](ledger-after-restore.md), step 2); makes a new context key ([context-key-rotation.md](context-key-rotation.md)).
4. Puts the blobs back: into the `files` volume, or into the bucket. In a bucket each restored object has a new version id while the file rows still name the old one (ADR-0013), so the script points each row at the version now under its key (`generations.tsv` in the restore directory lists every change). The sha256 of the row does not change, and step 5 reads the bytes back. This one update goes past the `file_guard` trigger (superuser, `session_replication_role = replica`, one transaction). `RESTORE_FILES=skip` leaves the files alone, for a bucket that survived.
5. Reads back `RESTORE_SAMPLE` blobs (default 50, `0` for all) named by restored file rows, each at its recorded version, and checks their sha256.
6. Starts the whole stack: `migrate` must finish (it applies migrations newer than the backup, sets the role passwords and runs the hardening guard), then `/readyz` must answer `{"ready":true}`.

It prints the time of each step and of the whole restore. Its log, the row counts, the blob sample and `generations.tsv` stay in `BACKUP_DIR/restore-<time>/`. A run downloaded for `s3:` is deleted from there when the restore passes (a failed restore keeps it for diagnosis), and restore directories past the local retention are deleted by the nightly backup (and by the next restore), so no plain copy outlives the retention.

### Onto a new server (disaster)

1. Provision the server as for the pilot (Docker, the checkout at the release you run, or a newer one: `migrate` applies the newer migrations). Put back `.env` from your secret store, and the credential key (into the `keys` volume, or as `CREDENTIAL_KEY`).
2. Files: if the files bucket survived, keep it in `S3_*` and restore with `RESTORE_FILES=skip`. If it is gone, point `S3_*` at a new, empty, versioned bucket.
3. Restore the newest run and keep the output:

   ```sh
   tools/backup/restore.sh s3:latest
   ```

4. Before opening the instance to users: reconcile the ledger with the e-invoice providers ([ledger-after-restore.md](ledger-after-restore.md), step 4); sign in, open the journal and an invoice. Then switch DNS or the reverse proxy to the new server.
5. Tell users what the RPO means for them: work since the backup's `FINISHED_AT` (in `meta.env`) is lost, except files, which the bucket kept.

Exports recorded before a restore into a new bucket keep the old object versions in their records, so they no longer download: ask for a new export (`org.offboard` again) if one is needed.

### Onto a scratch stack next to the live one (the monthly test, or to look at old data)

`tools/backup/scratch.compose.yml` makes a second stack on the same server that cannot act on the world: mail goes to its own Mailpit (no published port), no AI endpoint, files on its own volume instead of the production bucket, and its own credential key, so channel tokens stay sealed.

```sh
export COMPOSE_PROJECT_NAME=crove-restore-test COMPOSE_FILE=docker-compose.yml:tools/backup/scratch.compose.yml
PORT=18090 PUBLIC_URL=http://localhost:18090 STORAGE=local tools/backup/restore.sh s3:latest
# look at it through an SSH tunnel to 127.0.0.1:18090, then remove it with its volumes:
docker compose down -v
unset COMPOSE_PROJECT_NAME COMPOSE_FILE
```

`STORAGE=local` restores the blobs of an S3 backup onto the scratch stack's own volume (the local store reads a blob by key and checks its sha256, whatever version the row recorded).

## After a restore

- `restore.sh` has already run steps 2 and 3 of [ledger-after-restore.md](ledger-after-restore.md) (no stamp in the future; a new context key). Step 4, reconciling with the providers, is manual.
- Accounts, password hashes, MFA factors and sessions come back with the `auth` schema, so users sign in with their usual passwords. Sessions created after the backup are gone; a user whose session is gone signs in again.
- The `crove_jobs` queue and the outbox come back as they were at backup time, and the worker picks them up. Work done after the backup (an extraction, a sent invite) is not in the restored database and may run again.
- If the restored copy left your control (a laptop, another environment), rotate the context key there again; that copy and production must never share one.

## Monthly test

Once a month, and after any change to the backup scripts, the compose file or the storage settings:

1. Check that the timer ran: a run of last night in `BACKUP_DIR`, `systemctl list-timers crove-backup.timer`.
2. Restore `s3:latest` onto a scratch stack (above). It must end with `restore of <run> passed`.
3. Sign in on the scratch stack as yourself and open one invoice and the journal.
4. Note the run id, the restore time and anything that failed in the operations log, then `docker compose down -v` the scratch stack.

The plan's rehearsal of the full disaster path (§7.9) is the drill below, done on a development machine.

## The restore drill (2026-10-17)

`node tools/backup/drill.mjs` runs the whole path on throwaway stacks with their own compose project names, image tags and ports, then removes everything it made: it seeds a source stack (an org, three synthetic e-invoices uploaded and read into proposals, one approved into the journal), checks that a failing backup and a missing setting each exit 1 and alert through the prober, makes a backup to a separate MinIO playing the second location, deletes the source stack, its volumes and the local copy of the run, checks that `restore.sh` refuses a `STORAGE` that differs from the scratch stack's, restores `s3:latest` onto a scratch stack with empty volumes and an empty bucket, checks that the downloaded copy of the run is gone afterwards, and then signs in as the same user through the API, downloads the three files and compares their sha256, finds the journal entry, and uploads a fourth invoice that the worker reads.

Run on 2026-10-17 on a development workstation (Windows 11, Docker Desktop, Git Bash), on `main` at schema version `20261019010000`. All three variants passed (s3 four times, local three times, s3 to local twice; the table gives the range), and each removed its containers, volumes, networks and images:

| Variant | Backup | Restore (`restore.sh s3:latest` until `/readyz` is green) | Restore and API checks |
|---|---|---|---|
| `--storage s3`: api and worker, files in a versioned MinIO bucket, restored into a new empty bucket (the disaster path) | 63 to 88 s | 86 to 128 s | **89 to 129 s** |
| `--storage local`: the all-in-one stack, files on the volume | 46 to 73 s | 71 to 111 s | 73 to 114 s |
| `--storage s3 --restore-storage local`: the monthly test, an S3 backup onto a scratch stack with `scratch.compose.yml` | 62 to 74 s | 83 to 85 s | 87 s |

The steps of the s3 restore: fetch and check 11 s, database 19 s, database checks 9 s, files (with 3 generations pointed at the new versions) 7 s, blob read-back 9 s, stack start 27 s. The data was small (a 580 KB dump, 89 tables, 258 rows, 3 blobs), so these times are mostly fixed costs: starting containers and Supabase Auth. The failing backup exited 1 within seconds and the prober printed `[Crove] ALERT on localhost:18181: the backup failed.` with the reason.

Against the RTO of 4 h the restore itself is negligible; the time goes to provisioning a server, DNS and the reconciliation after a restore. Run the drill again after any change to `tools/backup/`, the compose files or the storage layer:

```sh
node tools/backup/drill.mjs                               # s3 to s3
node tools/backup/drill.mjs --storage local
node tools/backup/drill.mjs --storage s3 --restore-storage local
```

It needs Docker, bash and free ports 18181 and 18182 (`DRILL_SRC_PORT`, `DRILL_RESTORE_PORT`). CI does not run it yet.
