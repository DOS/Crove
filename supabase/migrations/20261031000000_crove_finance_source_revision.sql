-- Source revisions and payload hashes on journal entries, for idempotent posting and re-posting (issue #1283, ADR-0021
-- decision 5, red-team S32). Idempotent; applied files stay untouched.
--
-- crove_finance.journal_entry
--   source_revision int NOT NULL DEFAULT 1   which revision of its source the entry posts; at least 1.
--   payload_sha256 bytea                      SHA-256 of the canonical posting request (32 bytes), set by the posting
--                                             path; NULL on entries posted before this migration.
--   UNIQUE (org_id, source_type, source_id) becomes UNIQUE (org_id, source_type, source_id, source_revision).
--
-- Existing entries become revision 1 through the column default and keep a NULL payload hash: nothing is updated (the
-- table is append-only) and no row changes. PostgreSQL 17 adds both columns without rewriting the table (a constant
-- default is stored in the catalog). It scans the table to validate the two CHECK constraints and to build the new
-- unique index (no CONCURRENTLY: the runner applies each file in one transaction), under the ACCESS EXCLUSIVE lock of
-- ALTER TABLE; lock_timeout bounds the wait for that lock. Every existing (org, source type, source id) is unique
-- today, so the new index, which adds a column, builds on any data the old one held.
--
-- crove_finance.post_journal_entry(date, text, text, uuid, jsonb, uuid, int)   the posting path, with the revision.
--   After the request's own checks (lines, currency, amount scale), it takes a transaction advisory lock on
--   (org, source type, source id), so calls for one source are serialized and calls for different sources are not (a
--   hash collision only costs a wait). Then:
--   - same source and revision, same payload: a replay; it returns the posted entry's id and writes nothing;
--   - same source and revision, another payload: IDEMPOTENCY_CONFLICT (SQLSTATE 23505);
--   - a new revision: only the previous one + 1 (the first is 1), REVISION_OUT_OF_ORDER (23514) otherwise, and only
--     once the previous revision has been reversed, SOURCE_STILL_POSTED (23514) otherwise;
--   - a reversal (p_reverses_entry_id set) is always revision 1 of its source, REVERSAL_REVISION (23514) otherwise.
--   Each refusal carries JSON detail; none reports an amount. Org and author still come from the context.
--   The older signatures (6 and 5 arguments) post revision 1 through it, so every existing caller keeps working.
--
-- The unique index stays the backstop: a writer that does not take the lock (only the definer may insert) or a
-- transaction whose snapshot predates the lock (REPEATABLE READ) still cannot post one source revision twice; it gets
-- the unique violation instead of a replay.
--
-- The payload is what ADR-0021 lists that the posting path has today: the entry date, the book currency (the org's
-- base_currency), the entry it reverses, and each line's number, account, party, debit and credit at 4 decimals. The
-- description and memos are not part of it: a replay that changes only wording returns the posted entry. Legal entity
-- and document type join the payload when the posting path takes them as parameters (ADR-0021 section 7). An entry
-- posted before this migration has no stored hash; a replay of it is compared with the hash of its stored lines.
SET LOCAL lock_timeout = '2s';

-- A runner that is not a superuser (hosted PostgreSQL) needs the definer role's privileges to replace the posting
-- functions it owns and to hand the new one over (as in 20261016210000); granted first.
DO $$
BEGIN
  IF NOT (SELECT r.rolsuper FROM pg_catalog.pg_roles r WHERE r.rolname = current_user) THEN
    EXECUTE pg_catalog.format('GRANT crove_definer_tenant TO %I WITH INHERIT TRUE, SET TRUE', current_user);
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- The columns and the revision-keyed unique constraint
-- ---------------------------------------------------------------------------
ALTER TABLE crove_finance.journal_entry ADD COLUMN IF NOT EXISTS source_revision int NOT NULL DEFAULT 1;
ALTER TABLE crove_finance.journal_entry ADD COLUMN IF NOT EXISTS payload_sha256 bytea;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint
                 WHERE conrelid = 'crove_finance.journal_entry'::pg_catalog.regclass AND conname = 'journal_entry_source_revision_positive') THEN
    ALTER TABLE crove_finance.journal_entry
      ADD CONSTRAINT journal_entry_source_revision_positive CHECK (source_revision >= 1);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint
                 WHERE conrelid = 'crove_finance.journal_entry'::pg_catalog.regclass AND conname = 'journal_entry_payload_sha256_length') THEN
    ALTER TABLE crove_finance.journal_entry
      ADD CONSTRAINT journal_entry_payload_sha256_length CHECK (payload_sha256 IS NULL OR pg_catalog.octet_length(payload_sha256) = 32);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint
                 WHERE conrelid = 'crove_finance.journal_entry'::pg_catalog.regclass AND conname = 'journal_entry_source_revision_key') THEN
    ALTER TABLE crove_finance.journal_entry
      ADD CONSTRAINT journal_entry_source_revision_key UNIQUE (org_id, source_type, source_id, source_revision);
  END IF;
END $$;

-- The old key, found by its columns rather than its generated name (journal_entry_org_id_source_type_source_id_key on
-- every database so far). No foreign key references it; the new key's index serves every lookup by source, since the
-- source is its prefix.
DO $$
DECLARE
  v_name name;
BEGIN
  FOR v_name IN
    SELECT c.conname FROM pg_catalog.pg_constraint c
    WHERE c.conrelid = 'crove_finance.journal_entry'::pg_catalog.regclass AND c.contype = 'u'
      AND c.conkey = ARRAY(SELECT a.attnum FROM pg_catalog.unnest(ARRAY['org_id', 'source_type', 'source_id']) WITH ORDINALITY AS k (col, ord)
                           JOIN pg_catalog.pg_attribute a ON a.attrelid = c.conrelid AND a.attname = k.col
                           ORDER BY k.ord)::int2[]
  LOOP
    EXECUTE pg_catalog.format('ALTER TABLE crove_finance.journal_entry DROP CONSTRAINT %I', v_name);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- The canonical payload hash
-- ---------------------------------------------------------------------------
-- One definition for both sides of the comparison: the request's lines as given, and a stored entry's lines read back
-- (for entries posted before this migration). Amounts at 4 decimals, so '100500' and '100500.0000' hash alike; lines
-- ordered by number. The date is written with an explicit ISO pattern, never the session's DateStyle, so a replay from
-- a session with another DateStyle hashes alike. STABLE, as to_char() is; callable only by the posting definer.
CREATE OR REPLACE FUNCTION crove_finance.journal_payload_sha256(
  p_entry_date date,
  p_currency text,
  p_reverses_entry_id uuid,
  p_lines jsonb
) RETURNS bytea
LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.jsonb_build_object(
    'v', 1,
    'entry_date', pg_catalog.to_char(p_entry_date::timestamp, 'YYYY-MM-DD'),
    'currency', p_currency,
    'reverses_entry_id', p_reverses_entry_id,
    'lines', coalesce((
      SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(
               l.line_no, l.account_code, l.party_id,
               pg_catalog.round(coalesce(l.debit, 0), 4)::text, pg_catalog.round(coalesce(l.credit, 0), 4)::text)
             ORDER BY l.line_no, l.account_code)
      FROM pg_catalog.jsonb_to_recordset(p_lines) AS l (line_no int, account_code text, debit numeric, credit numeric, party_id uuid)
    ), '[]'::jsonb))::text, 'UTF8'))
$$;
REVOKE ALL ON FUNCTION crove_finance.journal_payload_sha256(date, text, uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crove_finance.journal_payload_sha256(date, text, uuid, jsonb) TO crove_definer_tenant;

-- ---------------------------------------------------------------------------
-- The posting path, with the source revision
-- ---------------------------------------------------------------------------
-- Same checks as 20261030002100, then the source rules above, then the insert, which stamps the revision and the hash.
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
  RETURN v_entry;
END $$;
REVOKE ALL ON FUNCTION crove_finance.post_journal_entry(date, text, text, uuid, jsonb, uuid, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crove_finance.post_journal_entry(date, text, text, uuid, jsonb, uuid, int) TO crove_tenant;

-- The new posting function is owned by the NOLOGIN definer role, like the others, so tenant RLS applies inside it.
-- The definer needs CREATE on the schema while the ownership moves; it is revoked right after.
GRANT CREATE ON SCHEMA crove_finance TO crove_definer_tenant;
ALTER FUNCTION crove_finance.post_journal_entry(date, text, text, uuid, jsonb, uuid, int) OWNER TO crove_definer_tenant;
REVOKE CREATE ON SCHEMA crove_finance FROM crove_definer_tenant;

-- The 6-argument signature (an ordinary entry or a reversal) posts revision 1 through the body above; the 5-argument
-- one still calls it (20261016210000). Both stay definers owned by crove_definer_tenant, so every existing caller and
-- grant is unchanged.
CREATE OR REPLACE FUNCTION crove_finance.post_journal_entry(
  p_entry_date date,
  p_description text,
  p_source_type text,
  p_source_id uuid,
  p_lines jsonb,
  p_reverses_entry_id uuid
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  RETURN crove_finance.post_journal_entry(p_entry_date, p_description, p_source_type, p_source_id, p_lines, p_reverses_entry_id, 1);
END $$;
REVOKE ALL ON FUNCTION crove_finance.post_journal_entry(date, text, text, uuid, jsonb, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crove_finance.post_journal_entry(date, text, text, uuid, jsonb, uuid) TO crove_tenant;
