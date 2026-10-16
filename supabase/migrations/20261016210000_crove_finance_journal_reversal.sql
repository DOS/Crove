-- Crove finance (issue #138): reversing a posted journal entry. A reversal is a NEW entry, posted through
-- crove_finance.post_journal_entry() like any other, whose lines mirror the original's (same line number, account,
-- party and memo, debit and credit swapped) and which names the original in reverses_entry_id. It never adds lines
-- to an existing entry: the balance error reports the difference over every line of an entry, which is safe only
-- because a line can join an entry only in the transaction that created it (20261015230000).
-- Rules, enforced here for every writer: an entry is reversed at most once; a reversal is not itself reversible (to
-- restore the original effect, post a new entry, so the books show one correction per mistake); a reversal is not
-- dated before the entry it reverses; and its lines mirror the original's exactly, counted over every line of both
-- entries whatever the caller can see. Idempotent; grants are restated at the end.
SET LOCAL lock_timeout = '2s';

-- A runner that is not a superuser (hosted PostgreSQL) needs the definer role's privileges to replace or revoke on
-- the posting functions it owns (as in 20261014090100); granted first, before anything below touches them.
DO $$
BEGIN
  IF NOT (SELECT r.rolsuper FROM pg_catalog.pg_roles r WHERE r.rolname = current_user) THEN
    EXECUTE pg_catalog.format('GRANT crove_definer_tenant TO %I WITH INHERIT TRUE, SET TRUE', current_user);
  END IF;
END $$;

ALTER TABLE crove_finance.journal_entry ADD COLUMN IF NOT EXISTS reverses_entry_id uuid;

-- The original, in the same org. ON DELETE NO ACTION: deleting an original that has a reversal fails loudly instead of
-- taking the reversal with it (entries are append-only anyway). NO ACTION rather than RESTRICT is checked at the end
-- of the statement, so one statement that removes both, such as purging a whole org, still works.
DO $$
BEGIN
  ALTER TABLE crove_finance.journal_entry
    ADD CONSTRAINT journal_entry_reverses_fk FOREIGN KEY (org_id, reverses_entry_id)
    REFERENCES crove_finance.journal_entry (org_id, id) ON DELETE NO ACTION;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE crove_finance.journal_entry
    ADD CONSTRAINT journal_entry_reverses_other CHECK (reverses_entry_id IS DISTINCT FROM id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- At most one reversal per entry. Two reversals of the same entry at once: the second insert waits on this index
-- for the first transaction and fails with a unique violation when it commits.
CREATE UNIQUE INDEX IF NOT EXISTS journal_entry_reverses_uq
  ON crove_finance.journal_entry (org_id, reverses_entry_id) WHERE reverses_entry_id IS NOT NULL;

-- The mirror check: a no-op unless (p_org_id, p_entry_id) is a reversal. Owned by the migration runner, like
-- require_entry_balanced(), so it reads every line of both entries past the caller's RLS; callable by nobody but
-- its owner (the commit trigger and assert_entry_balanced() below). Its errors carry no amounts and no line data.
-- It runs once per entry: from the deferred trigger on journal_entry, which fires at commit and so sees every line,
-- however late in the transaction it was inserted (lines can only join an entry in the transaction that created it),
-- and from assert_entry_balanced() inside the posting function.
CREATE OR REPLACE FUNCTION crove_finance.require_entry_mirrors(p_org_id uuid, p_entry_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_reversed uuid;
  v_date date;
  v_reversed_date date;
  v_reversed_is_reversal boolean;
BEGIN
  SELECT e.reverses_entry_id, e.entry_date INTO v_reversed, v_date
  FROM crove_finance.journal_entry e
  WHERE e.org_id = p_org_id AND e.id = p_entry_id;
  IF v_reversed IS NULL THEN
    RETURN;
  END IF;
  SELECT o.entry_date, o.reverses_entry_id IS NOT NULL INTO v_reversed_date, v_reversed_is_reversal
  FROM crove_finance.journal_entry o
  WHERE o.org_id = p_org_id AND o.id = v_reversed;
  -- The original exists: the foreign key is checked when the reversal row is inserted. (Were it missing, the checks
  -- below would still refuse: no lines to mirror.)
  IF v_reversed_is_reversal THEN
    RAISE EXCEPTION 'journal entry % is a reversal and cannot be reversed; post a new entry instead', v_reversed
      USING ERRCODE = '23514';
  END IF;
  IF v_date < v_reversed_date THEN
    RAISE EXCEPTION 'reversal % is dated before the entry it reverses', p_entry_id USING ERRCODE = '23514';
  END IF;
  -- Same multiset of lines both ways: every original line has exactly one mirror line, and nothing else is there.
  IF EXISTS (
    (SELECT o.line_no, o.account_code, o.party_id, o.memo, o.credit AS debit, o.debit AS credit
     FROM crove_finance.journal_line o WHERE o.org_id = p_org_id AND o.entry_id = v_reversed
     EXCEPT ALL
     SELECT r.line_no, r.account_code, r.party_id, r.memo, r.debit, r.credit
     FROM crove_finance.journal_line r WHERE r.org_id = p_org_id AND r.entry_id = p_entry_id)
    UNION ALL
    (SELECT r.line_no, r.account_code, r.party_id, r.memo, r.debit, r.credit
     FROM crove_finance.journal_line r WHERE r.org_id = p_org_id AND r.entry_id = p_entry_id
     EXCEPT ALL
     SELECT o.line_no, o.account_code, o.party_id, o.memo, o.credit AS debit, o.debit AS credit
     FROM crove_finance.journal_line o WHERE o.org_id = p_org_id AND o.entry_id = v_reversed)
  ) THEN
    RAISE EXCEPTION 'journal entry % does not mirror the entry it reverses', p_entry_id USING ERRCODE = '23514';
  END IF;
END $$;

-- The deferred check at commit (constraint triggers on journal_entry and journal_line), now also the mirror check, so
-- a reversal written by any role, superusers included, is held to the same rules as one posted by the function.
-- The full mirror check runs once per entry, from the entry's trigger. Each line's trigger adds only an indexed
-- lookup: a line of a reversal must mirror the original's line with the same line_no. Together they also hold when
-- a writer fires the entry's check early (SET CONSTRAINTS ... IMMEDIATE) and adds lines afterwards: once the full
-- check has passed, every line_no of the original is taken, so any further line repeats a line_no (primary key) or
-- has no original line to mirror; and a line added to an original whose reversal exists re-checks that reversal.
CREATE OR REPLACE FUNCTION crove_finance.check_entry_balanced() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_reversed uuid;
  v_reversal uuid;
BEGIN
  IF TG_TABLE_NAME = 'journal_entry' THEN
    PERFORM crove_finance.require_entry_balanced(NEW.org_id, NEW.id);
    PERFORM crove_finance.require_entry_mirrors(NEW.org_id, NEW.id);
    RETURN NULL;
  END IF;
  PERFORM crove_finance.require_entry_balanced(coalesce(NEW.org_id, OLD.org_id), coalesce(NEW.entry_id, OLD.entry_id));
  IF TG_OP = 'DELETE' THEN
    RETURN NULL;
  END IF;
  SELECT e.reverses_entry_id INTO v_reversed
  FROM crove_finance.journal_entry e
  WHERE e.org_id = NEW.org_id AND e.id = NEW.entry_id;
  IF v_reversed IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM crove_finance.journal_line o
    WHERE o.org_id = NEW.org_id AND o.entry_id = v_reversed AND o.line_no = NEW.line_no
      AND o.account_code = NEW.account_code AND o.party_id IS NOT DISTINCT FROM NEW.party_id
      AND o.memo IS NOT DISTINCT FROM NEW.memo AND o.debit = NEW.credit AND o.credit = NEW.debit
  ) THEN
    RAISE EXCEPTION 'journal entry % does not mirror the entry it reverses', NEW.entry_id USING ERRCODE = '23514';
  END IF;
  -- A line of an original whose reversal exists already (both created in this transaction): check that reversal
  -- again over every line. Rare, and only possible within the transaction that created the original.
  SELECT r.id INTO v_reversal
  FROM crove_finance.journal_entry r
  WHERE r.org_id = NEW.org_id AND r.reverses_entry_id = NEW.entry_id;
  IF v_reversal IS NOT NULL THEN
    PERFORM crove_finance.require_entry_mirrors(NEW.org_id, v_reversal);
  END IF;
  RETURN NULL;
END $$;

-- The early check inside the posting function (callable only by crove_definer_tenant, for the org in the sealed
-- context), now also the mirror check.
CREATE OR REPLACE FUNCTION crove_finance.assert_entry_balanced(p_org_id uuid, p_entry_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
BEGIN
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'NO_CONTEXT' USING ERRCODE = '42501';
  END IF;
  IF p_org_id IS DISTINCT FROM v_org THEN
    RAISE EXCEPTION 'ENTRY_ORG_NOT_IN_CONTEXT' USING ERRCODE = '42501';
  END IF;
  PERFORM crove_finance.require_entry_balanced(p_org_id, p_entry_id);
  PERFORM crove_finance.require_entry_mirrors(p_org_id, p_entry_id);
END $$;

-- The posting path, with the entry it reverses (NULL for an ordinary entry). Same body as before; org and author
-- still come from the context, never from parameters.
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
BEGIN
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'NO_CONTEXT' USING ERRCODE = '42501';
  END IF;
  IF pg_catalog.jsonb_typeof(p_lines) IS DISTINCT FROM 'array' OR pg_catalog.jsonb_array_length(p_lines) < 2 THEN
    RAISE EXCEPTION 'a journal entry needs at least 2 lines' USING ERRCODE = '23514';
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

-- The original signature, kept for every existing caller: an ordinary entry, through the one body above.
CREATE OR REPLACE FUNCTION crove_finance.post_journal_entry(
  p_entry_date date,
  p_description text,
  p_source_type text,
  p_source_id uuid,
  p_lines jsonb
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  RETURN crove_finance.post_journal_entry(p_entry_date, p_description, p_source_type, p_source_id, p_lines, NULL::uuid);
END $$;

-- Grants, restated, before the new posting function moves to its owner (they carry over).
REVOKE ALL ON FUNCTION
  crove_finance.require_entry_mirrors(uuid, uuid),
  crove_finance.check_entry_balanced(),
  crove_finance.assert_entry_balanced(uuid, uuid)
FROM PUBLIC, crove_tenant, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_finance.assert_entry_balanced(uuid, uuid) TO crove_definer_tenant;
REVOKE ALL ON FUNCTION
  crove_finance.post_journal_entry(date, text, text, uuid, jsonb),
  crove_finance.post_journal_entry(date, text, text, uuid, jsonb, uuid)
FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  crove_finance.post_journal_entry(date, text, text, uuid, jsonb),
  crove_finance.post_journal_entry(date, text, text, uuid, jsonb, uuid)
TO crove_tenant;

-- The new posting function is owned by the NOLOGIN definer role, like the original, so tenant RLS applies inside it.
-- The definer needs CREATE on the schema while the ownership moves; it is revoked right after.
GRANT CREATE ON SCHEMA crove_finance TO crove_definer_tenant;
ALTER FUNCTION crove_finance.post_journal_entry(date, text, text, uuid, jsonb, uuid) OWNER TO crove_definer_tenant;
REVOKE CREATE ON SCHEMA crove_finance FROM crove_definer_tenant;

-- Drift guard (as in 20261015230000): each check must run as a role that row security does not filter on
-- journal_line, or it would count only the lines the caller can see.
DO $$
DECLARE
  v_fn text;
BEGIN
  SELECT pg_catalog.string_agg(p.oid::pg_catalog.regprocedure::text, ', ') INTO v_fn
  FROM pg_catalog.pg_proc p
  JOIN pg_catalog.pg_roles r ON r.oid = p.proowner
  CROSS JOIN pg_catalog.pg_class c
  WHERE c.oid = 'crove_finance.journal_line'::pg_catalog.regclass
    AND p.oid IN ('crove_finance.require_entry_mirrors(uuid, uuid)'::pg_catalog.regprocedure,
                  'crove_finance.require_entry_balanced(uuid, uuid)'::pg_catalog.regprocedure,
                  'crove_finance.check_entry_balanced()'::pg_catalog.regprocedure,
                  'crove_finance.assert_entry_balanced(uuid, uuid)'::pg_catalog.regprocedure)
    AND NOT (r.rolsuper OR r.rolbypassrls OR (c.relowner = p.proowner AND NOT c.relforcerowsecurity));
  IF v_fn IS NOT NULL THEN
    RAISE EXCEPTION 'ledger checks % must be owned by the owner of crove_finance.journal_line (row security not forced), a superuser or a BYPASSRLS role', v_fn;
  END IF;
END $$;
