-- Org offboarding (issue #38, plan §7.9 "Offboarding"). Idempotent; applied files stay untouched.
--
-- Before: an org was 'active' or 'closed' (closed existed only in the schema), and nothing could take an org out of
-- service or produce its data for the tenant.
--
-- After:
--   * tenant.status gains 'offboarding'. The owner moves the org there with the R3 command kernel.org.offboard; the
--     worker then exports the org's data (JSON per table plus the stored files list, kernel.org.export.record).
--   * While offboarding, only owners get in: enter_context admits an owner and refuses every other member
--     (NOT_A_MEMBER, as for a closed org), my_orgs lists the org to its owners only, invites cannot be accepted
--     (invite_for_user wants an active org) and inbound mail is refused (org_by_inbound_token wants an active org).
--   * The worker's system context also enters an offboarding org, so the export job (and jobs already queued for the
--     org) can finish; new work cannot reach the org, since mail and members are refused.
--   * tenant_status_guard: every role but staff (a superuser or a role acting as the table owner) may only move an org
--     from 'active' to 'offboarding'; the login roles never reopen or close one. Staff close an org after the export;
--     closing and deleting records are a later staff step (docs/runbooks/org-offboarding.md), never automatic.
--   * tenant_offboarding_requires_audit: an org moves to 'offboarding' only together with the 'ok' audit row of
--     kernel.org.offboard written in the same transaction by a user who is an owner of the org, so no path can take an
--     org out of service unaudited.
SET LOCAL lock_timeout = '2s';

-- ---------------------------------------------------------------------------
-- Status
-- ---------------------------------------------------------------------------
ALTER TABLE crove_kernel.tenant DROP CONSTRAINT IF EXISTS tenant_status_check;
ALTER TABLE crove_kernel.tenant ADD CONSTRAINT tenant_status_check CHECK (status IN ('active', 'offboarding', 'closed'));

-- SECURITY INVOKER: session_user is the login role whatever definer runs the update. Deny by default: only a superuser
-- or a role that can act as the table's owner (staff, the migration runner) may make any change; every other role, the
-- API and worker login roles included, only the one transition the command makes. MEMBER is not enough to be staff: a
-- CREATEROLE runner that created crove_app holds ADMIN on it (PostgreSQL 16+), so the test is USAGE of the owner.
CREATE OR REPLACE FUNCTION crove_kernel.tenant_status_guard()
RETURNS trigger LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_staff boolean;
BEGIN
  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NEW;
  END IF;
  SELECT r.rolsuper
         OR pg_catalog.pg_has_role(r.oid, (SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid = TG_RELID), 'USAGE')
    INTO v_staff
  FROM pg_catalog.pg_roles r WHERE r.rolname = SESSION_USER;
  IF NOT COALESCE(v_staff, false) AND NOT (OLD.status = 'active' AND NEW.status = 'offboarding') THEN
    RAISE EXCEPTION 'TENANT_STATUS_TRANSITION' USING ERRCODE = '42501',
      DETAIL = 'tenant roles only move an org from active to offboarding';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tenant_status_guard ON crove_kernel.tenant;
CREATE TRIGGER tenant_status_guard BEFORE UPDATE OF status ON crove_kernel.tenant
  FOR EACH ROW EXECUTE FUNCTION crove_kernel.tenant_status_guard();

-- Refuses to commit the move to 'offboarding' without the kernel.org.offboard audit row execute() writes in the same
-- transaction (occurred_at defaults to now(), the transaction start), by a user who is an owner of the org.
CREATE OR REPLACE FUNCTION crove_kernel.tenant_offboarding_requires_audit()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM crove_kernel.audit_event a
    JOIN crove_kernel.tenant_member m ON m.org_id = a.org_id AND m.user_id = a.actor_id AND m.role = 'owner'
    WHERE a.org_id = NEW.org_id
      AND a.command = 'kernel.org.offboard'
      AND a.outcome = 'ok'
      AND a.actor_type = 'user'
      AND a.occurred_at = pg_catalog.now()
  ) THEN
    RAISE EXCEPTION 'ORG_OFFBOARD_UNAUDITED' USING ERRCODE = '42501';
  END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS tenant_offboarding_requires_audit ON crove_kernel.tenant;
CREATE CONSTRAINT TRIGGER tenant_offboarding_requires_audit
  AFTER UPDATE OF status ON crove_kernel.tenant
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (OLD.status = 'active' AND NEW.status = 'offboarding')
  EXECUTE FUNCTION crove_kernel.tenant_offboarding_requires_audit();

-- ---------------------------------------------------------------------------
-- Entry points. Same signatures, contracts and checks as the sealed-context versions (20261015170000) except for the
-- status rule; CREATE OR REPLACE keeps owner and ACL.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION crove_kernel.enter_context(p_user_id uuid, p_org_id uuid)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_role text;
BEGIN
  PERFORM crove_kernel.context_reentry_guard();
  SELECT m.role INTO v_role
  FROM crove_kernel.tenant_member m
  JOIN crove_kernel.tenant t ON t.org_id = m.org_id
  WHERE m.org_id = p_org_id AND m.user_id = p_user_id
    AND (t.status = 'active' OR (t.status = 'offboarding' AND m.role = 'owner'));
  IF v_role IS NULL THEN
    RAISE EXCEPTION 'NOT_A_MEMBER' USING ERRCODE = '42501';
  END IF;
  PERFORM crove_kernel.ctx_write(pg_catalog.jsonb_build_object(
    'v', 1,
    'org', p_org_id,
    'actor', 'user',
    'user', p_user_id,
    'role', v_role,
    'le_scope', pg_catalog.jsonb_build_array('*'),
    'flags', '[]'::jsonb));
  RETURN v_role;
END $$;

CREATE OR REPLACE FUNCTION crove_kernel.enter_system_context(p_org_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM crove_kernel.context_reentry_guard();
  IF NOT pg_catalog.pg_has_role(SESSION_USER, 'crove_worker', 'MEMBER') THEN
    RAISE EXCEPTION 'SYSTEM_CONTEXT_WORKER_ONLY' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM crove_kernel.tenant WHERE org_id = p_org_id AND status IN ('active', 'offboarding')) THEN
    RAISE EXCEPTION 'TENANT_NOT_ACTIVE' USING ERRCODE = '42501';
  END IF;
  PERFORM crove_kernel.ctx_write(pg_catalog.jsonb_build_object(
    'v', 1,
    'org', p_org_id,
    'actor', 'system',
    'user', NULL,
    'role', NULL,
    'le_scope', pg_catalog.jsonb_build_array('*'),
    'flags', '[]'::jsonb));
END $$;

-- Orgs the user may enter: active orgs, and offboarding orgs the user owns.
CREATE OR REPLACE FUNCTION crove_kernel.my_orgs(p_user_id uuid)
RETURNS TABLE (org_id uuid, slug text, name text, role text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT t.org_id, t.slug, t.name, m.role
  FROM crove_kernel.tenant_member m
  JOIN crove_kernel.tenant t ON t.org_id = m.org_id
  WHERE m.user_id = p_user_id
    AND (t.status = 'active' OR (t.status = 'offboarding' AND m.role = 'owner'))
  ORDER BY t.created_at
$$;

-- ---------------------------------------------------------------------------
-- EXECUTE matrix: the triggers' functions are callable by nobody.
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION crove_kernel.tenant_status_guard(), crove_kernel.tenant_offboarding_requires_audit()
FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
