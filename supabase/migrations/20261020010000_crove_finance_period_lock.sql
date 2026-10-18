-- Crove finance (issue #329, ADR-0021 section 3): period lock. Filed months must not change silently. Idempotent;
-- applied files stay untouched.
--
-- An org locks its books one month at a time, in order: the first lock may name any month, each later lock the month
-- right after the last locked one, and only the last locked month can be unlocked. The locked months are therefore
-- always one range, kept as one row per org: locked_from (the first day of the first locked month) and locked_through
-- (the last day of the last one), both NULL when nothing is locked. Nothing posts with an entry date up to
-- locked_through, dates before locked_from included: an entry there would change the opening balances of the locked
-- months. Unlocking the first locked month clears the row, so every lock can be undone in reverse order.
--
-- The guard is a BEFORE INSERT trigger on journal_entry, so it holds for every role and every path (purchase and sale
-- postings, reversals, opening balances, the database owner), as ADR-0021 measured. It reads the org's row FOR SHARE
-- and the lock and unlock functions take it FOR UPDATE, so a lock waits for postings in flight, and a posting that
-- starts while a lock is in flight waits, then sees it (ADR-0021 cases A and B). An org that has no row yet gets one
-- (nothing locked) from whichever of the two comes first, so the first lock and a posting in flight meet on the same
-- row too: the second creator waits on the unique index until the first commits.
--
-- Tenant roles read the row (RLS) and never write it. crove_finance.lock_period() and crove_finance.unlock_period(),
-- run by the finance.period.lock and finance.period.unlock commands, are its only writers besides the guard; the org
-- and the actor come from the sealed context. Owners and admins lock; only owners unlock (R3 with fresh MFA, with a
-- reason on the audit row). The commands check the roles, and the two functions check them again, so neither a raw
-- call nor a system or agent context moves the lock (the agent write guard on the table refuses agents as well). The
-- audit rows of the two commands are the history of locks and unlocks (who, when, why).
SET LOCAL lock_timeout = '2s';

CREATE TABLE IF NOT EXISTS crove_finance.period_lock (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  locked_from date,
  locked_through date,
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (org_id, id),
  CONSTRAINT period_lock_org_uq UNIQUE (org_id),
  CONSTRAINT period_lock_months CHECK (
    (locked_from IS NULL AND locked_through IS NULL)
    OR (EXTRACT(DAY FROM locked_from) = 1 AND EXTRACT(DAY FROM locked_through + 1) = 1 AND locked_from <= locked_through)
  )
);

SELECT crove_kernel.apply_tenant_rls('crove_finance.period_lock');
REVOKE INSERT, UPDATE, DELETE ON crove_finance.period_lock FROM crove_tenant;

-- The guard. Owned by the table owner (SECURITY DEFINER), since the roles that insert entries cannot write the row it
-- creates; it reads and writes only the row of the entry's org.
CREATE OR REPLACE FUNCTION crove_finance.journal_entry_period_open() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_through date;
BEGIN
  SELECT p.locked_through INTO v_through FROM crove_finance.period_lock p WHERE p.org_id = NEW.org_id FOR SHARE;
  IF NOT FOUND THEN
    INSERT INTO crove_finance.period_lock (org_id) VALUES (NEW.org_id) ON CONFLICT (org_id) DO NOTHING;
    SELECT p.locked_through INTO v_through FROM crove_finance.period_lock p WHERE p.org_id = NEW.org_id FOR SHARE;
  END IF;
  IF v_through IS NOT NULL AND NEW.entry_date <= v_through THEN
    RAISE EXCEPTION 'PERIOD_LOCKED' USING ERRCODE = '55000',
      DETAIL = pg_catalog.json_build_object('lockedThrough', v_through, 'entryDate', NEW.entry_date)::text;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS journal_entry_period_open ON crove_finance.journal_entry;
CREATE TRIGGER journal_entry_period_open
  BEFORE INSERT ON crove_finance.journal_entry
  FOR EACH ROW EXECUTE FUNCTION crove_finance.journal_entry_period_open();

-- Raises PERIOD_LOCK_FORBIDDEN (42501) unless the context is a user who holds one of p_roles in the org in context. The
-- commands check the same roles first; this keeps a raw call, or a system or agent context, from moving the lock.
-- Called only from the two definers below, so it runs as their owner.
CREATE OR REPLACE FUNCTION crove_finance.assert_period_lock_role(p_roles text[]) RETURNS void
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF crove_kernel.ctx_actor_type() IS DISTINCT FROM 'user' OR NOT EXISTS (
    SELECT 1 FROM crove_kernel.tenant_member m
    WHERE m.org_id = crove_kernel.ctx_org_id() AND m.user_id = crove_kernel.ctx_user_id() AND m.role = ANY (p_roles)
  ) THEN
    RAISE EXCEPTION 'PERIOD_LOCK_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
END $$;

-- Locks the month starting p_month (its first day) for the org in context and returns the new locked_through. Raises
-- PERIOD_ALREADY_LOCKED when the month is already locked, EARLIER_PERIOD_OPEN when it is not the month right after
-- the last locked one and PERIOD_NOT_ENDED when it is not over yet in Vietnam time (so the entries of its last days
-- can still be posted), all with the current locked_through as JSON DETAIL.
CREATE OR REPLACE FUNCTION crove_finance.lock_period(p_month date) RETURNS date
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
  v_end date;
  v_from date;
  v_through date;
BEGIN
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'NO_CONTEXT' USING ERRCODE = '42501';
  END IF;
  PERFORM crove_finance.assert_period_lock_role(ARRAY['owner', 'admin']);
  IF p_month IS NULL OR EXTRACT(DAY FROM p_month) <> 1 THEN
    RAISE EXCEPTION 'PERIOD_INVALID' USING ERRCODE = '22023';
  END IF;
  v_end := (p_month + pg_catalog.make_interval(months => 1) - pg_catalog.make_interval(days => 1))::date;
  INSERT INTO crove_finance.period_lock (org_id) VALUES (v_org) ON CONFLICT (org_id) DO NOTHING;
  SELECT p.locked_from, p.locked_through INTO v_from, v_through FROM crove_finance.period_lock p WHERE p.org_id = v_org FOR UPDATE;
  IF v_through IS NOT NULL AND v_end <= v_through THEN
    RAISE EXCEPTION 'PERIOD_ALREADY_LOCKED' USING DETAIL = pg_catalog.json_build_object('lockedThrough', v_through)::text;
  END IF;
  IF v_through IS NOT NULL AND p_month <> v_through + 1 THEN
    RAISE EXCEPTION 'EARLIER_PERIOD_OPEN' USING DETAIL = pg_catalog.json_build_object('lockedThrough', v_through)::text;
  END IF;
  IF p_month >= pg_catalog.date_trunc('month', pg_catalog.now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date THEN
    RAISE EXCEPTION 'PERIOD_NOT_ENDED' USING DETAIL = pg_catalog.json_build_object('lockedThrough', v_through)::text;
  END IF;
  UPDATE crove_finance.period_lock p
  SET locked_from = COALESCE(v_from, p_month), locked_through = v_end, updated_by = crove_kernel.ctx_user_id(), updated_at = pg_catalog.now()
  WHERE p.org_id = v_org;
  RETURN v_end;
END $$;

-- Unlocks the month starting p_month, which must be the last locked month, and returns the new locked_through (NULL
-- once the first locked month is unlocked). Raises PERIOD_NOT_LOCKED when the month is not locked and
-- LATER_PERIOD_LOCKED when a later month is, both with the current locked_through as JSON DETAIL.
CREATE OR REPLACE FUNCTION crove_finance.unlock_period(p_month date) RETURNS date
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
  v_end date;
  v_from date;
  v_through date;
BEGIN
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'NO_CONTEXT' USING ERRCODE = '42501';
  END IF;
  PERFORM crove_finance.assert_period_lock_role(ARRAY['owner']);
  IF p_month IS NULL OR EXTRACT(DAY FROM p_month) <> 1 THEN
    RAISE EXCEPTION 'PERIOD_INVALID' USING ERRCODE = '22023';
  END IF;
  v_end := (p_month + pg_catalog.make_interval(months => 1) - pg_catalog.make_interval(days => 1))::date;
  SELECT p.locked_from, p.locked_through INTO v_from, v_through FROM crove_finance.period_lock p WHERE p.org_id = v_org FOR UPDATE;
  IF v_through IS NULL OR v_end > v_through THEN
    RAISE EXCEPTION 'PERIOD_NOT_LOCKED' USING DETAIL = pg_catalog.json_build_object('lockedThrough', v_through)::text;
  END IF;
  IF v_end < v_through THEN
    RAISE EXCEPTION 'LATER_PERIOD_LOCKED' USING DETAIL = pg_catalog.json_build_object('lockedThrough', v_through)::text;
  END IF;
  UPDATE crove_finance.period_lock p
  SET locked_from = CASE WHEN p_month <= v_from THEN NULL ELSE v_from END,
      locked_through = CASE WHEN p_month <= v_from THEN NULL ELSE p_month - 1 END,
      updated_by = crove_kernel.ctx_user_id(),
      updated_at = pg_catalog.now()
  WHERE p.org_id = v_org;
  RETURN CASE WHEN p_month <= v_from THEN NULL ELSE p_month - 1 END;
END $$;

-- The trigger function runs for whoever inserts an entry and needs no EXECUTE grant; the lock and unlock functions are
-- for the commands, which run as the tenant roles.
REVOKE ALL ON FUNCTION
  crove_finance.journal_entry_period_open(),
  crove_finance.assert_period_lock_role(text[]),
  crove_finance.lock_period(date),
  crove_finance.unlock_period(date)
FROM PUBLIC, crove_tenant, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_finance.lock_period(date), crove_finance.unlock_period(date) TO crove_tenant;
