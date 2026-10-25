-- Balances per account and month as append-only deltas, written only by the posting definer and reconciled nightly
-- (issue #1284, plan §13 Phase 2a exit criteria, ADR-0021 section 3). Idempotent; applied files stay untouched.
--
-- crove_finance.period_balance_delta   what one journal entry adds to one account in its month: the debit and credit
--                                      totals and the line count of the entry's lines on that account. One row per
--                                      (org, entry, account), appended in the transaction that posts the entry, never
--                                      updated or deleted (append-only triggers). A month's balance of an account is
--                                      the sum of its rows; a reversal appends its own (swapped) lines in its own
--                                      month, as the ledger has them. Tenant roles read their org's rows; only
--                                      crove_definer_tenant, the owner of post_journal_entry(), inserts them. Keyed per
--                                      org, not per legal entity: journal lines carry no legal_entity_id yet (#1280,
--                                      ADR-0021 section 7); a legal entity column joins when they do.
--
-- Why deltas and not one row per account and month updated in place (decided on #1284): an updated row is locked by
-- every posting that touches the account until that posting commits, so all postings of an org on a shared account
-- (331, 1111, 1331) would queue behind each other, across document types and series. ADR-0021 allows a posting one
-- counter row lock (its voucher series). Measured with 50 concurrent postings and 5 ms of work after the posting in
-- the same transaction: 142 tps with a row updated in place, 3,315 with appended deltas (the ADR's measurement
-- section has the table).
--
-- crove_finance.post_journal_entry(date, text, text, uuid, jsonb, uuid, int)
--   Same body as 20261031000000, plus one statement after the entry has balanced: the request's lines, summed per
--   account, are appended as the entry's deltas. A replay returns before it and appends nothing; a refusal rolls back
--   with it; the unique key (org, entry, account) refuses a second delta for the same entry and account.
--
-- crove_finance.period_balance_differences(int)
--   For the nightly reconciler (crove_worker only): every (org, entry, account, month) where the deltas and the journal
--   lines disagree, with what differs, at most p_limit rows. Compared per entry, so an entry and its delta that agree
--   per month but sit in different entries still show. Owned by the migration runner, which owns both tables and is
--   not filtered by their row security, so it compares every line whatever a tenant role could see (as
--   require_entry_balanced does, #76). It returns references only, no amounts.
--
-- The entries posted before this migration get their deltas from the next one (20261101020100), in its own
-- transaction, once this body is the one every new posting runs.
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
-- Totals are plain numeric: the sum of an entry's lines on one account is not limited to one line's amount domain, so
-- a large entry is never refused for its delta. Every value is still a sum of amount values (4 decimals at most).
CREATE TABLE IF NOT EXISTS crove_finance.period_balance_delta (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  entry_id uuid NOT NULL,
  account_code text NOT NULL,
  period_month date NOT NULL,
  debit numeric NOT NULL CHECK (debit >= 0),
  credit numeric NOT NULL CHECK (credit >= 0),
  line_count int NOT NULL CHECK (line_count > 0),
  PRIMARY KEY (org_id, id),
  -- One delta per entry and account. No foreign key to journal_entry: the definer appends only for the entry it has
  -- just inserted, and the nightly comparison reports a delta without lines as 'extra'. A key would also change which
  -- rule refuses the deletion of a reversed entry (journal_entry_reverses_fk, ledger-reversal invariant).
  CONSTRAINT period_balance_delta_entry_account_uq UNIQUE (org_id, entry_id, account_code),
  CONSTRAINT period_balance_delta_month_start CHECK (EXTRACT(DAY FROM period_month) = 1)
);

SELECT crove_kernel.apply_tenant_rls('crove_finance.period_balance_delta', true);
SELECT crove_kernel.make_append_only('crove_finance.period_balance_delta');
-- Tenant roles read; only the posting definer inserts (as for journal_entry and journal_line, 20261014090100).
REVOKE INSERT ON crove_finance.period_balance_delta FROM crove_tenant;
GRANT INSERT ON crove_finance.period_balance_delta TO crove_definer_tenant;

-- The worker's queue for the nightly reconciliation (QUEUES.periodBalanceVerify in apps/kernel/src/jobs-schema.ts);
-- create_queue skips a queue that exists.
SELECT crove_jobs.create_queue('finance-period-balance-verify', '{"policy":"standard"}'::jsonb);

-- ---------------------------------------------------------------------------
-- The posting path, appending the deltas
-- ---------------------------------------------------------------------------
-- Same as 20261031000000 up to the balance check; the delta statement follows it.
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

  -- The entry's deltas, summed from the request, which is exactly what the insert above stored (the lines are not read
  -- back: a line hidden from this role by a policy would otherwise be missed). Appended rows lock nothing another
  -- posting needs.
  INSERT INTO crove_finance.period_balance_delta (org_id, entry_id, account_code, period_month, debit, credit, line_count)
  SELECT v_org, v_entry, l.account_code, pg_catalog.date_trunc('month', p_entry_date)::date,
         pg_catalog.sum(coalesce(l.debit, 0)), pg_catalog.sum(coalesce(l.credit, 0)), pg_catalog.count(*)
  FROM pg_catalog.jsonb_to_recordset(p_lines) AS l (account_code text, debit numeric, credit numeric)
  GROUP BY l.account_code;
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
-- One statement, so the ledger and the deltas are read from one snapshot: a posting is in both or in neither.
-- mismatch lists what differs: 'debit', 'credit', 'lines', or 'missing' (lines with no delta) and 'extra' (a delta
-- with no lines; also a delta whose month is not its entry's, which shows as one of each). Ordered by org, account,
-- month and entry; at most p_limit rows (1 to 1000).
CREATE OR REPLACE FUNCTION crove_finance.period_balance_differences(p_limit int)
RETURNS TABLE (org_id uuid, account_code text, period_month date, entry_id uuid, mismatch text[])
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
    SELECT l.org_id, l.entry_id, l.account_code, pg_catalog.date_trunc('month', e.entry_date)::date AS period_month,
           pg_catalog.sum(l.debit) AS debit, pg_catalog.sum(l.credit) AS credit, pg_catalog.count(*) AS line_count
    FROM crove_finance.journal_line l
    JOIN crove_finance.journal_entry e ON e.org_id = l.org_id AND e.id = l.entry_id
    GROUP BY 1, 2, 3, 4
  ), compared AS (
    SELECT coalesce(g.org_id, d.org_id) AS org_id, coalesce(g.account_code, d.account_code) AS account_code,
           coalesce(g.period_month, d.period_month) AS period_month, coalesce(g.entry_id, d.entry_id) AS entry_id,
           ARRAY(SELECT v.m FROM (VALUES
             (CASE WHEN d.org_id IS NULL THEN 'missing' END),
             (CASE WHEN g.org_id IS NULL THEN 'extra' END),
             (CASE WHEN g.org_id IS NOT NULL AND d.org_id IS NOT NULL AND g.debit <> d.debit THEN 'debit' END),
             (CASE WHEN g.org_id IS NOT NULL AND d.org_id IS NOT NULL AND g.credit <> d.credit THEN 'credit' END),
             (CASE WHEN g.org_id IS NOT NULL AND d.org_id IS NOT NULL AND g.line_count <> d.line_count THEN 'lines' END)
           ) AS v (m) WHERE v.m IS NOT NULL) AS mismatch
    FROM ledger g
    FULL JOIN crove_finance.period_balance_delta d
      ON d.org_id = g.org_id AND d.entry_id = g.entry_id AND d.account_code = g.account_code AND d.period_month = g.period_month
  )
  SELECT c.org_id, c.account_code, c.period_month, c.entry_id, c.mismatch
  FROM compared c
  WHERE pg_catalog.cardinality(c.mismatch) > 0
  ORDER BY c.org_id, c.account_code COLLATE "C", c.period_month, c.entry_id
  LIMIT p_limit;
END $$;
REVOKE ALL ON FUNCTION crove_finance.period_balance_differences(int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crove_finance.period_balance_differences(int) TO crove_worker;
