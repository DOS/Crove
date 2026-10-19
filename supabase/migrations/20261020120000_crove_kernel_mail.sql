-- Outbound mail, step E1a of the Email plan (docs/plan/email.md §3.2 and §3.3, ADR-0034, issue #538). Idempotent;
-- applied files stay untouched.
--
-- Added here:
--   mail_message       one row per mail to one recipient, written in the transaction of the command that sends it:
--                      stream, source, template, the recipient and a keyed hash of it, subject, the Message-ID and the
--                      delivery status. Tenant roles read and insert it and update only the status columns; nothing
--                      deletes a row. A guard keeps the identity columns fixed and the status moves legal.
--   mail_suppression   the addresses an org must not mail, keyed on the same hash so a row outlives an erasure of the
--                      address. Scope 'all' (a hard bounce, a manual stop) or 'marketing' (a complaint, an unsubscribe
--                      from everything). Never deleted: lifting writes lifted_at, lifted_by and lift_reason once. One
--                      live row per org, hash and scope.
--   mail_hash_key      the deployment's key for that hash: one row, readable by no role, read only by the definer
--                      below. Unlike the context key it never rotates, since the hashes already stored must keep
--                      matching.
--   mail_address_hash  HMAC-SHA256 of an address under that key, built from core sha256() as the sealed context is (no
--                      pgcrypto). The address is folded as invite_cap_key folds it (case, spaces, the +tag, Gmail's
--                      dots), so the variants of one inbox share one suppression. Keyed, so a hash left after an
--                      erasure cannot be reversed by hashing a list of addresses.
--
-- The mail body is never stored here: an invite mail carries the raw invite token, which no table may hold.
SET LOCAL lock_timeout = '2s';

-- ---------------------------------------------------------------------------
-- The hash key (definer-only, no org)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS crove_kernel.mail_hash_key (
  id smallint PRIMARY KEY CHECK (id = 1),
  k_ipad bytea NOT NULL CHECK (pg_catalog.length(k_ipad) = 64),
  k_opad bytea NOT NULL CHECK (pg_catalog.length(k_opad) = 64),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now()
);
REVOKE ALL ON crove_kernel.mail_hash_key FROM PUBLIC;
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT rolname FROM pg_catalog.pg_roles WHERE rolname LIKE 'crove\_%' AND rolname <> current_user LOOP
    EXECUTE pg_catalog.format('REVOKE ALL ON crove_kernel.mail_hash_key FROM %I', r.rolname);
  END LOOP;
END $$;
ALTER TABLE crove_kernel.mail_hash_key ENABLE ROW LEVEL SECURITY;
SELECT crove_kernel.agent_write_guard_install('crove_kernel.mail_hash_key');

DO $$
DECLARE
  v_key bytea;
  v_ipad bytea;
  v_opad bytea;
  i int;
BEGIN
  IF EXISTS (SELECT 1 FROM crove_kernel.mail_hash_key) THEN
    RETURN;
  END IF;
  -- 32-byte key, zero-padded to the 64-byte block as HMAC specifies.
  v_key := pg_catalog.sha256(
             pg_catalog.uuid_send(pg_catalog.gen_random_uuid()) || pg_catalog.uuid_send(pg_catalog.gen_random_uuid())
             || pg_catalog.uuid_send(pg_catalog.gen_random_uuid()) || pg_catalog.uuid_send(pg_catalog.gen_random_uuid()))
           || pg_catalog.decode(pg_catalog.repeat('00', 32), 'hex');
  v_ipad := v_key;
  v_opad := v_key;
  FOR i IN 0..63 LOOP
    v_ipad := pg_catalog.set_byte(v_ipad, i, pg_catalog.get_byte(v_key, i) # 54);
    v_opad := pg_catalog.set_byte(v_opad, i, pg_catalog.get_byte(v_key, i) # 92);
  END LOOP;
  INSERT INTO crove_kernel.mail_hash_key (id, k_ipad, k_opad) VALUES (1, v_ipad, v_opad);
END $$;

-- The keyed hash of an address, hex. NULL for an empty address; raises when the key is missing.
CREATE OR REPLACE FUNCTION crove_kernel.mail_address_hash(p_address text)
RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_ipad bytea;
  v_opad bytea;
  v_folded text;
BEGIN
  IF p_address IS NULL OR pg_catalog.btrim(p_address) = '' THEN
    RETURN NULL;
  END IF;
  SELECT k.k_ipad, k.k_opad INTO v_ipad, v_opad FROM crove_kernel.mail_hash_key k WHERE k.id = 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'MAIL_HASH_KEY_MISSING' USING ERRCODE = '55000';
  END IF;
  v_folded := crove_kernel.invite_cap_key(p_address);
  RETURN pg_catalog.encode(
    pg_catalog.sha256(v_opad || pg_catalog.sha256(v_ipad || pg_catalog.convert_to('crove.mail.v1' || pg_catalog.chr(31) || v_folded, 'UTF8'))),
    'hex');
END $$;
REVOKE ALL ON FUNCTION crove_kernel.mail_address_hash(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crove_kernel.mail_address_hash(text) TO crove_tenant;

-- ---------------------------------------------------------------------------
-- mail_message (tenant table)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS crove_kernel.mail_message (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  -- system: mail the platform sends (invites); transactional: one recipient, for the org's own work; marketing: a
  -- campaign. Marketing has its own queue and suppression scope (Email plan §1).
  stream text NOT NULL CHECK (stream IN ('system', 'transactional', 'marketing')),
  -- The command that sent it, and the record it is about (an invite, a document request).
  source text NOT NULL CONSTRAINT mail_message_source_format
    CHECK (pg_catalog.length(source) <= 100 AND source ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
  source_id uuid,
  template_key text NOT NULL CONSTRAINT mail_message_template_format
    CHECK (pg_catalog.length(template_key) <= 100 AND template_key ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
  template_version integer NOT NULL DEFAULT 1 CHECK (template_version BETWEEN 1 AND 100000),
  -- The recipient as normalized (lower-cased, trimmed). Nullable so a later retention purge can drop it and keep the
  -- hash.
  to_address text CONSTRAINT mail_message_to_format
    CHECK (to_address IS NULL OR (to_address = pg_catalog.lower(pg_catalog.btrim(to_address))
      AND pg_catalog.length(to_address) BETWEEN 3 AND 320 AND to_address LIKE '_%@_%')),
  to_hash text NOT NULL CONSTRAINT mail_message_hash_format CHECK (to_hash ~ '^[0-9a-f]{64}$'),
  subject text CHECK (subject IS NULL OR pg_catalog.length(subject) <= 998),
  -- Merge data for a mail the worker renders later (none in E1a); never a secret.
  payload jsonb CHECK (payload IS NULL OR pg_catalog.jsonb_typeof(payload) = 'object'),
  -- The RFC 5322 Message-ID, generated once and kept across attempts.
  message_id_header text NOT NULL CHECK (pg_catalog.length(message_id_header) BETWEEN 5 AND 255
    AND message_id_header LIKE '<_%@_%>'),
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'sending', 'sent', 'delivered', 'bounced', 'complained', 'suppressed', 'failed', 'ambiguous')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 1000),
  provider text CHECK (provider IS NULL OR provider ~ '^[a-z][a-z0-9_]{0,31}$'),
  provider_message_id text CHECK (provider_message_id IS NULL OR pg_catalog.length(provider_message_id) <= 255),
  error_code text CHECK (error_code IS NULL OR pg_catalog.length(error_code) <= 200),
  created_by uuid REFERENCES crove_kernel.user_account (id),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  sent_at timestamptz,
  PRIMARY KEY (org_id, id),
  CONSTRAINT mail_message_sent CHECK (status NOT IN ('sent', 'delivered', 'bounced', 'complained') OR sent_at IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS mail_message_org_created_idx ON crove_kernel.mail_message (org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS mail_message_source_idx ON crove_kernel.mail_message (org_id, source, source_id);
CREATE INDEX IF NOT EXISTS mail_message_hash_idx ON crove_kernel.mail_message (org_id, to_hash);
CREATE INDEX IF NOT EXISTS mail_message_created_by_idx ON crove_kernel.mail_message (created_by);
CREATE INDEX IF NOT EXISTS mail_message_queued_idx ON crove_kernel.mail_message (created_at) WHERE status IN ('queued', 'ambiguous');

SELECT crove_kernel.apply_tenant_rls('crove_kernel.mail_message');
REVOKE UPDATE, DELETE ON crove_kernel.mail_message FROM crove_tenant;
GRANT UPDATE (status, attempts, provider, provider_message_id, error_code, sent_at, updated_at) ON crove_kernel.mail_message TO crove_tenant;

-- The moves a mail's status may make. A no-op update (the same status) passes.
CREATE OR REPLACE FUNCTION crove_kernel.mail_message_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status NOT IN ('queued', 'sending', 'suppressed') OR NEW.sent_at IS NOT NULL OR NEW.provider_message_id IS NOT NULL THEN
      RAISE EXCEPTION 'MAIL_MESSAGE_INSERT' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.org_id IS DISTINCT FROM OLD.org_id OR NEW.id IS DISTINCT FROM OLD.id OR NEW.stream IS DISTINCT FROM OLD.stream
     OR NEW.source IS DISTINCT FROM OLD.source OR NEW.source_id IS DISTINCT FROM OLD.source_id
     OR NEW.template_key IS DISTINCT FROM OLD.template_key OR NEW.template_version IS DISTINCT FROM OLD.template_version
     OR NEW.to_hash IS DISTINCT FROM OLD.to_hash OR NEW.message_id_header IS DISTINCT FROM OLD.message_id_header
     OR NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.created_at IS DISTINCT FROM OLD.created_at
     -- The address, subject and payload may only be dropped (a retention purge), never changed.
     OR (NEW.to_address IS DISTINCT FROM OLD.to_address AND NEW.to_address IS NOT NULL)
     OR (NEW.subject IS DISTINCT FROM OLD.subject AND NEW.subject IS NOT NULL)
     OR (NEW.payload IS DISTINCT FROM OLD.payload AND NEW.payload IS NOT NULL) THEN
    RAISE EXCEPTION 'MAIL_MESSAGE_IMMUTABLE' USING ERRCODE = '23514';
  END IF;
  IF NEW.attempts < OLD.attempts THEN
    RAISE EXCEPTION 'MAIL_MESSAGE_ATTEMPTS' USING ERRCODE = '23514';
  END IF;
  IF NEW.status <> OLD.status AND NOT (
       (OLD.status = 'queued' AND NEW.status IN ('sending', 'suppressed', 'failed'))
    OR (OLD.status = 'sending' AND NEW.status IN ('sent', 'failed', 'ambiguous'))
    OR (OLD.status = 'ambiguous' AND NEW.status IN ('sending', 'sent', 'failed'))
    OR (OLD.status = 'sent' AND NEW.status IN ('delivered', 'bounced', 'complained'))
    OR (OLD.status = 'delivered' AND NEW.status IN ('bounced', 'complained'))) THEN
    RAISE EXCEPTION 'MAIL_MESSAGE_STATUS' USING ERRCODE = '23514', DETAIL = OLD.status || ' -> ' || NEW.status;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION crove_kernel.mail_message_guard() FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
DROP TRIGGER IF EXISTS mail_message_guard ON crove_kernel.mail_message;
CREATE TRIGGER mail_message_guard BEFORE INSERT OR UPDATE ON crove_kernel.mail_message
  FOR EACH ROW EXECUTE FUNCTION crove_kernel.mail_message_guard();

-- ---------------------------------------------------------------------------
-- mail_suppression (tenant table)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS crove_kernel.mail_suppression (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  to_hash text NOT NULL CONSTRAINT mail_suppression_hash_format CHECK (to_hash ~ '^[0-9a-f]{64}$'),
  scope text NOT NULL CHECK (scope IN ('all', 'marketing')),
  reason text NOT NULL CHECK (reason IN ('hard_bounce', 'complaint', 'unsubscribe_all', 'manual', 'provider')),
  -- The mail whose bounce or complaint caused it, when one did.
  source_message_id uuid,
  created_by uuid REFERENCES crove_kernel.user_account (id),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  lifted_at timestamptz,
  lifted_by uuid REFERENCES crove_kernel.user_account (id),
  lift_reason text CHECK (lift_reason IS NULL OR pg_catalog.length(pg_catalog.btrim(lift_reason)) BETWEEN 1 AND 500),
  PRIMARY KEY (org_id, id),
  CONSTRAINT mail_suppression_lifted CHECK ((lifted_at IS NULL) = (lifted_by IS NULL) AND (lifted_at IS NULL) = (lift_reason IS NULL)),
  CONSTRAINT mail_suppression_source_fk FOREIGN KEY (org_id, source_message_id) REFERENCES crove_kernel.mail_message (org_id, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS mail_suppression_live_uq ON crove_kernel.mail_suppression (org_id, to_hash, scope) WHERE lifted_at IS NULL;
CREATE INDEX IF NOT EXISTS mail_suppression_source_idx ON crove_kernel.mail_suppression (org_id, source_message_id);
CREATE INDEX IF NOT EXISTS mail_suppression_created_by_idx ON crove_kernel.mail_suppression (created_by);
CREATE INDEX IF NOT EXISTS mail_suppression_lifted_by_idx ON crove_kernel.mail_suppression (lifted_by);

SELECT crove_kernel.apply_tenant_rls('crove_kernel.mail_suppression');
REVOKE UPDATE, DELETE ON crove_kernel.mail_suppression FROM crove_tenant;
GRANT UPDATE (lifted_at, lifted_by, lift_reason) ON crove_kernel.mail_suppression TO crove_tenant;

-- A suppression is inserted live and lifted at most once; nothing else about it changes. A no-op update passes.
CREATE OR REPLACE FUNCTION crove_kernel.mail_suppression_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.lifted_at IS NOT NULL THEN
      RAISE EXCEPTION 'MAIL_SUPPRESSION_INSERT' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.org_id IS DISTINCT FROM OLD.org_id OR NEW.id IS DISTINCT FROM OLD.id OR NEW.to_hash IS DISTINCT FROM OLD.to_hash
     OR NEW.scope IS DISTINCT FROM OLD.scope OR NEW.reason IS DISTINCT FROM OLD.reason
     OR NEW.source_message_id IS DISTINCT FROM OLD.source_message_id OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'MAIL_SUPPRESSION_IMMUTABLE' USING ERRCODE = '23514';
  END IF;
  IF OLD.lifted_at IS NOT NULL AND (NEW.lifted_at IS DISTINCT FROM OLD.lifted_at OR NEW.lifted_by IS DISTINCT FROM OLD.lifted_by
       OR NEW.lift_reason IS DISTINCT FROM OLD.lift_reason) THEN
    RAISE EXCEPTION 'MAIL_SUPPRESSION_LIFTED' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION crove_kernel.mail_suppression_guard() FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
DROP TRIGGER IF EXISTS mail_suppression_guard ON crove_kernel.mail_suppression;
CREATE TRIGGER mail_suppression_guard BEFORE INSERT OR UPDATE ON crove_kernel.mail_suppression
  FOR EACH ROW EXECUTE FUNCTION crove_kernel.mail_suppression_guard();
