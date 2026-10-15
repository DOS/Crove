-- ADR-0021 spike (Phase 0b, issue #58): reference prototype only, NOT a migration.
-- Self-contained on a throwaway postgres:17 database: no kernel schema, no RLS, no roles.
-- It exercises the decisions in docs/adr/0021-finance-kernel-support.md:
--   money domains, gapless numbering, period close, hash chain, source_revision, bank line keys.
-- Run it through run.sh, which starts and removes the container.

DROP SCHEMA IF EXISTS spike CASCADE;
CREATE SCHEMA spike;
SET search_path = spike, pg_catalog;

-- ---------------------------------------------------------------------------
-- Money domains
-- ---------------------------------------------------------------------------
CREATE DOMAIN spike.amount AS numeric(20, 4);
CREATE DOMAIN spike.unit_amount AS numeric(24, 8);
CREATE DOMAIN spike.quantity AS numeric(20, 6);
CREATE DOMAIN spike.fx_rate AS numeric(24, 10) CHECK (VALUE > 0);

-- Minor units per currency (ISO 4217 exponent). The posting path refuses amounts with more decimals
-- than the currency has, instead of letting numeric(20,4) round them silently.
CREATE TABLE spike.currency (code text PRIMARY KEY, minor_units int NOT NULL CHECK (minor_units BETWEEN 0 AND 4));
INSERT INTO spike.currency VALUES ('VND', 0), ('USD', 2), ('JPY', 0), ('KWD', 3);

-- ---------------------------------------------------------------------------
-- Gapless numbering: one counter row per (org, legal entity, doc type, period key)
-- ---------------------------------------------------------------------------
CREATE TABLE spike.number_series (
  org_id uuid NOT NULL,
  legal_entity_id uuid NOT NULL,
  doc_type text NOT NULL,
  period_key text NOT NULL,           -- '2026' (yearly reset), '2026-10' (monthly) or '-' (never)
  next_number bigint NOT NULL,
  PRIMARY KEY (org_id, legal_entity_id, doc_type, period_key)
);

CREATE TABLE spike.number_allocation (
  org_id uuid NOT NULL,
  legal_entity_id uuid NOT NULL,
  doc_type text NOT NULL,
  period_key text NOT NULL,
  number bigint NOT NULL CHECK (number > 0),
  document_id uuid NOT NULL,
  allocated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (org_id, legal_entity_id, doc_type, period_key, number)
);

-- A voided number keeps its allocation row; the void is a second, append-only fact.
CREATE TABLE spike.number_void (
  org_id uuid NOT NULL,
  legal_entity_id uuid NOT NULL,
  doc_type text NOT NULL,
  period_key text NOT NULL,
  number bigint NOT NULL,
  reason text NOT NULL CHECK (length(reason) > 0),
  voided_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (org_id, legal_entity_id, doc_type, period_key, number),
  FOREIGN KEY (org_id, legal_entity_id, doc_type, period_key, number)
    REFERENCES spike.number_allocation (org_id, legal_entity_id, doc_type, period_key, number)
);

-- Allocates the next number inside the caller's transaction. The counter row stays locked until the
-- transaction ends, so a rollback returns the number and a commit keeps it: no gaps, no duplicates.
CREATE FUNCTION spike.allocate_number(p_org uuid, p_le uuid, p_doc_type text, p_period_key text, p_document_id uuid)
RETURNS bigint LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_number bigint;
BEGIN
  INSERT INTO spike.number_series AS s (org_id, legal_entity_id, doc_type, period_key, next_number)
  VALUES (p_org, p_le, p_doc_type, p_period_key, 2)
  ON CONFLICT (org_id, legal_entity_id, doc_type, period_key)
  DO UPDATE SET next_number = s.next_number + 1
  RETURNING s.next_number - 1 INTO v_number;
  INSERT INTO spike.number_allocation (org_id, legal_entity_id, doc_type, period_key, number, document_id)
  VALUES (p_org, p_le, p_doc_type, p_period_key, v_number, p_document_id);
  INSERT INTO spike.chain_pending (org_id, legal_entity_id, fact_kind, fact_key)
  VALUES (p_org, p_le, 'alloc', pg_catalog.concat_ws('|', p_doc_type, p_period_key, v_number));
  RETURN v_number;
END $$;

CREATE FUNCTION spike.void_number(p_org uuid, p_le uuid, p_doc_type text, p_period_key text, p_number bigint, p_reason text)
RETURNS void LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  INSERT INTO spike.number_void (org_id, legal_entity_id, doc_type, period_key, number, reason)
  VALUES (p_org, p_le, p_doc_type, p_period_key, p_number, p_reason);
  INSERT INTO spike.chain_pending (org_id, legal_entity_id, fact_kind, fact_key)
  VALUES (p_org, p_le, 'void', pg_catalog.concat_ws('|', p_doc_type, p_period_key, p_number));
END $$;

-- Baselines the ADR rejects, kept to measure why.
CREATE SEQUENCE spike.baseline_seq;
CREATE TABLE spike.baseline_seq_doc (n bigint PRIMARY KEY);
CREATE TABLE spike.baseline_max_doc (n bigint PRIMARY KEY);
CREATE TABLE spike.baseline_max_dup (at timestamptz NOT NULL DEFAULT clock_timestamp());

CREATE FUNCTION spike.baseline_max_plus_one() RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE
  v bigint;
BEGIN
  SELECT coalesce(max(n), 0) + 1 INTO v FROM spike.baseline_max_doc;
  PERFORM pg_sleep(0.001);          -- the rest of the command between read and insert
  INSERT INTO spike.baseline_max_doc VALUES (v);
  RETURN v;
EXCEPTION WHEN unique_violation THEN
  INSERT INTO spike.baseline_max_dup DEFAULT VALUES;
  RETURN NULL;
END $$;

-- ---------------------------------------------------------------------------
-- Periods: open | closed, closed in order, reopened newest first
-- ---------------------------------------------------------------------------
CREATE TABLE spike.accounting_period (
  org_id uuid NOT NULL,
  legal_entity_id uuid NOT NULL,
  period_start date NOT NULL,
  period_end date NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  PRIMARY KEY (org_id, legal_entity_id, period_start),
  CHECK (period_end >= period_start)
);

CREATE TABLE spike.period_event (
  org_id uuid NOT NULL,
  legal_entity_id uuid NOT NULL,
  period_start date NOT NULL,
  action text NOT NULL CHECK (action IN ('close', 'reopen')),
  reason text,
  at timestamptz NOT NULL DEFAULT clock_timestamp(),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  PRIMARY KEY (org_id, id)
);

CREATE FUNCTION spike.close_period(p_org uuid, p_le uuid, p_start date)
RETURNS void LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  -- Waits for every in-flight posting into the period, whichever guard it used.
  PERFORM pg_advisory_xact_lock(spike.period_lock_key(p_org, p_le, p_start));
  PERFORM 1 FROM spike.accounting_period p
  WHERE p.org_id = p_org AND p.legal_entity_id = p_le AND p.period_start = p_start AND p.status = 'open'
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'PERIOD_NOT_OPEN' USING ERRCODE = '55000'; END IF;
  IF EXISTS (SELECT 1 FROM spike.accounting_period p
             WHERE p.org_id = p_org AND p.legal_entity_id = p_le AND p.period_start < p_start AND p.status = 'open') THEN
    RAISE EXCEPTION 'EARLIER_PERIOD_OPEN' USING ERRCODE = '55000';
  END IF;
  UPDATE spike.accounting_period SET status = 'closed'
  WHERE org_id = p_org AND legal_entity_id = p_le AND period_start = p_start;
  INSERT INTO spike.period_event (org_id, legal_entity_id, period_start, action) VALUES (p_org, p_le, p_start, 'close');
  INSERT INTO spike.chain_pending (org_id, legal_entity_id, fact_kind, fact_key)
  VALUES (p_org, p_le, 'period', p_start::text || '|close|' || pg_catalog.clock_timestamp()::text);
END $$;

CREATE FUNCTION spike.reopen_period(p_org uuid, p_le uuid, p_start date, p_reason text)
RETURNS void LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF coalesce(length(p_reason), 0) = 0 THEN RAISE EXCEPTION 'REASON_REQUIRED' USING ERRCODE = '22023'; END IF;
  PERFORM pg_advisory_xact_lock(spike.period_lock_key(p_org, p_le, p_start));
  PERFORM 1 FROM spike.accounting_period p
  WHERE p.org_id = p_org AND p.legal_entity_id = p_le AND p.period_start = p_start AND p.status = 'closed'
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'PERIOD_NOT_CLOSED' USING ERRCODE = '55000'; END IF;
  IF EXISTS (SELECT 1 FROM spike.accounting_period p
             WHERE p.org_id = p_org AND p.legal_entity_id = p_le AND p.period_start > p_start AND p.status = 'closed') THEN
    RAISE EXCEPTION 'LATER_PERIOD_CLOSED' USING ERRCODE = '55000';
  END IF;
  UPDATE spike.accounting_period SET status = 'open'
  WHERE org_id = p_org AND legal_entity_id = p_le AND period_start = p_start;
  INSERT INTO spike.period_event (org_id, legal_entity_id, period_start, action, reason) VALUES (p_org, p_le, p_start, 'reopen', p_reason);
  INSERT INTO spike.chain_pending (org_id, legal_entity_id, fact_kind, fact_key)
  VALUES (p_org, p_le, 'period', p_start::text || '|reopen|' || pg_catalog.clock_timestamp()::text);
END $$;

-- ---------------------------------------------------------------------------
-- Ledger with source_revision and reversal
-- ---------------------------------------------------------------------------
CREATE TABLE spike.journal_entry (
  org_id uuid NOT NULL,
  id uuid NOT NULL,
  legal_entity_id uuid NOT NULL,
  entry_date date NOT NULL,
  currency text NOT NULL REFERENCES spike.currency (code),
  doc_type text NOT NULL,
  period_key text NOT NULL,
  number bigint NOT NULL,
  source_type text NOT NULL,
  source_id uuid NOT NULL,
  source_revision int NOT NULL CHECK (source_revision > 0),
  reverses_id uuid,
  payload_sha256 bytea NOT NULL,
  created_xact_id xid8 NOT NULL DEFAULT pg_current_xact_id(),
  PRIMARY KEY (org_id, id),
  UNIQUE (org_id, source_type, source_id, source_revision),
  UNIQUE (org_id, legal_entity_id, doc_type, period_key, number),
  UNIQUE (org_id, reverses_id),
  FOREIGN KEY (org_id, legal_entity_id, doc_type, period_key, number)
    REFERENCES spike.number_allocation (org_id, legal_entity_id, doc_type, period_key, number),
  FOREIGN KEY (org_id, reverses_id) REFERENCES spike.journal_entry (org_id, id)
);

CREATE TABLE spike.journal_line (
  org_id uuid NOT NULL,
  entry_id uuid NOT NULL,
  line_no int NOT NULL CHECK (line_no > 0),
  account_code text NOT NULL,
  debit spike.amount NOT NULL DEFAULT 0 CHECK (debit >= 0),
  credit spike.amount NOT NULL DEFAULT 0 CHECK (credit >= 0),
  PRIMARY KEY (org_id, entry_id, line_no),
  FOREIGN KEY (org_id, entry_id) REFERENCES spike.journal_entry (org_id, id),
  CHECK ((debit = 0) <> (credit = 0))
);

-- Period guard on the table, so it holds for every role and every path. spike.period_guard picks how a
-- posting excludes a concurrent close (the ADR compares them):
--   'share'    (default) FOR SHARE on the period row; close takes FOR UPDATE on it.
--   'advisory' a shared transaction advisory lock per period; close takes it exclusively. The status is
--              read after the lock is granted, in a new statement, so READ COMMITTED sees a committed close.
--   'none'     a plain read, to reproduce the race both locks prevent.
CREATE FUNCTION spike.period_lock_key(p_org uuid, p_le uuid, p_start date) RETURNS bigint
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT hashtextextended(concat_ws('|', 'period', p_org, p_le, p_start), 0)
$$;

CREATE FUNCTION spike.check_period_open() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_mode text := coalesce(nullif(current_setting('spike.period_guard', true), ''), 'share');
  v_start date;
BEGIN
  IF v_mode = 'share' THEN
    SELECT p.period_start INTO v_start FROM spike.accounting_period p
    WHERE p.org_id = NEW.org_id AND p.legal_entity_id = NEW.legal_entity_id
      AND NEW.entry_date BETWEEN p.period_start AND p.period_end AND p.status = 'open'
    FOR SHARE;
  ELSE
    IF v_mode = 'advisory' THEN
      -- Period boundaries never change, so finding the period before the lock is safe; its status is
      -- read again below, after the lock is granted.
      SELECT p.period_start INTO v_start FROM spike.accounting_period p
      WHERE p.org_id = NEW.org_id AND p.legal_entity_id = NEW.legal_entity_id
        AND NEW.entry_date BETWEEN p.period_start AND p.period_end;
      PERFORM pg_advisory_xact_lock_shared(spike.period_lock_key(NEW.org_id, NEW.legal_entity_id, v_start));
      v_start := NULL;
    END IF;
    SELECT p.period_start INTO v_start FROM spike.accounting_period p
    WHERE p.org_id = NEW.org_id AND p.legal_entity_id = NEW.legal_entity_id
      AND NEW.entry_date BETWEEN p.period_start AND p.period_end AND p.status = 'open';
  END IF;
  IF v_start IS NULL THEN
    RAISE EXCEPTION 'PERIOD_CLOSED: no open period for % on %', NEW.legal_entity_id, NEW.entry_date USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER journal_entry_period_open BEFORE INSERT ON spike.journal_entry
  FOR EACH ROW EXECUTE FUNCTION spike.check_period_open();

-- Canonical payload of a posting request: what an idempotent replay must match.
CREATE FUNCTION spike.payload_hash(p_le uuid, p_date date, p_currency text, p_doc_type text, p_lines jsonb, p_reverses uuid)
RETURNS bytea LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT sha256(convert_to(jsonb_build_object(
    'le', p_le, 'date', p_date, 'currency', p_currency, 'doc_type', p_doc_type, 'reverses', p_reverses,
    'lines', (SELECT jsonb_agg(jsonb_build_array(l.line_no, l.account_code,
                                                 coalesce(l.debit, 0)::numeric(20, 4)::text,
                                                 coalesce(l.credit, 0)::numeric(20, 4)::text) ORDER BY l.line_no)
              FROM jsonb_to_recordset(p_lines) AS l (line_no int, account_code text, debit numeric, credit numeric)))::text, 'UTF8'))
$$;

-- The posting path. Returns the entry id; a replay of the same (source, revision, payload) returns the
-- original id without allocating a number.
CREATE FUNCTION spike.post_entry(
  p_org uuid, p_le uuid, p_date date, p_currency text, p_doc_type text,
  p_source_type text, p_source_id uuid, p_source_revision int, p_lines jsonb,
  p_reverses uuid DEFAULT NULL, p_sync_chain boolean DEFAULT false
) RETURNS uuid LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_hash bytea := spike.payload_hash(p_le, p_date, p_currency, p_doc_type, p_lines, p_reverses);
  v_minor int;
  v_existing record;
  v_max_rev int;
  v_max_id uuid;
  v_id uuid := gen_random_uuid();
  v_period_key text := to_char(p_date, 'YYYY');
  v_number bigint;
  v_diff numeric;
BEGIN
  -- 1. Serialize calls for the same source, so replays and revisions never race.
  PERFORM pg_advisory_xact_lock(hashtextextended(concat_ws('|', p_org, p_source_type, p_source_id), 0));

  -- 2. Idempotent replay.
  SELECT e.id, e.payload_sha256 INTO v_existing FROM spike.journal_entry e
  WHERE e.org_id = p_org AND e.source_type = p_source_type AND e.source_id = p_source_id AND e.source_revision = p_source_revision;
  IF FOUND THEN
    IF v_existing.payload_sha256 = v_hash THEN RETURN v_existing.id; END IF;
    RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT: revision % of %/% was posted with a different payload',
      p_source_revision, p_source_type, p_source_id USING ERRCODE = '23505';
  END IF;

  -- 3. Revision rule: the next revision only, and only after the previous one was reversed.
  SELECT e.source_revision, e.id INTO v_max_rev, v_max_id FROM spike.journal_entry e
  WHERE e.org_id = p_org AND e.source_type = p_source_type AND e.source_id = p_source_id
  ORDER BY e.source_revision DESC LIMIT 1;
  IF p_source_revision <> coalesce(v_max_rev, 0) + 1 THEN
    RAISE EXCEPTION 'REVISION_OUT_OF_ORDER: expected %', coalesce(v_max_rev, 0) + 1 USING ERRCODE = '55000';
  END IF;
  IF v_max_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM spike.journal_entry r WHERE r.org_id = p_org AND r.reverses_id = v_max_id) THEN
    RAISE EXCEPTION 'SOURCE_STILL_POSTED: reverse revision % first', v_max_rev USING ERRCODE = '55000';
  END IF;

  -- 4. Amount scale must fit the currency (numeric(20,4) would round silently).
  SELECT c.minor_units INTO v_minor FROM spike.currency c WHERE c.code = p_currency;
  IF EXISTS (SELECT 1 FROM jsonb_to_recordset(p_lines) AS l (debit numeric, credit numeric)
             WHERE scale(trim_scale(coalesce(l.debit, 0))) > v_minor OR scale(trim_scale(coalesce(l.credit, 0))) > v_minor) THEN
    RAISE EXCEPTION 'AMOUNT_SCALE: % allows % decimals', p_currency, v_minor USING ERRCODE = '22023';
  END IF;

  -- 5. Number last, right before the insert, so the counter row is locked for as short a time as possible.
  v_number := spike.allocate_number(p_org, p_le, p_doc_type, v_period_key, v_id);
  INSERT INTO spike.journal_entry (org_id, id, legal_entity_id, entry_date, currency, doc_type, period_key, number,
                                   source_type, source_id, source_revision, reverses_id, payload_sha256)
  VALUES (p_org, v_id, p_le, p_date, p_currency, p_doc_type, v_period_key, v_number,
          p_source_type, p_source_id, p_source_revision, p_reverses, v_hash);
  INSERT INTO spike.journal_line (org_id, entry_id, line_no, account_code, debit, credit)
  SELECT p_org, v_id, l.line_no, l.account_code, coalesce(l.debit, 0), coalesce(l.credit, 0)
  FROM jsonb_to_recordset(p_lines) AS l (line_no int, account_code text, debit numeric, credit numeric);
  SELECT sum(debit) - sum(credit) INTO v_diff FROM spike.journal_line WHERE org_id = p_org AND entry_id = v_id;
  IF v_diff <> 0 THEN RAISE EXCEPTION 'UNBALANCED %', v_diff USING ERRCODE = '23514'; END IF;

  INSERT INTO spike.chain_pending (org_id, legal_entity_id, fact_kind, fact_key) VALUES (p_org, p_le, 'entry', v_id::text);
  IF p_sync_chain THEN PERFORM spike.chain_run(p_org, p_le, 1000000); END IF;
  RETURN v_id;
END $$;

-- Reversal: a new entry with debits and credits swapped, dated in an open period.
CREATE FUNCTION spike.reverse_entry(p_org uuid, p_entry_id uuid, p_date date)
RETURNS uuid LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  e record;
  v_lines jsonb;
BEGIN
  SELECT * INTO e FROM spike.journal_entry WHERE org_id = p_org AND id = p_entry_id;
  SELECT jsonb_agg(jsonb_build_object('line_no', l.line_no, 'account_code', l.account_code, 'debit', l.credit, 'credit', l.debit) ORDER BY l.line_no)
  INTO v_lines FROM spike.journal_line l WHERE l.org_id = p_org AND l.entry_id = p_entry_id;
  RETURN spike.post_entry(p_org, e.legal_entity_id, p_date, e.currency, 'NVK', 'reversal', p_entry_id, 1, v_lines, p_entry_id);
END $$;

-- ---------------------------------------------------------------------------
-- Hash chain per (org, legal entity), appended by a chainer from a pending queue
-- ---------------------------------------------------------------------------
CREATE TABLE spike.chain_pending (
  seq bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id uuid NOT NULL,
  legal_entity_id uuid NOT NULL,
  fact_kind text NOT NULL,
  fact_key text NOT NULL
);
CREATE INDEX ON spike.chain_pending (org_id, legal_entity_id, seq);

CREATE TABLE spike.chain_head (
  org_id uuid NOT NULL,
  legal_entity_id uuid NOT NULL,
  last_seq bigint NOT NULL,
  last_sha256 bytea NOT NULL,
  PRIMARY KEY (org_id, legal_entity_id)
);

CREATE TABLE spike.chain_link (
  org_id uuid NOT NULL,
  legal_entity_id uuid NOT NULL,
  chain_seq bigint NOT NULL,
  fact_kind text NOT NULL,
  fact_key text NOT NULL,
  fact_sha256 bytea NOT NULL,
  link_sha256 bytea NOT NULL,
  hash_version int NOT NULL DEFAULT 1,
  chained_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (org_id, legal_entity_id, chain_seq),
  UNIQUE (org_id, legal_entity_id, fact_kind, fact_key)
);

-- Canonical text of a fact (hash_version 1). Amounts render with the domain's fixed 4 decimals.
CREATE FUNCTION spike.fact_text(p_org uuid, p_le uuid, p_kind text, p_key text)
RETURNS text LANGUAGE plpgsql STABLE SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v jsonb;
  k text[] := string_to_array(p_key, '|');
BEGIN
  IF p_kind = 'entry' THEN
    SELECT jsonb_build_object('kind', 'entry', 'id', e.id, 'le', e.legal_entity_id, 'date', e.entry_date, 'currency', e.currency,
             'doc', jsonb_build_array(e.doc_type, e.period_key, e.number),
             'source', jsonb_build_array(e.source_type, e.source_id, e.source_revision), 'reverses', e.reverses_id,
             'lines', (SELECT jsonb_agg(jsonb_build_array(l.line_no, l.account_code, l.debit::text, l.credit::text) ORDER BY l.line_no)
                       FROM spike.journal_line l WHERE l.org_id = e.org_id AND l.entry_id = e.id))
    INTO v FROM spike.journal_entry e WHERE e.org_id = p_org AND e.id = p_key::uuid;
  ELSIF p_kind = 'alloc' THEN
    SELECT jsonb_build_object('kind', 'alloc', 'doc', jsonb_build_array(a.doc_type, a.period_key, a.number), 'document', a.document_id)
    INTO v FROM spike.number_allocation a
    WHERE a.org_id = p_org AND a.legal_entity_id = p_le AND a.doc_type = k[1] AND a.period_key = k[2] AND a.number = k[3]::bigint;
  ELSIF p_kind = 'void' THEN
    SELECT jsonb_build_object('kind', 'void', 'doc', jsonb_build_array(x.doc_type, x.period_key, x.number), 'reason', x.reason)
    INTO v FROM spike.number_void x
    WHERE x.org_id = p_org AND x.legal_entity_id = p_le AND x.doc_type = k[1] AND x.period_key = k[2] AND x.number = k[3]::bigint;
  ELSIF p_kind = 'period' THEN
    v := jsonb_build_object('kind', 'period', 'key', p_key);
  END IF;
  RETURN v::text;  -- NULL when the fact row is missing
END $$;

-- Chains up to p_limit pending facts of one legal entity, oldest queue entry first. One chainer per
-- legal entity at a time (row lock on chain_head). Only committed queue rows are visible, so a
-- transaction that commits late is simply chained in a later run: no watermark, no lost facts.
CREATE FUNCTION spike.chain_run(p_org uuid, p_le uuid, p_limit int)
RETURNS int LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  h record;
  p record;
  v_fact bytea;
  v_link bytea;
  n int := 0;
BEGIN
  INSERT INTO spike.chain_head VALUES (p_org, p_le, 0, sha256(''::bytea)) ON CONFLICT DO NOTHING;
  SELECT * INTO h FROM spike.chain_head WHERE org_id = p_org AND legal_entity_id = p_le FOR UPDATE;
  FOR p IN SELECT * FROM spike.chain_pending q WHERE q.org_id = p_org AND q.legal_entity_id = p_le ORDER BY q.seq LIMIT p_limit LOOP
    v_fact := sha256(convert_to(spike.fact_text(p_org, p_le, p.fact_kind, p.fact_key), 'UTF8'));
    v_link := sha256(h.last_sha256 || v_fact || int8send(h.last_seq + 1));
    INSERT INTO spike.chain_link (org_id, legal_entity_id, chain_seq, fact_kind, fact_key, fact_sha256, link_sha256)
    VALUES (p_org, p_le, h.last_seq + 1, p.fact_kind, p.fact_key, v_fact, v_link);
    h.last_seq := h.last_seq + 1;
    h.last_sha256 := v_link;
    DELETE FROM spike.chain_pending WHERE seq = p.seq;
    n := n + 1;
  END LOOP;
  UPDATE spike.chain_head SET last_seq = h.last_seq, last_sha256 = h.last_sha256 WHERE org_id = p_org AND legal_entity_id = p_le;
  RETURN n;
END $$;

-- Recomputes the chain from the facts as they are now. Reports the first broken link and every
-- entry, allocation or void that has no link.
CREATE FUNCTION spike.chain_verify(p_org uuid, p_le uuid)
RETURNS TABLE (problem text, chain_seq bigint, detail text) LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  l record;
  prev bytea := sha256(''::bytea);
  v_text text;
  v_fact bytea;
BEGIN
  FOR l IN SELECT * FROM spike.chain_link c WHERE c.org_id = p_org AND c.legal_entity_id = p_le ORDER BY c.chain_seq LOOP
    v_text := spike.fact_text(p_org, p_le, l.fact_kind, l.fact_key);
    v_fact := sha256(convert_to(coalesce(v_text, ''), 'UTF8'));
    IF v_text IS NULL THEN
      problem := 'fact_missing'; chain_seq := l.chain_seq; detail := l.fact_kind || ' ' || l.fact_key; RETURN NEXT;
    ELSIF v_fact <> l.fact_sha256 THEN
      problem := 'fact_changed'; chain_seq := l.chain_seq; detail := l.fact_kind || ' ' || l.fact_key; RETURN NEXT;
    END IF;
    IF sha256(prev || l.fact_sha256 || int8send(l.chain_seq)) <> l.link_sha256 THEN
      problem := 'link_broken'; chain_seq := l.chain_seq; detail := NULL; RETURN NEXT;
    END IF;
    prev := l.link_sha256;
  END LOOP;
  RETURN QUERY
    SELECT 'unchained_entry', NULL::bigint, e.id::text FROM spike.journal_entry e
    WHERE e.org_id = p_org AND e.legal_entity_id = p_le
      AND NOT EXISTS (SELECT 1 FROM spike.chain_link c WHERE c.org_id = p_org AND c.legal_entity_id = p_le AND c.fact_kind = 'entry' AND c.fact_key = e.id::text)
      AND NOT EXISTS (SELECT 1 FROM spike.chain_pending q WHERE q.org_id = p_org AND q.fact_kind = 'entry' AND q.fact_key = e.id::text);
END $$;

-- ---------------------------------------------------------------------------
-- Bank lines: provider reference when present, otherwise a positional key anchored on running balance
-- ---------------------------------------------------------------------------
CREATE TABLE spike.bank_line (
  org_id uuid NOT NULL,
  bank_account_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  import_id uuid NOT NULL,
  position int NOT NULL,             -- position in the statement file
  value_date date NOT NULL,
  amount spike.amount NOT NULL,      -- signed: credit to the account > 0
  running_balance spike.amount,      -- balance after the line, when the file has it
  bank_ref text,                     -- provider transaction id, when the file has it
  description text NOT NULL,
  dedupe_key text NOT NULL,
  PRIMARY KEY (org_id, id),
  UNIQUE (org_id, bank_account_id, dedupe_key)
);

CREATE TABLE spike.bank_import_exception (
  org_id uuid NOT NULL, bank_account_id uuid NOT NULL, import_id uuid NOT NULL, position int NOT NULL, reason text NOT NULL
);

-- Key: 'ref:' || bank_ref, else 'bal:' || value_date || amount || running_balance, else no key: the
-- line is ambiguous on re-import and becomes an Inbox exception instead of being dropped or doubled.
CREATE FUNCTION spike.import_bank_lines(p_org uuid, p_account uuid, p_lines jsonb)
RETURNS TABLE (inserted int, duplicates int, exceptions int) LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_import uuid := gen_random_uuid();
  r record;
  v_key text;
  v_ins int := 0;
  v_dup int := 0;
  v_exc int := 0;
BEGIN
  FOR r IN SELECT * FROM jsonb_to_recordset(p_lines) AS l (position int, value_date date, amount numeric, running_balance numeric, bank_ref text, description text) ORDER BY 1 LOOP
    IF r.bank_ref IS NOT NULL THEN
      v_key := 'ref:' || r.bank_ref;
    ELSIF r.running_balance IS NOT NULL THEN
      v_key := concat_ws('|', 'bal', r.value_date, r.amount::numeric(20, 4), r.running_balance::numeric(20, 4));
    ELSE
      -- No reference, no balance: identical lines cannot be told apart from an overlapping re-import.
      -- Within one file they are kept (each has its own position); against an earlier import they are ambiguous.
      IF EXISTS (SELECT 1 FROM spike.bank_line b WHERE b.org_id = p_org AND b.bank_account_id = p_account
                 AND b.import_id <> v_import AND b.value_date = r.value_date AND b.amount = r.amount) THEN
        INSERT INTO spike.bank_import_exception VALUES (p_org, p_account, v_import, r.position, 'ambiguous_without_balance');
        v_exc := v_exc + 1;
        CONTINUE;
      END IF;
      v_key := concat_ws('|', 'pos', v_import, r.position);
    END IF;
    INSERT INTO spike.bank_line (org_id, bank_account_id, import_id, position, value_date, amount, running_balance, bank_ref, description, dedupe_key)
    VALUES (p_org, p_account, v_import, r.position, r.value_date, r.amount, r.running_balance, r.bank_ref, r.description, v_key)
    ON CONFLICT (org_id, bank_account_id, dedupe_key) DO NOTHING;
    IF FOUND THEN v_ins := v_ins + 1; ELSE v_dup := v_dup + 1; END IF;
  END LOOP;
  inserted := v_ins; duplicates := v_dup; exceptions := v_exc;
  RETURN NEXT;
END $$;

-- ---------------------------------------------------------------------------
-- Fixtures: one org, two legal entities, monthly periods for 2026
-- ---------------------------------------------------------------------------
INSERT INTO spike.accounting_period (org_id, legal_entity_id, period_start, period_end)
SELECT '00000000-0000-0000-0000-00000000000a'::uuid, le, d::date, (d + interval '1 month' - interval '1 day')::date
FROM generate_series('2026-01-01'::date, '2026-12-01'::date, interval '1 month') AS d,
     (VALUES ('00000000-0000-0000-0000-0000000000e1'::uuid), ('00000000-0000-0000-0000-0000000000e2'::uuid)) AS les (le);
