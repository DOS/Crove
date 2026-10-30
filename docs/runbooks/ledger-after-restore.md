# Runbook: ledger checks after a restore

A journal entry can gain lines only in the transaction that created it (External-tenant gate T3, issue #76). The posting function writes the entry and all its lines in one call, and a trigger refuses any line added later, by any role, superusers included. This runbook covers what a restore does to that rule, what the restore lost compared with the WORM archive, and what to check before reopening writes (plan §7.9).

## How the rule knows the creating transaction

- A `BEFORE INSERT` trigger on `crove_finance.journal_entry` stamps two columns the caller cannot set:
  - `created_xact_id`: the `xid8` of the transaction (`pg_current_xact_id()`, the top-level transaction, so savepoints do not matter);
  - `created_xact_start`: the start time of that transaction (`now()`).
- A `BEFORE INSERT` trigger on `crove_finance.journal_line` refuses the line unless both match the current transaction.
- Entries posted before `created_xact_start` existed have `NULL` there and can never gain lines. That is expected; do not fill it in.

## The `xid8` limit

An `xid8` is a 64-bit transaction counter. It never wraps around, but it is unique only inside one cluster.

| How the database came back | Transaction counter | Effect on the rule |
|---|---|---|
| Point-in-time recovery, in place or into a new project | Continues from the backup | None |
| Promoted physical replica | Same as the primary | None |
| `pg_upgrade` | Copied from the old cluster | None |
| Logical dump and restore, or logical replication, into another cluster | Starts low in the new cluster | The restored `created_xact_id` values are old-cluster numbers. The new counter later passes each of them once, and that one transaction would match the stamp. `created_xact_start` does not match (that transaction starts later), so the entry stays closed. |

The comparison on `created_xact_start` holds only while the new cluster's clock is ahead of every restored stamp, which the check below confirms.

## After a logical restore, before reopening writes

1. Connect as the migration runner or a superuser (the `crove_*` login roles see only one org).
2. Check that no restored stamp lies in the future of the new cluster:

   ```sql
   SELECT count(*) FROM crove_finance.journal_entry WHERE created_xact_start >= now();
   ```

   It must be `0`. Otherwise the new cluster's clock is behind the old one: fix the clock (NTP) and run the check again. Do not reopen writes until it is `0`.
3. Rotate the context key in the restored database: `docs/runbooks/context-key-rotation.md`.
4. Reconcile finance with the WORM archive and the providers before reopening writes (plan §7.9; [What the restore lost](#what-the-restore-lost)).

## What the restore lost

The WORM archive ([worm-archive.md](worm-archive.md)) outlives the database. After a restore, it still holds every posting, voucher number and number allocation made after the backup point. `restore.sh` checks the restored database against it before the stack starts (`main.ts restore-report --reseed --acknowledge`, issues #2007 and #2020). Any restore runs the same check: the steps above, a point-in-time recovery, or a logical restore. Run it by hand in the worker's container, before the stack starts (the service `crove` on the all-in-one stack). Give it the backup's snapshot time, `SNAPSHOT_AT` in the run's `meta.env` (`FINISHED_AT` for a run made before it was recorded; for a point-in-time recovery, the recovery target time):

```sh
docker compose run --rm --no-deps worker restore-report --reseed --acknowledge --backup-point <SNAPSHOT_AT>
```

**What it reports.**
- The batches written after the backup point.
- Per org, what the archive holds and the database lacks: journal entries, cash and journal vouchers, voided purchase documents, number allocations, number voids and number series. Each is named by its id.
- Per org, the number of audit events lost.
- `restore.sh` also writes the whole report as JSON to `archive-report.json` in its restore directory (`BACKUP_DIR/restore-<time>/`).
- The archive holds hashes, not values. The report says which records were lost, not what they held: amounts, parties and lines come from the source documents (the paper or PDF vouchers, the e-invoices, the bank statements) or from the period's exports.

**What `--reseed` does.**
- It raises every number series whose next number is not above the highest number the archive holds for it. The series' next number becomes the archived highest + 1.
- A series the restore lost altogether is created again, with its archived id and key.
- Each raise is one audited command (`kernel.number.reseed`, system actor), and it never lowers a number. Running it again changes nothing.
- The numbers between the restored series and the new next number are the lost ones. They stay as the archive holds them, and the report names their allocations.
- A series it raises or creates no longer knows the dates of its documents (its `last_doc_date` becomes `infinity`), so its document type's reset can no longer be switched from a future year (`kernel.number.policy.schedule`, #1595).
- A switch scheduled after the backup point is lost with it: the reseed of a series that switch numbered then fails (`NUMBER_RESEED_PERIOD_MISFIT`). Schedule the switch again with `kernel.number.policy.schedule`, as the archive's audit event of it names, then run `--reseed` again.

**Its exit code** (also the outcome of that step of `restore.sh`):

| Exit | Meaning | What to do |
|---|---|---|
| 0 | The archive and the restored database agree. | Nothing. |
| 2 | Rows made after the backup point were lost; every series is above the archive. The restore goes on with a warning. | Reconcile (below). |
| 3 | A series could not be raised. Either the reseed refused it (the reason is in the log), or some org lost number allocations that no version 7 batch covers, because the archive ends before the first one (#2007). `restore.sh` stops before the stack starts. | Name a floor for each series of that org and confirm them complete (below), then start the stack (`docker compose up -d`). |
| 1 | The archive does not match: a broken chain, an edited batch, or a recorded batch that the store lacks, such as an archive setting that points at a new, empty store. `restore.sh` stops before the stack starts. | Point `ARCHIVE_*` at the deployment's surviving archive, or treat it as in [worm-archive.md](worm-archive.md), "Verification fails". |

**Floors for an org the archive cannot raise.** A floor is needed for every series of the org: one series left without one could give out an archived voucher number a second time.
1. Read the highest number of each of the org's series from the vouchers issued after the backup point (paper or PDF).
   - The run lists the series the restored database has for the org (`NEEDS A FLOOR: org ... series ...`).
   - A series made after the backup point is not in the restored database, nor in such an archive. Find it in the issued vouchers too.
2. Pass the next number to give, once per series: `--floor <org id>:<legal entity id>:<doc type>:<period key>=<next number>`.
3. Once every series the org numbered after the backup point has its floor, confirm it with `--floors-complete <org id>`. For example:

   ```sh
   docker compose run --rm --no-deps worker restore-report --reseed --acknowledge --backup-point <SNAPSHOT_AT> --floor <org id>:<legal entity id>:finance.cash_voucher.pt:2026=41 --floor <org id>:<legal entity id>:finance.journal_voucher:2026=12 --floors-complete <org id>
   ```

4. The run exits 2 once every listed series has a floor that the reseed accepted, and the org is confirmed. A floor never lowers a number, so a run with a floor too high leaves a gap; one too low changes nothing.

**Reconcile before reopening writes.** The owner and the accountant (#61) decide what to enter again.
- **Each lost journal entry and voucher.** Enter it again from its source document, with a new number. The number it had is in the archive's range of lost numbers, and the accountant notes the old and the new number on the voucher.
- **Each lost void and number void.** Repeat it.
- **Provider-issued numbers.** E-invoice numbers are not in the WORM archive. Reconcile them with the e-invoice provider's list for the same period, until a provider integration does it.
- Keep the report and the reconciliation with the incident record.
- **The acknowledgement.** Once every series is safe, `--acknowledge` writes the lost rows to the archive store. The nightly WORM verification then excuses exactly those rows ([worm-archive.md](worm-archive.md), "After a restore").
  - Give it on the run that leaves every series safe, before the stack starts: the run that exits 2, or 0.
  - Once the worker has archived after the restore, the batches after the backup point are recorded, and the check can no longer acknowledge them.

## How to restore the ledger tables

- A full restore (`pg_restore` of a whole dump) loads the data before it creates the triggers, so the stamps arrive as they were.
- `pg_restore --data-only --disable-triggers` (superuser) also keeps the stamps.
- A restore with the triggers in place and not disabled (for example `pg_restore --data-only` into a migrated database) is not a hole: the stamp trigger overwrites both columns with the restoring transaction, so no old-cluster `xid8` survives to match later.
- A data-only restore with triggers on re-stamps every entry with the restoring transaction. Lines are then refused ("already posted") unless the whole restore runs as one transaction (`--single-transaction`); in that case the balance check also runs again at commit. Either way no entry is reopened, but the original stamps are lost.
