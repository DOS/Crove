-- Crove kernel (issue #1482, plan §4.10): an audit row is stamped from the sealed context, whoever writes it. Until now
-- the runtime roles inserted audit_event rows as given: in its own org a session could write a row naming another
-- member or the system, as any command, dated any time, so a *_requires_audit trigger (tenant_tax_code_requires_audit,
-- tenant_approval_policy_requires_audit, member_invite_requires_audit, vat_return_filed_requires_audit, ...) proved
-- only that some allowed session wrote some row. Idempotent; applied files stay untouched.
--
-- audit_event_stamp (BEFORE INSERT, after agent_write_guard by name, so an agent context keeps its own stricter rule):
--   - a user context: actor_type 'user' and actor_id the context's user;
--   - a system context: actor_type 'system' and no actor_id;
--   - an agent context: left to agent_write_guard (its own agent and run only);
--   - occurred_at is the transaction's now(), so no row is backdated or dated ahead;
--   - no context, or another org's: left to the tenant policy, which refuses the row for every role but staff.
-- What is stamped is overwritten, not refused: the runtime already writes exactly these values, and a row a session
-- forges for someone else becomes its own, which the *_requires_audit triggers then judge (a member's row never stands
-- for an owner's). The command name cannot be authenticated here: the runtime and any statement on its connection are
-- the same session, so the plan's audit_write() as a definer would not add that either.
-- Staff (a superuser, or a role that can act as the table's owner) are not stamped, so a support fix or a test that
-- builds history is not changed.
SET LOCAL lock_timeout = '2s';

CREATE OR REPLACE FUNCTION crove_kernel.audit_event_stamp()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_staff boolean;
  v_ctx jsonb;
BEGIN
  SELECT r.rolsuper
         OR pg_catalog.pg_has_role(r.oid, (SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid = TG_RELID), 'USAGE')
    INTO v_staff
  FROM pg_catalog.pg_roles r WHERE r.rolname = SESSION_USER;
  IF COALESCE(v_staff, false) THEN
    RETURN NEW;
  END IF;
  v_ctx := crove_kernel.ctx_verified();
  -- No context, or another org's: the tenant policy refuses the row (it applies to every role but staff), with its
  -- own error.
  IF v_ctx IS NULL OR (v_ctx ->> 'org')::uuid IS DISTINCT FROM NEW.org_id THEN
    RETURN NEW;
  END IF;
  IF v_ctx ->> 'actor' = 'user' THEN
    NEW.actor_type := 'user';
    NEW.actor_id := (v_ctx ->> 'user')::uuid;
  ELSIF v_ctx ->> 'actor' = 'system' THEN
    NEW.actor_type := 'system';
    NEW.actor_id := NULL;
  ELSIF v_ctx ->> 'actor' IS DISTINCT FROM 'agent' THEN
    RAISE EXCEPTION 'AUDIT_CONTEXT_REQUIRED' USING ERRCODE = '42501';
  END IF;
  NEW.occurred_at := pg_catalog.now();
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS audit_event_stamp ON crove_kernel.audit_event;
CREATE TRIGGER audit_event_stamp BEFORE INSERT ON crove_kernel.audit_event
  FOR EACH ROW EXECUTE FUNCTION crove_kernel.audit_event_stamp();

-- EXECUTE matrix: the trigger's function is callable by nobody.
REVOKE ALL ON FUNCTION crove_kernel.audit_event_stamp() FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
