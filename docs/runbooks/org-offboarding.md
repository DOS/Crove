# Runbook: retention and org offboarding

What Crove deletes on its own, what an owner can do to leave, and what staff do afterwards (issue #38, plan §4.9 retention table, §7.9). Nothing here deletes accounting records: they are kept for the legal retention period.

## Retention purges (automatic)

The worker runs `crove_kernel.retention_purge()` every day at 02:30 Asia/Ho_Chi_Minh (pg-boss schedule `kernel-retention-purge`, registered at worker start; a run missed while the worker was down runs once when it is back). `pg_cron` is not needed. Each call deletes at most 10000 expired rows per table in its own short transaction; the worker calls it again until nothing expired is left (at most 100 calls per run, the next run continues).

| Table | Kept for | Why it is safe to delete |
|---|---|---|
| `crove_kernel.idempotency_key` | 7 days after `created_at` | Plan §4.8 TTL. A replay of an older key runs the command again. |
| `crove_kernel.inbound_drop` | 30 days after the last counted drop | `inbound_drop_count()` reads only addresses retired less than 30 days ago, so the row is never read again. |
| `crove_kernel.member_invite` | 90 days after accept, revoke or expiry | Removes the invitee's email. Pending invites that have not expired are never purged; the audit rows keep the invite id. |
| `crove_kernel.worker_heartbeat` | 7 days | Already purged by `worker_beat()`. |
| pg-boss jobs | pg-boss `deleteAfterSeconds` | pg-boss maintenance. |

Never purged by the job: `audit_event`, `outbox_event` (business facts; deleted only after the WORM archive of plan §4.9 exists), every `crove_finance` table, `auth_session` and `auth_session_org` (a revoked row is the revocation list), `inbound_address` (tombstones are permanent), `context_key`.

**Alert:** the worker logs `[retention] ALERT purge deleted 0 rows while expired rows remain: <tables>` when a batch makes no progress. Look for long transactions holding row locks on those tables (`pg_stat_activity`), then let the next run continue.

**Writes outside `execute()`:** the purge deletes rows of the tenant table `member_invite` (and the machinery tables) as a definer, without a command or an audit row, like the other housekeeping definers (`worker_beat`, `inbound_drop_record`). The rows are past their retention window and the worker logs the count per table on every run. This is a documented exception to the one write path rule for retention only.

### Blob sweeps (same daily run, issue #212)

After the database purges, the same job sweeps three blob prefixes. Each lists its prefix in key order (`BlobStore.list`, 1000 keys per page, at most 100 pages per run), catches its own errors and never stops the rest of the job.

| Prefix | Deleted when | Never deleted while |
|---|---|---|
| `staging/` | Older than 1 hour (abandoned presigned uploads, ADR-0013) | (a grant lives 5 minutes) |
| `inbound/<id>` | Older than 30 days (raw mail kept after a message's last failed attempt, or a finished job whose delete was lost) | A row in `crove_kernel.inbound_pending` references it (read through the worker-only definer `inbound_pending_blobs`), or a pg-boss job of `kernel-inbound-email` in state `created`, `retry` or `active` does. The pending rows are read first: the relay sends the job before it commits the claim that deletes the row, so a waiting message is always found in one of the two. |
| `export/<org_id>/` | One day after the `expiresAt` of the record that lists it (plan §7.9), or two days after it was written when no record lists it (a failed attempt) | A record of the org that has not expired lists it (system query `kernel.org.export.live_keys`). The record's date decides, so changing `EXPORT_RETENTION_DAYS` affects new exports only. When the org's records cannot be read (a closed or deleted tenant), the blob's age decides: `EXPORT_RETENTION_DAYS` plus one day. |

`org/<org_id>/` (documents and attachments, the evidence) is never listed or swept. Retrying an inbound job by hand (`boss.retry`) after its blob was swept fails with a missing blob; investigate a failed message within the 30 days.

**Alerts:** `[retention] ALERT <prefix> blobs: blobs remain after 100 pages` when the budget ran out (the next run continues; a backlog that keeps growing means the store needs a lifecycle rule), and `[retention] ALERT <prefix> blobs sweep failed` when listing, the reference check or a delete failed (nothing is deleted for a page whose reference check failed). On a versioned bucket a delete leaves a noncurrent version behind a delete marker; Crove holds no `s3:DeleteObjectVersion`, so a lifecycle rule for noncurrent versions under `inbound/` and `export/` is what frees the space. Noncurrent export versions stay sealed (below).

## Offboarding an org

1. **Owner starts it** with `kernel.org.offboard` (API `org.offboard`, R3: fresh second factor; the owner types the org slug to confirm). In the same transaction the org moves to `offboarding` and the command writes its audit row; a deferred trigger refuses the change without that row.
2. **Access** from then on: only owners can enter the org. Other members are refused like non-members, the org disappears from their org list, invites can no longer be accepted, and inbound mail to the org is refused. Jobs already queued for the org (for example an extraction) still finish.
3. **Export** (format `crove.org-export.v2`, issue #212): the worker exports the org (job `kernel-org-export`).
   - **One snapshot:** every table is read in one `REPEATABLE READ`, `READ ONLY` transaction (`Runtime.stream`), so the tables agree with each other (no journal line without its entry, no file row that appeared between two tables). The cost is one transaction open for the length of the export, which holds back vacuum for that long; an org in offboarding takes few writes, and a 250000-row table exports in seconds. Per-table transactions would release sooner but could export a line whose entry was written after its table was read.
   - **Streamed, bounded memory:** a server-side cursor per table hands out 1000 rows at a time. Rows are written as NDJSON (one JSON object per line) in chunks of at most 8 MiB, each stored before the next is filled, so the worker holds one chunk and one batch whatever the size of the org. There is no row limit; an export of more than 2048 chunks (16 GiB) fails with `EXPORT_TOO_LARGE` in the worker log.
   - **Storage:** every chunk and the manifest are content-addressed blobs under `export/<org_id>/` (never under `org/`, so expiring an export can never touch a document). The manifest lists every part (table, chunk number, key, generation, sha256, rows, bytes) and the file count; the stored documents are the rows of the `kernel.file` part (key, generation and sha256 of each blob, which stays under `org/`).
   - **Encrypted at rest:** with `EXPORT_ENCRYPTION_KEY` set (required on a public URL) every blob is sealed with AES-256-GCM; the additional authenticated data binds it to its org and its part, and the record pins its sha256 and version. Application-level rather than only bucket SSE because an export is the whole org in one place and it also lives on local disk, where there is no SSE; bucket SSE can stay on underneath. Without a key (localhost only) the blobs are stored as plaintext, still with random leading bytes so a new export never reuses an older blob's address. Key rotation: set the new key and move the old one to `EXPORT_ENCRYPTION_KEY_PREVIOUS` until its last export expired; deleting a key afterwards makes leftover copies (noncurrent versions, backups) unreadable.
   - **Expiry:** the record holds `expiresAt` (`EXPORT_RETENTION_DAYS`, 35 to 90 days, default 35, plan §7.9). The download answers `EXPORT_EXPIRED` from then on, and the retention job deletes the blobs a day later.
   - **Owners** start it and download it from **Settings, "Đóng tổ chức và xuất dữ liệu"** (typed slug, a second factor in the last 5 minutes), which shows the export's state and expiry and a download per table and for the manifest. The API: `org.offboard`, `org.export`, `GET /api/org-export/manifest` (JSON) and `GET /api/org-export/<table>` (NDJSON, streamed chunk by chunk, header `x-crove-org`). Each blob is read at its recorded version, checked against its recorded sha256 and opened with the key before a byte is served.
   - The export is recorded by `kernel.org.export.record`, whose audit row lists the parts; records from before #212 (format v1) are no longer served, and the owner asks for a new export. **Staff step for v1 leftovers:** v1 exports were plaintext JSON under `org/<org_id>/`, which no sweep touches. Find the `kernel.org.export.record` audit rows whose `detail` has no `format`, and delete the blobs named by their `manifest_key` and `parts[].key` (check first that no `crove_kernel.file` row has the same `storage_key`).
   - The settings screen downloads a table into the browser before saving it; for a table of several GB use the API with a client that writes the stream to disk. If the export fails after its retries the worker logs `[org-export] ALERT`; the owner runs `org.offboard` again, which only asks for a new export. A new request is refused (`EXPORT_PENDING`, 409) while the last one is younger than 15 minutes and has not finished, and only one export job per org is queued or running at a time. Blobs of a failed attempt are never recorded and expire with the rest of `export/`.
4. **Tables in the export:** `kernel.tenant` (without the inbound token), `kernel.tenant_member`, `kernel.member_invite` (without token hashes), `kernel.party`, `kernel.file`, `kernel.inbound_message`, `kernel.extraction`, `kernel.proposal`, `kernel.activity`, `kernel.audit_event`, the org chart and its work (`kernel.position`, `kernel.agent`, `kernel.task`, `kernel.task_comment`), and `finance.purchase_document`, `finance.purchase_line`, `finance.journal_entry`, `finance.journal_line`, `finance.vendor_account_rule`, `finance.org_account` (the org's sub-accounts). Machinery stays out: idempotency keys, outbox, session records, inbound address tokens and drop counts, agent runs, wake-ups, budgets and kill switches.

Every role except staff can only move an org from `active` to `offboarding` (trigger `tenant_status_guard`); the login roles never reopen or close it. Staff means a superuser or a role that can act as the table owner (the migration runner). Reopening or closing is a staff step.

## Deletion map (staff step, after the export)

Final deletion is not automated. Staff run it after the owner has the export and any notice period has passed, then set `status = 'closed'` as the database owner (closed orgs are refused for everyone, the system context included).

| Store | What happens | When | Why |
|---|---|---|---|
| Ledger: `crove_finance.journal_entry`, `journal_line`, `purchase_document`, `purchase_line`, and `org_account` (the sub-accounts the lines name by code; never deleted) | **Kept** | At least 10 years after the fiscal year | Accounting Law 88/2015, Art. 41: accounting records and the documents behind them are kept for the legal period. They are append-only and are never deleted by Crove. |
| Source documents behind booked entries (`crove_kernel.file` rows and their blobs that a purchase document references) | **Kept** | Same as the ledger | They are the accounting vouchers for those entries. |
| `crove_kernel.audit_event` | **Kept** | Same as the ledger (no automatic deletion in v1, plan §4.10) | Proof of who did what to the books; append-only. |
| `crove_kernel.outbox_event` | **Kept** until the archive exists | Plan §4.9: archived, then deleted by org prefix (13 months, plan §7.9) | Business facts stream; append-only today. |
| Other files and their blobs (documents never booked, email attachments) | Delete | After the export | Not accounting records. |
| Export blobs (`export/<org_id>/`) | Deleted by the daily retention job | `EXPORT_RETENTION_DAYS` (35 to 90) after the export, plus a day (plan §7.9) | Copies of data the owner already downloaded; sealed at rest. |
| `party`, `inbound_message`, `extraction`, `proposal`, `activity`, `vendor_account_rule`, `member_invite` | Delete or anonymize | After the export | Mutable working data; parties referenced by kept purchase documents are anonymized only as far as the law allows (tax code and name stay on the voucher). |
| `position`, `agent`, `task`, `task_comment` | Delete | After the export | The org chart and its work (ADR-0029); not accounting records. |
| `tenant_member`, `auth_session_org`, `inbound_drop`, `idempotency_key`, `ai_run`, `agent_wakeup`, `budget_policy`, `kill_switch` | Delete | After the export | Access and machinery rows. |
| `tenant` row | Keep with `status = 'closed'` | While any kept record references it | The kept records reference it; deleting it would cascade into append-only tables, which is refused. |
| AI payloads, DLQ payloads, eval store | Delete by org prefix | After the export | Plan §7.9 step 3 (none of these stores exist in the open-source core yet). |

Crypto-shredding of personal data inside immutable stores (plan §4.10, `subject_key`) is not built yet; until it is, personal data in kept records stays as long as the records do.
