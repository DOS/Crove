-- SPDX-License-Identifier: AGPL-3.0-only
-- The highest number of each series in the WORM fact stream, for the reseed after a restore (issue #2007, plan §7.9:
-- "Reseed number series with max(WORM log, numbers already issued by the provider)"). Idempotent; applied files stay
-- untouched.
--
-- A restore to a backup point loses every number allocated after it, while the archive store keeps their references.
-- A reference names an allocation by id only (number:<org_id>:<id>), and its hash covers the record it went to and the
-- time, so neither its series nor its number can be read back: a restored series would give out numbers the archive
-- already holds. Version 7 batches therefore also carry, for every series that took a number in their window, its key
-- and its highest number there, as one row per series with its own reference:
--   number_high:<org_id>:<series id>   the series' legal entity, doc type, period key and the highest number allocated
--                                      in the window
-- Unlike every other row, the batch also holds these values in the clear (the batch's `highs`), so the restore check
-- can read them; the verifier recomputes the row from the database, and the restore check recomputes each row hash
-- from the clear values, so a value changed in the store fails as the chained row hash does. They are the one exception
-- to "hashes and references only": ids, a doc type, a period key and a number, no personal data.
--
-- The row hash is the sha256 of one line of text, not of a jsonb value, so the worker recomputes it from the clear
-- values without PostgreSQL's jsonb text form (apps/kernel/src/worm.ts, highSha256):
--   number_high/v1 \n org_id \n series id \n legal entity id \n doc type \n period key \n number
-- The doc type and the period key hold no newline (number_series' CHECK constraints), so the line is unambiguous.
--
-- crove_kernel.archive_series_highs(from, to) gives those rows for the allocations made in [from, to), with their
-- hashes and clear values, to the worker only. The first version 7 batch takes them from the epoch (highsFrom), so it
-- holds the highest number of every series ever numbered; later ones their own window. An allocation is made in the
-- transaction of its command, with an audit event of the same time, so archive_next_window cuts the window that holds
-- it, as for the version 4 rows. The BRIN index on number_allocation.allocated_at (20261103060000) serves the range.
--
-- crove_kernel.archive_series_next() gives the restore check every series with its next number, to the worker only:
-- the series a restore must raise are those whose next number is not above the archived highest.
-- crove_kernel.archive_legal_entities() gives it every legal entity of an org that is active or offboarding (the orgs
-- whose system context the reseed may enter), to the worker only: a series of an org or entity made after the backup
-- point has nothing to raise in the restored database, and is reported as lost with it.
SET LOCAL lock_timeout = '2s';

CREATE OR REPLACE FUNCTION crove_kernel.archive_series_highs(p_from timestamptz, p_to timestamptz)
RETURNS TABLE (ref text, row_sha256 text, org_id uuid, series_id uuid, legal_entity_id uuid, doc_type text, period_key text, high bigint)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM crove_kernel.archive_require_worker();
  RETURN QUERY
  SELECT 'number_high:' || h.org_id::text || ':' || h.series_id::text,
         pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.concat_ws(E'\n',
           'number_high/v1', h.org_id::text, h.series_id::text, h.legal_entity_id::text, h.doc_type, h.period_key, h.high::text), 'UTF8')), 'hex'),
         h.org_id, h.series_id, h.legal_entity_id, h.doc_type, h.period_key, h.high
  FROM (
    SELECT a.org_id, a.series_id, s.legal_entity_id, s.doc_type, s.period_key, pg_catalog.max(a.number) AS high
    FROM crove_kernel.number_allocation a
    JOIN crove_kernel.number_series s ON s.org_id = a.org_id AND s.id = a.series_id
    WHERE a.allocated_at >= p_from AND a.allocated_at < p_to
    GROUP BY a.org_id, a.series_id, s.legal_entity_id, s.doc_type, s.period_key
  ) h;
END $$;
REVOKE ALL ON FUNCTION crove_kernel.archive_series_highs(timestamptz, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crove_kernel.archive_series_highs(timestamptz, timestamptz) TO crove_worker;

CREATE OR REPLACE FUNCTION crove_kernel.archive_series_next()
RETURNS TABLE (org_id uuid, series_id uuid, legal_entity_id uuid, doc_type text, period_key text, next_number bigint)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM crove_kernel.archive_require_worker();
  RETURN QUERY
  SELECT s.org_id, s.id, s.legal_entity_id, s.doc_type, s.period_key, s.next_number
  FROM crove_kernel.number_series s
  ORDER BY s.org_id, s.id;
END $$;
REVOKE ALL ON FUNCTION crove_kernel.archive_series_next() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crove_kernel.archive_series_next() TO crove_worker;

CREATE OR REPLACE FUNCTION crove_kernel.archive_legal_entities()
RETURNS TABLE (org_id uuid, legal_entity_id uuid)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM crove_kernel.archive_require_worker();
  RETURN QUERY
  SELECT e.org_id, e.id
  FROM crove_kernel.legal_entity e
  JOIN crove_kernel.tenant t ON t.org_id = e.org_id
  WHERE t.status IN ('active', 'offboarding')
  ORDER BY e.org_id, e.id;
END $$;
REVOKE ALL ON FUNCTION crove_kernel.archive_legal_entities() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crove_kernel.archive_legal_entities() TO crove_worker;
