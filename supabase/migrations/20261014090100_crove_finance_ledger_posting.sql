-- Crove finance: the ledger is written only through crove_finance.post_journal_entry(), a posted entry
-- never gains lines, and every entry has at least 2 lines and balances at commit. Idempotent.
-- Functions pin pg_catalog first and pg_temp last: with an empty search_path PostgreSQL still resolves
-- type names in the caller's temporary schema first.
SET LOCAL lock_timeout = '2s';

-- The transaction that created the entry, stamped by a trigger (never by the caller). Entries posted
-- before this migration keep NULL, so they can never gain lines either.
ALTER TABLE crove_finance.journal_entry ADD COLUMN IF NOT EXISTS created_xact_id xid8;

CREATE OR REPLACE FUNCTION crove_finance.stamp_entry_xact() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  NEW.created_xact_id := pg_catalog.pg_current_xact_id();
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS journal_entry_stamp_xact ON crove_finance.journal_entry;
CREATE TRIGGER journal_entry_stamp_xact
  BEFORE INSERT ON crove_finance.journal_entry
  FOR EACH ROW EXECUTE FUNCTION crove_finance.stamp_entry_xact();

-- A line may only be added in the transaction that created its entry. Applies to every role,
-- superusers included; pg_current_xact_id() is the top-level transaction, so savepoints do not matter.
CREATE OR REPLACE FUNCTION crove_finance.reject_line_on_posted_entry() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_xact xid8;
BEGIN
  SELECT e.created_xact_id INTO v_xact
  FROM crove_finance.journal_entry e
  WHERE e.org_id = NEW.org_id AND e.id = NEW.entry_id;
  IF v_xact IS DISTINCT FROM pg_catalog.pg_current_xact_id() THEN
    RAISE EXCEPTION 'journal entry % is already posted; lines can only be added in the transaction that creates it', NEW.entry_id
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS journal_line_entry_open ON crove_finance.journal_line;
CREATE TRIGGER journal_line_entry_open
  BEFORE INSERT ON crove_finance.journal_line
  FOR EACH ROW EXECUTE FUNCTION crove_finance.reject_line_on_posted_entry();

-- Raises unless the entry has at least 2 lines and debits equal credits. Reads through RLS, so lines the
-- caller cannot see count as missing and the check fails closed.
CREATE OR REPLACE FUNCTION crove_finance.assert_entry_balanced(p_org_id uuid, p_entry_id uuid) RETURNS void
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_diff numeric;
  v_lines int;
BEGIN
  SELECT coalesce(sum(l.debit), 0) - coalesce(sum(l.credit), 0), count(*) INTO v_diff, v_lines
  FROM crove_finance.journal_line l
  WHERE l.org_id = p_org_id AND l.entry_id = p_entry_id;
  IF v_lines < 2 THEN
    RAISE EXCEPTION 'journal entry % needs at least 2 lines (has %)', p_entry_id, v_lines USING ERRCODE = '23514';
  END IF;
  IF v_diff <> 0 THEN
    RAISE EXCEPTION 'journal entry % does not balance (difference %)', p_entry_id, v_diff USING ERRCODE = '23514';
  END IF;
END $$;

-- Deferred check at commit, from both sides: a line insert checks its entry, and an entry insert checks
-- itself, so an entry with no lines at all fails too. Replaces the line-only version, which skipped
-- entries without lines.
CREATE OR REPLACE FUNCTION crove_finance.check_entry_balanced() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_TABLE_NAME = 'journal_entry' THEN
    PERFORM crove_finance.assert_entry_balanced(NEW.org_id, NEW.id);
  ELSE
    PERFORM crove_finance.assert_entry_balanced(coalesce(NEW.org_id, OLD.org_id), coalesce(NEW.entry_id, OLD.entry_id));
  END IF;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS journal_entry_balanced ON crove_finance.journal_entry;
CREATE CONSTRAINT TRIGGER journal_entry_balanced
  AFTER INSERT ON crove_finance.journal_entry
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION crove_finance.check_entry_balanced();

-- The posting path: creates one entry with all its lines in a single call. Org and author come from the
-- context, never from parameters. p_lines is a JSON array of
-- {line_no, account_code, debit, credit, party_id, memo} with amounts as decimal strings.
CREATE OR REPLACE FUNCTION crove_finance.post_journal_entry(
  p_entry_date date,
  p_description text,
  p_source_type text,
  p_source_id uuid,
  p_lines jsonb
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
  INSERT INTO crove_finance.journal_entry (org_id, entry_date, description, source_type, source_id, created_by)
  VALUES (v_org, p_entry_date, p_description, p_source_type, p_source_id, crove_kernel.ctx_user_id())
  RETURNING id INTO v_entry;
  INSERT INTO crove_finance.journal_line (org_id, entry_id, line_no, account_code, debit, credit, party_id, memo)
  SELECT v_org, v_entry, l.line_no, l.account_code, coalesce(l.debit, 0), coalesce(l.credit, 0), l.party_id, l.memo
  FROM pg_catalog.jsonb_to_recordset(p_lines) AS l (line_no int, account_code text, debit numeric, credit numeric, party_id uuid, memo text);
  PERFORM crove_finance.assert_entry_balanced(v_org, v_entry);
  RETURN v_entry;
END $$;

REVOKE ALL ON FUNCTION
  crove_finance.stamp_entry_xact(),
  crove_finance.reject_line_on_posted_entry(),
  crove_finance.assert_entry_balanced(uuid, uuid),
  crove_finance.check_entry_balanced(),
  crove_finance.post_journal_entry(date, text, text, uuid, jsonb)
FROM PUBLIC;
-- Triggers call assert_entry_balanced() as the committing role, so tenant roles need EXECUTE on it.
GRANT EXECUTE ON FUNCTION
  crove_finance.assert_entry_balanced(uuid, uuid),
  crove_finance.post_journal_entry(date, text, text, uuid, jsonb)
TO crove_tenant;

-- Owned by the NOLOGIN definer role, so tenant RLS still applies inside it. The grants above are set
-- first and carry over to the new owner. A runner that is not a superuser (hosted PostgreSQL) may only
-- hand a function to a role it can SET ROLE to, and needs that role's privileges to replace the function
-- or revoke on it later; the new owner needs CREATE on the schema while the ownership moves, and that
-- CREATE is revoked right after.
DO $$
BEGIN
  IF NOT (SELECT r.rolsuper FROM pg_catalog.pg_roles r WHERE r.rolname = current_user) THEN
    EXECUTE pg_catalog.format('GRANT crove_definer_tenant TO %I WITH INHERIT TRUE, SET TRUE', current_user);
  END IF;
END $$;
GRANT CREATE ON SCHEMA crove_finance TO crove_definer_tenant;
ALTER FUNCTION crove_finance.post_journal_entry(date, text, text, uuid, jsonb) OWNER TO crove_definer_tenant;
REVOKE CREATE ON SCHEMA crove_finance FROM crove_definer_tenant;

-- Tenant roles keep SELECT but lose direct INSERT; only the definer writes the ledger.
REVOKE INSERT ON crove_finance.journal_entry, crove_finance.journal_line FROM crove_tenant;
GRANT INSERT ON crove_finance.journal_entry, crove_finance.journal_line TO crove_definer_tenant;
