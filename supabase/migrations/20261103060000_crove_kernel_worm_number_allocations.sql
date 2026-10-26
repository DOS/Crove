-- The gapless numbering in the WORM fact stream (issues #1594 and #1596, after #1401). Idempotent; applied files stay
-- untouched.
--
-- #1401 (20261103030000, 20261103040000) records every number given out (crove_kernel.number_allocation, append-only)
-- and every number voided (crove_kernel.number_void, append-only), and gives cash and journal vouchers the period of
-- their number (number_period) and their allocation (number_allocation_id). Version 2 row hashes (20261026230000)
-- cover a voucher's number but not its period or allocation, and nothing anchored the allocations or the voids. This
-- adds three kinds of rows, with their own references:
--   number:<org_id>:<id>                       an allocation: its series (entity, doc type, period key), its number and
--                                              the record it went to
--   number_void:<org_id>:<id>                  a void: the allocation, the reason, who and when
--   voucher_number:<type>:<org_id>:<id>        a cash or journal voucher's number, number period and allocation
--
-- crove_kernel.archive_allocation_hashes(from, to) gives those rows made in [from, to) (allocated_at, voided_at, the
-- voucher's created_at), with their hashes, to the worker only. Batches the worker writes from now on are version 4:
-- the version 3 rows of their window plus these, from allocationsFrom (the epoch for the first version 4 batch, which
-- takes in every allocation, void and voucher made before it; the window's start after). Version 1 to 3 batches keep
-- verifying as they were written. An allocation and a void are made in the transaction of their command, which writes
-- an audit event with the same time, so archive_next_window, which cuts windows by audit events and journal entries,
-- never leaves one behind.
SET LOCAL lock_timeout = '2s';

CREATE INDEX IF NOT EXISTS number_allocation_allocated_brin ON crove_kernel.number_allocation USING brin (allocated_at);
CREATE INDEX IF NOT EXISTS number_void_voided_brin ON crove_kernel.number_void USING brin (voided_at);

-- Version 4 row hashes over a fixed column list, like versions 1 to 3.
CREATE OR REPLACE FUNCTION crove_kernel.archive_allocation_hashes(p_from timestamptz, p_to timestamptz)
RETURNS TABLE (ref text, row_sha256 text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM crove_kernel.archive_require_worker();
  RETURN QUERY
  SELECT 'number:' || a.org_id::text || ':' || a.id::text,
         pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.jsonb_build_object(
           'org_id', a.org_id, 'id', a.id, 'legal_entity_id', a.legal_entity_id, 'series_id', a.series_id,
           'doc_type', s.doc_type, 'period_key', s.period_key, 'number', a.number::text,
           'target_type', a.target_type, 'target_id', a.target_id, 'allocated_by', a.allocated_by,
           'allocated_at', crove_kernel.archive_ts(a.allocated_at))::text, 'UTF8')), 'hex')
  FROM crove_kernel.number_allocation a
  JOIN crove_kernel.number_series s ON s.org_id = a.org_id AND s.id = a.series_id
  WHERE a.allocated_at >= p_from AND a.allocated_at < p_to
  UNION ALL
  SELECT 'number_void:' || v.org_id::text || ':' || v.id::text,
         pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.jsonb_build_object(
           'org_id', v.org_id, 'id', v.id, 'allocation_id', v.allocation_id, 'reason', v.reason,
           'voided_by', v.voided_by, 'voided_at', crove_kernel.archive_ts(v.voided_at))::text, 'UTF8')), 'hex')
  FROM crove_kernel.number_void v
  WHERE v.voided_at >= p_from AND v.voided_at < p_to
  UNION ALL
  SELECT 'voucher_number:cash_voucher:' || c.org_id::text || ':' || c.id::text,
         pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.jsonb_build_object(
           'org_id', c.org_id, 'id', c.id, 'number', c.number, 'number_period', c.number_period,
           'number_allocation_id', c.number_allocation_id)::text, 'UTF8')), 'hex')
  FROM crove_finance.cash_voucher c
  WHERE c.created_at >= p_from AND c.created_at < p_to
  UNION ALL
  SELECT 'voucher_number:journal_voucher:' || j.org_id::text || ':' || j.id::text,
         pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.jsonb_build_object(
           'org_id', j.org_id, 'id', j.id, 'number', j.number, 'number_period', j.number_period,
           'number_allocation_id', j.number_allocation_id)::text, 'UTF8')), 'hex')
  FROM crove_finance.journal_voucher j
  WHERE j.created_at >= p_from AND j.created_at < p_to;
END $$;
REVOKE ALL ON FUNCTION crove_kernel.archive_allocation_hashes(timestamptz, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crove_kernel.archive_allocation_hashes(timestamptz, timestamptz) TO crove_worker;
