-- Ties the audit row a new tenant needs to the tenant's creator (issue #102, follow-up of #96). Idempotent;
-- applied files stay untouched.
--
-- Before: the deferred constraint trigger tenant_requires_audit (20261015092600) let a tenant commit with any
-- 'ok' kernel.org.create audit row for its org_id, whoever the row named as actor.
--
-- After: the audit row must also name the creator, a.actor_id = NEW.created_by (both uuid). A row written by
-- another user, or by a system actor (actor_id NULL), does not satisfy it. execute() writes the row with the
-- calling user as actor, and create_or_replay_org records that same user as created_by, so the one write path
-- is unaffected.
SET LOCAL lock_timeout = '2s';

-- Signature, owner and settings unchanged; CREATE OR REPLACE keeps the trigger bound to it.
CREATE OR REPLACE FUNCTION crove_kernel.tenant_requires_audit()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM crove_kernel.audit_event a
    WHERE a.org_id = NEW.org_id
      AND a.command = 'kernel.org.create'
      AND a.outcome = 'ok'
      AND a.actor_type = 'user'
      AND a.actor_id = NEW.created_by
  ) THEN
    RAISE EXCEPTION 'ORG_CREATE_UNAUDITED' USING ERRCODE = '42501';
  END IF;
  RETURN NULL;
END $$;

-- Restated so this file alone leaves the matrix right: the trigger function is callable by nobody.
REVOKE ALL ON FUNCTION crove_kernel.tenant_requires_audit()
FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
