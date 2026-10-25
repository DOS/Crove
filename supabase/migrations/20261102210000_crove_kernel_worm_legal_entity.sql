-- The legal entity of every anchored finance row in the WORM fact stream (issue #1489, after #1280). Idempotent;
-- applied files stay untouched.
--
-- Version 1 and 2 row hashes (20261023230000, 20261026230000) cover fixed column lists that predate legal_entity_id,
-- so the archive did not prove which legal entity an entry, voucher or void belongs to. The posting path keeps the
-- entity out of the replay hash (20261102150000, ADR-0021 deviation accepted on #1503), so the anchor must carry it.
-- This adds one row per anchored finance row, with its own reference:
--   entity:journal:<org_id>:<id>            a journal entry's legal entity, and the legal entity of each of its lines
--   entity:cash_voucher:<org_id>:<id>       a cash or bank voucher's legal entity
--   entity:journal_voucher:<org_id>:<id>    a general journal voucher's legal entity
--   entity:document_void:<org_id>:<id>      a voided purchase document's legal entity
--
-- crove_kernel.archive_entity_hashes(from, to) gives those rows created in [from, to), with their hashes, to the
-- worker only. Batches the worker writes from now on are version 3: the version 2 rows of their window plus these. The
-- first version 3 batch also covers every row created before it (it reads them from the epoch), so nothing posted
-- before the switch stays without its entity anchored; later batches read their own window. Version 1 and 2 batches
-- keep verifying as they were written. Moving a row to another entity with the triggers disabled now fails the nightly
-- verification.
SET LOCAL lock_timeout = '2s';

-- Version 3 row hashes over a fixed column list, like versions 1 and 2. The voucher, void and entry rows share the
-- created_at of the entry's transaction, so they fall in the same window as the version 1 and 2 rows (the BRIN
-- indexes on created_at exist since 20261023230000 and 20261026230000).
CREATE OR REPLACE FUNCTION crove_kernel.archive_entity_hashes(p_from timestamptz, p_to timestamptz)
RETURNS TABLE (ref text, row_sha256 text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM crove_kernel.archive_require_worker();
  RETURN QUERY
  SELECT 'entity:journal:' || e.org_id::text || ':' || e.id::text,
         pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.jsonb_build_object(
           'org_id', e.org_id, 'id', e.id, 'legal_entity_id', e.legal_entity_id,
           'lines', coalesce((
             SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(l.line_no, l.legal_entity_id) ORDER BY l.line_no)
             FROM crove_finance.journal_line l WHERE l.org_id = e.org_id AND l.entry_id = e.id), '[]'::jsonb))::text, 'UTF8')), 'hex')
  FROM crove_finance.journal_entry e
  WHERE e.created_at >= p_from AND e.created_at < p_to
  UNION ALL
  SELECT 'entity:cash_voucher:' || v.org_id::text || ':' || v.id::text,
         pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.jsonb_build_object(
           'org_id', v.org_id, 'id', v.id, 'legal_entity_id', v.legal_entity_id)::text, 'UTF8')), 'hex')
  FROM crove_finance.cash_voucher v
  WHERE v.created_at >= p_from AND v.created_at < p_to
  UNION ALL
  SELECT 'entity:journal_voucher:' || j.org_id::text || ':' || j.id::text,
         pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.jsonb_build_object(
           'org_id', j.org_id, 'id', j.id, 'legal_entity_id', j.legal_entity_id)::text, 'UTF8')), 'hex')
  FROM crove_finance.journal_voucher j
  WHERE j.created_at >= p_from AND j.created_at < p_to
  UNION ALL
  SELECT 'entity:document_void:' || d.org_id::text || ':' || d.document_id::text,
         pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.jsonb_build_object(
           'org_id', d.org_id, 'document_id', d.document_id, 'legal_entity_id', d.legal_entity_id)::text, 'UTF8')), 'hex')
  FROM crove_finance.purchase_document_void d
  WHERE d.created_at >= p_from AND d.created_at < p_to;
END $$;
REVOKE ALL ON FUNCTION crove_kernel.archive_entity_hashes(timestamptz, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crove_kernel.archive_entity_hashes(timestamptz, timestamptz) TO crove_worker;
