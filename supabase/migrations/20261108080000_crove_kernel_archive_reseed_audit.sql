-- SPDX-License-Identifier: AGPL-3.0-only
-- The restore check's own rows (issue #2020, after #2007). Idempotent; applied files stay untouched.
--
-- Before it acknowledges a restore, the restore check (apps/kernel/src/worm.ts, restoreReport) reads the restored
-- database for any archived row stamped at or after the backup point, with no upper bound: a restored database holds
-- none, so one there was restamped (an old row edited and moved past the newest batch) or the database is not a
-- restore of that backup. The only such rows the check itself writes are the audit events of its reseed
-- (kernel.number.reseed, system actor) and a series it made again, which keeps its archived id. A run that stopped on a
-- series it could not raise, and runs again with the operator's floors, finds the first run's.
-- crove_kernel.archive_reseed_audit(from) gives the references (audit:<id>) of those audit events from that time, to the
-- worker only, so the check can tell them from the rest.
SET LOCAL lock_timeout = '2s';

CREATE OR REPLACE FUNCTION crove_kernel.archive_reseed_audit(p_from timestamptz)
RETURNS TABLE (ref text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM crove_kernel.archive_require_worker();
  RETURN QUERY
  SELECT 'audit:' || a.id::text
  FROM crove_kernel.audit_event a
  WHERE a.occurred_at >= p_from AND a.command = 'kernel.number.reseed' AND a.actor_type = 'system'
  ORDER BY 1;
END $$;
REVOKE ALL ON FUNCTION crove_kernel.archive_reseed_audit(timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crove_kernel.archive_reseed_audit(timestamptz) TO crove_worker;
