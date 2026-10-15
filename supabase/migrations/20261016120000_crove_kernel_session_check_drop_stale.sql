-- Drops the obsolete 3-argument session_check (issue #92). An earlier draft of 20261015090000_crove_kernel_auth_sessions
-- created crove_kernel.session_check(uuid, uuid, boolean) before the org argument was added. CREATE OR REPLACE with
-- the 4-argument signature adds an overload instead of replacing it. The built-in runner refuses a database that
-- applied the draft (the file's checksum changed); one recovered by deleting that ledger row and migrating again
-- would keep a callable overload that skips the org-scoped revocation check. Idempotent: a no-op elsewhere.

DROP FUNCTION IF EXISTS crove_kernel.session_check(uuid, uuid, boolean);
