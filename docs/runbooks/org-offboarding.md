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

**Not covered yet:** raw inbound mail blobs (`inbound/<id>`) kept after a message's last failed attempt. Sweeping them needs a list operation on the blob store, which the storage adapter does not have yet (follow-up).

## Offboarding an org

1. **Owner starts it** with `kernel.org.offboard` (API `org.offboard`, R3: fresh second factor; the owner types the org slug to confirm). In the same transaction the org moves to `offboarding` and the command writes its audit row; a deferred trigger refuses the change without that row.
2. **Access** from then on: only owners can enter the org. Other members are refused like non-members, the org disappears from their org list, invites can no longer be accepted, and inbound mail to the org is refused. Jobs already queued for the org (for example an extraction) still finish.
3. **Export**: the worker exports the org (job `kernel-org-export`): one JSON document per table and a manifest with the parts (table, key, sha256, row count) and the stored files list. Everything is stored as content-addressed blobs under `org/<org_id>/`. The export is recorded by `kernel.org.export.record`; its audit row holds the manifest. Owners see it with `org.export` and download each part from `GET /api/org-export/manifest` and `GET /api/org-export/<table>` (header `x-crove-org`). The stored documents themselves stay under the keys the manifest lists. If the export fails after its retries the worker logs `[org-export] ALERT`; the owner runs `org.offboard` again, which only asks for a new export. A new request is refused (`EXPORT_PENDING`, 409) while the last one is younger than 15 minutes and has not finished, and only one export job per org is queued or running at a time. A table with more than 200000 rows fails the export (`EXPORT_TOO_LARGE` in the worker log) until the export streams rows (follow-up).
4. **Tables in the export:** `kernel.tenant` (without the inbound token), `kernel.tenant_member`, `kernel.member_invite` (without token hashes), `kernel.party`, `kernel.file`, `kernel.inbound_message`, `kernel.extraction`, `kernel.proposal`, `kernel.activity`, `kernel.audit_event`, and `finance.purchase_document`, `finance.purchase_line`, `finance.journal_entry`, `finance.journal_line`, `finance.vendor_account_rule`. Machinery stays out: idempotency keys, outbox, session records, inbound address tokens and drop counts.

Every role except staff can only move an org from `active` to `offboarding` (trigger `tenant_status_guard`); the login roles never reopen or close it. Staff means a superuser or a role that can act as the table owner (the migration runner). Reopening or closing is a staff step.

## Deletion map (staff step, after the export)

Final deletion is not automated. Staff run it after the owner has the export and any notice period has passed, then set `status = 'closed'` as the database owner (closed orgs are refused for everyone, the system context included).

| Store | What happens | When | Why |
|---|---|---|---|
| Ledger: `crove_finance.journal_entry`, `journal_line`, `purchase_document`, `purchase_line` | **Kept** | At least 10 years after the fiscal year | Accounting Law 88/2015, Art. 41: accounting records and the documents behind them are kept for the legal period. They are append-only and are never deleted by Crove. |
| Source documents behind booked entries (`crove_kernel.file` rows and their blobs that a purchase document references) | **Kept** | Same as the ledger | They are the accounting vouchers for those entries. |
| `crove_kernel.audit_event` | **Kept** | Same as the ledger (no automatic deletion in v1, plan §4.10) | Proof of who did what to the books; append-only. |
| `crove_kernel.outbox_event` | **Kept** until the archive exists | Plan §4.9: archived, then deleted by org prefix (13 months, plan §7.9) | Business facts stream; append-only today. |
| Other files and their blobs (documents never booked, email attachments) | Delete | After the export | Not accounting records. |
| Export blobs | Delete | 35 to 90 days after the export (plan §7.9) | Copies of data the owner already downloaded. |
| `party`, `inbound_message`, `extraction`, `proposal`, `activity`, `vendor_account_rule`, `member_invite` | Delete or anonymize | After the export | Mutable working data; parties referenced by kept purchase documents are anonymized only as far as the law allows (tax code and name stay on the voucher). |
| `tenant_member`, `auth_session_org`, `inbound_drop`, `idempotency_key` | Delete | After the export | Access and machinery rows. |
| `tenant` row | Keep with `status = 'closed'` | While any kept record references it | The kept records reference it; deleting it would cascade into append-only tables, which is refused. |
| AI payloads, DLQ payloads, eval store | Delete by org prefix | After the export | Plan §7.9 step 3 (none of these stores exist in the open-source core yet). |

Crypto-shredding of personal data inside immutable stores (plan §4.10, `subject_key`) is not built yet; until it is, personal data in kept records stays as long as the records do.
