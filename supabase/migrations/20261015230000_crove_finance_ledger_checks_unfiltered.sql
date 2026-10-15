-- Crove finance (issue #76): the balance and line-count checks of a journal entry read every line of that entry,
-- whatever the caller can see, and a line can only join an entry created in the same transaction of the same
-- cluster. Idempotent; grants are restated at the end.
--
-- Until now assert_entry_balanced() read journal_line through RLS as the caller. Once restrictive legal-entity
-- policies (plan §4.6) filter journal_line, lines hidden from the caller would drop out of the sums, and an entry
-- that balances only over the visible lines would pass. The checks now run as the function owner, the migration
-- runner, which owns journal_line and so is not subject to its row security (it is not FORCEd; a guard below
-- refuses the migration otherwise). They stay scoped to one entry of one org, and no runtime role can call them
-- with arguments of its choosing.
SET LOCAL lock_timeout = '2s';

-- created_xact_id (xid8) is unique only inside one cluster. A logical dump restored into another cluster keeps the
-- old values, and the new cluster's counter later reaches each of them once, so that transaction would look like
-- the one that created the entry. The transaction start time, stamped next to it by the same trigger, tells the
-- two apart: a later transaction in any cluster starts later. Entries posted before this migration keep NULL here
-- and stay closed.
ALTER TABLE crove_finance.journal_entry ADD COLUMN IF NOT EXISTS created_xact_start timestamptz;

CREATE OR REPLACE FUNCTION crove_finance.stamp_entry_xact() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  NEW.created_xact_id := pg_catalog.pg_current_xact_id();
  NEW.created_xact_start := pg_catalog.now();
  RETURN NEW;
END $$;

-- A line may only be added in the transaction that created its entry: same xid8 and same transaction start.
-- Applies to every role, superusers included. Reads the entry as the caller: an entry the caller cannot see has
-- no stamp here, so the line is refused (fail closed).
CREATE OR REPLACE FUNCTION crove_finance.reject_line_on_posted_entry() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_xact xid8;
  v_start timestamptz;
BEGIN
  SELECT e.created_xact_id, e.created_xact_start INTO v_xact, v_start
  FROM crove_finance.journal_entry e
  WHERE e.org_id = NEW.org_id AND e.id = NEW.entry_id;
  IF v_xact IS DISTINCT FROM pg_catalog.pg_current_xact_id() OR v_start IS DISTINCT FROM pg_catalog.now() THEN
    RAISE EXCEPTION 'journal entry % is already posted; lines can only be added in the transaction that creates it', NEW.entry_id
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;

-- The check itself: raises unless the entry has at least 2 lines and debits equal credits, counting every line of
-- (p_org_id, p_entry_id) and nothing else. SECURITY DEFINER so it reads as its owner, never through the caller's
-- RLS. Callable only by its owner: the two functions below call it, nobody else may.
-- The error reports the difference, which sums lines the caller may not be able to see. That is safe only because
-- reject_line_on_posted_entry() accepts lines only in the transaction that created the entry, so every summed line
-- was supplied by this caller in this transaction. Any future feature that appends lines to an open or existing
-- entry must first drop the amount (and the line count) from these errors.
CREATE OR REPLACE FUNCTION crove_finance.require_entry_balanced(p_org_id uuid, p_entry_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
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

-- The deferred check at commit (constraint triggers on journal_entry and journal_line). A trigger function cannot
-- be called directly, and its arguments are the rows just written, which RLS already bound to the caller's org.
CREATE OR REPLACE FUNCTION crove_finance.check_entry_balanced() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_TABLE_NAME = 'journal_entry' THEN
    PERFORM crove_finance.require_entry_balanced(NEW.org_id, NEW.id);
  ELSE
    PERFORM crove_finance.require_entry_balanced(coalesce(NEW.org_id, OLD.org_id), coalesce(NEW.entry_id, OLD.entry_id));
  END IF;
  RETURN NULL;
END $$;

-- The early check inside post_journal_entry() (owned by crove_definer_tenant, the only role allowed to call this).
-- The org must be the one in the sealed request context, so even that role cannot probe another org's entries.
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
END $$;

-- Drift guard: each check must run as a role that row security does not filter on journal_line (a superuser, a
-- BYPASSRLS role, or the table owner while row security is not forced). Otherwise the fix above is void.
DO $$
DECLARE
  v_fn text;
BEGIN
  SELECT pg_catalog.string_agg(p.oid::pg_catalog.regprocedure::text, ', ') INTO v_fn
  FROM pg_catalog.pg_proc p
  JOIN pg_catalog.pg_roles r ON r.oid = p.proowner
  CROSS JOIN pg_catalog.pg_class c
  WHERE c.oid = 'crove_finance.journal_line'::pg_catalog.regclass
    AND p.oid IN ('crove_finance.require_entry_balanced(uuid, uuid)'::pg_catalog.regprocedure,
                  'crove_finance.check_entry_balanced()'::pg_catalog.regprocedure,
                  'crove_finance.assert_entry_balanced(uuid, uuid)'::pg_catalog.regprocedure)
    AND NOT (r.rolsuper OR r.rolbypassrls OR (c.relowner = p.proowner AND NOT c.relforcerowsecurity));
  IF v_fn IS NOT NULL THEN
    RAISE EXCEPTION 'ledger checks % must be owned by the owner of crove_finance.journal_line (row security not forced), a superuser or a BYPASSRLS role', v_fn;
  END IF;
END $$;

-- Grants, restated. Tenant roles lose EXECUTE on assert_entry_balanced() (granted to crove_tenant in
-- 20261014090100): it now reads past RLS, so only the posting definer may call it, for its own context.
REVOKE ALL ON FUNCTION
  crove_finance.stamp_entry_xact(),
  crove_finance.reject_line_on_posted_entry(),
  crove_finance.require_entry_balanced(uuid, uuid),
  crove_finance.check_entry_balanced(),
  crove_finance.assert_entry_balanced(uuid, uuid)
FROM PUBLIC, crove_tenant, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_finance.assert_entry_balanced(uuid, uuid) TO crove_definer_tenant;
