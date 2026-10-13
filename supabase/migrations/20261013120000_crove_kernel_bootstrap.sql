-- Crove kernel bootstrap: roles, schemas, tenancy helpers, identity and machinery tables.
-- Applied by the built-in runner (`crove migrate`) as the database owner. Idempotent.

-- ---------------------------------------------------------------------------
-- Roles
-- crove_tenant: group role that every tenant RLS policy targets.
-- crove_app:    login role used by the API. Owns nothing, no BYPASSRLS.
-- crove_worker: login role used by the worker; also allowed to claim the cross-tenant outbox.
-- supabase_auth_admin: owner of the `auth` schema for the bundled Supabase Auth (self-host only;
--               on Supabase-hosted databases the role already exists and is left alone).
-- Passwords are set by the runner from environment variables, never in migrations.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'crove_tenant') THEN
    CREATE ROLE crove_tenant NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'crove_app') THEN
    CREATE ROLE crove_app LOGIN INHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'crove_worker') THEN
    CREATE ROLE crove_worker LOGIN INHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_auth_admin') THEN
    CREATE ROLE supabase_auth_admin LOGIN NOINHERIT CREATEROLE;
    EXECUTE 'CREATE SCHEMA IF NOT EXISTS auth AUTHORIZATION supabase_auth_admin';
    EXECUTE format('GRANT CREATE ON DATABASE %I TO supabase_auth_admin', current_database());
    ALTER ROLE supabase_auth_admin SET search_path = auth;
  END IF;
END $$;

GRANT crove_tenant TO crove_app, crove_worker;
ALTER ROLE crove_app SET search_path = pg_catalog, pg_temp;
ALTER ROLE crove_worker SET search_path = pg_catalog, pg_temp;

CREATE SCHEMA IF NOT EXISTS crove_kernel;
CREATE SCHEMA IF NOT EXISTS crove_finance;
GRANT USAGE ON SCHEMA crove_kernel, crove_finance TO crove_tenant;

-- ---------------------------------------------------------------------------
-- Ids and context helpers
-- ---------------------------------------------------------------------------
-- UUIDv7 from core functions only (no pgcrypto), so the schema runs on any PostgreSQL 17.
CREATE OR REPLACE FUNCTION crove_kernel.uuid_v7() RETURNS uuid
LANGUAGE plpgsql VOLATILE SET search_path = '' AS $$
DECLARE
  ts bigint := (extract(epoch FROM clock_timestamp()) * 1000)::bigint;
  b bytea := uuid_send(gen_random_uuid());
BEGIN
  b := set_byte(b, 0, ((ts >> 40) & 255)::int);
  b := set_byte(b, 1, ((ts >> 32) & 255)::int);
  b := set_byte(b, 2, ((ts >> 24) & 255)::int);
  b := set_byte(b, 3, ((ts >> 16) & 255)::int);
  b := set_byte(b, 4, ((ts >> 8) & 255)::int);
  b := set_byte(b, 5, (ts & 255)::int);
  b := set_byte(b, 6, (get_byte(b, 6) & 15) | 112);
  b := set_byte(b, 8, (get_byte(b, 8) & 63) | 128);
  RETURN encode(b, 'hex')::uuid;
END $$;

-- 24 hex chars of randomness for opaque tokens (random bytes of a v4 UUID, version/variant bytes skipped).
CREATE OR REPLACE FUNCTION crove_kernel.random_token() RETURNS text
LANGUAGE sql VOLATILE SET search_path = '' AS $$
  SELECT encode(substring(b FROM 1 FOR 6) || substring(b FROM 11 FOR 6), 'hex')
  FROM (SELECT uuid_send(gen_random_uuid()) AS b) r
$$;

CREATE OR REPLACE FUNCTION crove_kernel.ctx_org_id() RETURNS uuid
LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT nullif(pg_catalog.current_setting('crove.org_id', true), '')::uuid
$$;

CREATE OR REPLACE FUNCTION crove_kernel.ctx_user_id() RETURNS uuid
LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT nullif(pg_catalog.current_setting('crove.user_id', true), '')::uuid
$$;

-- Applies the standard tenant policy and grants to a table that has an org_id column.
CREATE OR REPLACE FUNCTION crove_kernel.apply_tenant_rls(t regclass, append_only boolean DEFAULT false) RETURNS void
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', t);
  EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %s', t);
  EXECUTE format(
    'CREATE POLICY tenant_isolation ON %s AS PERMISSIVE FOR ALL TO crove_tenant '
    'USING (org_id = (SELECT crove_kernel.ctx_org_id())) WITH CHECK (org_id = (SELECT crove_kernel.ctx_org_id()))', t);
  EXECUTE format('REVOKE ALL ON %s FROM PUBLIC, crove_tenant', t);
  IF append_only THEN
    EXECUTE format('GRANT SELECT, INSERT ON %s TO crove_tenant', t);
  ELSE
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %s TO crove_tenant', t);
  END IF;
END $$;

-- Blocks UPDATE, DELETE and TRUNCATE for every role, superusers included.
CREATE OR REPLACE FUNCTION crove_kernel.reject_mutation() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  RAISE EXCEPTION 'table %.% is append-only', TG_TABLE_SCHEMA, TG_TABLE_NAME USING ERRCODE = '42501';
END $$;

CREATE OR REPLACE FUNCTION crove_kernel.make_append_only(t regclass) RETURNS void
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  EXECUTE format('DROP TRIGGER IF EXISTS append_only_row ON %s', t);
  EXECUTE format('CREATE TRIGGER append_only_row BEFORE UPDATE OR DELETE ON %s FOR EACH ROW EXECUTE FUNCTION crove_kernel.reject_mutation()', t);
  EXECUTE format('DROP TRIGGER IF EXISTS append_only_truncate ON %s', t);
  EXECUTE format('CREATE TRIGGER append_only_truncate BEFORE TRUNCATE ON %s FOR EACH STATEMENT EXECUTE FUNCTION crove_kernel.reject_mutation()', t);
END $$;

-- ---------------------------------------------------------------------------
-- Identity (global machinery tables, no org_id)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS crove_kernel.user_account (
  id uuid PRIMARY KEY DEFAULT crove_kernel.uuid_v7(),
  issuer text NOT NULL,
  subject text NOT NULL,
  email text NOT NULL,
  display_name text,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (issuer, subject)
);
CREATE INDEX IF NOT EXISTS user_account_email_idx ON crove_kernel.user_account (lower(email));
REVOKE ALL ON crove_kernel.user_account FROM PUBLIC;
GRANT SELECT ON crove_kernel.user_account TO crove_tenant;

CREATE TABLE IF NOT EXISTS crove_kernel.tenant (
  org_id uuid PRIMARY KEY DEFAULT crove_kernel.uuid_v7(),
  slug text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,46}[a-z0-9]$'),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'closed')),
  inbound_token text NOT NULL UNIQUE DEFAULT crove_kernel.random_token(),
  base_currency text NOT NULL DEFAULT 'VND',
  created_by uuid NOT NULL REFERENCES crove_kernel.user_account (id),
  created_at timestamptz NOT NULL DEFAULT now()
);
SELECT crove_kernel.apply_tenant_rls('crove_kernel.tenant');

CREATE TABLE IF NOT EXISTS crove_kernel.tenant_member (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES crove_kernel.user_account (id),
  role text NOT NULL CHECK (role IN ('owner', 'admin', 'member', 'viewer')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, user_id)
);
CREATE INDEX IF NOT EXISTS tenant_member_user_idx ON crove_kernel.tenant_member (user_id);
SELECT crove_kernel.apply_tenant_rls('crove_kernel.tenant_member');

-- A user sees their own account and the accounts of members of the org in context, nobody else.
ALTER TABLE crove_kernel.user_account ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS member_visibility ON crove_kernel.user_account;
CREATE POLICY member_visibility ON crove_kernel.user_account AS PERMISSIVE FOR SELECT TO crove_tenant
  USING (
    id = (SELECT crove_kernel.ctx_user_id())
    OR id IN (SELECT m.user_id FROM crove_kernel.tenant_member m WHERE m.org_id = (SELECT crove_kernel.ctx_org_id()))
  );

-- Upserts the Crove user for a verified identity-provider subject. Called on every authenticated request.
CREATE OR REPLACE FUNCTION crove_kernel.identity_upsert(p_issuer text, p_subject text, p_email text, p_name text)
RETURNS uuid LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
  INSERT INTO crove_kernel.user_account AS u (issuer, subject, email, display_name)
  VALUES (p_issuer, p_subject, p_email, p_name)
  ON CONFLICT (issuer, subject) DO UPDATE
    SET email = excluded.email,
        display_name = coalesce(excluded.display_name, u.display_name),
        last_seen_at = now()
  RETURNING id
$$;

-- Orgs the user belongs to (org-less query).
CREATE OR REPLACE FUNCTION crove_kernel.my_orgs(p_user_id uuid)
RETURNS TABLE (org_id uuid, slug text, name text, role text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT t.org_id, t.slug, t.name, m.role
  FROM crove_kernel.tenant_member m
  JOIN crove_kernel.tenant t ON t.org_id = m.org_id
  WHERE m.user_id = p_user_id AND t.status = 'active'
  ORDER BY t.created_at
$$;

-- Creates an org with the caller as owner.
CREATE OR REPLACE FUNCTION crove_kernel.create_org(p_user_id uuid, p_slug text, p_name text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_org uuid;
BEGIN
  INSERT INTO crove_kernel.tenant (slug, name, created_by) VALUES (p_slug, p_name, p_user_id) RETURNING org_id INTO v_org;
  INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES (v_org, p_user_id, 'owner');
  RETURN v_org;
END $$;

-- Enters the tenant context for a member. Raises 42501 when the user is not an active member.
CREATE OR REPLACE FUNCTION crove_kernel.enter_context(p_user_id uuid, p_org_id uuid)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_role text;
BEGIN
  SELECT m.role INTO v_role
  FROM crove_kernel.tenant_member m
  JOIN crove_kernel.tenant t ON t.org_id = m.org_id
  WHERE m.org_id = p_org_id AND m.user_id = p_user_id AND t.status = 'active';
  IF v_role IS NULL THEN
    RAISE EXCEPTION 'NOT_A_MEMBER' USING ERRCODE = '42501';
  END IF;
  PERFORM pg_catalog.set_config('crove.org_id', p_org_id::text, true);
  PERFORM pg_catalog.set_config('crove.user_id', p_user_id::text, true);
  RETURN v_role;
END $$;

-- Enters a tenant context for system work (worker jobs, inbound email). No user.
CREATE OR REPLACE FUNCTION crove_kernel.enter_system_context(p_org_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM crove_kernel.tenant WHERE org_id = p_org_id AND status = 'active') THEN
    RAISE EXCEPTION 'TENANT_NOT_ACTIVE' USING ERRCODE = '42501';
  END IF;
  PERFORM pg_catalog.set_config('crove.org_id', p_org_id::text, true);
  PERFORM pg_catalog.set_config('crove.user_id', '', true);
END $$;

-- Resolves an inbound email address token to its org.
CREATE OR REPLACE FUNCTION crove_kernel.org_by_inbound_token(p_token text)
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT org_id FROM crove_kernel.tenant WHERE inbound_token = lower(p_token) AND status = 'active'
$$;

-- Finds a user by email for adding members (returns only the id).
CREATE OR REPLACE FUNCTION crove_kernel.user_id_by_email(p_email text)
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT id FROM crove_kernel.user_account WHERE lower(email) = lower(p_email) ORDER BY created_at LIMIT 1
$$;

-- ---------------------------------------------------------------------------
-- Command machinery: idempotency, outbox, audit
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS crove_kernel.idempotency_key (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  actor_key text NOT NULL,
  key text NOT NULL,
  command text NOT NULL,
  request_sha256 text NOT NULL,
  response jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, actor_key, key)
);
SELECT crove_kernel.apply_tenant_rls('crove_kernel.idempotency_key');

CREATE TABLE IF NOT EXISTS crove_kernel.outbox_event (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  type text NOT NULL,
  payload jsonb NOT NULL,
  actor_id uuid,
  command_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, id)
);
SELECT crove_kernel.apply_tenant_rls('crove_kernel.outbox_event', true);
SELECT crove_kernel.make_append_only('crove_kernel.outbox_event');
-- Writes go through crove_kernel.emit() only, which stamps org and actor from the context.
REVOKE INSERT ON crove_kernel.outbox_event FROM crove_tenant;

CREATE TABLE IF NOT EXISTS crove_kernel.outbox_pending (
  seq bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id uuid NOT NULL,
  event_id uuid NOT NULL,
  attempts int NOT NULL DEFAULT 0,
  last_error text
);
REVOKE ALL ON crove_kernel.outbox_pending FROM PUBLIC;

-- Inserts an event into the outbox, stamping org and actor from the context.
CREATE OR REPLACE FUNCTION crove_kernel.emit(p_type text, p_payload jsonb, p_command_id uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
  v_id uuid;
BEGIN
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'NO_CONTEXT' USING ERRCODE = '42501';
  END IF;
  INSERT INTO crove_kernel.outbox_event (org_id, type, payload, actor_id, command_id)
  VALUES (v_org, p_type, p_payload, crove_kernel.ctx_user_id(), p_command_id)
  RETURNING id INTO v_id;
  INSERT INTO crove_kernel.outbox_pending (org_id, event_id) VALUES (v_org, v_id);
  PERFORM pg_catalog.pg_notify('crove_outbox', '');
  RETURN v_id;
END $$;

-- Claims pending outbox rows for the relay (cross-tenant, system only).
CREATE OR REPLACE FUNCTION crove_kernel.outbox_claim(p_limit int)
RETURNS TABLE (seq bigint, org_id uuid, event_id uuid, type text, payload jsonb, actor_id uuid)
LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
  WITH claimed AS (
    DELETE FROM crove_kernel.outbox_pending p
    WHERE p.seq IN (
      SELECT seq FROM crove_kernel.outbox_pending ORDER BY seq LIMIT p_limit FOR UPDATE SKIP LOCKED
    )
    RETURNING p.seq, p.org_id, p.event_id
  )
  SELECT c.seq, c.org_id, c.event_id, e.type, e.payload, e.actor_id
  FROM claimed c JOIN crove_kernel.outbox_event e ON e.org_id = c.org_id AND e.id = c.event_id
  ORDER BY c.seq
$$;

CREATE TABLE IF NOT EXISTS crove_kernel.audit_event (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  actor_type text NOT NULL CHECK (actor_type IN ('user', 'system')),
  actor_id uuid,
  command text NOT NULL,
  command_id uuid NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('ok', 'pending_approval', 'denied', 'failed')),
  target_type text,
  target_id uuid,
  input_sha256 text NOT NULL,
  proposal_id uuid,
  detail jsonb,
  PRIMARY KEY (org_id, id)
);
CREATE INDEX IF NOT EXISTS audit_event_time_idx ON crove_kernel.audit_event (org_id, occurred_at DESC);
SELECT crove_kernel.apply_tenant_rls('crove_kernel.audit_event', true);
SELECT crove_kernel.make_append_only('crove_kernel.audit_event');

-- ---------------------------------------------------------------------------
-- Kernel module: party, file, inbound message, extraction, proposal, activity
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS crove_kernel.party (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  kind text NOT NULL DEFAULT 'organization' CHECK (kind IN ('organization', 'person')),
  name text NOT NULL,
  tax_code text,
  address text,
  email text,
  phone text,
  source_trust text NOT NULL DEFAULT 'user' CHECK (source_trust IN ('external', 'user', 'system')),
  verified_at timestamptz,
  verified_by uuid,
  version int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS party_tax_code_uq ON crove_kernel.party (org_id, tax_code) WHERE tax_code IS NOT NULL;
CREATE INDEX IF NOT EXISTS party_name_idx ON crove_kernel.party (org_id, lower(name));
SELECT crove_kernel.apply_tenant_rls('crove_kernel.party');

CREATE TABLE IF NOT EXISTS crove_kernel.file (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  storage_key text NOT NULL,
  filename text NOT NULL,
  content_type text NOT NULL,
  size_bytes bigint NOT NULL CHECK (size_bytes >= 0),
  source text NOT NULL CHECK (source IN ('upload', 'email')),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, id),
  UNIQUE (org_id, sha256)
);
SELECT crove_kernel.apply_tenant_rls('crove_kernel.file');

CREATE TABLE IF NOT EXISTS crove_kernel.inbound_message (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  message_id text NOT NULL,
  from_address text,
  subject text,
  attachment_count int NOT NULL DEFAULT 0,
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, id),
  UNIQUE (org_id, message_id)
);
SELECT crove_kernel.apply_tenant_rls('crove_kernel.inbound_message');

CREATE TABLE IF NOT EXISTS crove_kernel.extraction (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  file_id uuid NOT NULL,
  method text NOT NULL CHECK (method IN ('einvoice_xml', 'pdf_text_ai', 'image_ai', 'unsupported')),
  status text NOT NULL CHECK (status IN ('done', 'failed')),
  result jsonb,
  checks jsonb NOT NULL DEFAULT '[]'::jsonb,
  error text,
  tainted boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, id),
  FOREIGN KEY (org_id, file_id) REFERENCES crove_kernel.file (org_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS extraction_file_idx ON crove_kernel.extraction (org_id, file_id);
SELECT crove_kernel.apply_tenant_rls('crove_kernel.extraction');

CREATE TABLE IF NOT EXISTS crove_kernel.proposal (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  kind text NOT NULL,
  command text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'executed', 'rejected', 'failed')),
  title text NOT NULL,
  payload jsonb NOT NULL,
  revision int NOT NULL DEFAULT 1,
  source_file_id uuid,
  extraction_id uuid,
  duplicate_of uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_by uuid,
  decided_at timestamptz,
  decision_note text,
  executed_command_id uuid UNIQUE,
  result jsonb,
  PRIMARY KEY (org_id, id)
);
CREATE INDEX IF NOT EXISTS proposal_status_idx ON crove_kernel.proposal (org_id, status, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS proposal_extraction_uq ON crove_kernel.proposal (org_id, extraction_id) WHERE extraction_id IS NOT NULL;
SELECT crove_kernel.apply_tenant_rls('crove_kernel.proposal');

CREATE TABLE IF NOT EXISTS crove_kernel.activity (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  record_type text NOT NULL,
  record_id uuid NOT NULL,
  kind text NOT NULL,
  summary text NOT NULL,
  actor_id uuid,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, id)
);
CREATE INDEX IF NOT EXISTS activity_record_idx ON crove_kernel.activity (org_id, record_type, record_id, occurred_at DESC);
SELECT crove_kernel.apply_tenant_rls('crove_kernel.activity', true);

-- ---------------------------------------------------------------------------
-- Function privileges: nothing is callable by PUBLIC; the app role gets what it needs.
-- ---------------------------------------------------------------------------
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA crove_kernel FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  crove_kernel.uuid_v7(),
  crove_kernel.random_token(),
  crove_kernel.ctx_org_id(),
  crove_kernel.ctx_user_id(),
  crove_kernel.identity_upsert(text, text, text, text),
  crove_kernel.my_orgs(uuid),
  crove_kernel.create_org(uuid, text, text),
  crove_kernel.enter_context(uuid, uuid),
  crove_kernel.enter_system_context(uuid),
  crove_kernel.org_by_inbound_token(text),
  crove_kernel.user_id_by_email(text),
  crove_kernel.emit(text, jsonb, uuid)
TO crove_tenant;
GRANT EXECUTE ON FUNCTION crove_kernel.outbox_claim(int) TO crove_worker;
