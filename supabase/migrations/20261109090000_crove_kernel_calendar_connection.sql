-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove kernel (issue #2123, part of #1374, plan docs/plan/calendar.md decision CAL-4): a member connects an outside
-- calendar, and its busy times block booking slots. Idempotent; applied files stay untouched.
--
-- calendar_connection   one row per outside calendar account a member connected (Google now; Microsoft 365 and CalDAV
--                       later). It is the member's own: a member reads and changes only theirs (the system context,
--                       the worker's sync, reads all). Tokens are not here.
-- calendar_credential   the connection's tokens, sealed by the deployment's credential key like channel credentials
--                       (ADR-0025, packages/kernel-runtime/src/vault.ts). Definer-only machinery: no Crove role holds a
--                       grant on it.
--                         calendar_credential_put   seals in (connect, refresh): the member who owns the connection,
--                                                   or the system (the worker refreshing a token);
--                         calendar_credential_get   reads out: the worker only, in the system context of the org, and
--                                                   only while the member is still an owner, admin or member of the
--                                                   org and not disabled;
--                         calendar_credential_drop  forgets it (disconnect).
-- calendar_oauth_begin / calendar_oauth_consume  the single-use OAuth state of a calendar connect, in the existing
--                       oauth_state table: the same rules as oauth_state_create / oauth_state_consume, but for any
--                       member who edits (not owners and admins only) and only for the calendar providers.
-- calendar_event        gains the kinds google, microsoft and caldav: the busy times of a connected calendar, with a
--                       source_id (the connection) and an external_id (one per interval, for the diff). Only start
--                       and end are kept: no title, no attendees. Deleting a connection deletes its blocks.
-- calendar_sync_due     the active connections of active orgs after a key, for the worker's sweep.
-- The worker's sweep runs every 15 minutes in its own timer, one at a time across processes (no queue).
SET LOCAL lock_timeout = '2s';

CREATE TABLE IF NOT EXISTS crove_kernel.calendar_connection (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  -- The member who owns the calendar. Not a foreign key, like channel_connection.connected_by: the sync checks that
  -- this user is still a member (calendar_credential_get).
  user_id uuid NOT NULL,
  provider text NOT NULL CHECK (provider IN ('google', 'microsoft', 'caldav')),
  -- The account's address as the provider names it, lowercased.
  external_account text NOT NULL CHECK (pg_catalog.length(external_account) BETWEEN 1 AND 200),
  display_name text NOT NULL CHECK (pg_catalog.length(display_name) BETWEEN 1 AND 200),
  scopes text[] NOT NULL DEFAULT '{}' CHECK (pg_catalog.cardinality(scopes) <= 20),
  -- expired: the provider refused the grant (the member revoked the app); the member reconnects. A sync that failed
  -- for another reason leaves the connection active and says why in status_reason; the next sweep tries again.
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'expired')),
  status_reason text CHECK (status_reason IS NULL OR pg_catalog.length(status_reason) <= 500),
  -- When the access token expires, if the provider says.
  expires_at timestamptz,
  last_synced_at timestamptz,
  -- Whether bookings are written to this calendar (part of #1374, off until then).
  write_back boolean NOT NULL DEFAULT false,
  connected_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (org_id, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS calendar_connection_account_uq ON crove_kernel.calendar_connection (org_id, user_id, provider, external_account);
SELECT crove_kernel.apply_tenant_rls('crove_kernel.calendar_connection');
-- Commands change the state of a connection, never its owner, provider or account.
REVOKE UPDATE ON crove_kernel.calendar_connection FROM crove_tenant;
GRANT UPDATE (display_name, scopes, status, status_reason, expires_at, last_synced_at, write_back, updated_at) ON crove_kernel.calendar_connection TO crove_tenant;
DROP POLICY IF EXISTS own_calendar_connection ON crove_kernel.calendar_connection;
-- Each context function is wrapped in a subquery, as the tenant policy is, so it runs once per statement.
CREATE POLICY own_calendar_connection ON crove_kernel.calendar_connection AS RESTRICTIVE FOR ALL TO crove_tenant
  USING (user_id = (SELECT crove_kernel.ctx_user_id()) OR ((SELECT crove_kernel.ctx_user_id()) IS NULL AND (SELECT crove_kernel.ctx_agent_id()) IS NULL))
  WITH CHECK (user_id = (SELECT crove_kernel.ctx_user_id()) OR ((SELECT crove_kernel.ctx_user_id()) IS NULL AND (SELECT crove_kernel.ctx_agent_id()) IS NULL));

CREATE TABLE IF NOT EXISTS crove_kernel.calendar_credential (
  org_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  -- Which credential key sealed the envelope, for rotation.
  key_id text NOT NULL CHECK (key_id ~ '^[A-Za-z0-9_.-]{1,64}$'),
  envelope bytea NOT NULL CHECK (pg_catalog.octet_length(envelope) BETWEEN 1 AND 65536),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  sealed_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (org_id, connection_id),
  CONSTRAINT calendar_credential_connection_fk FOREIGN KEY (org_id, connection_id)
    REFERENCES crove_kernel.calendar_connection (org_id, id) ON DELETE CASCADE
);
ALTER TABLE crove_kernel.calendar_credential ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON crove_kernel.calendar_credential FROM PUBLIC, crove_tenant, crove_app, crove_worker;
-- Definer-only tables skip apply_tenant_rls, which installs the agent write guard (#285) on tenant tables.
SELECT crove_kernel.agent_write_guard_install('crove_kernel.calendar_credential');

-- Seals in, or replaces, the credential of a connection of the org in context. Raises NO_CONTEXT (42501) without a
-- context, CALENDAR_FORBIDDEN (42501) for an actor that is neither the system nor the member who owns the connection
-- (and still edits in the org), and CALENDAR_NOT_FOUND (P0002) when the org has no such connection.
CREATE OR REPLACE FUNCTION crove_kernel.calendar_credential_put(p_connection_id uuid, p_key_id text, p_envelope bytea)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
  v_actor_type text := crove_kernel.ctx_actor_type();
  v_user uuid := crove_kernel.ctx_user_id();
  v_owner uuid;
BEGIN
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'NO_CONTEXT' USING ERRCODE = '42501';
  END IF;
  SELECT c.user_id INTO v_owner FROM crove_kernel.calendar_connection c
  WHERE c.org_id = v_org AND c.id = p_connection_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CALENDAR_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  IF v_actor_type IS DISTINCT FROM 'system' AND NOT (
    v_actor_type = 'user' AND v_user = v_owner AND EXISTS (
      SELECT 1 FROM crove_kernel.tenant_member m
      WHERE m.org_id = v_org AND m.user_id = v_user AND m.role IN ('owner', 'admin', 'member')
    )
  ) THEN
    RAISE EXCEPTION 'CALENDAR_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  INSERT INTO crove_kernel.calendar_credential AS k (org_id, connection_id, key_id, envelope)
  VALUES (v_org, p_connection_id, p_key_id, p_envelope)
  ON CONFLICT (org_id, connection_id) DO UPDATE
    SET key_id = EXCLUDED.key_id, envelope = EXCLUDED.envelope, sealed_at = pg_catalog.now();
END $$;

-- The sealed credential of an active connection, for the worker in the system context of its org. Raises NO_CONTEXT
-- (42501) outside a system context, CALENDAR_NOT_FOUND (P0002) when the org has no such connection or it has no
-- credential, CALENDAR_NOT_ACTIVE (55000) when the connection is expired, and CALENDAR_OWNER_LEFT (42501)
-- when the member who owns it has left the org, no longer edits in it, or is disabled.
CREATE OR REPLACE FUNCTION crove_kernel.calendar_credential_get(p_connection_id uuid)
RETURNS TABLE (key_id text, envelope bytea, provider text, external_account text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
  v_connection crove_kernel.calendar_connection%ROWTYPE;
BEGIN
  IF v_org IS NULL OR crove_kernel.ctx_actor_type() IS DISTINCT FROM 'system' THEN
    RAISE EXCEPTION 'NO_CONTEXT' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_connection FROM crove_kernel.calendar_connection c WHERE c.org_id = v_org AND c.id = p_connection_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CALENDAR_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM crove_kernel.tenant_member m JOIN crove_kernel.user_account u ON u.id = m.user_id
    WHERE m.org_id = v_org AND m.user_id = v_connection.user_id AND m.role IN ('owner', 'admin', 'member') AND u.disabled_at IS NULL
  ) THEN
    RAISE EXCEPTION 'CALENDAR_OWNER_LEFT' USING ERRCODE = '42501';
  END IF;
  IF v_connection.status <> 'active' THEN
    RAISE EXCEPTION 'CALENDAR_NOT_ACTIVE' USING ERRCODE = '55000';
  END IF;
  RETURN QUERY
    SELECT k.key_id, k.envelope, v_connection.provider, v_connection.external_account
    FROM crove_kernel.calendar_credential k WHERE k.org_id = v_org AND k.connection_id = p_connection_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CALENDAR_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
END $$;

-- Forgets the credential of a connection of the org in context. Same actors as calendar_credential_put; a connection
-- without a credential is a no-op.
CREATE OR REPLACE FUNCTION crove_kernel.calendar_credential_drop(p_connection_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
  v_actor_type text := crove_kernel.ctx_actor_type();
  v_user uuid := crove_kernel.ctx_user_id();
BEGIN
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'NO_CONTEXT' USING ERRCODE = '42501';
  END IF;
  IF v_actor_type IS DISTINCT FROM 'system' AND NOT (
    v_actor_type = 'user' AND EXISTS (
      SELECT 1 FROM crove_kernel.calendar_connection c
      WHERE c.org_id = v_org AND c.id = p_connection_id AND c.user_id = v_user
    )
  ) THEN
    RAISE EXCEPTION 'CALENDAR_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  DELETE FROM crove_kernel.calendar_credential k WHERE k.org_id = v_org AND k.connection_id = p_connection_id;
END $$;

REVOKE ALL ON FUNCTION crove_kernel.calendar_credential_put(uuid, text, bytea) FROM PUBLIC, crove_tenant, crove_app, crove_worker;
REVOKE ALL ON FUNCTION crove_kernel.calendar_credential_get(uuid) FROM PUBLIC, crove_tenant, crove_app, crove_worker;
REVOKE ALL ON FUNCTION crove_kernel.calendar_credential_drop(uuid) FROM PUBLIC, crove_tenant, crove_app, crove_worker;
GRANT EXECUTE ON FUNCTION crove_kernel.calendar_credential_put(uuid, text, bytea) TO crove_app, crove_worker;
GRANT EXECUTE ON FUNCTION crove_kernel.calendar_credential_drop(uuid) TO crove_app, crove_worker;
-- Reading a credential out is the worker's alone: the API seals tokens in, it never reads them back.
GRANT EXECUTE ON FUNCTION crove_kernel.calendar_credential_get(uuid) TO crove_worker;

-- Starts a calendar connect attempt for the member and org in context; returns its id. Raises NO_CONTEXT (42501)
-- without a user context, OAUTH_FORBIDDEN (42501) for a viewer or a non-member, OAUTH_INVALID (22023) for a provider
-- that is not a calendar provider or a malformed hash, verifier or lifetime (60 to 900 seconds), and OAUTH_TOO_MANY
-- (54000) when the member started 20 attempts in the org in the last 2 minutes that are still open.
CREATE OR REPLACE FUNCTION crove_kernel.calendar_oauth_begin(p_provider text, p_state_hash text, p_code_verifier text, p_ttl_seconds integer)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
  v_user uuid := crove_kernel.ctx_user_id();
  v_id uuid;
BEGIN
  IF v_org IS NULL OR v_user IS NULL OR crove_kernel.ctx_actor_type() IS DISTINCT FROM 'user' THEN
    RAISE EXCEPTION 'NO_CONTEXT' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM crove_kernel.tenant_member m
    WHERE m.org_id = v_org AND m.user_id = v_user AND m.role IN ('owner', 'admin', 'member')
  ) THEN
    RAISE EXCEPTION 'OAUTH_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  IF p_provider IS NULL OR p_provider NOT IN ('google_calendar', 'microsoft_calendar')
     OR p_state_hash IS NULL OR p_state_hash !~ '^sha256:[0-9a-f]{64}$'
     OR (p_code_verifier IS NOT NULL AND p_code_verifier !~ '^[A-Za-z0-9._~-]{43,128}$')
     OR p_ttl_seconds IS NULL OR p_ttl_seconds NOT BETWEEN 60 AND 900 THEN
    RAISE EXCEPTION 'OAUTH_INVALID' USING ERRCODE = '22023';
  END IF;
  DELETE FROM crove_kernel.oauth_state s WHERE s.org_id = v_org AND s.created_at < pg_catalog.now() - interval '1 day';
  IF (SELECT count(*) FROM crove_kernel.oauth_state s
      WHERE s.org_id = v_org AND s.user_id = v_user AND s.consumed_at IS NULL AND s.expires_at > pg_catalog.now()
        AND s.created_at > pg_catalog.now() - interval '2 minutes') >= 20 THEN
    RAISE EXCEPTION 'OAUTH_TOO_MANY' USING ERRCODE = '54000';
  END IF;
  INSERT INTO crove_kernel.oauth_state (org_id, user_id, provider, state_hash, code_verifier, expires_at)
  VALUES (v_org, v_user, p_provider, p_state_hash, p_code_verifier, pg_catalog.now() + pg_catalog.make_interval(secs => p_ttl_seconds))
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;

-- Finishes a calendar connect attempt once and hands out its PKCE verifier (NULL without PKCE). Raises NO_CONTEXT
-- (42501) without a user context, OAUTH_FORBIDDEN (42501) for a viewer or a non-member, OAUTH_STATE_INVALID (P0002)
-- when no attempt matches the hash for this member, org and a calendar provider (one answer for all of them), and
-- OAUTH_STATE_USED (55000) or OAUTH_STATE_EXPIRED (55000).
CREATE OR REPLACE FUNCTION crove_kernel.calendar_oauth_consume(p_provider text, p_state_hash text)
RETURNS TABLE (code_verifier text) LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
  v_user uuid := crove_kernel.ctx_user_id();
  v_row crove_kernel.oauth_state%ROWTYPE;
BEGIN
  IF v_org IS NULL OR v_user IS NULL OR crove_kernel.ctx_actor_type() IS DISTINCT FROM 'user' THEN
    RAISE EXCEPTION 'NO_CONTEXT' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM crove_kernel.tenant_member m
    WHERE m.org_id = v_org AND m.user_id = v_user AND m.role IN ('owner', 'admin', 'member')
  ) THEN
    RAISE EXCEPTION 'OAUTH_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  IF p_provider IS NULL OR p_provider NOT IN ('google_calendar', 'microsoft_calendar') THEN
    RAISE EXCEPTION 'OAUTH_STATE_INVALID' USING ERRCODE = 'P0002';
  END IF;
  SELECT * INTO v_row FROM crove_kernel.oauth_state s
  WHERE s.state_hash = p_state_hash AND s.org_id = v_org AND s.user_id = v_user AND s.provider = p_provider
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'OAUTH_STATE_INVALID' USING ERRCODE = 'P0002';
  END IF;
  IF v_row.consumed_at IS NOT NULL THEN
    RAISE EXCEPTION 'OAUTH_STATE_USED' USING ERRCODE = '55000';
  END IF;
  IF v_row.expires_at <= pg_catalog.now() THEN
    RAISE EXCEPTION 'OAUTH_STATE_EXPIRED' USING ERRCODE = '55000';
  END IF;
  UPDATE crove_kernel.oauth_state s SET consumed_at = pg_catalog.now(), code_verifier = NULL
  WHERE s.org_id = v_row.org_id AND s.id = v_row.id;
  RETURN QUERY SELECT v_row.code_verifier;
END $$;

REVOKE ALL ON FUNCTION crove_kernel.calendar_oauth_begin(text, text, text, integer) FROM PUBLIC, crove_tenant, crove_app, crove_worker;
REVOKE ALL ON FUNCTION crove_kernel.calendar_oauth_consume(text, text) FROM PUBLIC, crove_tenant, crove_app, crove_worker;
-- The API starts and finishes attempts for the signed-in member; the worker never takes part in a connect.
GRANT EXECUTE ON FUNCTION crove_kernel.calendar_oauth_begin(text, text, text, integer) TO crove_app;
GRANT EXECUTE ON FUNCTION crove_kernel.calendar_oauth_consume(text, text) TO crove_app;

-- The busy times of connected calendars: calendar_event kinds google, microsoft and caldav.
ALTER TABLE crove_kernel.calendar_event ADD COLUMN IF NOT EXISTS source_id uuid;
ALTER TABLE crove_kernel.calendar_event ADD COLUMN IF NOT EXISTS external_id text;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint WHERE conname = 'calendar_event_kind_v2' AND conrelid = 'crove_kernel.calendar_event'::regclass
  ) THEN
    ALTER TABLE crove_kernel.calendar_event DROP CONSTRAINT IF EXISTS calendar_event_kind_check;
    ALTER TABLE crove_kernel.calendar_event ADD CONSTRAINT calendar_event_kind_v2
      CHECK (kind IN ('manual', 'time_off', 'booking', 'google', 'microsoft', 'caldav'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint WHERE conname = 'calendar_event_source_fk' AND conrelid = 'crove_kernel.calendar_event'::regclass
  ) THEN
    ALTER TABLE crove_kernel.calendar_event ADD CONSTRAINT calendar_event_source_fk
      FOREIGN KEY (org_id, source_id) REFERENCES crove_kernel.calendar_connection (org_id, id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint WHERE conname = 'calendar_event_source' AND conrelid = 'crove_kernel.calendar_event'::regclass
  ) THEN
    ALTER TABLE crove_kernel.calendar_event ADD CONSTRAINT calendar_event_source
      CHECK ((kind IN ('google', 'microsoft', 'caldav')) = (source_id IS NOT NULL AND external_id IS NOT NULL));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint WHERE conname = 'calendar_event_external_id_length' AND conrelid = 'crove_kernel.calendar_event'::regclass
  ) THEN
    ALTER TABLE crove_kernel.calendar_event ADD CONSTRAINT calendar_event_external_id_length
      CHECK (external_id IS NULL OR pg_catalog.length(external_id) <= 200);
  END IF;
END $$;
-- One block per interval of a connection: the sync diffs by this key, and the foreign key above is backed by it.
CREATE UNIQUE INDEX IF NOT EXISTS calendar_event_source_uq ON crove_kernel.calendar_event (org_id, source_id, external_id) WHERE source_id IS NOT NULL;

-- A page of the active calendar connections of active orgs after a key, in key order, for the worker's sweep, which
-- pages through them all. A connection of a member who left or is disabled is not due: the sync would only refuse it.
CREATE OR REPLACE FUNCTION crove_kernel.calendar_sync_due(p_after_org uuid, p_after_id uuid, p_limit int)
RETURNS TABLE (org_id uuid, connection_id uuid, provider text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT c.org_id, c.id, c.provider
  FROM crove_kernel.calendar_connection c
  JOIN crove_kernel.tenant t ON t.org_id = c.org_id AND t.status = 'active'
  WHERE c.status = 'active'
    AND (p_after_org IS NULL OR (c.org_id, c.id) > (p_after_org, p_after_id))
    AND EXISTS (
      SELECT 1 FROM crove_kernel.tenant_member m JOIN crove_kernel.user_account u ON u.id = m.user_id
      WHERE m.org_id = c.org_id AND m.user_id = c.user_id AND m.role IN ('owner', 'admin', 'member') AND u.disabled_at IS NULL)
  ORDER BY c.org_id, c.id
  LIMIT LEAST(GREATEST(p_limit, 1), 1000)
$$;
REVOKE ALL ON FUNCTION crove_kernel.calendar_sync_due(uuid, uuid, int) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_kernel.calendar_sync_due(uuid, uuid, int) TO crove_worker;

-- The org purge (#1024) deletes a closing org's calendar connections, their sealed credentials and the blocks they
-- made. The function is copied verbatim from 20261108110000_crove_kernel_org_purge_bank_feed_listed.sql (the newest),
-- with only these tables added to v_kernel_first.
CREATE OR REPLACE FUNCTION crove_kernel.org_purge(p_min_days integer)
RETURNS TABLE (outcome text, counts jsonb, blob_keys text[])
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
  v_refusal text;
  v_n bigint;
  v_t text;
  v_deleted jsonb := '{}'::jsonb;
  v_pinned jsonb := '{}'::jsonb;
  v_anonymized bigint;
  v_keep_proposal uuid[];
  v_keep_task uuid[];
  v_keep_position uuid[];
  v_keep_run uuid[];
  v_keep_agent uuid[];
  v_keep_variant uuid[];
  v_keep_post uuid[];
  v_keep_connection uuid[];
  v_keep_party uuid[];
  v_keep_file uuid[];
  v_keys text[];
  -- Rows of these tables are deleted whole, in this order (children before the rows they reference).
  v_kernel_first text[] := ARRAY[
    'crove_notes.link', 'crove_notes.todo', 'crove_notes.note',
    'crove_kernel.activity', 'crove_kernel.agent_wakeup', 'crove_kernel.extraction',
    'crove_kernel.inbound_message', 'crove_kernel.notification', 'crove_kernel.notification_mute', 'crove_kernel.inbox_item',
    'crove_kernel.mail_event', 'crove_kernel.mail_suppression', 'crove_kernel.mail_message',
    'crove_kernel.member_invite', 'crove_kernel.auth_session_org', 'crove_kernel.inbound_drop',
    'crove_kernel.idempotency_key', 'crove_kernel.oauth_state', 'crove_kernel.outbox_pending',
    'crove_kernel.proposal_policy', 'crove_kernel.refusal_tally', 'crove_kernel.tax_obligation_done',
    'crove_kernel.tax_profile', 'crove_kernel.usage_deferral', 'crove_kernel.file_upload', 'crove_kernel.record_le',
    'crove_kernel.budget_policy', 'crove_kernel.kill_switch', 'crove_kernel.credential', 'crove_kernel.calendar_credential',
    'crove_finance.vendor_account_rule', 'crove_finance.categorization_rule', 'crove_finance.bank_feed_account', 'crove_finance.bank_feed_listed_account', 'crove_crm.booking_feed', 'crove_crm.booking', 'crove_kernel.availability_rule',
    'crove_kernel.calendar_event', 'crove_kernel.calendar_connection', 'crove_crm.event_type'];
  v_social text[] := ARRAY[
    'crove_social.account_snapshot', 'crove_social.bio_click', 'crove_social.bio_page', 'crove_social.brand_voice',
    'crove_social.calendar_feed', 'crove_social.calendar_note', 'crove_social.channel_policy',
    'crove_social.channel_set', 'crove_social.chat_alert_target', 'crove_social.chat_alert',
    'crove_social.feed_item', 'crove_social.feed', 'crove_social.idea_label', 'crove_social.idea',
    'crove_social.post_label', 'crove_social.queue_slot', 'crove_social.queue', 'crove_social.label',
    'crove_social.link_preview', 'crove_social.media_tag', 'crove_social.metric_snapshot',
    'crove_social.notification', 'crove_social.notification_mail_off', 'crove_social.notification_mute',
    'crove_social.post_comment', 'crove_social.post_media', 'crove_social.post_version', 'crove_social.publish_hold', 'crove_social.report_link',
    'crove_social.report_schedule_run', 'crove_social.report_schedule', 'crove_social.review_feedback',
    'crove_social.review_link_post', 'crove_social.review_link', 'crove_social.short_link_click',
    'crove_social.short_link', 'crove_social.snippet', 'crove_social.watermark', 'crove_social.report_branding', 'crove_social.goal', 'crove_social.banned_word', 'crove_social.external_import', 'crove_social.external_post', 'crove_social.channel_access', 'crove_social.review_check', 'crove_social.digest_week', 'crove_social.channel_option', 'crove_social.media_attribution', 'crove_social.push_subscription', 'crove_social.saved_view', 'crove_social.media_archive'];
BEGIN
  -- Also refuses a definer owner or another role reached through a mistaken grant: only the worker login, in the
  -- sealed system context of the org it purges (execute() of kernel.org.purge).
  IF NOT pg_catalog.pg_has_role(SESSION_USER, 'crove_worker', 'MEMBER') THEN
    RAISE EXCEPTION 'ORG_PURGE_WORKER_ONLY' USING ERRCODE = '42501';
  END IF;
  IF v_org IS NULL OR crove_kernel.ctx_actor_type() IS DISTINCT FROM 'system' THEN
    RAISE EXCEPTION 'ORG_PURGE_SYSTEM_CONTEXT' USING ERRCODE = '42501';
  END IF;
  -- The write fence: every other transaction inside an offboarding org holds this lock shared (enter_context,
  -- enter_system_context), so taking it exclusive waits for those in flight and holds new ones back until the purge
  -- commits; they then see the org closed and are refused. Taken before the tenant row, so an in-flight transaction
  -- that updates the tenant row cannot deadlock with the purge. This transaction's own shared hold does not conflict.
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('kernel.org.purge:' || v_org::text, 0));
  -- Serializes purges of one org and holds the status still while the map runs.
  PERFORM 1 FROM crove_kernel.tenant t WHERE t.org_id = v_org FOR UPDATE;
  v_refusal := crove_kernel.org_purge_refusal(v_org, p_min_days);
  IF v_refusal IS NOT NULL THEN
    outcome := v_refusal;
    RETURN NEXT;
    RETURN;
  END IF;

  -- The append-only working rows (#1032): task comments and Social post approvals. Their append_only_row trigger
  -- (purge_append_only_guard) lets a DELETE through only from this function, for the org it purges, under this
  -- transaction-local mark, cleared again right after. Deleted first, so the tasks, positions, agents, runs, variants,
  -- posts and channel connections they referenced are no longer pinned and go with the rest of the map.
  PERFORM pg_catalog.set_config('crove.org_purge', v_org::text, true);
  DELETE FROM crove_kernel.task_comment c WHERE c.org_id = v_org;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_deleted := v_deleted || pg_catalog.jsonb_build_object('crove_kernel.task_comment', v_n);
  DELETE FROM crove_social.post_approval a WHERE a.org_id = v_org;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_deleted := v_deleted || pg_catalog.jsonb_build_object('crove_social.post_approval', v_n);
  PERFORM pg_catalog.set_config('crove.org_purge', '', true);

  -- The proposals behind kept books: the approval and four-eyes trail of booked entries (purchase documents, cash and
  -- journal vouchers, and reversals, whose entry names the proposal).
  v_keep_proposal := ARRAY(
    SELECT d.proposal_id FROM crove_finance.purchase_document d WHERE d.org_id = v_org AND d.proposal_id IS NOT NULL
    UNION
    SELECT c.proposal_id FROM crove_finance.cash_voucher c WHERE c.org_id = v_org AND c.proposal_id IS NOT NULL
    UNION
    SELECT j.proposal_id FROM crove_finance.journal_voucher j WHERE j.org_id = v_org AND j.proposal_id IS NOT NULL
    UNION
    SELECT e.source_id FROM crove_finance.journal_entry e
    WHERE e.org_id = v_org AND e.source_type = 'kernel.proposal' AND e.source_id IS NOT NULL);

  -- Rows that append-only rows and kept proposals reference, with what they reference in turn.
  v_keep_task := ARRAY(
    WITH RECURSIVE k(id) AS (
      SELECT c.task_id FROM crove_kernel.task_comment c WHERE c.org_id = v_org
      UNION
      SELECT r.source_task_id FROM crove_kernel.proposal r
      WHERE r.org_id = v_org AND r.id = ANY (v_keep_proposal) AND r.source_task_id IS NOT NULL
      UNION
      SELECT t.parent_task_id FROM crove_kernel.task t JOIN k ON t.org_id = v_org AND t.id = k.id WHERE t.parent_task_id IS NOT NULL
    ) SELECT id FROM k);
  v_keep_run := ARRAY(
    SELECT t.checkout_run_id FROM crove_kernel.task t
    WHERE t.org_id = v_org AND t.id = ANY (v_keep_task) AND t.checkout_run_id IS NOT NULL
    UNION
    SELECT r.requested_by_run FROM crove_kernel.proposal r
    WHERE r.org_id = v_org AND r.id = ANY (v_keep_proposal) AND r.requested_by_run IS NOT NULL);
  v_keep_position := ARRAY(
    WITH RECURSIVE k(id) AS (
      SELECT t.assignee_position_id FROM crove_kernel.task t
      WHERE t.org_id = v_org AND t.id = ANY (v_keep_task) AND t.assignee_position_id IS NOT NULL
      UNION
      SELECT p.reports_to FROM crove_kernel.position p JOIN k ON p.org_id = v_org AND p.id = k.id WHERE p.reports_to IS NOT NULL
    ) SELECT id FROM k);
  v_keep_agent := ARRAY(
    SELECT p.holder_agent_id FROM crove_kernel.position p
    WHERE p.org_id = v_org AND p.id = ANY (v_keep_position) AND p.holder_agent_id IS NOT NULL
    UNION
    SELECT r.agent_id FROM crove_kernel.ai_run r WHERE r.org_id = v_org AND r.id = ANY (v_keep_run) AND r.agent_id IS NOT NULL
    UNION
    SELECT a.agent FROM crove_kernel.proposal r
    CROSS JOIN LATERAL (VALUES (r.requested_by_agent), (r.decided_by_agent)) a(agent)
    WHERE r.org_id = v_org AND r.id = ANY (v_keep_proposal) AND a.agent IS NOT NULL);
  v_keep_variant := ARRAY(SELECT DISTINCT a.variant_id FROM crove_social.post_approval a WHERE a.org_id = v_org);
  v_keep_post := ARRAY(
    WITH RECURSIVE k(id) AS (
      SELECT a.post_id FROM crove_social.post_approval a WHERE a.org_id = v_org
      UNION
      SELECT s.src FROM crove_social.post p JOIN k ON p.org_id = v_org AND p.id = k.id
      CROSS JOIN LATERAL (VALUES (p.repost_of), (p.recurrence_source_id)) s(src) WHERE s.src IS NOT NULL
    ) SELECT id FROM k);
  v_keep_connection := ARRAY(
    SELECT DISTINCT v.channel_connection_id FROM crove_social.post_variant v
    WHERE v.org_id = v_org AND v.id = ANY (v_keep_variant) AND v.channel_connection_id IS NOT NULL);
  v_keep_party := ARRAY(
    SELECT d.party_id FROM crove_finance.purchase_document d WHERE d.org_id = v_org AND d.party_id IS NOT NULL
    UNION
    SELECT c.party_id FROM crove_finance.cash_voucher c WHERE c.org_id = v_org AND c.party_id IS NOT NULL
    UNION
    -- Ledger lines name parties without a foreign key (sales, opening balances, bank matching on 131 and 331).
    SELECT l.party_id FROM crove_finance.journal_line l WHERE l.org_id = v_org AND l.party_id IS NOT NULL);
  v_keep_file := ARRAY(
    SELECT d.source_file_id FROM crove_finance.purchase_document d WHERE d.org_id = v_org AND d.source_file_id IS NOT NULL
    UNION
    SELECT l.file_id FROM crove_finance.portal_invoice_list l WHERE l.org_id = v_org AND l.file_id IS NOT NULL);

  DELETE FROM crove_kernel.proposal r WHERE r.org_id = v_org AND r.id <> ALL (v_keep_proposal);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_deleted := v_deleted || pg_catalog.jsonb_build_object('crove_kernel.proposal', v_n);

  FOREACH v_t IN ARRAY v_kernel_first || v_social LOOP
    EXECUTE pg_catalog.format('DELETE FROM %s WHERE org_id = $1', v_t::regclass) USING v_org;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_deleted := v_deleted || pg_catalog.jsonb_build_object(v_t, v_n);
  END LOOP;

  -- Social: the posts and variants no approval pins, then the channel connections no kept variant uses.
  DELETE FROM crove_social.post_variant v WHERE v.org_id = v_org AND v.id <> ALL (v_keep_variant);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_deleted := v_deleted || pg_catalog.jsonb_build_object('crove_social.post_variant', v_n);
  DELETE FROM crove_social.post p WHERE p.org_id = v_org AND p.id <> ALL (v_keep_post);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_deleted := v_deleted || pg_catalog.jsonb_build_object('crove_social.post', v_n);
  DELETE FROM crove_kernel.channel_connection c WHERE c.org_id = v_org AND c.id <> ALL (v_keep_connection);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_deleted := v_deleted || pg_catalog.jsonb_build_object('crove_kernel.channel_connection', v_n);

  -- The org chart and its work, but what a task comment pins.
  DELETE FROM crove_kernel.task t WHERE t.org_id = v_org AND t.id <> ALL (v_keep_task);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_deleted := v_deleted || pg_catalog.jsonb_build_object('crove_kernel.task', v_n);
  DELETE FROM crove_kernel.ai_run r WHERE r.org_id = v_org AND r.id <> ALL (v_keep_run);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_deleted := v_deleted || pg_catalog.jsonb_build_object('crove_kernel.ai_run', v_n);
  DELETE FROM crove_kernel.position p WHERE p.org_id = v_org AND p.id <> ALL (v_keep_position);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_deleted := v_deleted || pg_catalog.jsonb_build_object('crove_kernel.position', v_n);
  DELETE FROM crove_kernel.agent a WHERE a.org_id = v_org AND a.id <> ALL (v_keep_agent);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_deleted := v_deleted || pg_catalog.jsonb_build_object('crove_kernel.agent', v_n);

  -- Members last among the org chart: a kept position's holder becomes NULL (ON DELETE SET NULL).
  DELETE FROM crove_kernel.tenant_member m WHERE m.org_id = v_org;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_deleted := v_deleted || pg_catalog.jsonb_build_object('crove_kernel.tenant_member', v_n);

  -- Parties: those a kept voucher names are anonymized, the rest deleted.
  UPDATE crove_kernel.party p SET duplicate_of = NULL
  WHERE p.org_id = v_org AND p.id = ANY (v_keep_party) AND p.duplicate_of IS NOT NULL;
  UPDATE crove_kernel.party p SET address = NULL, email = NULL, phone = NULL, verified_by = NULL
  WHERE p.org_id = v_org AND p.id = ANY (v_keep_party)
    AND (p.address IS NOT NULL OR p.email IS NOT NULL OR p.phone IS NOT NULL OR p.verified_by IS NOT NULL);
  GET DIAGNOSTICS v_anonymized = ROW_COUNT;
  DELETE FROM crove_kernel.party p WHERE p.org_id = v_org AND p.id <> ALL (v_keep_party);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_deleted := v_deleted || pg_catalog.jsonb_build_object('crove_kernel.party', v_n);

  -- Files: those the books reference stay. The blobs of the others go, unless a kept row has the same content. Only
  -- keys under the org's own documents prefix are returned (the content-address check is NOT VALID for old rows), so
  -- no archive/ or export/ key, nor another org's, can ever be deleted from here.
  WITH gone AS (
    DELETE FROM crove_kernel.file f WHERE f.org_id = v_org AND f.id <> ALL (v_keep_file) RETURNING f.storage_key
  )
  SELECT pg_catalog.count(*), ARRAY(
    SELECT DISTINCT g.storage_key FROM gone g
    WHERE g.storage_key LIKE 'org/' || v_org::text || '/%'
      AND NOT EXISTS (SELECT 1 FROM crove_kernel.file k WHERE k.org_id = v_org AND k.id = ANY (v_keep_file) AND k.storage_key = g.storage_key)
    ORDER BY 1)
  INTO v_n, v_keys FROM gone;
  v_deleted := v_deleted || pg_catalog.jsonb_build_object('crove_kernel.file', v_n);

  v_pinned := pg_catalog.jsonb_build_object(
    'crove_kernel.task_comment', (SELECT pg_catalog.count(*) FROM crove_kernel.task_comment c WHERE c.org_id = v_org),
    'crove_kernel.task', pg_catalog.cardinality(v_keep_task),
    'crove_kernel.ai_run', pg_catalog.cardinality(v_keep_run),
    'crove_kernel.position', pg_catalog.cardinality(v_keep_position),
    'crove_kernel.agent', pg_catalog.cardinality(v_keep_agent),
    'crove_social.post_approval', (SELECT pg_catalog.count(*) FROM crove_social.post_approval a WHERE a.org_id = v_org),
    'crove_social.post_variant', pg_catalog.cardinality(v_keep_variant),
    'crove_social.post', pg_catalog.cardinality(v_keep_post),
    'crove_kernel.channel_connection', pg_catalog.cardinality(v_keep_connection));

  UPDATE crove_kernel.tenant t SET status = 'closed' WHERE t.org_id = v_org;

  outcome := 'ok';
  counts := pg_catalog.jsonb_build_object(
    'deleted', v_deleted,
    'pinned', v_pinned,
    'anonymized', pg_catalog.jsonb_build_object('crove_kernel.party', v_anonymized),
    'keptFiles', pg_catalog.cardinality(v_keep_file),
    'keptParties', pg_catalog.cardinality(v_keep_party),
    'keptProposals', pg_catalog.cardinality(v_keep_proposal));
  blob_keys := v_keys;
  RETURN NEXT;
END $$;

REVOKE ALL ON FUNCTION crove_kernel.org_purge(integer) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_kernel.org_purge(integer) TO crove_worker;
