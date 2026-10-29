-- The reset policy of the gapless numbering in the WORM fact stream (issue #1623, after #1594 and #1596). Idempotent;
-- applied files stay untouched.
--
-- crove_kernel.number_series_policy (#1401, 20261103030000) holds the reset of a doc type in a legal entity: 'yearly'
-- (also when there is no row), 'monthly' or 'never'. Version 4 batches (20261103060000) anchor every allocation with
-- its series' period key, but not the policy that decides the period key of the next one: a database owner who
-- disables the triggers and switches a doc type's reset (yearly to monthly, say) or deletes its policy row went
-- unnoticed, and the doc type's next numbers started again from 1 in a new period.
--
-- What is anchored, and why per series. A doc type's reset changes legitimately only before its first number:
-- number_series_policy_set refuses a change once the doc type has allocations (NUMBER_POLICY_IN_USE, after the
-- advisory lock of 20261103050000), and every change it makes is an R2 command whose audit event names the reset and
-- the previous one (version 1 rows since #891). A series row exists exactly when its doc type has numbers: it is
-- created in the transaction of its first allocation, and allocations are append-only. So from a series' creation on,
-- the reset in force for its doc type never changes legitimately, and this adds one row per series, with its own
-- reference:
--   number_series:<org_id>:<id>   a series: its legal entity, doc type, period key, creation time, and the reset in
--                                 force for its doc type in its entity (the policy row's, or 'yearly' without one)
-- A switched reset, or a policy row deleted or added for a doc type in use, changes the row of every series of that
-- doc type; a policy changed or restated before the doc type's first number changes no anchored row. The policy row's
-- updated_by and updated_at are left out: restating the reset in force updates them, and the audit event records who.
--
-- crove_kernel.archive_series_hashes(from, to) gives those rows for the series created in [from, to), with their
-- hashes, to the worker only. Batches the worker writes from now on are version 5: the version 4 rows of their window
-- plus these, from seriesFrom (the epoch for the first version 5 batch, which takes in every series made before it;
-- the window's start after). Version 1 to 4 batches keep verifying as they were written. A series is created in the
-- transaction of its first allocation, at the same time as it and as the command's audit event, so
-- archive_next_window cuts the window that holds it, as for the allocations. number_series is small (one row per doc
-- type, entity and period), so no index on created_at.
SET LOCAL lock_timeout = '2s';

-- Version 5 row hashes over a fixed column list, like versions 1 to 4.
CREATE OR REPLACE FUNCTION crove_kernel.archive_series_hashes(p_from timestamptz, p_to timestamptz)
RETURNS TABLE (ref text, row_sha256 text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM crove_kernel.archive_require_worker();
  RETURN QUERY
  SELECT 'number_series:' || s.org_id::text || ':' || s.id::text,
         pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.jsonb_build_object(
           'org_id', s.org_id, 'id', s.id, 'legal_entity_id', s.legal_entity_id, 'doc_type', s.doc_type,
           'period_key', s.period_key, 'reset', coalesce(p.reset, 'yearly'),
           'created_at', crove_kernel.archive_ts(s.created_at))::text, 'UTF8')), 'hex')
  FROM crove_kernel.number_series s
  LEFT JOIN crove_kernel.number_series_policy p
    ON p.org_id = s.org_id AND p.legal_entity_id = s.legal_entity_id AND p.doc_type = s.doc_type
  WHERE s.created_at >= p_from AND s.created_at < p_to;
END $$;
REVOKE ALL ON FUNCTION crove_kernel.archive_series_hashes(timestamptz, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crove_kernel.archive_series_hashes(timestamptz, timestamptz) TO crove_worker;
