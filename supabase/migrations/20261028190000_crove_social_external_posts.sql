-- Crove Social: posts a connected account published outside Crove (issue #1054), so the Metrics tab and client
-- reports can count every post of the account when asked. Idempotent; applied files stay untouched.
--
-- crove_social.external_post    a post a connected Facebook Page or Instagram account published itself, brought in by
--                               the worker (at most 30 days back): the platform's id, a bounded excerpt of its text,
--                               its permalink (https only), when it went out, and the latest real counts the platform
--                               reported (metrics, read at captured_at; checked_at is the last try, gone once the
--                               platform no longer has the post). One row per connection and platform id. A post that is
--                               also a variant's external_post_id on the same connection (Crove published it) is never
--                               brought in, and every read leaves it out again, so no post is counted twice. Written by
--                               the worker's system commands only (they check the actor); every member reads it. It
--                               goes with its channel.
-- crove_social.external_import  the worker's last bring-in per connection: when, how many posts the platform listed,
--                               and why nothing came (no answer, token refused, permission refused).
-- crove_social.report_link.include_external  whether a client report link counts such posts (off by default, and
--                               fixed when the link is made); the report view reads it in its own migration.
-- crove_social.external_import_due, crove_social.external_metrics_due  the worker's scans, across orgs, of the
--                               connections due a bring-in and of the brought-in posts due their counts; ids only,
--                               for crove_worker alone.
SET LOCAL lock_timeout = '2s';

CREATE TABLE IF NOT EXISTS crove_social.external_post (
  org_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  channel_connection_id uuid NOT NULL,
  external_post_id text NOT NULL CHECK (external_post_id ~ '^[A-Za-z0-9_.:-]{1,200}$'),
  excerpt text NOT NULL DEFAULT '' CHECK (length(excerpt) <= 500),
  permalink text CHECK (permalink IS NULL OR (length(permalink) <= 2000 AND permalink ~ '^https://')),
  published_at timestamptz NOT NULL,
  metrics jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metrics) = 'object' AND octet_length(metrics::text) <= 8192),
  captured_at timestamptz,
  checked_at timestamptz,
  gone boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, id),
  CONSTRAINT external_post_connection_fk FOREIGN KEY (org_id, channel_connection_id) REFERENCES crove_kernel.channel_connection (org_id, id) ON DELETE CASCADE,
  CONSTRAINT external_post_uq UNIQUE (org_id, channel_connection_id, external_post_id)
);
CREATE INDEX IF NOT EXISTS external_post_window_idx ON crove_social.external_post (org_id, published_at DESC);
-- The worker's scan of posts due their counts, across orgs.
CREATE INDEX IF NOT EXISTS external_post_due_idx ON crove_social.external_post (published_at) WHERE NOT gone;
SELECT crove_kernel.apply_tenant_rls('crove_social.external_post');
-- A brought-in post changes its text, link and counts; never its org, channel, id or date. Nobody deletes one but the
-- org purge and its channel's removal.
REVOKE UPDATE, DELETE ON crove_social.external_post FROM crove_tenant;
GRANT UPDATE (excerpt, permalink, metrics, captured_at, checked_at, gone, updated_at) ON crove_social.external_post TO crove_tenant;

CREATE TABLE IF NOT EXISTS crove_social.external_import (
  org_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  channel_connection_id uuid NOT NULL,
  ran_at timestamptz NOT NULL DEFAULT now(),
  found integer NOT NULL DEFAULT 0 CHECK (found BETWEEN 0 AND 100000),
  error text CHECK (error IS NULL OR error IN ('no_answer', 'token_expired', 'permission')),
  PRIMARY KEY (org_id, id),
  CONSTRAINT external_import_connection_fk FOREIGN KEY (org_id, channel_connection_id) REFERENCES crove_kernel.channel_connection (org_id, id) ON DELETE CASCADE,
  CONSTRAINT external_import_uq UNIQUE (org_id, channel_connection_id)
);
SELECT crove_kernel.apply_tenant_rls('crove_social.external_import');
REVOKE UPDATE, DELETE ON crove_social.external_import FROM crove_tenant;
GRANT UPDATE (ran_at, found, error) ON crove_social.external_import TO crove_tenant;

-- What every read of brought-in posts checks: is this platform id a variant's on the same channel?
CREATE INDEX IF NOT EXISTS post_variant_external_id_idx ON crove_social.post_variant (org_id, channel_connection_id, external_post_id)
  WHERE external_post_id IS NOT NULL;

ALTER TABLE crove_social.report_link ADD COLUMN IF NOT EXISTS include_external boolean NOT NULL DEFAULT false;

-- Active channels of active orgs on the given providers whose last bring-in is older than the interval (never run
-- first). version: the connection's updated_at, so a refused token marks it expired only if no reconnect came since.
CREATE OR REPLACE FUNCTION crove_social.external_import_due(p_limit int, p_providers text[], p_interval_seconds int)
RETURNS TABLE (org_id uuid, connection_id uuid, provider text, version timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT c.org_id, c.id, c.provider, c.updated_at
  FROM crove_kernel.channel_connection c
  JOIN crove_kernel.tenant t ON t.org_id = c.org_id AND t.status = 'active'
  LEFT JOIN crove_social.external_import i ON i.org_id = c.org_id AND i.channel_connection_id = c.id
  WHERE c.status = 'active'
    AND c.provider = ANY (p_providers)
    AND (i.ran_at IS NULL OR i.ran_at < pg_catalog.now() - pg_catalog.make_interval(secs => GREATEST(p_interval_seconds, 600)))
  ORDER BY i.ran_at NULLS FIRST, c.org_id, c.id
  LIMIT LEAST(GREATEST(p_limit, 1), 1000)
$$;
REVOKE ALL ON FUNCTION crove_social.external_import_due(int, text[], int) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_social.external_import_due(int, text[], int) TO crove_worker;

-- Brought-in posts of the last 30 days on active channels of active orgs, not gone and not Crove's own, whose last try
-- is older than the interval (never tried first).
CREATE OR REPLACE FUNCTION crove_social.external_metrics_due(p_limit int, p_providers text[], p_interval_seconds int)
RETURNS TABLE (org_id uuid, external_id uuid, provider text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT e.org_id, e.id, c.provider
  FROM crove_social.external_post e
  JOIN crove_kernel.tenant t ON t.org_id = e.org_id AND t.status = 'active'
  JOIN crove_kernel.channel_connection c ON c.org_id = e.org_id AND c.id = e.channel_connection_id AND c.status = 'active'
  WHERE NOT e.gone
    AND c.provider = ANY (p_providers)
    AND e.published_at > pg_catalog.now() - interval '30 days'
    AND (e.checked_at IS NULL OR e.checked_at < pg_catalog.now() - pg_catalog.make_interval(secs => GREATEST(p_interval_seconds, 600)))
    AND NOT EXISTS (
      SELECT 1 FROM crove_social.post_variant v
      WHERE v.org_id = e.org_id AND v.channel_connection_id = e.channel_connection_id AND v.external_post_id = e.external_post_id
    )
  ORDER BY e.checked_at NULLS FIRST, e.published_at DESC
  LIMIT LEAST(GREATEST(p_limit, 1), 1000)
$$;
REVOKE ALL ON FUNCTION crove_social.external_metrics_due(int, text[], int) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_social.external_metrics_due(int, text[], int) TO crove_worker;

-- The org purge (#1024) deletes crove_social.external_import, crove_social.external_post with the org's other Social rows (#1054). The function
-- is copied verbatim from 20261028130000_crove_kernel_org_purge.sql, with only these tables added to v_social;
-- the runbook's deletion map already says every crove_social table but post_approval is deleted.
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
    'crove_kernel.activity', 'crove_kernel.agent_wakeup', 'crove_kernel.extraction',
    'crove_kernel.inbound_message', 'crove_kernel.notification', 'crove_kernel.notification_mute',
    'crove_kernel.mail_event', 'crove_kernel.mail_suppression', 'crove_kernel.mail_message',
    'crove_kernel.member_invite', 'crove_kernel.auth_session_org', 'crove_kernel.inbound_drop',
    'crove_kernel.idempotency_key', 'crove_kernel.oauth_state', 'crove_kernel.outbox_pending',
    'crove_kernel.proposal_policy', 'crove_kernel.refusal_tally', 'crove_kernel.tax_obligation_done',
    'crove_kernel.tax_profile', 'crove_kernel.usage_deferral', 'crove_kernel.file_upload',
    'crove_kernel.budget_policy', 'crove_kernel.kill_switch', 'crove_kernel.credential',
    'crove_finance.vendor_account_rule'];
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
    'crove_social.short_link', 'crove_social.snippet', 'crove_social.watermark', 'crove_social.external_import', 'crove_social.external_post'];
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
