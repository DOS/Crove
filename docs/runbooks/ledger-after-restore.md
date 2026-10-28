# Runbook: ledger checks after a restore

A journal entry can gain lines only in the transaction that created it (External-tenant gate T3, issue #76). The posting function writes the entry and all its lines in one call, and a trigger refuses any line added later, by any role, superusers included. This runbook covers what a restore does to that rule and what to check before reopening writes (plan §7.9).

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
4. Reconcile finance with the providers (and the WORM stream once it exists) before reopening writes (plan §7.9).

## How to restore the ledger tables

- A full restore (`pg_restore` of a whole dump) loads the data before it creates the triggers, so the stamps arrive as they were.
- `pg_restore --data-only --disable-triggers` (superuser) also keeps the stamps.
- A restore with the triggers in place and not disabled (for example `pg_restore --data-only` into a migrated database) is not a hole: the stamp trigger overwrites both columns with the restoring transaction, so no old-cluster `xid8` survives to match later.
- A data-only restore with triggers on re-stamps every entry with the restoring transaction. Lines are then refused ("already posted") unless the whole restore runs as one transaction (`--single-transaction`); in that case the balance check also runs again at commit. Either way no entry is reopened, but the original stamps are lost.
