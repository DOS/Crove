-- Org creation runs through execute() as the org-less command kernel.org.create (External-tenant gate T4,
-- plan §4.5). Idempotent; applied files stay untouched.
--
-- Before: the API called crove_kernel.create_org(user, slug, name) outside execute(), so creating a tenant
-- wrote no audit row and had no idempotency key, and every crove_tenant member could execute it.
--
-- After:
--   create_or_replay_org  the only definer that creates a tenant, executable by crove_app alone. It creates
--                         the tenant with the caller as owner, or, when the caller already used the same
--                         idempotency key for kernel.org.create, returns that org so execute() replays the
--                         stored response. execute() then enters the org as the caller (membership checked)
--                         and writes the audit row and the idempotency key in the same transaction.
--   tenant_requires_audit a deferred constraint trigger: a tenant row commits only together with its
--                         kernel.org.create audit row, so no path can create an unaudited tenant.
--   create_org            the raw definer is dropped.
SET LOCAL lock_timeout = '2s';

-- Finds an earlier org creation by the caller's key without knowing the org.
CREATE INDEX IF NOT EXISTS idempotency_key_org_create_idx
  ON crove_kernel.idempotency_key (actor_key, key) WHERE command = 'kernel.org.create';

-- Creates an org with p_user_id as owner and returns its id, or returns the org an earlier kernel.org.create
-- with the same idempotency key created. Two requests with one key are serialized by an advisory lock, so
-- the second sees the first one's key and creates nothing. A taken slug gets a random suffix (5 tries).
CREATE OR REPLACE FUNCTION crove_kernel.create_or_replay_org(p_user_id uuid, p_slug text, p_name text, p_idempotency_key text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid;
  v_slug text := p_slug;
BEGIN
  IF p_idempotency_key IS NOT NULL THEN
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('kernel.org.create:' || p_user_id::text || ':' || p_idempotency_key, 0));
    SELECT k.org_id INTO v_org
    FROM crove_kernel.idempotency_key k
    WHERE k.actor_key = 'user:' || p_user_id::text AND k.key = p_idempotency_key AND k.command = 'kernel.org.create';
    IF v_org IS NOT NULL THEN
      RETURN v_org;
    END IF;
  END IF;
  FOR attempt IN 1..5 LOOP
    INSERT INTO crove_kernel.tenant (slug, name, created_by) VALUES (v_slug, p_name, p_user_id)
    ON CONFLICT (slug) DO NOTHING
    RETURNING org_id INTO v_org;
    EXIT WHEN v_org IS NOT NULL;
    v_slug := pg_catalog.left(p_slug, 40) || '-' || pg_catalog.left(crove_kernel.random_token(), 4);
  END LOOP;
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'ORG_SLUG_TAKEN' USING ERRCODE = '23505';
  END IF;
  INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES (v_org, p_user_id, 'owner');
  RETURN v_org;
END $$;

-- Refuses to commit a tenant without the kernel.org.create audit row execute() writes for it.
CREATE OR REPLACE FUNCTION crove_kernel.tenant_requires_audit()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM crove_kernel.audit_event a
    WHERE a.org_id = NEW.org_id AND a.command = 'kernel.org.create' AND a.outcome = 'ok'
  ) THEN
    RAISE EXCEPTION 'ORG_CREATE_UNAUDITED' USING ERRCODE = '42501';
  END IF;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS tenant_requires_audit ON crove_kernel.tenant;
CREATE CONSTRAINT TRIGGER tenant_requires_audit
  AFTER INSERT ON crove_kernel.tenant
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION crove_kernel.tenant_requires_audit();

DROP FUNCTION IF EXISTS crove_kernel.create_org(uuid, text, text);

-- ---------------------------------------------------------------------------
-- EXECUTE matrix: only the API login role creates orgs; the trigger function is callable by nobody.
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION
  crove_kernel.create_or_replay_org(uuid, text, text, text),
  crove_kernel.tenant_requires_audit()
FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;

GRANT EXECUTE ON FUNCTION crove_kernel.create_or_replay_org(uuid, text, text, text) TO crove_app;
