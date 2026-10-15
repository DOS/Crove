-- Drops the obsolete 3-argument session_check (issue #92). An earlier draft of 20261015090000_crove_kernel_auth_sessions
-- created crove_kernel.session_check(uuid, uuid, boolean) before the org argument was added. CREATE OR REPLACE with
-- the 4-argument signature adds an overload instead of replacing it, so a database that applied the draft would keep
-- a callable function that skips the org-scoped revocation check. Idempotent: a no-op where the draft never ran.

DROP FUNCTION IF EXISTS crove_kernel.session_check(uuid, uuid, boolean);
