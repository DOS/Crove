# Runbook: backups and restore

How a Ludy instance that runs the `docker compose` stack on one server (the pilot setup, backlog item M1-7) is backed up every night, how it is restored, and how the restore is tested. Issues #307 and #351.

| Target | Value | Why |
|---|---|---|
| RPO (data that may be lost) | 24 h | One backup a night. The files bucket's versioning keeps files written since then; the database changes of the last day can be lost. |
| RTO (time to serve again) | 4 h | Restoring the backup takes minutes (see [the drill](#the-restore-drill)); the rest is a new server, DNS and the checks after a restore. |

These targets are for the pilot. Plan §7.9 sets tighter ones for Ludy Cloud (point-in-time recovery, a WORM stream); they need managed PostgreSQL or WAL archiving and are not part of this setup.

## What holds state, and what the backup takes

| State | Where | In the backup | Notes |
|---|---|---|---|
| The database: every `crove_*` schema, Supabase Auth's `auth` schema (users, password hashes, sessions, MFA factors), the `crove_jobs` queue (pg-boss), the migration ledger `crove_meta.schema_migrations` | `db-data` volume | `db.dump`, a `pg_dump --format=custom` of the whole database, made as the superuser so row level security hides nothing | The ledger stamps travel as they are; see [After a restore](#after-a-restore). |
| Roles (`crove_app`, `crove_worker`, `crove_prober`, `supabase_auth_admin`, the definer roles), their memberships and settings | the cluster | `roles.sql` (`pg_dumpall --roles-only --no-role-passwords`) | No password hashes: `migrate` sets the passwords from `.env` after a restore. |
| The context key (`crove_kernel.context_key`) | a table | **No.** Its rows are left out (`--exclude-table-data`) | Every restore must make a new key anyway ([context-key-rotation.md](context-key-rotation.md)); `restore.sh` does. A stolen backup therefore holds no key that works against the live database. |
| Files: uploaded invoices, inbound mail not yet filed, org exports | the `files` volume (`STORAGE=local`) or the bucket (`STORAGE=s3`, versioned) | `files/`: every blob, the current version of each object; not `staging/` (abandoned uploads) or temporary files | Org files are content addressed (`org/<org_id>/<sha256>`), and every file row records the blob's sha256, so the backup checks each one. |
| The credential key (seals channel tokens) | the `keys` volume, or `CREDENTIAL_KEY` | **No** | Keep it apart from the database backups ([credential-key.md](credential-key.md)): the two together open every channel token. |
| `.env`: passwords, `AUTH_JWT_SECRET`, `EXPORT_ENCRYPTION_KEY` (and `_PREVIOUS`), `BACKUP_ENCRYPTION_KEY` (and `_PREVIOUS`), `INBOUND_SECRET`, `CREDENTIAL_KEY`, S3 and SMTP keys | the server | **No** | Keep it in your secret store. Without `EXPORT_ENCRYPTION_KEY` the org exports in a restored bucket do not open; without `BACKUP_ENCRYPTION_KEY` the sealed runs in the backup bucket do not open. |

A run is a directory named by its UTC start time, for example `20261017T020000Z/`:

| File | Content |
|---|---|
| `db.dump`, `roles.sql` | the database and the roles |
| `counts.tsv` | the row count of every table, read in the same snapshot as the dump (pg_dump runs on a snapshot exported by the transaction that counts) |
| `file-refs.tsv` | every file row's storage key, sha256 and generation, from the same snapshot |
| `files/`, `files.sha256` | the blobs and their sha256. An org blob the previous run holds with the same bytes is a hard link to it, so a run costs disk only for new blobs |
| `meta.env` | finish time, the snapshot's own time (`SNAPSHOT_AT`, the backup point a restore's WORM acknowledgement is read by, #2020), storage mode, schema version (the newest migration) and PostgreSQL version (both read in the dump's snapshot), compose project, and how the copy in the bucket is laid out (`FORMAT=2`, `ENCRYPTION`, `BLOB_STORE`) |
| `SHA256SUMS` | the sha256 of every file above except `files/` (covered by `files.sha256`), written last |

A run fails, and is kept as `<run id>.partial` until the next one deletes it, when the dump or the copy fails, when a file row's blob is missing from the copy or has another sha256, or when an org blob's bytes do not match its name.

## Schedule, retention and the second location

- `tools/backup/backup.sh` makes one run. Run it nightly on the host (below); a lock directory keeps two runs apart.
- Each run is written to `BACKUP_DIR` on the server, then copied to `BACKUP_S3_*`, an S3-compatible bucket in another place than the server and than the files bucket (another provider or account). In that bucket, under `BACKUP_S3_PREFIX`:

  | Path | What |
  |---|---|
  | `<run id>/` | the run's files, without the org blobs; `SHA256SUMS` goes up last, so a run without it is incomplete and restore refuses it |
  | `blobs/<store>/org/<org_id>/<sha256>` | the org blobs. They are content addressed, so each one is uploaded once and shared by every run that lists it: a run uploads only the blobs the store does not hold yet. `<store>` is `plain`, or `k<key id>` for blobs sealed with a key |

  The copy is checked: `SHA256SUMS` read back must match, the run's object count too, and every org blob the run lists must be in the store with the size it should have.
- Retention: runs older than `BACKUP_KEEP_DAYS` (30) are deleted from the bucket, and older than `BACKUP_LOCAL_KEEP_DAYS` (default the same; 7 in `.env.example`) from `BACKUP_DIR`. Then the blobs no kept run lists are deleted from the blob stores: each run's `files.sha256` is read (opened, when sealed), and a complete run whose list cannot be read stops the prune, so no blob a run needs is ever deleted. A blob goes only when the previous run's prune found it unlisted too (`prune-candidates` in the prefix), so it outlives a run that was still uploading. Logs are in `BACKUP_DIR/logs/`.
- **One writer per prefix.** The lock that keeps two runs apart lives in `BACKUP_DIR`, on one server. A second server (a standby, or a new server while the old one still runs its timer) gets a `BACKUP_S3_PREFIX` of its own; stop the old server's timer before the new one takes over a prefix.
- With `STORAGE=s3` the files bucket is read with `mc mirror` into a run that already holds the previous run's org blobs (hard links), so only new objects are downloaded; objects the bucket no longer has are dropped from the run, so an erased blob never comes back through an old one.
- A run holds password hashes, refresh tokens and MFA secrets (the `auth` schema). The scripts run with `umask 077` and keep `BACKUP_DIR` at mode 700, so only the user that runs them can read it; run them as root or as a dedicated user in the `docker` group. The S3 keys reach the MinIO client container as `MC_HOST_*` environment variables, and the encryption key reaches the container that seals as an environment variable, never on a command line.
- **Encryption.** With `BACKUP_ENCRYPTION_KEY` set, every file that goes to the bucket is sealed first (`tools/backup/seal.mjs`, AES-256-GCM in the STREAM construction, each file bound to its name), run files get a `.enc` suffix, and blobs go to the store of that key. So whoever can read the backup bucket, and nothing else, cannot read the books; restore needs the key. The names of org blobs in the bucket are their sha256, which tells a reader which known documents a run holds, not their content. The copy in `BACKUP_DIR` stays unsealed (it sits next to the live database). Keep a copy of the key in the secret store, apart from the bucket: without it no sealed run opens. Also use a private bucket with encryption at rest, keys that reach only `BACKUP_S3_PREFIX` (list, read, write, delete), and, if the provider has it, versioning or object lock so a stolen server key cannot erase the history.
- With no `BACKUP_S3_ENDPOINT` the runs stay in `BACKUP_DIR` only. That is for development: a copy on the same disk is not a backup. Every run logs a warning, and on a deployment (`PUBLIC_URL` unset, or not localhost, `*.localhost`, `127.x.x.x` or `[::1]`) the run fails and alerts after it completed locally. Such a run is not sealed, whatever `BACKUP_ENCRYPTION_KEY` says, and `meta.env` and `last-success` record `ENCRYPTION=none`.
- The scripts read `.env` as `docker compose` does (`export` prefix, quotes, escapes, `${VAR}`, `${VAR:-default}` and the other forms), so they see the values the stack runs with. A value Compose would read differently from them (an unclosed quote, a multi-line value) stops the run with the line and the key named.

## Set up (once per server)

1. Fill the "Backups" block of `.env` (see `.env.example`): `BACKUP_DIR`, `BACKUP_KEEP_DAYS`, `BACKUP_LOCAL_KEEP_DAYS`, `BACKUP_S3_ENDPOINT`, `BACKUP_S3_BUCKET`, `BACKUP_S3_PREFIX`, `BACKUP_S3_ACCESS_KEY_ID`, `BACKUP_S3_SECRET_ACCESS_KEY`. With `STORAGE=s3` the script reads the stack's own `S3_*` settings to copy the files bucket; those keys must allow listing and reading it.
2. Make the encryption key, `openssl rand -base64 32`, set it as `BACKUP_ENCRYPTION_KEY` in `.env`, and store a copy in your secret store apart from the backup bucket. Use a key of its own, not `EXPORT_ENCRYPTION_KEY`.
3. The host needs bash, Docker with the compose plugin, tar, sha256sum and coreutils; the S3 work runs in a throwaway container of the pinned MinIO client image and sealing in a container of the stack's own image, so nothing else is installed.
4. Run it once by hand from the checkout and read the end of the output (`complete`, `uploaded`, `blob stores`, `done`):

   ```sh
   tools/backup/backup.sh
   ```

5. Install a timer. systemd (`/etc/systemd/system/crove-backup.service` and `crove-backup.timer`):

   ```ini
   [Unit]
   Description=Ludy nightly backup
   After=docker.service

   [Service]
   Type=oneshot
   WorkingDirectory=/opt/crove
   ExecStart=/opt/crove/tools/backup/backup.sh
   ```

   ```ini
   [Unit]
   Description=Run the Ludy backup every night

   [Timer]
   OnCalendar=*-*-* 02:00:00
   RandomizedDelaySec=15min
   Persistent=true

   [Install]
   WantedBy=timers.target
   ```

   Then `systemctl daemon-reload && systemctl enable --now crove-backup.timer`; `systemctl list-timers crove-backup.timer` shows the next run. Or cron: `0 2 * * * cd /opt/crove && tools/backup/backup.sh >> /var/log/crove-backup.log 2>&1`.
6. The heartbeat, so a backup that never runs pages someone: at the heartbeat monitor ([alerts.md](alerts.md), step 3), create a second check with period 1 day and grace 2 hours, and set its ping URL as `BACKUP_HEARTBEAT_URL` in `.env`. Every complete run ends with `prober --backup-ok`, which pings it (`[prober] backup heartbeat sent to ...` in the log). Test it once by disabling the timer for a day (`systemctl disable --now crove-backup.timer`): the phone gets the alert; enable it again.
7. Test the alert: run it once with a bucket that does not exist, `BACKUP_S3_BUCKET=no-such-bucket tools/backup/backup.sh`. It must exit 1 and the alert must reach your channel.
8. Store the credential key (`docker compose cp crove:/data/keys/credential.key .`, or your `CREDENTIAL_KEY`) and `.env` in your secret store, apart from the backups. Do it again after a key rotation.

Steps 2, 6, 7 and 8 need the owner: the secret store, the monitor account and the phone.

## When a backup fails

A failed run exits 1, writes `[backup] FAILED: <step> failed (exit <code>, backup.sh line <n>); run <id>, log <file>` to stderr and to its log, and runs `docker compose run --rm --no-deps prober prober --backup-failed "<reason>"`. That sends `[Crove] ALERT on <instance>: the backup failed.` with the reason to `ALERT_WEBHOOK_URL`, in the format the other alerts use (README, "Monitoring and alerts"); without a webhook it is printed. `BACKUP_ALERT=off` skips the alert. A missing setting (say `BACKUP_S3_BUCKET` with `BACKUP_S3_ENDPOINT` set) or a `.env` line the scripts cannot read as Compose does fails the same way before anything is dumped, and any other stop of the script (a shell error, a signal) is reported and alerted from its exit handler. A run whose copy in the bucket does not read back whole is deleted from the bucket, so `s3:latest` never picks it; blobs it uploaded stay until the next prune finds no run that lists them.

Read the log, fix the cause, and run `tools/backup/backup.sh` again by hand. The next run deletes the `.partial` directory of the failed one.

A backup that never runs (the timer disabled, the server off) sends no alert of its own: the backup heartbeat (`BACKUP_HEARTBEAT_URL`, set up above) pages when its daily ping does not come, and the outside uptime check (M1-9) catches a server that is off. `cat "$BACKUP_DIR/last-success"` shows the newest complete run (`RUN_ID`, `FINISHED_AT`, whether it reached the second location and whether it was sealed).

## Restore

`tools/backup/restore.sh <run>` restores a run onto the compose stack named by the current directory's `.env`, `COMPOSE_PROJECT_NAME` and `COMPOSE_FILE`, and checks it. `<run>` is a run directory, `s3:<run id>` or `s3:latest` (the newest complete run in `BACKUP_S3_*`). It refuses a database that already holds Ludy data (`the target database already holds Crove`): restore into empty volumes only. It also refuses when its own `STORAGE` (or, with `s3`, `S3_BUCKET`) differs from what the target compose project resolves (`docker compose config`): the blobs would otherwise go where the target does not read them, for a scratch stack possibly the production bucket, bringing back erased blobs.

It runs these steps and stops at the first failure with `[restore] FAILED: <reason>`:

1. Fetches the run (for `s3:`, its files; a sealed run is opened with `BACKUP_ENCRYPTION_KEY`, or `BACKUP_ENCRYPTION_KEY_PREVIOUS` for one sealed before a rotation; then the org blobs it lists, from the blob store `meta.env` names) and checks it against `SHA256SUMS` and `files.sha256`. A file that neither lists is refused, so nothing unchecked reaches the store. With `BACKUP_ENCRYPTION_KEY` set, an unsealed run in the bucket is refused too: it may have been written by whoever holds the bucket's keys alone. To restore one anyway (a run made before the key was set), name it and set the variable on the command itself, never in `.env`: `RESTORE_ALLOW_UNSEALED=yes tools/backup/restore.sh s3:<run id>`. `s3:latest` never restores an unsealed run while a key is set.
2. Starts `RESTORE_PRESTART` (default `db`), loads `roles.sql`, then `pg_restore --create` (the database's own settings and grants come back too, such as TEMPORARY revoked from PUBLIC).
3. Compares the row count of every table with `counts.tsv`; checks that no journal entry is stamped in the future of the new cluster ([ledger-after-restore.md](ledger-after-restore.md), step 2); makes a new context key ([context-key-rotation.md](context-key-rotation.md)).
4. Puts the blobs back: into the `files` volume, or into the bucket. In a bucket each restored object has a new version id while the file rows still name the old one (ADR-0013), so the script points each row at the version now under its key (`generations.tsv` in the restore directory lists every change). The sha256 of the row does not change, and step 5 reads the bytes back. This one update goes past the `file_guard` trigger (superuser, `session_replication_role = replica`, one transaction); when any row has no object in the bucket, the transaction rolls back and no row changes. On GCS (`S3_ENDPOINT` at `storage.googleapis.com`) the MinIO client lists no generations, so rows point at `content:<sha256>` instead and are read as the current object, checked by sha256 (`RESTORE_GENERATIONS=content`; turn on object versioning in the GCS bucket's own settings). `RESTORE_FILES=skip` leaves the files alone, for a bucket that survived.
5. Reads back `RESTORE_SAMPLE` blobs (default 50, `0` for all) named by restored file rows, each at its recorded version, and checks their sha256; a missing blob is reported as missing, never hashed as empty input.
6. Runs `migrate`, which must finish (it applies migrations newer than the backup, sets the role passwords and runs the hardening guard). After a restore into a new bucket, each org's newest export is then re-recorded with the restored object versions, before the worker starts, so no queued export job can record a newer one first (`main.ts exports-rebind`, a one-off container of the worker's image): an export is recorded in an audit row, which nothing may change, so it is recorded again through `kernel.org.export.record`, after every part is read back and its sha256 checked. It is recorded as a rebind: the record must be that export's own but for the versions, and it keeps the tables the export was made with, so an export made before a table was added to the export still re-records (#1726). A recorded version the new bucket does not have, or cannot even parse (a version id from another provider), counts as stale; bytes that differ from the record, or a bucket that refuses the read, do not. The export then downloads as before; one that cannot be re-recorded is reported with a warning at the end of the restore (the data is in place, so the restore still passes), and its owner asks for a new export (`org.offboard` again). Then the restored database is checked against the WORM archive (`main.ts restore-report --reseed --acknowledge`, issues #2007 and #2020; [ledger-after-restore.md](ledger-after-restore.md), "What the restore lost"). It lists what the archive holds beyond the backup point in `archive-report.json`, and raises every number series above the numbers the archive holds, before the worker can give one out. Then it acknowledges the lost rows in the archive store, with the run's snapshot time (`SNAPSHOT_AT`, else `FINISHED_AT`) as the backup point, so the nightly verification excuses exactly those. Lost rows are a warning; a series it cannot raise, or an archive that does not match, stops the restore with the stack not started. `RESTORE_ARCHIVE=skip` leaves the check out, for a stack that cannot reach the deployment's archive (the scratch stack below). Then the whole stack starts, and `/readyz` must answer `{"ready":true}`. The new record shows the restore time as the export's date in the app (its expiry stays) and adds a line to the org's activity that the export was re-recorded after the restore.

It prints the time of each step and of the whole restore. Its log, the row counts, the blob sample, `generations.tsv` and `archive-report.json` stay in `BACKUP_DIR/restore-<time>/`. A run downloaded for `s3:` is deleted from there when the restore passes (a failed restore keeps it for diagnosis), and restore directories past the local retention are deleted by the nightly backup (and by the next restore), so no plain copy outlives the retention.

### Onto a new server (disaster)

1. Provision the server as for the pilot (Docker, the checkout at the release you run, or a newer one: `migrate` applies the newer migrations). Put back `.env` from your secret store (with `BACKUP_ENCRYPTION_KEY`), and the credential key (into the `keys` volume, or as `CREDENTIAL_KEY`). Point `ARCHIVE_*` at the surviving WORM archive (the Object Lock bucket; with `ARCHIVE_STORE=local`, a copy of the old `archive` volume): the restore checks the database against it.
2. Files: if the files bucket survived, keep it in `S3_*` and restore with `RESTORE_FILES=skip`. If it is gone, point `S3_*` at a new, empty, versioned bucket.
3. Restore the newest run and keep the output:

   ```sh
   tools/backup/restore.sh s3:latest
   ```

4. Before opening the instance to users: reconcile the ledger with the WORM archive report and the e-invoice providers ([ledger-after-restore.md](ledger-after-restore.md), step 4); sign in, open the journal and an invoice. Then switch DNS or the reverse proxy to the new server.
5. Tell users what the RPO means for them: work since the backup's `FINISHED_AT` (in `meta.env`) is lost, except files, which the bucket kept.

### Onto a scratch stack next to the live one (the monthly test, or to look at old data)

`tools/backup/scratch.compose.yml` makes a second stack on the same server that cannot act on the world: mail goes to its own Mailpit (no published port), no AI endpoint, files on its own volume instead of the production bucket, and its own credential key, so channel tokens stay sealed.

```sh
export COMPOSE_PROJECT_NAME=crove-restore-test COMPOSE_FILE=docker-compose.yml:tools/backup/scratch.compose.yml
PORT=18090 PUBLIC_URL=http://localhost:18090 STORAGE=local RESTORE_ARCHIVE=skip tools/backup/restore.sh s3:latest
# look at it through an SSH tunnel to 127.0.0.1:18090, then remove it with its volumes:
docker compose down -v
unset COMPOSE_PROJECT_NAME COMPOSE_FILE
```

`STORAGE=local` restores the blobs of an S3 backup onto the scratch stack's own volume (the local store reads a blob by key and checks its sha256, whatever version the row recorded). `RESTORE_ARCHIVE=skip` leaves out the WORM archive check: the scratch stack has an empty archive of its own, and must never write to production's.

## After a restore

- `restore.sh` has already run steps 2 and 3 of [ledger-after-restore.md](ledger-after-restore.md): no stamp in the future, and a new context key. It has also run the WORM archive check of step 4, with the number series raised above the archive.
- What is left is the reconciliation: the entries and vouchers the report names as lost, and the e-invoice providers. Who decides and what to enter again is in [What the restore lost](ledger-after-restore.md#what-the-restore-lost).
- Accounts, password hashes, MFA factors and sessions come back with the `auth` schema, so users sign in with their usual passwords. Sessions created after the backup are gone; a user whose session is gone signs in again.
- The `crove_jobs` queue and the outbox come back as they were at backup time, and the worker picks them up. Work done after the backup (an extraction, a sent invite) is not in the restored database and may run again.
- If the restored copy left your control (a laptop, another environment), rotate the context key there again; that copy and production must never share one.

## Rotating the backup encryption key

1. Make a new key (`openssl rand -base64 32`), move the old one to `BACKUP_ENCRYPTION_KEY_PREVIOUS`, set the new one as `BACKUP_ENCRYPTION_KEY`, and store both in the secret store.
2. The next run seals with the new key and uploads every org blob again, into the new key's store. The prune keeps reading the runs sealed with the old key (it needs `_PREVIOUS` for that) until they are older than `BACKUP_KEEP_DAYS`; then the old store empties.
3. After `BACKUP_KEEP_DAYS`, remove `BACKUP_ENCRYPTION_KEY_PREVIOUS` (keep it in the secret store as long as you keep any copy of the old runs).

## Monthly test

Once a month, and after any change to the backup scripts, the compose file or the storage settings:

1. Check that the timer ran: `cat "$BACKUP_DIR/last-success"` shows last night's run, `systemctl list-timers crove-backup.timer` the next one, and the backup heartbeat check is green.
2. Restore `s3:latest` onto a scratch stack (above). It must end with `restore of <run> passed`.
3. Sign in on the scratch stack as yourself and open one invoice and the journal.
4. Note the run id, the restore time and anything that failed in the operations log, then `docker compose down -v` the scratch stack.

The plan's rehearsal of the full disaster path (§7.9) is the drill below, done on a development machine and in CI.

## The restore drill

`node tools/backup/drill.mjs` runs the whole path on throwaway stacks with their own compose project names, image tags and ports, then removes everything it made: it seeds a source stack (an org, three synthetic e-invoices uploaded and read into proposals, one approved into the journal, and a second org offboarded, so the worker exports it), checks that a failing backup and a missing setting each exit 1 and alert through the prober, makes a backup to a separate MinIO playing the second location (sealed with a throwaway key unless `--seal off`, and checked to hold no plaintext), with a stray object in the blob store that the first prune must keep and the second delete, adds a fourth invoice, and makes a second backup, which must upload only the new blob and link the old ones to the first run. It then deletes the source stack, its volumes and the local copies of the runs, checks that `restore.sh` refuses a `STORAGE` that differs from the scratch stack's, a run with a file its checksums do not list and (sealed) an unsealed run in the bucket, restores `s3:latest` onto a scratch stack with empty volumes and an empty bucket, checks that the downloaded copy of the run is gone afterwards, and then signs in as the same user through the API, downloads the four files and compares their sha256, finds the journal entry, downloads the second org's export (so its record points at the restored object versions), and uploads one more invoice that the worker reads. Between the second backup and the wipe it posts a journal voucher (NVK00001), which the worker archives in a WORM archive both stacks share (a volume of the drill's own, as a deployment's archive outlives its database). The restore's archive check must name that voucher, its entry and its number allocation as lost, and raise the NVK series, so the restored stack's next journal voucher takes NVK00002 (#2007).

CI runs it on every pull request and push (`ci.yml`, job "Backup and restore drill", s3 to s3, sealed).

Run on 2026-10-17 (issue #307) on a development workstation (Windows 11, Docker Desktop, Git Bash), on `main` at schema version `20261019010000`. All three variants passed (s3 four times, local three times, s3 to local twice; the table gives the range), and each removed its containers, volumes, networks and images:

| Variant | Backup | Restore (`restore.sh s3:latest` until `/readyz` is green) | Restore and API checks |
|---|---|---|---|
| `--storage s3`: api and worker, files in a versioned MinIO bucket, restored into a new empty bucket (the disaster path) | 63 to 88 s | 86 to 128 s | **89 to 129 s** |
| `--storage local`: the all-in-one stack, files on the volume | 46 to 73 s | 71 to 111 s | 73 to 114 s |
| `--storage s3 --restore-storage local`: the monthly test, an S3 backup onto a scratch stack with `scratch.compose.yml` | 62 to 74 s | 83 to 85 s | 87 s |

The steps of the s3 restore (2026-10-17): fetch and check 11 s, database 19 s, database checks 9 s, files (with 3 generations pointed at the new versions) 7 s, blob read-back 9 s, stack start 27 s. The data was small (a 580 KB dump, 89 tables, 258 rows, 3 blobs), so these times are mostly fixed costs: starting containers and Supabase Auth. The failing backup exited 1 within seconds and the prober printed `[Crove] ALERT on localhost:18181: the backup failed.` with the reason.

On 2026-10-20 (issue #351) the s3 variant, sealed, with two backups (the second incremental), the refusals and the export check, passed twice on the same workstation while it ran several other stacks, so every step took two to four times longer than on 2026-10-17: backups 168 to 266 s (the incremental one uploaded 1 new blob and found 3 already there), the restore 238 to 247 s (fetch, open and check 91 to 93 s, database 31 to 36 s, database checks 15 to 16 s, files 28 to 32 s, blob read-back 18 to 19 s, stack start and export re-record 44 to 48 s), restore and API checks 246 to 255 s. The CI job gives the figures on a quiet machine.

Against the RTO of 4 h the restore itself is negligible; the time goes to provisioning a server, DNS and the reconciliation after a restore. Run the drill again after any change to `tools/backup/`, the compose files or the storage layer:

```sh
node tools/backup/drill.mjs                               # s3 to s3, sealed
node tools/backup/drill.mjs --storage local --seal off
node tools/backup/drill.mjs --storage s3 --restore-storage local
```

It needs Docker, bash and free ports 18181 and 18182 (`DRILL_SRC_PORT`, `DRILL_RESTORE_PORT`); `DRILL_PREFIX` (default `crove-drill`) names its compose projects, target and images, so two drills on one machine stay apart.
