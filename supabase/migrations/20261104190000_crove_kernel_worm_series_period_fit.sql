-- The nightly WORM verifier also checks that each number series' period key fits the reset it is anchored with (issues
-- #1811 and #1820, the reviews of #1623). Idempotent; applied files stay untouched.
--
-- Version 5 batches (20261104140000) anchor every number series with the reset in force for its doc type. A database
-- owner who disables the triggers, switches a yearly doc type to monthly, allocates once (a series with period key
-- 2026-11 that starts again at 1) and switches the policy back, all within the archiver's lag, leaves a series anchored
-- as {period_key: '2026-11', reset: 'yearly'} that verifies as written: a forgery before anchoring, which the stream
-- itself cannot see. The mismatch shows, though: legitimate data always fits, since number_allocate takes the period key
-- from the policy (number_period_key, 20261103030000), the reset cannot change once the doc type has numbers
-- (NUMBER_POLICY_IN_USE, with the lock of 20261103050000), and the #1401 backfill wrote 'never' policies with '-' series.
-- One historical exception: before 20261103050000 (#1607) a reset change racing a doc type's first number could commit
-- beside it, and such a series is reported the same way (docs/runbooks/worm-archive.md says how to tell them apart).
--
-- crove_kernel.archive_series_misfits() gives, to the worker only, the reference (number_series:<org_id>:<id>, ids
-- only) of every series whose period key does not fit the reset in force for its doc type: 'YYYY' for yearly (also
-- without a policy row), 'YYYY-MM' for monthly, '-' for never. The verifier (apps/kernel/src/worm.ts) reports each one
-- it has anchored as series_period_mismatch, under the batch that anchored it. A series whose reset was switched after
-- it was anchored already fails as row_changed; this catches the one whose reset was switched back before.
-- number_series is small (one row per doc type, entity and period): one scan a night.
SET LOCAL lock_timeout = '2s';

CREATE OR REPLACE FUNCTION crove_kernel.archive_series_misfits()
RETURNS TABLE (ref text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM crove_kernel.archive_require_worker();
  RETURN QUERY
  SELECT 'number_series:' || s.org_id::text || ':' || s.id::text
  FROM crove_kernel.number_series s
  LEFT JOIN crove_kernel.number_series_policy p
    ON p.org_id = s.org_id AND p.legal_entity_id = s.legal_entity_id AND p.doc_type = s.doc_type
  WHERE NOT CASE coalesce(p.reset, 'yearly')
              WHEN 'yearly' THEN s.period_key ~ '^[0-9]{4}$'
              WHEN 'monthly' THEN s.period_key ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'
              ELSE s.period_key = '-'
            END
  ORDER BY 1;
END $$;
REVOKE ALL ON FUNCTION crove_kernel.archive_series_misfits() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crove_kernel.archive_series_misfits() TO crove_worker;
