-- Row-level security on crove_kernel.outbox_pending (External-tenant gate T8, issue #17). Idempotent; applied
-- files stay untouched.
--
-- Before: outbox_pending carries org_id but was the one table with org_id and RLS off. No role but its owner
-- holds a privilege on it (the bootstrap revoked PUBLIC and granted nothing), so it was not reachable from a
-- login role; only the definers emit() and outbox_claim(), owned by the table owner, touch it.
--
-- After: RLS is enabled, with no policy, like the other definer-only machinery tables (inbound_pending,
-- auth_session, auth_session_org). A privilege granted by mistake later now reads and writes nothing instead of
-- every org's pending events. The owner is unaffected (RLS is enabled, not forced), so emit() and
-- outbox_claim() work as before. The generated RLS matrix (apps/kernel/test/invariant/rls-matrix.db.test.ts)
-- fails on any table with org_id and RLS off.
SET LOCAL lock_timeout = '2s';

ALTER TABLE crove_kernel.outbox_pending ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON crove_kernel.outbox_pending FROM PUBLIC;
