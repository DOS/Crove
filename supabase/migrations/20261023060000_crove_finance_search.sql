-- Crove finance (issue #673): search across parties, documents and journal entries, from the command palette. The
-- query is finance.search (modules/finance/src/search.ts); it runs as the member, so row security keeps it in the org.
-- Idempotent.
--
-- crove_kernel.search_fold(text)     the text an accountant types and the text stored, folded the same way: Unicode
--                                     NFC, the Vietnamese letters with marks (and đ) to their base letter, lower case,
--                                     and every run of characters outside a-z and 0-9 to one space. So "Điện lực" and
--                                     "dien luc" fold alike, and "AA/24E" becomes the two words "aa 24e".
-- crove_kernel.search_vector(text)   the folded text as a tsvector of the 'simple' configuration (no stemming, no
--                                     stop words: names, tax codes and invoice numbers are not prose).
-- crove_kernel.search_query(text)    what was typed as a tsquery: every folded word as a prefix, all of them required
--                                     ("dien 012" finds "Điện lực 0101234564"); null when nothing is left to match.
--                                     The words hold only a-z and 0-9, so no input can change the query's syntax, and
--                                     only the first 8 count, so a long string of short words cannot make it costly.
--
-- The three are pure (no table, no setting), so they are IMMUTABLE and can be used in generated columns. Their results
-- are stored in those columns: a later change to a body must come with an update that recomputes them.
--
-- Each searched table gets a stored `search` column with its folded words, and a GIN index on it (row security adds
-- the org). The vectors are stored rather than indexed as expressions: folding costs some 40 microseconds a row, and
-- a plan that filters by the expression (the planner picks one whenever many rows match) would compute it for every
-- row it reads, seconds on an org of 50,000 documents. Stored, the test is a lookup.
--   party.search             name and tax code
--   purchase_document.search series and number, and the number without its leading zeros ("123" finds "0000123")
--   journal_entry.search     description
-- And journal_line_amount_idx: a line's amount (debit + credit: exactly one of them is not zero), for a typed amount.
--
-- Adding a stored column rewrites the three tables once; row triggers (the append-only guards) do not fire for that.
SET LOCAL lock_timeout = '2s';

CREATE OR REPLACE FUNCTION crove_kernel.search_fold(p_text text)
RETURNS text LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE SET search_path = pg_catalog, pg_temp AS $$
  SELECT pg_catalog.btrim(pg_catalog.regexp_replace(
    pg_catalog.lower(pg_catalog.translate(
      pg_catalog.normalize(p_text, 'NFC'),
      'àáạảãâầấậẩẫăằắặẳẵÀÁẠẢÃÂẦẤẬẨẪĂẰẮẶẲẴèéẹẻẽêềếệểễÈÉẸẺẼÊỀẾỆỂỄìíịỉĩÌÍỊỈĨòóọỏõôồốộổỗơờớợởỡÒÓỌỎÕÔỒỐỘỔỖƠỜỚỢỞỠùúụủũưừứựửữÙÚỤỦŨƯỪỨỰỬỮỳýỵỷỹỲÝỴỶỸđĐ',
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaeeeeeeeeeeeeeeeeeeeeeeiiiiiiiiiioooooooooooooooooooooooooooooooooouuuuuuuuuuuuuuuuuuuuuuyyyyyyyyyydd'
    )),
    '[^a-z0-9]+', ' ', 'g'
  ))
$$;

CREATE OR REPLACE FUNCTION crove_kernel.search_vector(p_text text)
RETURNS tsvector LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = pg_catalog, pg_temp AS $$
  SELECT pg_catalog.to_tsvector('pg_catalog.simple'::pg_catalog.regconfig, COALESCE(crove_kernel.search_fold(p_text), ''))
$$;

CREATE OR REPLACE FUNCTION crove_kernel.search_query(p_text text)
RETURNS tsquery LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE SET search_path = pg_catalog, pg_temp AS $$
  SELECT CASE WHEN f.words = '' THEN NULL
    ELSE pg_catalog.to_tsquery(
      'pg_catalog.simple'::pg_catalog.regconfig,
      pg_catalog.array_to_string((pg_catalog.string_to_array(f.words, ' '))[1:8], ':* & ') || ':*'
    )
  END
  FROM (SELECT crove_kernel.search_fold(p_text) AS words) f
$$;

-- Executed whenever a row of the tables below is written (the generated columns), so by every role that writes them (crove_app, crove_worker
-- and crove_definer_tenant are members of crove_tenant), and by the search itself. They read nothing.
REVOKE ALL ON FUNCTION crove_kernel.search_fold(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION crove_kernel.search_vector(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION crove_kernel.search_query(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crove_kernel.search_fold(text) TO crove_tenant;
GRANT EXECUTE ON FUNCTION crove_kernel.search_vector(text) TO crove_tenant;
GRANT EXECUTE ON FUNCTION crove_kernel.search_query(text) TO crove_tenant;

ALTER TABLE crove_kernel.party
  ADD COLUMN IF NOT EXISTS search tsvector GENERATED ALWAYS AS (crove_kernel.search_vector(name || ' ' || COALESCE(tax_code, ''))) STORED;
ALTER TABLE crove_finance.purchase_document
  ADD COLUMN IF NOT EXISTS search tsvector GENERATED ALWAYS AS
  (crove_kernel.search_vector(invoice_series || ' ' || invoice_number || ' ' || pg_catalog.ltrim(invoice_number, '0'))) STORED;
ALTER TABLE crove_finance.journal_entry
  ADD COLUMN IF NOT EXISTS search tsvector GENERATED ALWAYS AS (crove_kernel.search_vector(description)) STORED;

CREATE INDEX IF NOT EXISTS party_search_idx ON crove_kernel.party USING gin (search);
CREATE INDEX IF NOT EXISTS purchase_document_search_idx ON crove_finance.purchase_document USING gin (search);
CREATE INDEX IF NOT EXISTS journal_entry_search_idx ON crove_finance.journal_entry USING gin (search);
CREATE INDEX IF NOT EXISTS journal_line_amount_idx ON crove_finance.journal_line (org_id, (debit + credit));
