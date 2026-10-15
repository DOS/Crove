-- Rotatable inbound email addresses with tombstones (issue #37, plan §7.6). Idempotent; applied files stay
-- untouched.
--
-- Data model (the smaller change, a deviation from the plan's table list): tenant.inbound_token stays the
-- org's one active token, so the worker's resolver and the org detail query keep reading one column.
-- crove_kernel.inbound_address is the ledger of every token ever issued, active or retired:
--   - UNIQUE (token) spans active and retired tokens, so a token that ever existed can never be issued again;
--   - a retired token keeps its row with retired_at set (the tombstone); rows are never deleted or changed,
--     except that an active row is retired once;
--   - at most one active row per org, and the tenant's token must be that row (checked at commit).
-- Issuing goes through the ledger only: a new org's token is registered by triggers on tenant,
-- and rotation runs in crove_kernel.inbound_rotate(), which the command kernel.inbound.rotate calls through
-- execute(). Both draw from crove_kernel.random_token() and let the UNIQUE constraint decide, drawing again
-- on a collision. No grace period: mail to a retired token is dropped from the moment of rotation, exactly
-- like mail to a token that never existed (the API answers 202 either way, so there is no oracle).
SET LOCAL lock_timeout = '2s';

-- ---------------------------------------------------------------------------
-- The ledger. No cascade on the foreign key: tombstones must outlive anything that could remove a tenant.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS crove_kernel.inbound_address (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id),
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  token text NOT NULL CONSTRAINT inbound_address_token_format CHECK (token ~ '^[0-9a-f]{24}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  retired_at timestamptz,
  PRIMARY KEY (org_id, id),
  CONSTRAINT inbound_address_token_uq UNIQUE (token),
  CONSTRAINT inbound_address_retired_after_created CHECK (retired_at IS NULL OR retired_at >= created_at)
);
CREATE UNIQUE INDEX IF NOT EXISTS inbound_address_active_uq ON crove_kernel.inbound_address (org_id) WHERE retired_at IS NULL;
SELECT crove_kernel.apply_tenant_rls('crove_kernel.inbound_address');
-- Tenant roles neither read nor write the ledger; only the definers below do.
REVOKE ALL ON crove_kernel.inbound_address FROM PUBLIC, crove_tenant;

-- Existing orgs: their current token becomes their active ledger row.
INSERT INTO crove_kernel.inbound_address (org_id, token, created_at)
SELECT t.org_id, t.inbound_token, t.created_at
FROM crove_kernel.tenant t
WHERE NOT EXISTS (SELECT 1 FROM crove_kernel.inbound_address a WHERE a.token = t.inbound_token);

-- Ledger rows are never deleted and never changed, for every role, the database owner included (only a
-- superuser that disables triggers, for example with session_replication_role = replica, can bypass this);
-- the one allowed change is retiring an active row.
CREATE OR REPLACE FUNCTION crove_kernel.inbound_address_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD.retired_at IS NULL AND NEW.retired_at IS NOT NULL
     AND NEW.org_id = OLD.org_id AND NEW.id = OLD.id AND NEW.token = OLD.token AND NEW.created_at = OLD.created_at THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'INBOUND_ADDRESS_TOMBSTONE' USING ERRCODE = '42501',
    DETAIL = 'inbound addresses are never deleted or changed; an active one may only be retired, once';
END $$;

DROP TRIGGER IF EXISTS inbound_address_guard ON crove_kernel.inbound_address;
CREATE TRIGGER inbound_address_guard BEFORE UPDATE OR DELETE ON crove_kernel.inbound_address
  FOR EACH ROW EXECUTE FUNCTION crove_kernel.inbound_address_guard();
DROP TRIGGER IF EXISTS inbound_address_truncate ON crove_kernel.inbound_address;
CREATE TRIGGER inbound_address_truncate BEFORE TRUNCATE ON crove_kernel.inbound_address
  FOR EACH STATEMENT EXECUTE FUNCTION crove_kernel.reject_mutation();

-- ---------------------------------------------------------------------------
-- New orgs: the token is issued through the ledger. Before the insert, a default token that already exists
-- (active or retired, in any org) is replaced by a fresh one; after it, the token is registered, and the
-- UNIQUE constraint is the final check. Registering after the insert matters: create_or_replay_org inserts
-- with ON CONFLICT (slug) DO NOTHING, and a skipped row fires no AFTER trigger.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION crove_kernel.tenant_pick_inbound_token()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  FOR attempt IN 1..5 LOOP
    IF NEW.inbound_token IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM crove_kernel.inbound_address a WHERE a.token = NEW.inbound_token) THEN
      RETURN NEW;
    END IF;
    NEW.inbound_token := crove_kernel.random_token();
  END LOOP;
  RAISE EXCEPTION 'INBOUND_TOKEN_EXHAUSTED' USING ERRCODE = '23505';
END $$;

CREATE OR REPLACE FUNCTION crove_kernel.tenant_register_inbound_token()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  INSERT INTO crove_kernel.inbound_address (org_id, token) VALUES (NEW.org_id, NEW.inbound_token);
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS tenant_pick_inbound_token ON crove_kernel.tenant;
CREATE TRIGGER tenant_pick_inbound_token BEFORE INSERT ON crove_kernel.tenant
  FOR EACH ROW EXECUTE FUNCTION crove_kernel.tenant_pick_inbound_token();
DROP TRIGGER IF EXISTS tenant_register_inbound_token ON crove_kernel.tenant;
CREATE TRIGGER tenant_register_inbound_token AFTER INSERT ON crove_kernel.tenant
  FOR EACH ROW EXECUTE FUNCTION crove_kernel.tenant_register_inbound_token();

-- Refuses to commit a tenant whose token is not its active ledger row (a token set by hand, or a retired one).
-- Reads the committed-to-be row, so several changes in one transaction are judged by the final state.
CREATE OR REPLACE FUNCTION crove_kernel.tenant_inbound_token_active()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM crove_kernel.tenant t
    JOIN crove_kernel.inbound_address a ON a.org_id = t.org_id AND a.token = t.inbound_token AND a.retired_at IS NULL
    WHERE t.org_id = NEW.org_id
  ) THEN
    RAISE EXCEPTION 'INBOUND_TOKEN_NOT_ISSUED' USING ERRCODE = '42501';
  END IF;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS tenant_inbound_token_active ON crove_kernel.tenant;
CREATE CONSTRAINT TRIGGER tenant_inbound_token_active
  AFTER INSERT OR UPDATE OF inbound_token ON crove_kernel.tenant
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION crove_kernel.tenant_inbound_token_active();

-- ---------------------------------------------------------------------------
-- Rotation, for the org and user in context (the command kernel.inbound.rotate, run by execute()). Owner
-- only, checked here as well as by the command. Retires the active token and issues a new one; returns it.
-- Concurrent rotations of one org serialize on the tenant row.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION crove_kernel.inbound_rotate()
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
  v_user uuid := crove_kernel.ctx_user_id();
  v_token text;
BEGIN
  IF v_org IS NULL OR v_user IS NULL THEN
    RAISE EXCEPTION 'NO_CONTEXT' USING ERRCODE = '42501';
  END IF;
  PERFORM 1 FROM crove_kernel.tenant t WHERE t.org_id = v_org AND t.status = 'active' FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'TENANT_NOT_ACTIVE' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM crove_kernel.tenant_member m WHERE m.org_id = v_org AND m.user_id = v_user AND m.role = 'owner'
  ) THEN
    RAISE EXCEPTION 'INBOUND_ROTATE_OWNER_ONLY' USING ERRCODE = '42501';
  END IF;
  UPDATE crove_kernel.inbound_address SET retired_at = pg_catalog.now() WHERE org_id = v_org AND retired_at IS NULL;
  FOR attempt IN 1..5 LOOP
    INSERT INTO crove_kernel.inbound_address (org_id, token) VALUES (v_org, crove_kernel.random_token())
    ON CONFLICT (token) DO NOTHING
    RETURNING token INTO v_token;
    EXIT WHEN v_token IS NOT NULL;
  END LOOP;
  IF v_token IS NULL THEN
    RAISE EXCEPTION 'INBOUND_TOKEN_EXHAUSTED' USING ERRCODE = '23505';
  END IF;
  UPDATE crove_kernel.tenant SET inbound_token = v_token WHERE org_id = v_org;
  RETURN v_token;
END $$;

-- The worker's resolver also requires the token's ledger row to be active, so a retired token never routes.
CREATE OR REPLACE FUNCTION crove_kernel.org_by_inbound_token(p_token text)
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT t.org_id
  FROM crove_kernel.tenant t
  JOIN crove_kernel.inbound_address a ON a.org_id = t.org_id AND a.token = t.inbound_token AND a.retired_at IS NULL
  WHERE t.inbound_token = pg_catalog.lower(p_token) AND t.status = 'active'
$$;

-- ---------------------------------------------------------------------------
-- EXECUTE matrix: only the API login role rotates; the trigger functions are callable by nobody.
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION crove_kernel.inbound_rotate() FROM PUBLIC, crove_tenant, crove_app, crove_worker;
REVOKE ALL ON FUNCTION
  crove_kernel.inbound_address_guard(),
  crove_kernel.tenant_pick_inbound_token(),
  crove_kernel.tenant_register_inbound_token(),
  crove_kernel.tenant_inbound_token_active()
FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_kernel.inbound_rotate() TO crove_app;

-- inbound_rotate writes tenant data for the context it runs in, so it is owned by the NOLOGIN definer role and
-- tenant RLS stays in force inside it (plan §7.1). The definer role gets exactly the ledger writes it needs.
-- Ownership moves as in the ledger posting migration: a runner that is not a superuser joins the role first,
-- and the new owner holds CREATE on the schema only while the ownership moves.
DO $$
BEGIN
  IF NOT (SELECT r.rolsuper FROM pg_catalog.pg_roles r WHERE r.rolname = current_user) THEN
    EXECUTE pg_catalog.format('GRANT crove_definer_tenant TO %I WITH INHERIT TRUE, SET TRUE', current_user);
  END IF;
END $$;
GRANT CREATE ON SCHEMA crove_kernel TO crove_definer_tenant;
ALTER FUNCTION crove_kernel.inbound_rotate() OWNER TO crove_definer_tenant;
REVOKE CREATE ON SCHEMA crove_kernel FROM crove_definer_tenant;
-- The NOLOGIN owner keeps its own EXECUTE: a runner that is not a superuser grants and revokes on the function
-- through the owner's grant options, so revoking them would make this file fail when it is applied again.

GRANT SELECT, INSERT ON crove_kernel.inbound_address TO crove_definer_tenant;
GRANT UPDATE (retired_at) ON crove_kernel.inbound_address TO crove_definer_tenant;
