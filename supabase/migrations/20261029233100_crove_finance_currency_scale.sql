-- Per-currency amount scale and the fx_rate domain (issue #1282, ADR-0021 decision 1). Idempotent; applied files stay
-- untouched. The currency table with each currency's minor units is crove_kernel.currency (20261029233000).
--
-- crove_finance.fx_rate                 numeric(24,10), CHECK (VALUE > 0): an exchange rate, as a direct quote (units
--                                       of the book currency per 1 unit of the foreign currency). Now the type of
--                                       purchase_document.exchange_rate, which had the same size and a table CHECK.
-- crove_finance.post_journal_entry()    refuses a line whose debit or credit has more decimals than the book
--                                       currency (the org's base_currency) uses: AMOUNT_SCALE, SQLSTATE 22023, with
--                                       the line, currency and minor units as JSON detail. numeric(20,4) would round
--                                       a fifth decimal silently and keep 100.5 VND as given; neither may reach the
--                                       ledger. Trailing zeros are fine ('100.0000' VND posts). An org whose
--                                       base_currency is not in the table is refused too (UNKNOWN_CURRENCY, 22023).
--
-- Rows posted before this rule are not checked again. This read-only query lists journal lines whose amounts use
-- more decimals than their org's book currency, and purchase documents whose amounts do so for VND (their amounts
-- are in VND, #918); it returned no rows on every database this migration was tested on (#1282):
--
--   SELECT 'journal_line' AS source, l.org_id, l.entry_id AS id, l.line_no, t.base_currency AS currency, l.debit, l.credit
--   FROM crove_finance.journal_line l
--   JOIN crove_kernel.tenant t ON t.org_id = l.org_id
--   LEFT JOIN crove_kernel.currency c ON c.code = t.base_currency
--   WHERE c.code IS NULL OR l.debit <> pg_catalog.round(l.debit, c.minor_units) OR l.credit <> pg_catalog.round(l.credit, c.minor_units)
--   UNION ALL
--   SELECT 'purchase_document', d.org_id, d.id, NULL, 'VND', d.subtotal, d.total
--   FROM crove_finance.purchase_document d
--   WHERE d.subtotal <> pg_catalog.round(d.subtotal, 0) OR d.vat_amount <> pg_catalog.round(d.vat_amount, 0)
--      OR d.total <> pg_catalog.round(d.total, 0);
SET LOCAL lock_timeout = '2s';

-- A runner that is not a superuser (hosted PostgreSQL) needs the definer role's privileges to replace the posting
-- function it owns (as in 20261016210000); granted first.
DO $$
BEGIN
  IF NOT (SELECT r.rolsuper FROM pg_catalog.pg_roles r WHERE r.rolname = current_user) THEN
    EXECUTE pg_catalog.format('GRANT crove_definer_tenant TO %I WITH INHERIT TRUE, SET TRUE', current_user);
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- The fx_rate domain, on purchase_document.exchange_rate
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_type t JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
                 WHERE n.nspname = 'crove_finance' AND t.typname = 'fx_rate') THEN
    CREATE DOMAIN crove_finance.fx_rate AS numeric(24, 10) CONSTRAINT fx_rate_positive CHECK (VALUE > 0);
  END IF;
END $$;
GRANT USAGE ON TYPE crove_finance.fx_rate TO crove_tenant;

-- Same base type and size, so no rewrite: PostgreSQL only checks the existing rows against the domain (the table's
-- own CHECK already holds them to > 0).
DO $$
BEGIN
  IF (SELECT a.atttypid FROM pg_catalog.pg_attribute a
      WHERE a.attrelid = 'crove_finance.purchase_document'::pg_catalog.regclass AND a.attname = 'exchange_rate' AND NOT a.attisdropped)
     IS DISTINCT FROM 'crove_finance.fx_rate'::pg_catalog.regtype THEN
    ALTER TABLE crove_finance.purchase_document ALTER COLUMN exchange_rate TYPE crove_finance.fx_rate;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- The posting path: amounts within the book currency's minor units
-- ---------------------------------------------------------------------------
-- Same body as 20261016210000 plus the scale check before the insert. Org and author still come from the context,
-- never from parameters; the book currency is the org's base_currency, read through the tenant's row-level security.
CREATE OR REPLACE FUNCTION crove_finance.post_journal_entry(
  p_entry_date date,
  p_description text,
  p_source_type text,
  p_source_id uuid,
  p_lines jsonb,
  p_reverses_entry_id uuid
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
  v_entry uuid;
  v_currency text;
  v_minor int;
  v_bad record;
BEGIN
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'NO_CONTEXT' USING ERRCODE = '42501';
  END IF;
  IF pg_catalog.jsonb_typeof(p_lines) IS DISTINCT FROM 'array' OR pg_catalog.jsonb_array_length(p_lines) < 2 THEN
    RAISE EXCEPTION 'a journal entry needs at least 2 lines' USING ERRCODE = '23514';
  END IF;
  SELECT t.base_currency, c.minor_units INTO v_currency, v_minor
  FROM crove_kernel.tenant t
  LEFT JOIN crove_kernel.currency c ON c.code = t.base_currency
  WHERE t.org_id = v_org;
  IF v_minor IS NULL THEN
    RAISE EXCEPTION 'UNKNOWN_CURRENCY' USING ERRCODE = '22023',
      DETAIL = pg_catalog.json_build_object('currency', v_currency)::text;
  END IF;
  -- Compared after rounding, so trailing zeros pass and any further decimal, however small, is refused before the
  -- amount domain could round it away.
  SELECT l.line_no, l.debit, l.credit INTO v_bad
  FROM pg_catalog.jsonb_to_recordset(p_lines) AS l (line_no int, debit numeric, credit numeric)
  WHERE l.debit <> pg_catalog.round(l.debit, v_minor) OR l.credit <> pg_catalog.round(l.credit, v_minor)
  ORDER BY l.line_no
  LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'AMOUNT_SCALE' USING ERRCODE = '22023',
      DETAIL = pg_catalog.json_build_object(
        'lineNo', v_bad.line_no, 'currency', v_currency, 'minorUnits', v_minor,
        'amount', CASE WHEN v_bad.debit <> pg_catalog.round(v_bad.debit, v_minor) THEN v_bad.debit ELSE v_bad.credit END::text)::text;
  END IF;
  INSERT INTO crove_finance.journal_entry (org_id, entry_date, description, source_type, source_id, created_by, reverses_entry_id)
  VALUES (v_org, p_entry_date, p_description, p_source_type, p_source_id, crove_kernel.ctx_user_id(), p_reverses_entry_id)
  RETURNING id INTO v_entry;
  INSERT INTO crove_finance.journal_line (org_id, entry_id, line_no, account_code, debit, credit, party_id, memo)
  SELECT v_org, v_entry, l.line_no, l.account_code, coalesce(l.debit, 0), coalesce(l.credit, 0), l.party_id, l.memo
  FROM pg_catalog.jsonb_to_recordset(p_lines) AS l (line_no int, account_code text, debit numeric, credit numeric, party_id uuid, memo text);
  PERFORM crove_finance.assert_entry_balanced(v_org, v_entry);
  RETURN v_entry;
END $$;

-- CREATE OR REPLACE keeps the owner (crove_definer_tenant) and the grants; restated so the file stands on its own.
REVOKE ALL ON FUNCTION crove_finance.post_journal_entry(date, text, text, uuid, jsonb, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crove_finance.post_journal_entry(date, text, text, uuid, jsonb, uuid) TO crove_tenant;
