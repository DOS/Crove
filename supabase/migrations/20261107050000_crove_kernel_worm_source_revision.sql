-- SPDX-License-Identifier: AGPL-3.0-only
-- A journal entry's source revision and payload hash in the WORM fact stream (issue #1337, after #1283). Idempotent;
-- applied files stay untouched.
--
-- #1283 (20261031000000) gave journal entries source_revision (which revision of its source the entry posts) and
-- payload_sha256 (the SHA-256 of the canonical posting request, NULL on entries posted before it). The version 1 row
-- hash (20261023230000) covers a fixed column list that predates them, so the archive did not prove either: a database
-- owner who disabled the triggers and changed an entry's revision (making a reversed revision look current, or two
-- entries of one source look like different revisions) or its payload hash (so a replay would match another request)
-- went unnoticed. This adds one row per journal entry, with its own reference:
--   revision:journal:<org_id>:<id>   a journal entry's source type, source id, source revision and payload hash (hex,
--                                    or null)
-- The source type and id are anchored in the version 1 row already; they are repeated here so this row says which
-- revision of which source the entry is, on its own.
--
-- crove_kernel.archive_revision_hashes(from, to) gives those rows for the entries created in [from, to), with their
-- hashes, to the worker only. Batches the worker writes from now on are version 6: the version 5 rows of their window
-- plus these, from revisionsFrom (the epoch for the first version 6 batch, which takes in every entry made before it;
-- the window's start after). Version 1 to 5 batches keep verifying as they were written. An entry's row shares its
-- created_at with its version 1 row, so it falls in the same window from the second version 6 batch on; the BRIN index
-- on created_at (20261023230000) serves the range.
SET LOCAL lock_timeout = '2s';

-- Version 6 row hashes over a fixed column list, like versions 1 to 5.
CREATE OR REPLACE FUNCTION crove_kernel.archive_revision_hashes(p_from timestamptz, p_to timestamptz)
RETURNS TABLE (ref text, row_sha256 text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM crove_kernel.archive_require_worker();
  RETURN QUERY
  SELECT 'revision:journal:' || e.org_id::text || ':' || e.id::text,
         pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.jsonb_build_object(
           'org_id', e.org_id, 'id', e.id, 'source_type', e.source_type, 'source_id', e.source_id,
           'source_revision', e.source_revision,
           'payload_sha256', CASE WHEN e.payload_sha256 IS NULL THEN NULL ELSE pg_catalog.encode(e.payload_sha256, 'hex') END)::text, 'UTF8')), 'hex')
  FROM crove_finance.journal_entry e
  WHERE e.created_at >= p_from AND e.created_at < p_to;
END $$;
REVOKE ALL ON FUNCTION crove_kernel.archive_revision_hashes(timestamptz, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crove_kernel.archive_revision_hashes(timestamptz, timestamptz) TO crove_worker;
