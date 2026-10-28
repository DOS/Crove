# Runbook: rotate the context key

The context key signs the request context (plan §4.5 item 5, External-tenant gate T11). `enter_context` and `enter_system_context` seal `crove.ctx` with HMAC-SHA256 under this key, and every `ctx_*` helper, and so every RLS policy and definer, refuses a context whose seal does not verify. Anyone who holds the key and can run SQL as a `crove_*` login role can forge a context for any org. This runbook replaces the key.

## Where the key lives

- One row in `crove_kernel.context_key` (`id = 1`), stored as the HMAC inner and outer padded keys (`k_ipad`, `k_opad`). Created by `20261015170000_crove_kernel_sealed_context.sql`.
- Owned by the migration runner (the role of `ADMIN_DATABASE_URL`, which also owns the definers). No `crove_*` role has a grant on it, and RLS is on without a policy.
- It is ordinary table data, so it **travels with every copy of the database**:
  - `pg_dump` run as the owner or a superuser includes it (the owner bypasses RLS on its own table).
  - Point-in-time recovery: base backups and archived WAL hold every key the database ever had.
  - Physical replicas (streaming or a promoted standby) carry the same key.
  - Logical replication copies it only if a publication includes it (for example `FOR ALL TABLES`). Ludy defines no publication.

## When to rotate

- A dump, backup or replica left the place it is trusted (copied to a laptop, a ticket, another cloud account).
- After every restore, in place or into a new project (plan §7.9): an in-place PITR brings back an older key.
- A copy of production was restored or promoted into another environment (staging, a test project, a new self-host): rotate **in the copy**, so the copy and production no longer share a key.
- Someone who could read the key (superuser, database owner, the migration runner's password) loses that access.
- On a schedule, if your policy asks for one. Nothing in Ludy expires the key.

Rotating does not change what the superuser, the database owner or a holder of a dump can do: they can bypass RLS anyway (accepted residual of T11). It ends the use of a leaked key against the live database.

## Steps

1. Connect as the migration runner (the `ADMIN_DATABASE_URL` role) or a superuser. The login roles (`crove_app`, `crove_worker`) cannot rotate: they have no EXECUTE on the function and no access to the table.
2. Rotate:

   ```sql
   SELECT crove_kernel.context_key_rotate();
   ```

   It writes a fresh 32-byte random key (the same derivation as the first one) and returns the time of the rotation. If the key row is missing, it creates it.
3. Check that the row changed and that the app still serves requests:

   ```sql
   SELECT created_at FROM crove_kernel.context_key;
   ```

   Then open `/readyz` and sign in once.

No restart and no configuration change are needed: the definers read the key on every check.

## What users see

- Transactions that entered their context before the rotation committed fail at their next statement with `CONTEXT_SEAL_INVALID`, which the runtime maps to `INTERNAL` 500 and logs. Requests are short, so this is a handful of requests at most; rotate at a quiet time. A REPEATABLE READ transaction that took its snapshot before the rotation keeps the old key until it ends.
- Every transaction that starts after the commit seals and verifies with the new key.
- There is no way back to the old key, and none is needed: rotate again if something looks wrong.

## Copies without the key

To hand a dump to a less trusted place, leave the key out and create a new one after the restore:

```sh
pg_dump --exclude-table-data=crove_kernel.context_key ...
```

After restoring such a dump, `enter_context` raises `CONTEXT_KEY_MISSING` until step 2 runs in the restored database. The migration ledger already lists the sealed-context migration, so `migrate` does not recreate the key; `context_key_rotate()` does.

## Tested by

`apps/kernel/test/invariant/sealed-context.db.test.ts`, "stops verifying seals made with the old key once the key is rotated": a seal made with the old key stops verifying in the open transaction as soon as the rotation commits, new transactions seal with the new key, and neither login role can rotate.
