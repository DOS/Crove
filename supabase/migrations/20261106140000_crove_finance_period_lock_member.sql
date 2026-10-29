-- Crove finance (issue #1348): lock_period and unlock_period lock the caller's membership before their role and
-- permission checks. Idempotent; applied files stay untouched.
--
-- Both checked the caller's role (an owner or an admin to lock, an owner to unlock) or finance.period.unlock without a
-- lock on the caller's tenant_member row. A revoke of the chief accountant role or a demotion that committed while a
-- lock or unlock was in flight was not serialized with it, so the change of the month could commit on a right the
-- caller had just lost. Each now takes that row FOR SHARE first. The role and permission commands
-- (kernel.member.change_role, kernel.member.role.assign and .revoke) lock the member rows FOR UPDATE before they change
-- them, so such a change that starts later waits for the lock or unlock to commit, and one in flight makes it wait and
-- then read the change. The member row is the first row either function locks, before the month's period_lock row,
-- which those commands never lock. One wait can still go the other way: in an org whose preset reserves the ledger to
-- the chief accountant, a revoke or demotion of the last one locks the tenant row (chief_accountant_keep_guard), which
-- the lock or unlock command's idempotency row already holds FOR KEY SHARE; one of the two is then refused as a
-- deadlock (RETRY), and the other decides on committed data, as the approve gate already does.
--
-- crove_finance.lock_period(date, uuid)    the body of 20261102150000_crove_finance_legal_entity_books.sql with the lock.
-- crove_finance.unlock_period(date, uuid)  the body of 20261106090000_crove_finance_unlock_per_entity.sql with the lock;
--     its checks, per entity included, are unchanged.
-- The one-argument wrappers call these and are unchanged.
SET LOCAL lock_timeout = '2s';

CREATE OR REPLACE FUNCTION crove_finance.lock_period(p_month date, p_legal_entity_id uuid) RETURNS date
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
  v_end date;
  v_from date;
  v_through date;
  v_entity uuid;
BEGIN
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'NO_CONTEXT' USING ERRCODE = '42501';
  END IF;
  -- The caller's membership first (#1348), as the role and permission commands lock it: a revoke or demotion that
  -- committed before is read by the checks below, and one that starts later waits for this transaction.
  PERFORM 1 FROM crove_kernel.tenant_member m WHERE m.org_id = v_org AND m.user_id = crove_kernel.ctx_user_id() FOR SHARE;
  PERFORM crove_finance.assert_period_lock_role(ARRAY['owner', 'admin']);
  v_entity := crove_finance.period_lock_entity(v_org, p_legal_entity_id);
  IF p_month IS NULL OR EXTRACT(DAY FROM p_month) <> 1 THEN
    RAISE EXCEPTION 'PERIOD_INVALID' USING ERRCODE = '22023';
  END IF;
  v_end := (p_month + pg_catalog.make_interval(months => 1) - pg_catalog.make_interval(days => 1))::date;
  INSERT INTO crove_finance.period_lock (org_id, legal_entity_id) VALUES (v_org, v_entity) ON CONFLICT (org_id, legal_entity_id) DO NOTHING;
  SELECT p.locked_from, p.locked_through INTO v_from, v_through FROM crove_finance.period_lock p WHERE p.org_id = v_org AND p.legal_entity_id = v_entity FOR UPDATE;
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
  WHERE p.org_id = v_org AND p.legal_entity_id = v_entity;
  RETURN v_end;
END $$;

CREATE OR REPLACE FUNCTION crove_finance.unlock_period(p_month date, p_legal_entity_id uuid) RETURNS date
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
  v_end date;
  v_from date;
  v_through date;
  v_entity uuid;
BEGIN
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'NO_CONTEXT' USING ERRCODE = '42501';
  END IF;
  -- The caller's membership first (#1348), as the role and permission commands lock it: a revoke or demotion that
  -- committed before is read by the checks below, and one that starts later waits for this transaction.
  PERFORM 1 FROM crove_kernel.tenant_member m WHERE m.org_id = v_org AND m.user_id = crove_kernel.ctx_user_id() FOR SHARE;
  -- An owner, or a user holding finance.period.unlock org-wide or for some entity (both answer nothing for any other
  -- actor): refused first, as before, when they hold it nowhere.
  IF crove_kernel.ctx_has_permission('finance.period.unlock') IS NOT TRUE
     AND COALESCE(pg_catalog.cardinality(crove_kernel.ctx_permission_entities('finance.period.unlock')), 0) = 0 THEN
    PERFORM crove_finance.assert_period_lock_role(ARRAY['owner']);
  END IF;
  v_entity := crove_finance.period_lock_entity(v_org, p_legal_entity_id);
  -- Then for the entity resolved (#1507): an entity holder unlocks only the months of its own entities.
  IF crove_finance.may_unlock_period(v_entity) IS NOT TRUE THEN
    RAISE EXCEPTION 'PERIOD_LOCK_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  IF p_month IS NULL OR EXTRACT(DAY FROM p_month) <> 1 THEN
    RAISE EXCEPTION 'PERIOD_INVALID' USING ERRCODE = '22023';
  END IF;
  v_end := (p_month + pg_catalog.make_interval(months => 1) - pg_catalog.make_interval(days => 1))::date;
  SELECT p.locked_from, p.locked_through INTO v_from, v_through FROM crove_finance.period_lock p WHERE p.org_id = v_org AND p.legal_entity_id = v_entity FOR UPDATE;
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
  WHERE p.org_id = v_org AND p.legal_entity_id = v_entity;
  RETURN CASE WHEN p_month <= v_from THEN NULL ELSE p_month - 1 END;
END $$;

REVOKE ALL ON FUNCTION crove_finance.lock_period(date, uuid), crove_finance.unlock_period(date, uuid)
  FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_finance.lock_period(date, uuid), crove_finance.unlock_period(date, uuid) TO crove_tenant;
