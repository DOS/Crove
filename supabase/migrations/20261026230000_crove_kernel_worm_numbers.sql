-- Voucher numbers and voids in the WORM fact stream (plan §4.10 "number allocations, voided numbers included", §13
-- Phase 2a exit criterion "voided numbers are in the hash chain", issue #977). Idempotent; applied files stay untouched.
--
-- 20261023230000 anchors audit events and journal entries. This adds the gapless numbers Crove allocates and the
-- voids it records, so that renumbering a voucher or dropping a void row shows in the nightly verification:
--   cash_voucher:<org_id>:<id>       a cash or bank voucher (PT, PC, BC, BN): its type, number, date, account, amount
--   journal_voucher:<org_id>:<id>    a general journal voucher (NVK): its number and date
--   document_void:<org_id>:<id>      a voided purchase document and the reversal entry that voided it
-- A voucher keeps its number when its entry is reversed; the reversal is the journal entry that names it
-- (reverses_entry_id), anchored already.
--
-- crove_kernel.archive_number_hashes(from, to) gives those rows created in [from, to), with their hashes, to the worker
-- only. Batches the worker writes from now on are version 2: the version 1 rows of their window plus these. The first
-- version 2 batch also covers every voucher and void created before it (it reads them from the epoch), so nothing
-- older than the switch stays unanchored; later batches read their own window. Version 1 batches keep verifying as
-- they were written.
--
-- A voucher and a void are created in the same transaction as their journal entry (a database rule for both), so they
-- share its created_at and archive_next_window, which finds the next window by audit events and journal entries, never
-- leaves one behind.
SET LOCAL lock_timeout = '2s';

CREATE INDEX IF NOT EXISTS cash_voucher_created_brin ON crove_finance.cash_voucher USING brin (created_at);
CREATE INDEX IF NOT EXISTS journal_voucher_created_brin ON crove_finance.journal_voucher USING brin (created_at);
CREATE INDEX IF NOT EXISTS purchase_document_void_created_brin ON crove_finance.purchase_document_void USING brin (created_at);

-- Version 2 row hashes over a fixed column list, like version 1: a column added later changes no stored hash.
CREATE OR REPLACE FUNCTION crove_kernel.archive_number_hashes(p_from timestamptz, p_to timestamptz)
RETURNS TABLE (ref text, row_sha256 text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM crove_kernel.archive_require_worker();
  RETURN QUERY
  SELECT 'cash_voucher:' || v.org_id::text || ':' || v.id::text,
         pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.jsonb_build_object(
           'org_id', v.org_id, 'id', v.id, 'voucher_type', v.voucher_type, 'number', v.number,
           'voucher_date', v.voucher_date::text, 'cash_account', v.cash_account, 'amount', v.amount::text,
           'party_id', v.party_id, 'created_at', crove_kernel.archive_ts(v.created_at))::text, 'UTF8')), 'hex')
  FROM crove_finance.cash_voucher v
  WHERE v.created_at >= p_from AND v.created_at < p_to
  UNION ALL
  SELECT 'journal_voucher:' || j.org_id::text || ':' || j.id::text,
         pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.jsonb_build_object(
           'org_id', j.org_id, 'id', j.id, 'number', j.number, 'voucher_date', j.voucher_date::text,
           'created_at', crove_kernel.archive_ts(j.created_at))::text, 'UTF8')), 'hex')
  FROM crove_finance.journal_voucher j
  WHERE j.created_at >= p_from AND j.created_at < p_to
  UNION ALL
  SELECT 'document_void:' || d.org_id::text || ':' || d.document_id::text,
         pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.jsonb_build_object(
           'org_id', d.org_id, 'document_id', d.document_id, 'reversal_entry_id', d.reversal_entry_id,
           'created_at', crove_kernel.archive_ts(d.created_at))::text, 'UTF8')), 'hex')
  FROM crove_finance.purchase_document_void d
  WHERE d.created_at >= p_from AND d.created_at < p_to;
END $$;
REVOKE ALL ON FUNCTION crove_kernel.archive_number_hashes(timestamptz, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crove_kernel.archive_number_hashes(timestamptz, timestamptz) TO crove_worker;
