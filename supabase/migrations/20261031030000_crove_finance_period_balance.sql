-- Balances per account and month, written only by the posting definer and reconciled nightly (issue #1284, plan §13
-- Phase 2a exit criteria, ADR-0021 section 3). Idempotent; applied files stay untouched.
--
-- crove_finance.period_balance   one row per (org, account, month): the debit and credit totals and the line count of
--                                every journal line whose entry is dated in that month. Kept as gross totals, not a net
--                                amount, so a reversal adds its own (swapped) lines to its own month, exactly as the
--                                ledger has them. Tenant roles read their org's rows; only crove_definer_tenant, the
--                                owner of post_journal_entry(), inserts and updates them, and no runtime role deletes
--                                one. Keyed per org, not per legal entity: journal lines carry no legal_entity_id yet
--                                (ADR-0021 section 7); the key gains it when they do.
--
-- crove_finance.post_journal_entry(date, text, text, uuid, jsonb, uuid, int)
--   Same body as 20261031000000, plus one statement after the entry has balanced: the request's lines, summed per
--   account, are added to the entry month's rows (INSERT ... ON CONFLICT DO UPDATE), in account order so two postings
--   never take the same rows in opposite orders. A replay returns before it and adds nothing; a refusal rolls back
--   with it. This takes one row lock per distinct account of the entry, held until the posting transaction ends;
--   the measurement and the decision against ADR-0021's lock cap are in docs/adr/0021-finance-kernel-support.md.
--
-- crove_finance.period_balance_differences(int)
--   For the nightly reconciler (crove_worker only): every (org, account, month) whose totals or line count differ
--   between period_balance and the journal lines, with which of them differ, at most p_limit rows. Owned by the
--   migration runner, which owns journal_line and period_balance and is not filtered by their row security, so it
--   compares every line whatever a tenant role could see (as require_entry_balanced does, #76). It returns no amounts.
--
-- The existing lines are summed into the table by the next migration (20261031030100), in its own transaction, once
-- this body is the one every new posting runs.
SET LOCAL lock_timeout = '2s';

-- A runner that is not a superuser (hosted PostgreSQL) needs the definer role's privileges to replace the posting
-- function it owns (as in 20261031000000); granted first.
DO $$
BEGIN
  IF NOT (SELECT r.rolsuper FROM pg_catalog.pg_roles r WHERE r.rolname = current_user) THEN
    EXECUTE pg_catalog.format('GRANT crove_definer_tenant TO %I WITH INHERIT TRUE, SET TRUE', current_user);
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- The table
-- ---------------------------------------------------------------------------
-- migration-lint: cross-module the balance rows belong to an org: a foreign key to the kernel's tenant row, as every tenant table has.
CREATE TABLE IF NOT EXISTS crove_finance.period_balance (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  account_code text NOT NULL,
  period_month date NOT NULL,
  debit crove_finance.amount NOT NULL DEFAULT 0 CHECK (debit >= 0),
  credit crove_finance.amount NOT NULL DEFAULT 0 CHECK (credit >= 0),
  line_count bigint NOT NULL DEFAULT 0 CHECK (line_count >= 0),
  PRIMARY KEY (org_id, id),
  CONSTRAINT period_balance_account_month_uq UNIQUE (org_id, account_code, period_month),
  CONSTRAINT period_balance_month_start CHECK (EXTRACT(DAY FROM period_month) = 1)
);

SELECT crove_kernel.apply_tenant_rls('crove_finance.period_balance');
-- Tenant roles read; only the posting definer writes. Nothing deletes a row but the cascade from its tenant row,
-- which the kept ledger rows already refuse.
REVOKE INSERT, UPDATE, DELETE ON crove_finance.period_balance FROM crove_tenant;
GRANT SELECT, INSERT, UPDATE ON crove_finance.period_balance TO crove_definer_tenant;

-- ---------------------------------------------------------------------------
-- The posting path, keeping the balances
-- ---------------------------------------------------------------------------
-- Same as 20261031000000 up to the balance check; the balance statement follows it.
CREATE OR REPLACE FUNCTION crove_finance.post_journal_entry(
  p_entry_date date,
  p_description text,
  p_source_type text,
  p_source_id uuid,
  p_lines jsonb,
  p_reverses_entry_id uuid,
  p_source_revision int
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
  v_entry uuid;
  v_currency text;
  v_minor int;
  v_bad record;
  v_hash bytea;
  v_same record;
  v_latest record;
BEGIN
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'NO_CONTEXT' USING ERRCODE = '42501';
  END IF;
  IF pg_catalog.jsonb_typeof(p_lines) IS DISTINCT FROM 'array' OR pg_catalog.jsonb_array_length(p_lines) < 2 THEN
    RAISE EXCEPTION 'a journal entry needs at least 2 lines' USING ERRCODE = '23514';
  END IF;
  IF p_source_type IS NULL OR p_source_id IS NULL THEN
    RAISE EXCEPTION 'a journal entry needs a source' USING ERRCODE = '23502';
  END IF;
  IF p_source_revision IS NULL OR p_source_revision < 1 THEN
    RAISE EXCEPTION 'SOURCE_REVISION_INVALID' USING ERRCODE = '22023',
      DETAIL = pg_catalog.json_build_object('revision', p_source_revision)::text;
  END IF;
  IF p_reverses_entry_id IS NOT NULL AND p_source_revision <> 1 THEN
    RAISE EXCEPTION 'REVERSAL_REVISION' USING ERRCODE = '23514',
      DETAIL = pg_catalog.json_build_object(
        'sourceType', p_source_type, 'sourceId', p_source_id, 'revision', p_source_revision, 'entryId', p_reverses_entry_id)::text;
  END IF;
  SELECT t.base_currency, c.minor_units INTO v_currency, v_minor
  FROM crove_kernel.tenant t
  LEFT JOIN crove_kernel.currency c ON c.code = t.base_currency
  WHERE t.org_id = v_org;
  IF v_minor IS NULL THEN
    RAISE EXCEPTION 'UNKNOWN_CURRENCY' USING ERRCODE = '22023',
      DETAIL = pg_catalog.json_build_object('currency', v_currency)::text;
  END IF;
  -- NaN and infinity (a jsonb string such as "NaN" reads as numeric NaN) are no amount; NaN would also pass the
  -- comparison below, since PostgreSQL holds NaN equal to itself.
  SELECT l.line_no, l.account_code, l.debit, l.credit INTO v_bad
  FROM pg_catalog.jsonb_to_recordset(p_lines) AS l (line_no int, account_code text, debit numeric, credit numeric)
  WHERE l.debit IN ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric)
     OR l.credit IN ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric)
  ORDER BY l.line_no
  LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'AMOUNT_INVALID' USING ERRCODE = '22023',
      DETAIL = pg_catalog.json_build_object('lineNo', v_bad.line_no, 'account', v_bad.account_code)::text;
  END IF;
  -- Compared after rounding, so trailing zeros pass and any further decimal, however small, is refused before the
  -- amount domain could round it away.
  SELECT l.line_no, l.account_code, l.debit, l.credit INTO v_bad
  FROM pg_catalog.jsonb_to_recordset(p_lines) AS l (line_no int, account_code text, debit numeric, credit numeric)
  WHERE l.debit <> pg_catalog.round(l.debit, v_minor) OR l.credit <> pg_catalog.round(l.credit, v_minor)
  ORDER BY l.line_no
  LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'AMOUNT_SCALE' USING ERRCODE = '22023',
      DETAIL = pg_catalog.json_build_object(
        'lineNo', v_bad.line_no, 'account', v_bad.account_code, 'currency', v_currency, 'minorUnits', v_minor,
        'amount', CASE WHEN v_bad.debit <> pg_catalog.round(v_bad.debit, v_minor) THEN v_bad.debit ELSE v_bad.credit END::text)::text;
  END IF;

  -- One source at a time, until this transaction ends. Each statement below takes a new snapshot (READ COMMITTED), so
  -- after the wait it sees what the previous holder committed.
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'crove_finance.journal_entry.source:' || v_org::text || ':' || p_source_type || ':' || p_source_id::text, 0));
  v_hash := crove_finance.journal_payload_sha256(p_entry_date, v_currency, p_reverses_entry_id, p_lines);

  SELECT e.id, e.entry_date, e.reverses_entry_id, e.payload_sha256 INTO v_same
  FROM crove_finance.journal_entry e
  WHERE e.org_id = v_org AND e.source_type = p_source_type AND e.source_id = p_source_id AND e.source_revision = p_source_revision;
  IF FOUND THEN
    IF coalesce(v_same.payload_sha256, crove_finance.journal_payload_sha256(v_same.entry_date, v_currency, v_same.reverses_entry_id, (
         SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                  'line_no', l.line_no, 'account_code', l.account_code, 'debit', l.debit, 'credit', l.credit, 'party_id', l.party_id))
         FROM crove_finance.journal_line l WHERE l.org_id = v_org AND l.entry_id = v_same.id))) = v_hash THEN
      RETURN v_same.id;
    END IF;
    RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT' USING ERRCODE = '23505', CONSTRAINT = 'journal_entry_source_revision_key',
      DETAIL = pg_catalog.json_build_object(
        'sourceType', p_source_type, 'sourceId', p_source_id, 'revision', p_source_revision, 'entryId', v_same.id)::text;
  END IF;

  SELECT e.id, e.source_revision INTO v_latest
  FROM crove_finance.journal_entry e
  WHERE e.org_id = v_org AND e.source_type = p_source_type AND e.source_id = p_source_id
  ORDER BY e.source_revision DESC
  LIMIT 1;
  IF p_source_revision <> coalesce(v_latest.source_revision, 0) + 1 THEN
    RAISE EXCEPTION 'REVISION_OUT_OF_ORDER' USING ERRCODE = '23514',
      DETAIL = pg_catalog.json_build_object(
        'sourceType', p_source_type, 'sourceId', p_source_id, 'expected', coalesce(v_latest.source_revision, 0) + 1,
        'revision', p_source_revision)::text;
  END IF;
  IF v_latest.id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM crove_finance.journal_entry r WHERE r.org_id = v_org AND r.reverses_entry_id = v_latest.id) THEN
    RAISE EXCEPTION 'SOURCE_STILL_POSTED' USING ERRCODE = '23514',
      DETAIL = pg_catalog.json_build_object(
        'sourceType', p_source_type, 'sourceId', p_source_id, 'revision', v_latest.source_revision, 'entryId', v_latest.id)::text;
  END IF;

  INSERT INTO crove_finance.journal_entry (org_id, entry_date, description, source_type, source_id, created_by, reverses_entry_id,
                                           source_revision, payload_sha256)
  VALUES (v_org, p_entry_date, p_description, p_source_type, p_source_id, crove_kernel.ctx_user_id(), p_reverses_entry_id,
          p_source_revision, v_hash)
  RETURNING id INTO v_entry;
  INSERT INTO crove_finance.journal_line (org_id, entry_id, line_no, account_code, debit, credit, party_id, memo)
  SELECT v_org, v_entry, l.line_no, l.account_code, coalesce(l.debit, 0), coalesce(l.credit, 0), l.party_id, l.memo
  FROM pg_catalog.jsonb_to_recordset(p_lines) AS l (line_no int, account_code text, debit numeric, credit numeric, party_id uuid, memo text);
  PERFORM crove_finance.assert_entry_balanced(v_org, v_entry);

  -- The balances, last, so their row locks are held for as short a time as the posting allows. Summed from the
  -- request, which is exactly what the insert above stored (the lines are not read back: a line hidden from this role
  -- by a policy would otherwise be missed). Account order, so concurrent postings lock shared rows in one order and
  -- cannot deadlock on them.
  INSERT INTO crove_finance.period_balance AS b (org_id, account_code, period_month, debit, credit, line_count)
  SELECT v_org, l.account_code, pg_catalog.date_trunc('month', p_entry_date)::date,
         pg_catalog.sum(coalesce(l.debit, 0)), pg_catalog.sum(coalesce(l.credit, 0)), pg_catalog.count(*)
  FROM pg_catalog.jsonb_to_recordset(p_lines) AS l (account_code text, debit numeric, credit numeric)
  GROUP BY l.account_code
  ORDER BY l.account_code COLLATE "C"
  ON CONFLICT (org_id, account_code, period_month) DO UPDATE
    SET debit = b.debit + EXCLUDED.debit, credit = b.credit + EXCLUDED.credit, line_count = b.line_count + EXCLUDED.line_count;
  RETURN v_entry;
END $$;
REVOKE ALL ON FUNCTION crove_finance.post_journal_entry(date, text, text, uuid, jsonb, uuid, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crove_finance.post_journal_entry(date, text, text, uuid, jsonb, uuid, int) TO crove_tenant;

-- CREATE OR REPLACE keeps the owner (crove_definer_tenant, 20261031000000); restated so a fresh database ends the same.
GRANT CREATE ON SCHEMA crove_finance TO crove_definer_tenant;
ALTER FUNCTION crove_finance.post_journal_entry(date, text, text, uuid, jsonb, uuid, int) OWNER TO crove_definer_tenant;
REVOKE CREATE ON SCHEMA crove_finance FROM crove_definer_tenant;

-- ---------------------------------------------------------------------------
-- The reconciler's comparison
-- ---------------------------------------------------------------------------
-- One statement, so the ledger and the balances are read from one snapshot: a posting is in both or in neither.
-- mismatch lists what differs: 'debit', 'credit', 'lines', or 'missing' (lines with no balance row) and 'extra' (a
-- balance row with no lines). Ordered by org, account and month; at most p_limit rows (1 to 1000).
CREATE OR REPLACE FUNCTION crove_finance.period_balance_differences(p_limit int)
RETURNS TABLE (org_id uuid, account_code text, period_month date, mismatch text[])
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NOT pg_catalog.pg_has_role(SESSION_USER, 'crove_worker', 'MEMBER') THEN
    RAISE EXCEPTION 'WORKER_ONLY' USING ERRCODE = '42501';
  END IF;
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 1000 THEN
    RAISE EXCEPTION 'LIMIT_INVALID' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
  WITH ledger AS (
    SELECT l.org_id, l.account_code, pg_catalog.date_trunc('month', e.entry_date)::date AS period_month,
           pg_catalog.sum(l.debit) AS debit, pg_catalog.sum(l.credit) AS credit, pg_catalog.count(*) AS line_count
    FROM crove_finance.journal_line l
    JOIN crove_finance.journal_entry e ON e.org_id = l.org_id AND e.id = l.entry_id
    GROUP BY 1, 2, 3
  ), compared AS (
    SELECT coalesce(g.org_id, b.org_id) AS org_id, coalesce(g.account_code, b.account_code) AS account_code,
           coalesce(g.period_month, b.period_month) AS period_month,
           ARRAY(SELECT m FROM (VALUES
             (CASE WHEN b.org_id IS NULL THEN 'missing' END),
             (CASE WHEN g.org_id IS NULL THEN 'extra' END),
             (CASE WHEN g.org_id IS NOT NULL AND b.org_id IS NOT NULL AND g.debit <> b.debit THEN 'debit' END),
             (CASE WHEN g.org_id IS NOT NULL AND b.org_id IS NOT NULL AND g.credit <> b.credit THEN 'credit' END),
             (CASE WHEN g.org_id IS NOT NULL AND b.org_id IS NOT NULL AND g.line_count <> b.line_count THEN 'lines' END)
           ) AS v (m) WHERE m IS NOT NULL) AS mismatch
    FROM ledger g
    FULL JOIN crove_finance.period_balance b
      ON b.org_id = g.org_id AND b.account_code = g.account_code AND b.period_month = g.period_month
  )
  SELECT c.org_id, c.account_code, c.period_month, c.mismatch
  FROM compared c
  WHERE pg_catalog.cardinality(c.mismatch) > 0
  ORDER BY c.org_id, c.account_code COLLATE "C", c.period_month
  LIMIT p_limit;
END $$;
REVOKE ALL ON FUNCTION crove_finance.period_balance_differences(int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crove_finance.period_balance_differences(int) TO crove_worker;
