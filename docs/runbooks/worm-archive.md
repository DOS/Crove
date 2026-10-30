# Runbook: the WORM archive of audit events, journal entries and voucher numbers

The audit and ledger tables refuse updates and deletes by trigger, but the database owner (`postgres`) can turn a trigger off. The WORM fact stream (plan §4.10, issue #891) is how such an edit is noticed. WORM means write once, read many.

- **Archiver.** The worker copies the hash of every audit event, every journal entry (with its lines), every voucher number and every voided purchase document into an archive that the database cannot change.
- **Verifier.** Every night it compares the database with that archive.

This runbook covers setting the archive up, reading its two alerts, and what to do about each one.

## How it works

- **Batches.** Every minute, the worker cuts the rows that are not yet archived into batches. The rows of one batch span at most 5 minutes. A row is archived no earlier than `ARCHIVE_LAG_SECONDS` (default 600) after it is written, so a transaction that is still open is not cut off. The code is `apps/kernel/src/worm.ts`.
- **What a batch holds.** References and hashes only, each with the SHA-256 of a fixed set of columns. It also holds a batch hash and a chain hash, which folds in the previous batch. The one exception is the series highs of version 7 (below), which a restore must read back.
  - Version 1 batches (#891): `audit:<id>` and `journal:<org>:<id>` (`crove_kernel.archive_row_hashes`, migration `20261023230000`).
  - Version 2 batches (#977), written from migration `20261026230000` on: the same, plus `cash_voucher:<org>:<id>` (a PT, PC, BC or BN with its type, number, date, account and amount), `journal_voucher:<org>:<id>` (an NVK and its number) and `document_void:<org>:<document>` (a voided purchase document and its reversal entry), from `crove_kernel.archive_number_hashes`. A voucher keeps its number when its entry is reversed; the reversal is a journal entry that names the original.
  - The first version 2 batch takes in every voucher and void made before it (its `numbersFrom` is the epoch); later batches take their own window. The verifier checks each batch with the version it was written with.
  - Version 3 batches (#1489), written from migration `20261102220000` on: the same, plus the legal entity of each finance row (#1280), from `crove_kernel.archive_entity_hashes`: `entity:journal:<org>:<id>` (an entry's entity and each of its lines'), `entity:cash_voucher:<org>:<id>`, `entity:journal_voucher:<org>:<id>` and `entity:document_void:<org>:<document>`. The first version 3 batch takes in every row made before it (its `entitiesFrom` is the epoch); later batches take their own window.
  - Version 4 batches (#1594, #1596), written from migration `20261103060000` on: the same, plus the gapless numbering (#1401), from `crove_kernel.archive_allocation_hashes`: `number:<org>:<id>` (an allocation: its legal entity, its series and the series' legal entity, number and the record it went to), `number_void:<org>:<id>` (a void, with its reason) and `voucher_number:<cash_voucher|journal_voucher>:<org>:<id>` (a voucher's number, number period and allocation). The first version 4 batch takes in every allocation, void and voucher made before it (its `allocationsFrom` is the epoch); later batches take their own window.
  - Version 5 batches (#1623), written from migration `20261104140000` on: the same, plus `number_series:<org>:<id>` (a number series: its legal entity, doc type, period key and creation time, and the reset policy in force for its doc type, `yearly` when the doc type has no policy row), from `crove_kernel.archive_series_hashes`. A doc type's reset can change only before its first number, so a switched reset, or a policy row deleted or added for a doc type with numbers with a reset other than `yearly`, changes the row of each of its series. A legitimate change before the first number is an audit event, anchored since version 1. The first version 5 batch takes in every series made before it (its `seriesFrom` is the epoch); later batches take their own window.
  - Version 6 batches (#1337), written from migration `20261107050000` on: the same, plus `revision:journal:<org>:<id>` (a journal entry's source type and id, its source revision and the hash of its posting request, #1283), from `crove_kernel.archive_revision_hashes`. Changing which revision an entry posts, or its payload hash, now fails the verification. The first version 6 batch takes in every entry made before it (its `revisionsFrom` is the epoch); later batches take their own window.
  - Version 7 batches (#2007), written from migration `20261107140000` on: the same, plus `number_high:<org>:<series id>` for every number series that gave out a number in the window. It holds the series' legal entity, doc type and period key, and the highest number allocated in the window, from `crove_kernel.archive_series_highs`. The first version 7 batch takes them from the epoch (its `highsFrom`), so it holds the highest number of every series ever numbered; later batches take their own window.
    - **The exception to "hashes and references only".** The batch also holds these values in the clear, in its `highs` list. After a restore, they are what lets the series be raised above every number the archive holds ([After a restore](#after-a-restore)).
    - They are ids, a doc type, a period key and a number: no personal data.
    - Each value is checked against its row hash, which the chain covers. A value changed in the store fails the verification as `high_mismatch`.
- **Where batches go.** Each batch is written once to `chain/v1/<sequence>.json` in the archive store, then recorded in `crove_kernel.archive_batch`.
- **The nightly check.** At 03:10 Vietnam time the verifier reads every batch back from the store, checks the chain, and recomputes every row hash from the database. The result goes to `crove_kernel.archive_verification`. A run that passes also writes a marker to the store, `verify/v1/<UTC time>.json`, which the prober reads from the store alone ([The verification heartbeat](#the-verification-heartbeat-2082)).
- **Markers.** A marker holds only when the run passed, how many batches it read and the chain hash of the newest one: no tenant data. Like a batch it is written once (create-only); on `s3` it is locked for 400 days. Add a lifecycle rule for `verify/` that expires objects after 400 days; on a versioned Object Lock bucket an expiry only adds a delete marker, so the rule also needs `NoncurrentVersionExpiration` and the removal of expired delete markers. The worker holds no delete permission.
- **How alerts reach you.** Both jobs fail loudly:
  - A batch write that keeps failing fails its job (`kernel-archive-write`) after its retries.
  - A verifier run that finds a mismatch fails its job (`kernel-archive-verify`) at once, with a message that starts with `ARCHIVE_MISMATCH`.

  pg-boss keeps a failed job, and the prober's `dead_letters` check alerts on it ([incidents.md](incidents.md) section 3).

## Outbox events (#997)

The same store also keeps the outbox events that the daily retention run deletes from the database (plan §4.9, [org-offboarding.md](org-offboarding.md)):

- **What:** one object per org and UTC day, `outbox/v1/<org_id>/<day>.jsonl`, one JSON line per event in time order, and `outbox/v1/<org_id>/<day>.manifest.json` with the row count, the first and last event and the object's SHA-256. Unlike the batches, these hold the events themselves (their payloads are ids and short codes).
- **When:** once the whole day is more than 30 days old. The worker writes the object once, reads it back and compares the SHA-256, records the day in `crove_kernel.outbox_archive`, and only then deletes the day's events. The database refuses any other delete of an outbox event, and rolls a purge back if the day's events no longer match the archived count.
- **How long:** on `s3`, each object is locked for 400 days (13 months and a margin, plan §7.9) instead of `ARCHIVE_RETENTION_DAYS`. Add a lifecycle rule that expires objects under `outbox/` after 400 days; the worker holds no delete permission. On `local`, the files stay until removed by hand.
- **Reading an org's old events:** list `outbox/v1/<org_id>/` and read the day's object; the manifest's `sha256` must match it.

## Setting up the store

| `ARCHIVE_STORE` | Where | Holds against |
|---|---|---|
| `local` (default) | Read-only files under `ARCHIVE_DIR` (`/data/archive`, the `archive` volume in compose) | Edits made inside the database. Whoever controls the host can still rewrite the files. |
| `s3` | `ARCHIVE_S3_BUCKET`, reached with the `S3_*` settings (endpoint, region, credentials, path style) | Edits made by the database owner and by the host. The bucket refuses to delete or overwrite a locked object until its retention ends. |

For production, use `s3`.

1. **Create the bucket with Object Lock.** It can only be turned on at creation:
   - AWS: `aws s3api create-bucket --bucket crove-archive-prod --object-lock-enabled-for-bucket`.
   - MinIO: `mc mb --with-lock local/crove-archive-prod`.

   The worker checks for Object Lock and refuses to start without it.
2. **Choose the lock mode in `ARCHIVE_LOCK_MODE`.**
   - `GOVERNANCE` (default): an account with the `s3:BypassGovernanceRetention` permission can still delete objects. Use it while you are trying the setup.
   - `COMPLIANCE`: nobody can delete an object until its retention ends, the bucket's root account included. Switch to it once the setup is final.
3. **Retention:** `ARCHIVE_RETENTION_DAYS`, default 3650 (10 years, plan §7.9). It applies to each batch from the moment it is written.
4. **Credentials.** They need only `s3:PutObject`, `s3:PutObjectRetention`, `s3:GetObject`, `s3:ListBucket`, `s3:ListBucketVersions` and `s3:GetBucketObjectLockConfiguration` on the archive bucket. Do not grant any delete permission. `s3:ListBucketVersions` is needed since #2020: the verifier reads each key's versions, and without it every run fails with `AccessDenied`. If you scope `s3:PutObject` by prefix, the worker needs `chain/*`, `restores/*`, `outbox/*` and, since #2082, `verify/*`: without the last, every verification posts the marker write alert and the prober reports the marker stale. If possible, use credentials apart from the evidence bucket's.
   - **The prober's key (#2082).** The prober reads the verification markers from the bucket. Give it a key of its own that only reads: `s3:ListBucket` and `s3:ListBucketVersions` on the bucket, `s3:GetObject` on `verify/*` and `chain/*`. Set it as `PROBER_ARCHIVE_S3_ACCESS_KEY_ID` and `PROBER_ARCHIVE_S3_SECRET_ACCESS_KEY` on the prober, both or neither. With neither, the marker check is disabled and the prober says why, unless you set `PROBER_ARCHIVE_S3_DEFAULT_CHAIN=true` (since #2098): then it uses the SDK's default credential chain (an instance or task role, `AWS_*` variables, a profile, a web identity). That chain can resolve to the worker's role or to any role that writes the archive, and the prober cannot tell, so it is opt-in: say so only when the role the prober runs under only reads, as the policy above. A pair and `PROBER_ARCHIVE_S3_DEFAULT_CHAIN=true` together are refused. It never uses `S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY`: that is the worker's key, which reads and writes every tenant document and writes the archive, so Compose does not pass it to the prober and a prober that has `S3_ACCESS_KEY_ID` in its environment (run from the shared `.env`, say) and no pair of its own disables the marker check and says so, since the default chain might then resolve to the worker's role. The default chain must itself be a read-only role: the prober cannot tell, so its start line says `with the default credential chain`, which it only says when you opted in. A store with static keys only (MinIO, R2) needs the pair.
5. **After the first deploy, check the worker log.**
   - On start it prints `[archive] s3 bucket <name>, Object Lock <mode> for <days> days`.
   - Within a few minutes it prints `[archive] wrote N batch(es)`.

The first batch covers everything written before the archive existed.

## Which job failed

The prober says `N job(s) failed after their last retry ...: see the worker log`. List the failed jobs:

```sh
docker compose exec db psql -U postgres -c "SELECT name, completed_on, left(output::text, 400) AS error FROM crove_jobs.job WHERE state = 'failed' AND name LIKE 'kernel-archive-%' ORDER BY completed_on DESC LIMIT 10"
```

- `kernel-archive-write`: rows are not being archived. Read the next section.
- `kernel-archive-verify` with `ARCHIVE_MISMATCH` in the error: the archive and the database disagree. Read the section after it.
- `kernel-archive-verify` with any other error: the verifier could not run (store or database unreachable). Fix that, then run it by hand (last section).

## Batch writes fail: rows are not being archived

**Checks**

- `docker compose logs --tail 200 crove | grep archive` (or `worker` in the split layout).
- Is the worker running at all? A `heartbeat` alert at the same time means it is down: see [incidents.md](incidents.md) section 1.
- How far behind is it?

  ```sh
  docker compose exec db psql -U postgres -c "SELECT max(window_to) AS archived_up_to, now() - max(window_to) AS behind FROM crove_kernel.archive_batch"
  ```

  Rows written before `archived_up_to` are anchored.

**Causes and fixes**

- **The store cannot be written:** credentials, network, a full disk under `ARCHIVE_DIR`. Fix the store; the next run catches up, up to 50 batches a minute.
- **`does not continue the chain recorded in the database`.** The store holds a batch for the next sequence that does not follow the database's last batch. Either someone wrote to the store, or the database was restored to a point before batches that are already archived. Do not delete anything. Run the verifier (below) and treat its findings as in the next section.
- **After a database restore.** The archive keeps the batches written after the restore point. Their rows are gone from the database, so the verifier reports them as `row_missing`. That is expected, and [ledger-after-restore.md](ledger-after-restore.md) covers reconciling the lost period. Record the restore in an issue, so the next person reading the alert knows why.

## Verification fails: the archive and the database disagree

The failed `kernel-archive-verify` job's error starts with `ARCHIVE_MISMATCH` and lists the problem codes.

**Treat a mismatch as a SEV1 security incident.** Tell the owner at once. Do not change the database or the store until someone has taken a copy of both.

**Read the findings.** They name codes and references only:

```sh
docker compose exec db psql -U postgres -c "SELECT verified_at, ok, batches, rows_checked, problems FROM crove_kernel.archive_verification ORDER BY verified_at DESC LIMIT 3"
```

| Code | Meaning |
|---|---|
| `row_changed` | The row's columns differ from what was archived. For a journal entry, a line was edited, added or removed. For a `cash_voucher` or `journal_voucher`, its number, type, date or amount changed: a voucher was renumbered. For an `entity:` reference, the row (or one of an entry's lines) was moved to another legal entity. For a `number:` or `number_void:` reference, a number was renumbered, moved or its void rewritten; for `voucher_number:`, a voucher was moved to another number period or allocation. For a `number_series:` reference, the series was moved or renamed, or its doc type's reset policy was switched after its first number, or a policy row with a reset other than `yearly` deleted or added (every series of that doc type shows). |
| `row_missing` | An archived row is no longer in the database (deleted, or lost to a restore). |
| `row_added` | A row sits in a window that was already archived: it was inserted with a backdated time. |
| `chain_broken`, `window_gap`, `batch_hash_mismatch`, `chain_hash_mismatch`, `object_unreadable`, `object_out_of_order` | A batch in the store was changed, removed or replaced. With `s3` and Object Lock this should be impossible; check the bucket's lock and access logs. |
| `object_missing` | The database recorded a batch the store does not have. |
| `version_regressed`, `numbers_gap`, `entities_gap`, `allocations_gap`, `series_gap`, `revisions_gap`, `highs_gap` | A batch of a lower version follows a higher one, or a batch does not take its numbers (versions 2 and up), legal entities (versions 3 and up), number allocations (versions 4 and up), number series (versions 5 and up), source revisions (versions 6 and up) or series highs (version 7) from where the last one stopped. Either a worker older than #977, #1489, #1594, #1623, #1337 or #2007 wrote to the archive, or a batch was replaced. The numbers, entities, series, revisions or highs in that stretch are not anchored. Find the deploy that ran the old worker. |
| `high_mismatch` | A version 7 batch's series high in the clear does not match its row hash, or a high row has no clear values: the batch was edited in the store. The restore check does not trust that high. Treat it like `chain_broken`. |
| `restore_ack_unreadable` | An object under `restores/v1/` does not parse as a restore acknowledgement, or its key does not match its own sequence (#2020). The restore check writes these objects create-only: one that does not read was written by something else. Treat it like `chain_broken`. Under COMPLIANCE Object Lock it cannot be removed, so the verification fails on it until its retention ends; record it in the incident, with who could write the store. |
| `restore_ack_mismatch` | A restore the newest acknowledgement names, or the restore the check is asked to acknowledge, does not read as a restore (#2020). Either the database holds an archived row stamped at or after its backup point, or a row it lost is stamped more than an hour before that point. A restore loses everything from its backup point on, so this is a deletion, not a restore (or the backup point given was wrong). Nothing of that restore is excused, and the restore check acknowledges nothing. Check the backup point against the run's `meta.env`; otherwise treat it like `row_missing`: a SEV1 incident. |
| `series_period_mismatch` | A `number_series:` row verifies as written, but its period key does not fit the reset of its doc type (`YYYY` for yearly, `YYYY-MM` for monthly, `-` for never; #1820, `crove_kernel.archive_series_misfits`). The doc type's reset was switched, a number given out, and the reset switched back before the archiver anchored the series. Numbering never does this since #1608 (20261103050000): the reset is locked once a doc type has numbers, and a reset change waits for a first number in flight. A series created before that fix, by a reset change racing the doc type's first number (#1607), shows the same way. |
| `record_mismatch` | `crove_kernel.archive_batch` disagrees with the store. The store is the authority. |

**What to do**

1. **Copy both sides.** Take a database dump (`tools/backup`, [backup-and-restore.md](backup-and-restore.md)) and a copy of the archive (the `archive` volume, or `mc mirror` of the bucket).
2. **Find who could have done it.**
   - Superuser sessions: `log_connections` and the database logs.
   - Changes to triggers: `ALTER TABLE ... DISABLE TRIGGER` shows in the logs when `log_statement` is `ddl`.
   - Host and bucket access logs.
3. **For a `series_period_mismatch`, compare the series' `created_at` with the deploy of #1608 and with the doc type's `kernel.number.policy.set` and `kernel.number.policy.schedule` audit events.** A scheduled switch (#1595) gives a year or month series the reset in force on the first day of its period, and the `-` series `never`. A series created before that deploy, next to a policy change at the same moment, is the #1607 race, not an edit: record it in the issue. Otherwise the reset was edited outside the command: restore the policy row from the last backup before the series and find who wrote it (step 2).
4. **For a `row_changed` journal entry, compare the entry with the period's exports and the accountant's books.** The archive holds hashes, not values, so the correct values come from the last export or backup taken before the change.
5. **Write it up in an issue (security label):** what changed, when it was noticed, what was restored.

A single `row_added` right after a long-running transaction, with no other finding, can be a transaction that stayed open longer than `ARCHIVE_LAG_SECONDS`. Look up the row's command in the audit trail. If it is a normal command, raise the lag. Do not silence the alert.

## After a restore

A restore brings the database back to its backup point. The archive store is not restored: it keeps every batch written after that point, with the rows the restored database no longer has.

- **The restore check.** `tools/backup/restore.sh` runs it before the stack starts (`main.ts restore-report --reseed`, in the worker's container; [backup-and-restore.md](backup-and-restore.md), step 6).
  - It lists, per org, the journal entries, vouchers, document voids, number allocations, number voids and number series that the archive holds and the database lacks, and the batches written after the backup point.
  - It raises every number series above the highest number that the version 7 batches hold for it, so no number is given out twice.
  - Once every series is safe, it **acknowledges** the restore (`--acknowledge`, #2020). That writes an acknowledgement to the archive store, under `restores/v1/<sequence>.json` (1, 2, ... for each restore), and records the batches written after the backup point in the restored database.
    - The acknowledgement names each row excused from then on, with its batch:
      - the rows this restore lost: those the restored database lacks, and the series highs that it holds with another hash;
      - the rows of the previous acknowledgement that this database still lacks. A row a later restore brought back is excused no more.
    - It carries each restore with its interval of batches (the first batch with a row it lost, to the newest batch then) and its **backup point**: the backup's snapshot time, from the backup run's `meta.env` (`SNAPSHOT_AT`; `FINISHED_AT` for a run made before it was recorded). That is evidence the database does not hold. `restore.sh` passes it (`--backup-point`), unless `RESTORE_BACKUP_POINT` is set on its command; a check run by hand needs it.
      - A run without `SNAPSHOT_AT` whose dump took long is refused with its `FINISHED_AT` (`restore_ack_mismatch`). Then set `RESTORE_BACKUP_POINT` to the dump's start, from the backup log, and restore again.
    - It is written create-only, like a batch, and with `s3` under Object Lock. Only the store holds it, so no database role can write or change one.
    - **A restore loses a suffix in time:** every archived row stamped at or after its backup point. So the check refuses to acknowledge a restore, and the verifier excuses nothing of one (`restore_ack_mismatch`), when:
      - the database holds any archived row stamped from the backup point to the end of the restore's batches; or
      - a row it lost lies in a batch that ended more than an hour before the backup point. The hour covers the archive lag and a transaction still open at the backup.

      A deletion fails it. For example, the database owner forgets the newest batches in `archive_batch` and deletes a row, the newer rows still there. Batch windows are checked by their time, so the rows a version's first batch took in from the epoch do not count.
    - **The acknowledgements form a chain**, checked whole before any is trusted:
      - sequences 1, 2, ... with no gap, each with the sha256 of the one before;
      - each bound to the store's newest batch when it was written: it names that batch and its chain hash, and the batch after it must have been written later, by the store's own clock. On `s3` that is the `LastModified` of the object's oldest version. Object Lock turns versioning on, so a later PUT of the same key adds a version but cannot redate or remove the first. On `local` it is the file's time, which whoever controls the host can set: there the binding protects nothing against the host.
      - The verifier fails any batch, acknowledgement or verification marker key with more than one version, delete markers included (`object_versions`); a marker older than its 400 days is left out, since a lifecycle rule may have expired it, and the restore check leaves markers out altogether. So a PUT over a WORM object, or a delete, shows even though Object Lock keeps the first version, and `get` and the write time read the same single version.
      - To keep the store create-only for the worker's key too, give the archive bucket a policy that denies `s3:PutObject` without `If-None-Match: *`: a `Deny` on `s3:PutObject` with the condition `"Null": { "s3:if-none-match": "true" }` (the request carries no `If-None-Match` header). Then no new version can be written over an existing key at all. AWS S3 accepts that condition. With MinIO, check that your release honours `If-None-Match` on a PUT and accepts the condition in a bucket policy; where it does not, the version check above is what catches an overwrite. Cloudflare R2 offers no S3 Object Lock configuration, so the worker refuses it as the archive store (`assertObjectLock`).
      - each carries the restores of the one before it, or some of them, and at most one of its own, ending at its own newest batch. It may drop excuses of earlier restores, never add any.

      A break anywhere is `restore_ack_unreadable` or `restore_ack_mismatch`, and then no acknowledgement is in force: nothing is excused.
    - **What is left:**
      - **The last hour before a backup point.** A row stamped less than `RESTORE_SLACK_MS` (an hour) before the point, in the restore's own batches, counts as lost with the restore. Someone who deletes such a row in the restored database between the restore and its check gets it excused with the rest. `restore.sh` runs the check right after the restore, before the stack starts.
      - **The restored database, read with no upper bound.** Before it acknowledges, the check reads the restored database for any archived row stamped at or after the backup point, however far ahead. A restore of that backup holds none, so it refuses on one (`restore_ack_mismatch`), and runs before anything else writes: before the export rebind, and before the stack starts. The only exceptions are the rows of its own reseed: its `kernel.number.reseed` audit events, and a series made again with its archived id. Then an old row edited and moved, with every row after it, past the newest batch is refused.
      - **A lost row never comes back.** The verifier fails a restore whose excused row shows up again under its own reference, in a batch after the acknowledgement's newest or among the rows not archived yet. Series rows and series highs are the exceptions, since they legitimately go on.
      - **Store and database access together: the real residual.** Anyone who holds both the database owner's access and the store's write key (the worker's) can stage a fake restore. They write the next acknowledgement straight to the store, with a restore interval and a point of their choosing; delete every row from that point on; and enter those rows again under new ids. Every check above then passes. The archive alone cannot tell that from a real restore followed by work entered again. **The control is an alert they cannot silence:**
        - every verification run records how many rows it excused and the acknowledgement in force (`excused` and `restore_ack` in `crove_kernel.archive_verification`, for the record), and logs `excused N row(s) under restore acknowledgement #n`;
        - every run first posts `[archive] ALERT restore acknowledgement restores/v1/<n>.json, written <time>, is in the WORM archive`, from the store alone and before it reads the database, so a run the database owner stops, kills or locks has alerted already;
        - every run, passing or failing, then posts `[archive] ALERT restore acknowledgement #n, written <time>, excuses N row(s)` to the alert webhook, for `ARCHIVE_RESTORE_ALERT_DAYS` (14 by default) after the store wrote the acknowledgement. The count N comes from the database run; the first line does not need it;
        - each kind of alert is posted at most once per `SECURITY_ALERT_REPEAT_MINUTES` window per process, so it posts once a night;
        - the write time is the store's own: the oldest version's `LastModified`, which the key holder cannot backdate. Nothing in the database decides or suppresses the alert;
        - because it repeats every night, a webhook down for a night, or a failing run, loses nothing.

        Every acknowledgement must match a real restore incident, recorded with its backup run. One that does not is a SEV1 security incident ([incidents.md](incidents.md)). This holds until restores get a credential of their own (below).
      - **A verification that never finishes (not new here, and true of all WORM verification).** Someone with the database owner's access can stop the nightly verification from finishing: terminate its session, lock a table it reads, or delete its pg-boss job. They can also write `archive_verification` rows of their own, so any signal that lives only in the database can be hidden. The store-only alert above still posts before the run touches the database. For the rest, the prober checks the verification markers in the store, outside the database: a run that does not pass writes none, and the `archive_marker` alert fires once the newest is about a day old ([The verification heartbeat](#the-verification-heartbeat-2082)).
      - **Production step for later (owner):** give restores a store credential of their own, which the worker does not hold, and a bucket policy that denies the worker's key any write under `restores/`. Then the worker's key alone cannot write an acknowledgement, and the restore check runs with the restore credential. Until then, the alert above is the control.
      - Under GOVERNANCE, deleting the newest acknowledgement with the bypass permission leaves a delete marker, which the version check reports. Use COMPLIANCE in production.
      - **The backup point is the operator's word.** The check reads a restore by the point it is given. `restore.sh` takes it from the backup run, which the database owner does not control. Someone who runs the check by hand with a made-up point, on a database where rows were deleted, can have those rows read as lost to a restore, as long as every newer row is gone too. Run it by hand only right after a restore, with the run's `SNAPSHOT_AT`.
      - **A clock behind after a restore.** If the restored cluster's clock is behind the old one, rows written after the restore can be stamped before the end of the restore's newest batch. They then read as rows kept past the backup point: a false `restore_ack_mismatch`, and the restore's rows are no longer excused. Fix the clock, as for the ledger stamps ([ledger-after-restore.md](ledger-after-restore.md), step 2). The rows stamped in the wrong window stay, so raise it on #2020.
  - What to do with the report is in [ledger-after-restore.md](ledger-after-restore.md), step 4.
- **Run it again by hand at any time.** It reads only, unless `--reseed` (and `--acknowledge --backup-point <the backup's SNAPSHOT_AT>`) is given:

  ```sh
  docker compose run --rm --no-deps worker restore-report
  ```

  Use the service `crove` on the all-in-one stack.
- **The nightly verification after a restore.** The verifier reads the newest acknowledgement in `restores/v1/`. While each of its restores still reads as one, it excuses exactly the rows it names, in the batch it names them for:
  - a row missing from the database;
  - a series high that holds another hash, because its window lost some numbers.

  It counts them as `excused`, and the run passes, but not silently: it records the count and the acknowledgement's sequence, logs them on every run, and alerts on every run for `ARCHIVE_RESTORE_ALERT_DAYS` after the store wrote the acknowledgement (above). Anything else is still a finding:
  - a row of a batch the restored database had recorded, deleted or changed since;
  - a lost row that comes back with other content;
  - a row of a batch after the restore.

  An acknowledgement it cannot read, or one under a key that does not match its own sequence, is reported as `restore_ack_unreadable`. A restore in it that no longer reads as one is reported as `restore_ack_mismatch` and excuses nothing.
  - If the check says that another run wrote the next acknowledgement meanwhile, two checks ran at once: run it again.
  - Record the restore and its report in the incident.
  - **A restore whose check did not acknowledge** (it stopped on exit 3, and the stack was started anyway; or it ran with `RESTORE_ARCHIVE=skip`): the worker records the batches after the backup point on its next run, and the verification fails on the lost rows every night. Before the stack starts, run the check again with `--reseed --acknowledge --backup-point <SNAPSHOT_AT>` (and the floors). Once the worker has recorded those batches, the check finds nothing after the backup point and can no longer acknowledge them; raise it on #2020.

## Running the verifier by hand

The worker runs it every night. To run it now, queue one job. This is the row pg-boss itself would insert, and the queue's own table is the only thing it writes:

```sh
docker compose exec db psql -U postgres -c "INSERT INTO crove_jobs.job (name, data, policy) VALUES ('kernel-archive-verify', '{}', 'standard')"
```

The result appears in `crove_kernel.archive_verification` and in the worker log: `[archive] verified ...`, or `[archive] ALERT ARCHIVE_MISMATCH ...`.

The prober watches both for you (#1997) and alerts like for a stuck worker:

- `archive_verify`: the newest verification run that passed is older than `PROBER_MAX_ARCHIVE_VERIFY_AGE_SECONDS` (26 h by default; before the first, the first batch is). Either the worker or its schedule is not running (check the worker, incidents.md, section 1, then run the verifier by hand as above), or it runs and keeps failing: read the problems of its latest rows (`SELECT verified_at, ok, problems FROM crove_kernel.archive_verification ORDER BY verified_at DESC LIMIT 3`) and follow "Verification fails: the archive and the database disagree" above.
- `archive_lag`: the oldest audit event not yet in a batch (journal entries go in the same windows) is older than `PROBER_MAX_ARCHIVE_LAG_SECONDS` (by default the larger of 3600 s and `ARCHIVE_LAG_SECONDS` plus 900 s; the archiver itself waits `ARCHIVE_LAG_SECONDS`, 600 s by default, on purpose, so keep the limit well above it). The archiver is stopped or its writes fail: look for `[archive]` lines in the worker log and for failed `kernel-archive-write` jobs, and check the store (the `archive` volume, or the bucket and its credentials).

To look by hand:

```sh
docker compose exec db psql -U postgres -c "SELECT max(verified_at) FROM crove_kernel.archive_verification"
```

## The verification heartbeat (#2082)

`archive_verify` reads the database, so whoever owns the database can fake it: stop the nightly run (terminate its session, lock a table it reads, delete its pg-boss job) and write an `archive_verification` row that says it passed. The verification markers are the check they cannot fake.

- **What the worker writes.** Each verification run that passes writes `verify/v1/<UTC time>.json` to the archive store, after the run: `{"format":"crove-verify-marker","version":1,"verifiedAt":...,"batches":N,"chainSha256":...}`. It holds the time, the number of batches the run read and the chain hash of the newest one: no org, no row, no tenant data. It is create-only like a batch (`If-None-Match: *` and Object Lock on `s3`, a read-only file on `local`). A run that fails, or never finishes, writes none. A marker the worker cannot write posts `[archive] ALERT the verification passed, but its marker could not be written to the archive store`.
- **What the prober checks.** On every probe, before it reads the database, the prober reads the newest marker from the store and alerts `archive_marker` when:
  - the store wrote it more than `PROBER_MAX_ARCHIVE_MARKER_AGE_SECONDS` ago (93600, 26 h: a day and the slack of one late run). The time that counts is the store's own write time (the oldest version's `LastModified` on `s3`, the file's time on `local`), never the time the marker states. "Newest" is by that time too, not by key, so a marker named from a worker clock that ran ahead does not stay newest;
  - it does not parse, or names a chain hash that the store's batch of that sequence does not hold;
  - the store cannot be read (a refused key, a bucket that cannot be reached, or one that does not answer). Each call to the store gives up when no response arrives within 10 s (5 s to connect), with one more attempt; the whole read, a body that stalls included, is aborted after 30 s. So a hung store holds up none of the other checks and leaves no connection open;
  - there is no marker yet, and the store wrote its first batch more than the limit ago. A probe loop that started less than the limit ago waits, so the first nightly run after an upgrade can write the first marker; one probe a run (cron) does not wait. The wait starts again when the prober restarts, so it only delays the alert before the first marker exists;
  - the store keeps more than one version of a marker key inside its 400 days (written over, or deleted and written again): the writer's key can do that, and Object Lock keeps it in view. The nightly verification fails the same way (`object_versions`, below). A marker older than 400 days may have been expired by a lifecycle rule, and its delete marker is not reported;

  Settings the check cannot use disable only this check: `ARCHIVE_STORE=s3` without `ARCHIVE_S3_BUCKET`, half of the `PROBER_ARCHIVE_S3_*` pair, the worker's `S3_ACCESS_KEY_ID` in the environment with no `PROBER_ARCHIVE_S3_*` pair, a `PROBER_ARCHIVE_S3_ACCESS_KEY_ID` equal to the worker's `S3_ACCESS_KEY_ID`, or a malformed `ARCHIVE_STORE`, `PROBER_MAX_ARCHIVE_MARKER_AGE_SECONDS` or, with `ARCHIVE_STORE=s3`, `S3_ENDPOINT` or `S3_FORCE_PATH_STYLE`. The pilot preflight (`pnpm pilot:check`) reports a malformed setting too. The prober logs `[prober] ERROR verification marker check disabled (...)` at the start of its loop and reports `archive_marker` on every probe, naming the settings (never their values), until they are fixed. Its other checks run, and `prober --backup-failed`, `--backup-ok` and `--test-alert` never depend on them.

  With one probe a run (cron), every run alerts while the marker is stale, and no resolved notice follows: like the outage alert, the state lives in the process.
- **Why the database owner cannot hide it.** The check reads only the store, and its alert state lives in the prober's process, never in the database (unlike the other checks, whose state the `crove_kernel.prober_alert_gate` row keeps). It alerts when the database cannot be read too. Writing a marker needs the store's write key, which the database does not hold.
- **What it does not cover.**
  - Someone who holds the worker's store key (the host, on `local` the archive volume) can write a marker without a run. The marker check is against the database owner; against the host, `s3` with Object Lock still keeps every batch, and the restore acknowledgement alerts above stay.
  - On `local`, the claim holds only while the database server cannot write the archive directory. Under Compose the `db` container does not mount the `archive` volume. On a single host without containers, a PostgreSQL superuser can run programs as the database's OS user (`COPY ... TO PROGRAM`), so keep `ARCHIVE_DIR` out of that user's reach, or use `s3`.
  - The marker proves the verification ran, not that archiving goes on: a stopped archiver leaves the verification passing over the batches already written. `archive_lag` watches that, from the database.
- **Settings.** The prober reads the worker's store settings: `ARCHIVE_STORE`, and `ARCHIVE_S3_BUCKET`, `S3_ENDPOINT`, `S3_REGION`, `S3_FORCE_PATH_STYLE` for `s3`, or `ARCHIVE_DIR` for `local` (the image sets `/data/archive`; Compose mounts the `archive` volume read-only into the prober). Its key: [Setting up the store](#setting-up-the-store), step 4. `PROBER_MAX_ARCHIVE_MARKER_AGE_SECONDS=0` turns the check off; a prober run outside the image without `ARCHIVE_DIR` or `ARCHIVE_STORE=s3` does not check. A prober pointed at the wrong store sees no batch and no marker, which reads as nothing to verify yet: its start line names the store it reads (`[prober] probing every ... verification markers from ...`), so check it once after setting up.
- **When it fires.**
  1. If `archive_verify` fires too, the verification is not running or keeps failing: follow `archive_verify` above.
  2. If `archive_verify` does not fire, the database says the verification passed while the store holds no recent marker. Look for `[archive] verified` lines in the worker log for the last nights, and for the marker write alert. A `verified` line with no marker: the store refuses the write (fix the key or the bucket). No `verified` line while the database shows a recent pass: treat it as a SEV1 security incident ([incidents.md](incidents.md)), since something wrote `archive_verification` outside the verifier.
  3. The marker cannot be trusted (a chain hash the batch does not hold): someone wrote a marker by hand. A SEV1 security incident.
  4. The store cannot be read: check the prober's key and its permissions (above), and that the bucket answers.

To list the markers by hand: `docker compose exec crove ls /data/archive/verify/v1 | tail -3` (local), or `aws s3api list-object-versions --bucket <archive bucket> --prefix verify/v1/` (s3).
