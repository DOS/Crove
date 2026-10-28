# Runbook: fiscal year archive packages

Accounting Law 88/2015, Art. 41 keeps accounting records and the documents behind them for at least 10 years after the fiscal year (plan §7.9 "Legal retention"). Once every month of a year is locked, an owner asks Ludy for the year's package; the worker builds it once and keeps it (issue #922). The fiscal year is the calendar year.

## What a package holds

Every part is stored once under `archive/<org_id>/<year>/<sha256>` (content addressed, create-only):

| Part | Kind |
|---|---|
| `so-nhat-ky-<year>.xlsx` | The journal of the year |
| `so-sach-<year>.xlsx` | Trial balance, general ledger, receivables and payables |
| `bao-cao-tai-chinh-<year>.xlsx` | Financial statements B01 and B02 |
| `gtgt-<period>.xlsx` | The VAT working of every month, or every quarter when the org files quarterly |
| `01gtgt-<period>.xml` | The 01/GTGT declaration of the same periods, when the org has a tax code |

The manifest (JSON, format `crove-year-archive-v1`, stored under the same prefix) lists every part and the original file of every document booked in the year by its storage key, version and sha256. The originals stay where they are (`org/<org_id>/`); Ludy never deletes them. The manifest names the `finance.archive.build` command that asked for it; the `finance.archive.record` audit row names the manifest's key, version and sha256, and is the build's record.

## How it runs

1. An owner calls `yearArchive/build` (R3: a second factor within the last 5 minutes). It is refused while a month of the year is unlocked (`ARCHIVE_YEAR_OPEN`), once the year is built (`ARCHIVE_EXISTS`), and while an earlier request is less than 60 minutes old (`ARCHIVE_PENDING`).
2. The request emits `finance.archive_requested`; the outbox relay queues one `finance-year-archive` job per org and year.
3. The worker checks the lock again, builds every part, stores the manifest and records it. A job retried after the record exists (the worker stopped before finishing it) builds nothing. Two workers building the same year at once store the same parts (content addressed) and the second record is audited as a duplicate; the first record stands.
4. Owners list the packages (`yearArchive/list`), download the manifest (`GET /api/finance-archive/<year>/manifest`) or a part (`GET /api/finance-archive/<year>/<sha256>`, only a part the manifest lists), and verify the package (`GET /api/finance-archive/<year>/verify`).

## Making the store WORM

The package is only as durable as the blob store under it.

- **S3 (production):** use a bucket created with Object Lock (it implies versioning) and set `S3_ARCHIVE_LOCK_DAYS=3653` with `ARCHIVE_LOCK_MODE=COMPLIANCE`. The credentials also need `s3:PutObjectRetention`: a part already stored without the lock (a failed build retried after the lock was turned on) is locked when the build reuses it. Every part under `archive/` is then written with that retention; nobody, the root account included, can delete or overwrite it before the date. Use `GOVERNANCE` while trying it out. A bucket without Object Lock refuses the lock headers and the build fails, which is the intended alarm.
- **Local disk (`STORAGE=local`):** files are written create-only, but anyone with access to the volume can delete them. This is not WORM. Back the volume up with the rest of the data (docs/runbooks/backup-and-restore.md), and move to S3 with Object Lock before relying on the package for the legal period.

## A build failed

The worker retries three times (60 seconds apart, with backoff), then logs `[year-archive] ALERT archive of org <org_id> year <year> failed after 4 attempts` with the error. The list keeps showing the request as `requested`; once it is 60 minutes old the owner may ask again.

- `ARCHIVE_YEAR_OPEN` on the worker: a month was unlocked after the request. Lock it again, then ask again.
- `EXPORT_TOO_LARGE`: the year has more entries than one journal workbook holds. Open an issue; the package needs to be split.
- A store error (Object Lock refused, access denied): fix the bucket or credentials, then ask again.

## Verification fails

`verify` reads the manifest and every part and original at its recorded version, and reports each one by name:

- `missing`: nothing is stored under the key or version. Restore it from the backup or the bucket's versions.
- `changed`: the bytes no longer hash to the manifest's sha256. Treat as an incident (docs/runbooks/incidents.md): the store was written outside Ludy.
- `manifest_changed`: the manifest itself, or a key in it outside the package's prefix or the org's files. Same as `changed`.

Never rebuild a year to clear a failed verification: the record is written once, and a second build would not replace it.
