# Runbook: retention holds on evidence files

Accounting Law 88/2015, Art. 41 keeps the documents behind the books for at least 10 years. Ludy holds the original file of every posted invoice in the bucket for that long, so that nobody, Ludy included, can delete or overwrite the version the books stand on (issue #1009, [ADR-0013](../adr/0013-evidence-storage-and-integrity.md) section 6).

## What is held, and for how long

| | |
|---|---|
| Which files | The original file of every invoice posted to the journal (purchases and sales: `crove_finance.purchase_document.source_file_id` of a document with a journal entry). Files never posted (a proposal still waiting or rejected, an email attachment that was not an invoice, Social images) keep the bucket's default. Ludy stores no filed tax return file yet; when it does, it joins this list. |
| From when | The time the entry was posted (the journal entry's `created_at`). A file posted again (an invoice recorded again after a reversal voided its first document) is held from its latest posting. |
| How long | `EVIDENCE_LOCK_DAYS` (default 3650, 10 years), rounded up to the whole second. |
| How | An S3 Object Lock retention in **GOVERNANCE** mode on the exact object version the file row records (owner decision on #1009): an operator with `s3:BypassGovernanceRetention` can still lift it, for a court order or a mistake. A version that already has a longer retention, or a COMPLIANCE one, keeps it. |

The accountant (#61) is asked to confirm which files need 10 years and whether the period starts at the posting or at the end of the fiscal year. Either answer is a setting, not a code change:

- **Another period:** set `EVIDENCE_LOCK_DAYS`. A longer period lengthens every existing hold on the worker's next run. A shorter one never shortens a hold already set (S3 refuses it without the bypass permission, which Ludy never holds); it applies to new postings only.
- **From the end of the fiscal year:** add 365 days to the period (`EVIDENCE_LOCK_DAYS=4015`), which covers a posting on the first day of the year.

## How it runs

Posting writes nothing for the hold: the posting commits as before, and S3 is never called inside a database transaction. Every 5 minutes the worker:

1. reads up to 100 posted files whose hold is missing or shorter than the period (`crove_kernel.evidence_hold_due`, worker only);
2. checks once that the bucket has Object Lock (`GetObjectLockConfiguration`);
3. for each file, reads the version's retention and sets a longer one (`GetObjectRetention`, `PutObjectRetention`); a file row without a recorded version (from before ADR-0013) holds the current version, and only after its bytes match the recorded sha256;
4. records the outcome on the file row with the system command `kernel.file.hold.record` (audited): `held_until` on success, or `hold_error` and `hold_attempts` on failure.

A failed file is tried again after 5 minutes, then 10, 20 and so on, at least once a day. `held_until` is set only by the system and never goes back to null or to an earlier time (`crove_kernel.file_guard`).

## Settings and bucket

- `STORAGE=s3` with a bucket that has **Object Lock enabled** (it implies versioning, which evidence buckets need anyway). AWS can enable Object Lock on an existing versioned bucket; MinIO only on a new bucket, so create one with `--with-lock` and copy the objects with their versions, or keep holds off.
- The credentials need `s3:GetBucketObjectLockConfiguration` on the bucket, and `s3:GetObjectRetention` and `s3:PutObjectRetention` on `org/*`. Never give them `s3:BypassGovernanceRetention`.
- `EVIDENCE_LOCK_DAYS=0` turns holds off.
- **Local disk** has no per-object retention: the worker logs `the file store has no per-object retention (local disk): posted files get no retention hold` at start and sets none. Ludy still never deletes an `org/` file; backups are the protection there.
- **GCS** (interoperability endpoint) has no Object Lock API; use a bucket retention policy instead. **Cloudflare R2** without versioning (`S3_VERSIONING=off`) cannot lock a version; use an R2 bucket lock rule on `org/`. In both cases the worker reports that the bucket has no Object Lock (below).

## Alerts

| Log line | Meaning | What to do |
|---|---|---|
| `[evidence-hold] ALERT the bucket has no Object Lock: N posted file(s) wait for their retention hold` | Holds are on but the bucket cannot hold objects. Logged once a day while files wait; nothing is recorded per file, and postings go on. | Enable Object Lock on the bucket (see above), or set `EVIDENCE_LOCK_DAYS=0` if this deployment keeps evidence another way. The waiting files are held on the next run once it is on. |
| `[evidence-hold] ALERT N retention hold(s) failed` | The store refused a hold for some files. The line before each names the file, its org and the store's message. | List them (below) and read `hold_error`, a code (members of the org can read it, so the store's message stays in the log). `BLOB_NOT_FOUND`: the recorded version is gone from the bucket, which is an incident (red-team S25): restore it from a backup ([backup-and-restore.md](backup-and-restore.md)). `BLOB_INTEGRITY`: a row without a version whose current object no longer matches its sha256, also an incident. `STORE_ERROR:AccessDenied`: the credentials lack the permissions above. Another `STORE_ERROR:<name>`: read the store's message in the log. |
| `[evidence-hold] ALERT sweep failed` | The scan itself failed (database or bucket unreachable). | The next run, 5 minutes later, tries again; look at the worker's other errors. |

As staff, the files still waiting and the failures:

```sql
SELECT f.org_id, f.id, f.held_until, f.hold_attempts, f.hold_error, f.hold_attempted_at
  FROM crove_kernel.file f
 WHERE f.hold_error IS NOT NULL
 ORDER BY f.hold_attempted_at DESC
 LIMIT 50;
```

## Lifting a hold

Only for a court order or a hold set by mistake, decided by the owner and written in the incident log ([incidents.md](incidents.md)). An operator with `s3:BypassGovernanceRetention` (never the deployment's credentials) shortens or removes the retention of that one version:

```sh
aws s3api put-object-retention --bucket <bucket> --key org/<org_id>/<sha256> --version-id <version> \
  --retention '{"Mode":"GOVERNANCE","RetainUntilDate":"<new date>"}' --bypass-governance-retention
```

The file row keeps the `held_until` Ludy recorded: it is the record of what Ludy set, and the guard refuses shortening it. While `EVIDENCE_LOCK_DAYS` still covers the file, the worker does not set the hold again, because the row already says it is held.

## Offboarding and personal-data erasure

Neither deletes a held file, and both say so:

- **Offboarding** ([org-offboarding.md](org-offboarding.md)): the export's `kernel.file` table carries `held_until` for every file. The `org-purge` command (#1024) keeps every file a purchase document references, so it never deletes a held file or one still waiting for its hold; on a bucket with holds the store would also refuse the deletion of the held version until `held_until`.
- **Personal-data erasure** ([personal-data-requests.md](personal-data-requests.md)): erasure clears data in the database only. Its result lists the original files of posted invoices that name the person's party under "kept", with the date their hold runs to.
