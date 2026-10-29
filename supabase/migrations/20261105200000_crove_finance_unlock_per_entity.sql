-- Crove finance (issue #1507): a month is unlocked by an owner, an org-wide holder of finance.period.unlock (an org-wide
-- finance.chief_accountant), or a holder of it for that month's legal entity (finance.entity_chief_accountant, assigned
-- per entity; 20261105190000_crove_kernel_entity_permissions.sql). Idempotent; applied files stay untouched.
--
-- crove_finance.may_unlock_period(entity)  whether the user of the sealed context may unlock that entity's months: an
--     owner, or finance.period.unlock org-wide or for that entity (crove_kernel.ctx_permission_entities). Read as the
--     caller; EXECUTE for crove_tenant: the period lock state answers it to the screen (unlockable), and unlock_period
--     asks it again.
-- crove_finance.unlock_period(date, uuid)  the body of 20261102150000_crove_finance_legal_entity_books.sql with the
--     check per entity: a caller who holds the permission nowhere is refused first, as before (PERIOD_LOCK_FORBIDDEN
--     unless an owner); then the entity is resolved as before, and a caller who may not unlock that entity's months is
--     refused with the same PERIOD_LOCK_FORBIDDEN. An org-wide holder and an owner keep every entity in their scope.
SET LOCAL lock_timeout = '2s';

CREATE OR REPLACE FUNCTION crove_finance.may_unlock_period(p_legal_entity_id uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT COALESCE(crove_kernel.ctx_actor_type() = 'user', false) AND (
    EXISTS (
      SELECT 1 FROM crove_kernel.tenant_member m
      WHERE m.org_id = crove_kernel.ctx_org_id() AND m.user_id = crove_kernel.ctx_user_id() AND m.role = 'owner')
    OR crove_kernel.ctx_has_permission('finance.period.unlock')
    OR (p_legal_entity_id IS NOT NULL AND p_legal_entity_id::text = ANY (crove_kernel.ctx_permission_entities('finance.period.unlock'))))
$$;
REVOKE ALL ON FUNCTION crove_finance.may_unlock_period(uuid) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_finance.may_unlock_period(uuid) TO crove_tenant;

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

REVOKE ALL ON FUNCTION crove_finance.unlock_period(date, uuid) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_finance.unlock_period(date, uuid) TO crove_tenant;
