# Runbook: the WORM archive of audit events, journal entries and voucher numbers

The audit and ledger tables refuse updates and deletes by trigger, but the database owner (`postgres`) can turn a trigger off. The WORM fact stream (plan §4.10, issue #891) is how such an edit is noticed. WORM means write once, read many.

- **Archiver.** The worker copies the hash of every audit event, every journal entry (with its lines), every voucher number and every voided purchase document into an archive that the database cannot change.
- **Verifier.** Every night it compares the database with that archive.

This runbook covers setting the archive up, reading its two alerts, and what to do about each one.

## How it works

- **Batches.** Every minute, the worker cuts the rows that are not yet archived into batches. The rows of one batch span at most 5 minutes. A row is archived no earlier than `ARCHIVE_LAG_SECONDS` (default 600) after it is written, so a transaction that is still open is not cut off. The code is `apps/kernel/src/worm.ts`.
- **What a batch holds.** References and hashes only, each with the SHA-256 of a fixed set of columns. It also holds a batch hash and a chain hash, which folds in the previous batch.
  - Version 1 batches (#891): `audit:<id>` and `journal:<org>:<id>` (`crove_kernel.archive_row_hashes`, migration `20261023230000`).
  - Version 2 batches (#977), written from migration `20261026230000` on: the same, plus `cash_voucher:<org>:<id>` (a PT, PC, BC or BN with its type, number, date, account and amount), `journal_voucher:<org>:<id>` (an NVK and its number) and `document_void:<org>:<document>` (a voided purchase document and its reversal entry), from `crove_kernel.archive_number_hashes`. A voucher keeps its number when its entry is reversed; the reversal is a journal entry that names the original.
  - The first version 2 batch takes in every voucher and void made before it (its `numbersFrom` is the epoch); later batches take their own window. The verifier checks each batch with the version it was written with.
  - Version 3 batches (#1489), written from migration `20261102220000` on: the same, plus the legal entity of each finance row (#1280), from `crove_kernel.archive_entity_hashes`: `entity:journal:<org>:<id>` (an entry's entity and each of its lines'), `entity:cash_voucher:<org>:<id>`, `entity:journal_voucher:<org>:<id>` and `entity:document_void:<org>:<document>`. The first version 3 batch takes in every row made before it (its `entitiesFrom` is the epoch); later batches take their own window.
  - Version 4 batches (#1594, #1596), written from migration `20261103060000` on: the same, plus the gapless numbering (#1401), from `crove_kernel.archive_allocation_hashes`: `number:<org>:<id>` (an allocation: its legal entity, its series and the series' legal entity, number and the record it went to), `number_void:<org>:<id>` (a void, with its reason) and `voucher_number:<cash_voucher|journal_voucher>:<org>:<id>` (a voucher's number, number period and allocation). The first version 4 batch takes in every allocation, void and voucher made before it (its `allocationsFrom` is the epoch); later batches take their own window.
  - Version 5 batches (#1623), written from migration `20261104130000` on: the same, plus `number_series:<org>:<id>` (a number series: its legal entity, doc type, period key and creation time, and the reset policy in force for its doc type, `yearly` when the doc type has no policy row), from `crove_kernel.archive_series_hashes`. A doc type's reset can change only before its first number, so a switched reset, or a policy row deleted or added for a doc type with numbers, changes the row of each of its series. A legitimate change before the first number is an audit event, anchored since version 1. The first version 5 batch takes in every series made before it (its `seriesFrom` is the epoch); later batches take their own window.
- **Where batches go.** Each batch is written once to `chain/v1/<sequence>.json` in the archive store, then recorded in `crove_kernel.archive_batch`.
- **The nightly check.** At 03:10 Vietnam time the verifier reads every batch back from the store, checks the chain, and recomputes every row hash from the database. The result goes to `crove_kernel.archive_verification`.
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
4. **Credentials.** They need only `s3:PutObject`, `s3:PutObjectRetention`, `s3:GetObject`, `s3:ListBucket` and `s3:GetBucketObjectLockConfiguration` on the archive bucket. Do not grant any delete permission. If possible, use credentials apart from the evidence bucket's.
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
| `row_changed` | The row's columns differ from what was archived. For a journal entry, a line was edited, added or removed. For a `cash_voucher` or `journal_voucher`, its number, type, date or amount changed: a voucher was renumbered. For an `entity:` reference, the row (or one of an entry's lines) was moved to another legal entity. For a `number:` or `number_void:` reference, a number was renumbered, moved or its void rewritten; for `voucher_number:`, a voucher was moved to another number period or allocation. For a `number_series:` reference, the series was moved or renamed, or its doc type's reset policy was switched, deleted or added after its first number (every series of that doc type shows). |
| `row_missing` | An archived row is no longer in the database (deleted, or lost to a restore). |
| `row_added` | A row sits in a window that was already archived: it was inserted with a backdated time. |
| `chain_broken`, `window_gap`, `batch_hash_mismatch`, `chain_hash_mismatch`, `object_unreadable`, `object_out_of_order` | A batch in the store was changed, removed or replaced. With `s3` and Object Lock this should be impossible; check the bucket's lock and access logs. |
| `object_missing` | The database recorded a batch the store does not have. |
| `version_regressed`, `numbers_gap`, `entities_gap`, `allocations_gap`, `series_gap` | A batch of a lower version follows a higher one, or a batch does not take its numbers (versions 2 and up), legal entities (versions 3 and up), number allocations (versions 4 and up) or number series (version 5) from where the last one stopped: a worker older than #977, #1489, #1594 or #1623 wrote to the archive, or a batch was replaced. The numbers, entities or series in that stretch are not anchored. Find the deploy that ran the old worker. |
| `record_mismatch` | `crove_kernel.archive_batch` disagrees with the store. The store is the authority. |

**What to do**

1. **Copy both sides.** Take a database dump (`tools/backup`, [backup-and-restore.md](backup-and-restore.md)) and a copy of the archive (the `archive` volume, or `mc mirror` of the bucket).
2. **Find who could have done it.**
   - Superuser sessions: `log_connections` and the database logs.
   - Changes to triggers: `ALTER TABLE ... DISABLE TRIGGER` shows in the logs when `log_statement` is `ddl`.
   - Host and bucket access logs.
3. **For a `row_changed` journal entry, compare the entry with the period's exports and the accountant's books.** The archive holds hashes, not values, so the correct values come from the last export or backup taken before the change.
4. **Write it up in an issue (security label):** what changed, when it was noticed, what was restored.

A single `row_added` right after a long-running transaction, with no other finding, can be a transaction that stayed open longer than `ARCHIVE_LAG_SECONDS`. Look up the row's command in the audit trail. If it is a normal command, raise the lag. Do not silence the alert.

## Running the verifier by hand

The worker runs it every night. To run it now, queue one job. This is the row pg-boss itself would insert, and the queue's own table is the only thing it writes:

```sh
docker compose exec db psql -U postgres -c "INSERT INTO crove_jobs.job (name, data, policy) VALUES ('kernel-archive-verify', '{}', 'standard')"
```

The result appears in `crove_kernel.archive_verification` and in the worker log: `[archive] verified ...`, or `[archive] ALERT ARCHIVE_MISMATCH ...`.

Check that the verifier still runs every night. A run older than a day means the worker or its schedule is not running:

```sh
docker compose exec db psql -U postgres -c "SELECT max(verified_at) FROM crove_kernel.archive_verification"
```
