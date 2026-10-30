-- SPDX-License-Identifier: AGPL-3.0-only
-- The prober sees the WORM archive (issue #1997): the nightly verification that stopped running or keeps failing, or
-- the archive that fell behind, alert like a stuck worker instead of waiting for someone to run the runbook's queries
-- by hand (docs/runbooks/worm-archive.md). Idempotent; applied files stay untouched.
--
-- crove_kernel.archive_health()   for crove_prober alone, read beside crove_kernel.health() in the prober's one
--                                 read-only transaction (apps/kernel/src/prober.ts, readHealth):
--   archive_verify_age_seconds  seconds since the newest crove_kernel.archive_verification run that passed (ok), or,
--                               before the first, since the first archive batch was written; NULL while the archive
--                               holds no batch. A verification that keeps failing ages like one that stopped running.
--   archive_lag_seconds         the age of the oldest audit event not yet in an archive batch; NULL when every one is
--                               anchored. Journal entries are archived by the same windows, and every one is written by a
--                               command whose audit row carries the same transaction time, so the oldest unarchived
--                               audit event is never younger than the oldest unarchived entry: the ledger (BRIN only on
--                               created_at, a scan that grows when the archiver stalls) is not read.
-- Times only, no tenant data, each one index lookup (archive_verification_time_idx, archive_batch's primary key,
-- audit_event_occurred_idx).
--
-- A function of its own rather than two more columns of health(): every migration file must re-apply on the final
-- schema (packages/db/test/invariant/migrate.db.test.ts), and 20261015234500 recreates health(int) with its columns,
-- so health()'s result never changes. The invariant suite lets crove_prober execute this one since #2031.
SET LOCAL lock_timeout = '2s';

CREATE OR REPLACE FUNCTION crove_kernel.archive_health()
RETURNS TABLE (archive_verify_age_seconds double precision, archive_lag_seconds double precision)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_now constant timestamptz := pg_catalog.now();
  -- The end of the newest archive batch: rows from there on are not anchored yet.
  v_archived_to timestamptz;
BEGIN
  -- The newest run that passed, or, before the first, the first batch (the verifier owes a run within a day of it). A
  -- failing run resets nothing, so a verifier that keeps failing alerts as stale too.
  SELECT EXTRACT(EPOCH FROM v_now - COALESCE(
           (SELECT v.verified_at FROM crove_kernel.archive_verification v WHERE v.ok ORDER BY v.verified_at DESC LIMIT 1),
           (SELECT b.written_at FROM crove_kernel.archive_batch b ORDER BY b.seq LIMIT 1)))::double precision
    INTO archive_verify_age_seconds;
  -- The oldest audit event at or after the newest batch's end (windows are [from, to)), the time the archiver cuts
  -- windows by. It normally stays near ARCHIVE_LAG_SECONDS (600 s), which the archiver waits so an open transaction is
  -- not cut off.
  SELECT b.window_to INTO v_archived_to FROM crove_kernel.archive_batch b ORDER BY b.seq DESC LIMIT 1;
  SELECT EXTRACT(EPOCH FROM v_now - (
           SELECT a.occurred_at FROM crove_kernel.audit_event a WHERE a.occurred_at >= COALESCE(v_archived_to, '-infinity') ORDER BY a.occurred_at LIMIT 1))::double precision
    INTO archive_lag_seconds;
  RETURN NEXT;
END $$;
REVOKE ALL ON FUNCTION crove_kernel.archive_health() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crove_kernel.archive_health() TO crove_prober;
