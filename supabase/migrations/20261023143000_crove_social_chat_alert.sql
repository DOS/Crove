-- Team alerts in a Telegram or Discord chat (issue #863). Idempotent; applied files stay untouched.
--
-- crove_social.chat_alert         the org's team chat for Social alerts: Telegram or Discord, its title, the alert
--                                 kinds it gets and the outcome of the last test line. One per org, kept by the
--                                 commands under a per-org lock. Tenant data: every member reads it, owners and admins
--                                 change it through the commands. It holds no secret.
-- crove_social.chat_alert_target  the chat's target (a Telegram bot's token and the chat's id, or a Discord webhook's
--                                 id and token), sealed by the deployment's credential broker for the binding (org,
--                                 'social.chat_alert', the alert's id), as crove_kernel.credential holds a channel's
--                                 tokens: the key never reaches the database, and no Crove role holds a grant on it.
--                                   chat_alert_target_put   seals in (save): owners and admins of the org in context,
--                                                           or the system;
--                                   chat_alert_target_get   reads out: the worker only, in the system context of the
--                                                           org, and only while the member who saved the chat is still
--                                                           an owner or admin of the org and not disabled;
--                                   chat_alert_target_drop  forgets it (remove; the cascade from chat_alert also does).
--                                 After a credential key rotation the worker reseals the targets still under the
--                                 previous key, as it does channel credentials (#776): chat_alert_target_reseal_due
--                                 lists them (ids and key ids only), chat_alert_target_reseal stores the new envelope
--                                 only if the stored one is still the one it read, and chat_alert_target_key_counts says
--                                 how many each key still seals, of usable targets and of the others (whose saver left:
--                                 those reseal when the chat is saved again).
--                                 So the API seals a target in and never reads it back; only the worker opens it, to
--                                 post an alert or an owner's test line.
-- social-chat-alert               the worker's queue: one job per alerting outbox event, and test lines.
SET LOCAL lock_timeout = '2s';

CREATE TABLE IF NOT EXISTS crove_social.chat_alert (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  kind text NOT NULL CHECK (kind IN ('telegram', 'discord')),
  -- The chat's title or the webhook's name, as the platform gave it when the target was checked. Not a secret.
  label text CHECK (label IS NULL OR length(label) BETWEEN 1 AND 200),
  -- The alert kinds the chat gets (CHAT_ALERT_KINDS in modules/social).
  events text[] NOT NULL CHECK (events <@ ARRAY['needs_approval', 'failed', 'published', 'client_answered']::text[]),
  -- The member who saved the target; the worker opens it only while they are an owner or admin of the org.
  updated_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- The last test line the worker sent: when, and why it did not go out (NULL: it did).
  last_test_at timestamptz,
  last_test_code text CHECK (last_test_code IS NULL OR last_test_code ~ '^[A-Z_]{1,64}$'),
  PRIMARY KEY (org_id, id),
  CONSTRAINT chat_alert_events_some CHECK (cardinality(events) BETWEEN 1 AND 4)
);
SELECT crove_kernel.apply_tenant_rls('crove_social.chat_alert');

CREATE TABLE IF NOT EXISTS crove_social.chat_alert_target (
  org_id uuid NOT NULL,
  alert_id uuid NOT NULL,
  -- Which credential key sealed the envelope, for rotation.
  key_id text NOT NULL CHECK (key_id ~ '^[A-Za-z0-9_.-]{1,64}$'),
  envelope bytea NOT NULL CHECK (octet_length(envelope) BETWEEN 1 AND 4096),
  sealed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, alert_id),
  CONSTRAINT chat_alert_target_alert_fk FOREIGN KEY (org_id, alert_id)
    REFERENCES crove_social.chat_alert (org_id, id) ON DELETE CASCADE
);
ALTER TABLE crove_social.chat_alert_target ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON crove_social.chat_alert_target FROM PUBLIC, crove_tenant, crove_app, crove_worker;
-- Definer-only tables skip apply_tenant_rls, which installs the agent write guard (#285) on tenant tables; an agent
-- context never saves or removes a team chat.
SELECT crove_kernel.agent_write_guard_install('crove_social.chat_alert_target');

-- Seals in, or replaces, the target of the org's chat alert with this id. Raises NO_CONTEXT (42501) without a context,
-- CREDENTIAL_FORBIDDEN (42501) for an actor that is neither the system nor an owner or admin of the org, and
-- CHAT_ALERT_NOT_SET (P0002) when the org has no chat alert with that id.
CREATE OR REPLACE FUNCTION crove_social.chat_alert_target_put(p_alert_id uuid, p_key_id text, p_envelope bytea)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
  v_actor_type text := crove_kernel.ctx_actor_type();
  v_user uuid := crove_kernel.ctx_user_id();
BEGIN
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'NO_CONTEXT' USING ERRCODE = '42501';
  END IF;
  IF v_actor_type IS DISTINCT FROM 'system' AND NOT EXISTS (
    SELECT 1 FROM crove_kernel.tenant_member m
    WHERE m.org_id = v_org AND m.user_id = v_user AND v_actor_type = 'user' AND m.role IN ('owner', 'admin')
  ) THEN
    RAISE EXCEPTION 'CREDENTIAL_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  PERFORM 1 FROM crove_social.chat_alert a WHERE a.org_id = v_org AND a.id = p_alert_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CHAT_ALERT_NOT_SET' USING ERRCODE = 'P0002';
  END IF;
  INSERT INTO crove_social.chat_alert_target AS t (org_id, alert_id, key_id, envelope)
  VALUES (v_org, p_alert_id, p_key_id, p_envelope)
  ON CONFLICT (org_id, alert_id) DO UPDATE
    SET key_id = EXCLUDED.key_id, envelope = EXCLUDED.envelope, sealed_at = pg_catalog.now();
END $$;

-- The sealed target of the org's chat alert, for the worker in the system context of its org. Raises NO_CONTEXT
-- (42501) outside a system context, CHAT_ALERT_NOT_SET (P0002) when the org has no such alert or it has no target, and
-- CHAT_ALERT_OWNER_LEFT (42501) when the member who saved it has left the org, is no longer an owner or admin, or is
-- disabled (as credential_get: the chat needs saving again by someone who may).
CREATE OR REPLACE FUNCTION crove_social.chat_alert_target_get(p_alert_id uuid)
RETURNS TABLE (key_id text, envelope bytea)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
  v_alert crove_social.chat_alert%ROWTYPE;
BEGIN
  IF v_org IS NULL OR crove_kernel.ctx_actor_type() IS DISTINCT FROM 'system' THEN
    RAISE EXCEPTION 'NO_CONTEXT' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_alert FROM crove_social.chat_alert a WHERE a.org_id = v_org AND a.id = p_alert_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CHAT_ALERT_NOT_SET' USING ERRCODE = 'P0002';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM crove_kernel.tenant_member m JOIN crove_kernel.user_account u ON u.id = m.user_id
    WHERE m.org_id = v_org AND m.user_id = v_alert.updated_by AND m.role IN ('owner', 'admin') AND u.disabled_at IS NULL
  ) THEN
    RAISE EXCEPTION 'CHAT_ALERT_OWNER_LEFT' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
    SELECT t.key_id, t.envelope FROM crove_social.chat_alert_target t WHERE t.org_id = v_org AND t.alert_id = p_alert_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CHAT_ALERT_NOT_SET' USING ERRCODE = 'P0002';
  END IF;
END $$;

-- Forgets the target of the org's chat alert with this id. Same actors as chat_alert_target_put; no target is a no-op.
CREATE OR REPLACE FUNCTION crove_social.chat_alert_target_drop(p_alert_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
  v_actor_type text := crove_kernel.ctx_actor_type();
  v_user uuid := crove_kernel.ctx_user_id();
BEGIN
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'NO_CONTEXT' USING ERRCODE = '42501';
  END IF;
  IF v_actor_type IS DISTINCT FROM 'system' AND NOT EXISTS (
    SELECT 1 FROM crove_kernel.tenant_member m
    WHERE m.org_id = v_org AND m.user_id = v_user AND v_actor_type = 'user' AND m.role IN ('owner', 'admin')
  ) THEN
    RAISE EXCEPTION 'CREDENTIAL_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  DELETE FROM crove_social.chat_alert_target t WHERE t.org_id = v_org AND t.alert_id = p_alert_id;
END $$;

-- Whether the worker may use the target of this alert: the member who saved it is still an owner or admin of the org
-- and not disabled (the rule of chat_alert_target_get).
CREATE OR REPLACE FUNCTION crove_social.chat_alert_target_usable(p_org_id uuid, p_alert_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM crove_social.chat_alert a
    JOIN crove_kernel.tenant_member m ON m.org_id = a.org_id AND m.user_id = a.updated_by AND m.role IN ('owner', 'admin')
    JOIN crove_kernel.user_account u ON u.id = m.user_id AND u.disabled_at IS NULL
    WHERE a.org_id = p_org_id AND a.id = p_alert_id
  )
$$;

-- The worker's scan, across active orgs, of usable targets sealed with a key other than the given (current) one: ids
-- and key ids only, in pages after a (sealed_at, alert_id) cursor, so a target that cannot be resealed never holds back
-- the ones after it.
CREATE OR REPLACE FUNCTION crove_social.chat_alert_target_reseal_due(p_key_id text, p_limit int, p_after_sealed timestamptz, p_after_id uuid)
RETURNS TABLE (org_id uuid, alert_id uuid, key_id text, sealed_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT k.org_id, k.alert_id, k.key_id, k.sealed_at
  FROM crove_social.chat_alert_target k
  JOIN crove_kernel.tenant t ON t.org_id = k.org_id AND t.status = 'active'
  WHERE k.key_id <> p_key_id
    AND crove_social.chat_alert_target_usable(k.org_id, k.alert_id)
    AND (p_after_sealed IS NULL OR (k.sealed_at, k.alert_id) > (p_after_sealed, p_after_id))
  ORDER BY k.sealed_at, k.alert_id
  LIMIT LEAST(GREATEST(p_limit, 1), 1000)
$$;

-- How many targets each key id still seals: usable ones (resealed by the worker) and the others.
CREATE OR REPLACE FUNCTION crove_social.chat_alert_target_key_counts()
RETURNS TABLE (key_id text, active bigint, inactive bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT k.key_id,
    count(*) FILTER (WHERE crove_social.chat_alert_target_usable(k.org_id, k.alert_id)),
    count(*) FILTER (WHERE NOT crove_social.chat_alert_target_usable(k.org_id, k.alert_id))
  FROM crove_social.chat_alert_target k
  GROUP BY k.key_id
$$;

-- Stores a resealed target, for the worker in the system context of its org, only if the stored envelope is still the
-- one it read (its key id and the hex SHA-256 of its bytes), the key changes, and the target is still usable. Returns
-- whether it stored it. Raises NO_CONTEXT (42501) outside a system context.
CREATE OR REPLACE FUNCTION crove_social.chat_alert_target_reseal(p_alert_id uuid, p_from_key_id text, p_from_sha256 text, p_key_id text, p_envelope bytea)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
  v_target crove_social.chat_alert_target%ROWTYPE;
BEGIN
  IF v_org IS NULL OR crove_kernel.ctx_actor_type() IS DISTINCT FROM 'system' THEN
    RAISE EXCEPTION 'NO_CONTEXT' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_target FROM crove_social.chat_alert_target t WHERE t.org_id = v_org AND t.alert_id = p_alert_id FOR UPDATE;
  IF NOT FOUND OR v_target.key_id IS DISTINCT FROM p_from_key_id OR p_from_key_id = p_key_id
     OR pg_catalog.encode(pg_catalog.sha256(v_target.envelope), 'hex') IS DISTINCT FROM p_from_sha256
     OR NOT crove_social.chat_alert_target_usable(v_org, p_alert_id) THEN
    RETURN false;
  END IF;
  UPDATE crove_social.chat_alert_target t SET key_id = p_key_id, envelope = p_envelope, sealed_at = pg_catalog.now()
  WHERE t.org_id = v_org AND t.alert_id = p_alert_id;
  RETURN true;
END $$;

REVOKE ALL ON FUNCTION crove_social.chat_alert_target_put(uuid, text, bytea) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
REVOKE ALL ON FUNCTION crove_social.chat_alert_target_get(uuid) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
REVOKE ALL ON FUNCTION crove_social.chat_alert_target_drop(uuid) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
REVOKE ALL ON FUNCTION crove_social.chat_alert_target_usable(uuid, uuid) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
REVOKE ALL ON FUNCTION crove_social.chat_alert_target_reseal_due(text, int, timestamptz, uuid) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
REVOKE ALL ON FUNCTION crove_social.chat_alert_target_key_counts() FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
REVOKE ALL ON FUNCTION crove_social.chat_alert_target_reseal(uuid, text, text, text, bytea) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_social.chat_alert_target_put(uuid, text, bytea) TO crove_app, crove_worker;
GRANT EXECUTE ON FUNCTION crove_social.chat_alert_target_drop(uuid) TO crove_app, crove_worker;
-- Reading a target out is the worker's alone: the API seals targets in, it never reads them back.
GRANT EXECUTE ON FUNCTION crove_social.chat_alert_target_get(uuid) TO crove_worker;
-- Resealing after a key rotation is the worker's alone too.
GRANT EXECUTE ON FUNCTION crove_social.chat_alert_target_reseal_due(text, int, timestamptz, uuid) TO crove_worker;
GRANT EXECUTE ON FUNCTION crove_social.chat_alert_target_key_counts() TO crove_worker;
GRANT EXECUTE ON FUNCTION crove_social.chat_alert_target_reseal(uuid, text, text, text, bytea) TO crove_worker;

-- create_queue skips a queue that exists.
SELECT crove_jobs.create_queue('social-chat-alert', '{"policy":"standard"}'::jsonb);
