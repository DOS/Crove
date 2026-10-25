-- Crove finance (issue #1279, ADR-0021 section 3): the chief accountant reopens a period too. Idempotent; applied
-- files stay untouched.
--
-- ADR-0021 restricts reopening to the chief accountant and the owner; until roles existed, unlock_period() let owners
-- only (20261020070000_crove_finance_period_lock.sql). Now a user who holds the permission finance.period.unlock
-- through an org-wide role assignment (finance.chief_accountant, 20261101000000_crove_kernel_roles.sql) may unlock as
-- well. Nothing else changes: same signature, order rules, refusals and row lock; locking stays with owners and admins.
-- The finance.period.unlock command checks the same first (its permission, read in the command's transaction), so a
-- revoked chief accountant is refused from the next command. CREATE OR REPLACE keeps owner and ACL.
SET LOCAL lock_timeout = '2s';

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
  -- An owner, or a user holding finance.period.unlock org-wide (ctx_has_permission answers false for any other actor).
  IF NOT crove_kernel.ctx_has_permission('finance.period.unlock') THEN
    PERFORM crove_finance.assert_period_lock_role(ARRAY['owner']);
  END IF;
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
