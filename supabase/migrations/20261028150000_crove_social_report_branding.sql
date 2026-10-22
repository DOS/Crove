-- Crove Social: white-label client reports, with the agency's logo and colour (issue #1053). Idempotent; applied files
-- stay untouched.
--
-- crove_social.report_branding  an org's branding of its client report and review pages, the plan print and the report
--                               mail: display_name (empty: the org's own name), logo (a small inline data URL the
--                               browser made from an image of the Social library: PNG, WebP or JPEG, at most 64 KB
--                               decoded, never SVG, whose markup can carry script; the CHECK reads the declared type
--                               and the file's magic number), accent (one colour, #rrggbb; the command refuses one with
--                               less than 3:1 contrast against the page) and hide_crove (no "Crove" on the pages or in
--                               the mail). One per org, kept by the commands under an advisory lock, as the watermark
--                               is. Owners and admins save and remove it (the commands check the role); every member
--                               reads it.
-- crove_social.report_brand(org)  the brand as the public views return it: { name, logo, accent, hideCrove }, or null
--                               when the org has none. Called only by the definers below (no grant).
--
-- crove_social.report_link_view(token)  as in 20261026053000, with the same signature, RETURNS, checks (token format
--                               and hash, revoked, expiry, active org) and grants, plus brand: the link's own org's.
-- crove_social.review_link_view(token)  as in 20261023233000, the same, plus brand on a single-post and a plan page.
SET LOCAL lock_timeout = '2s';

CREATE TABLE IF NOT EXISTS crove_social.report_branding (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  display_name text CHECK (display_name IS NULL OR (length(display_name) BETWEEN 1 AND 100 AND display_name !~ '[[:cntrl:]]')),
  -- The prefix and the canonical base64 of at most 65536 bytes decoded: first a cheap bound on the whole text (87407
  -- characters, the longest prefix and the base64 of 65536 bytes), then the pattern, then the exact decoded size (the
  -- base64 length over 4 times 3, less its padding), then the magic number of the declared type in the first 12 bytes
  -- (16 base64 characters). The CASE keeps that order, so decode() only sees a value the pattern accepted.
  logo text CONSTRAINT report_branding_logo_check CHECK (
    logo IS NULL OR CASE
      WHEN length(logo) > 87407 THEN false
      WHEN logo !~ '^data:image/(png|webp|jpeg);base64,([A-Za-z0-9+/]{4})*([A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$' THEN false
      WHEN (pg_catalog.length(logo) - pg_catalog.strpos(logo, ',')) / 4 * 3 - (pg_catalog.length(logo) - pg_catalog.length(pg_catalog.rtrim(logo, '='))) > 65536 THEN false
      WHEN logo LIKE 'data:image/png;base64,%' THEN
        pg_catalog.substr(pg_catalog.decode(pg_catalog.substr(logo, 23, 16), 'base64'), 1, 8) = '\x89504e470d0a1a0a'::bytea
      WHEN logo LIKE 'data:image/jpeg;base64,%' THEN
        pg_catalog.substr(pg_catalog.decode(pg_catalog.substr(logo, 24, 16), 'base64'), 1, 3) = '\xffd8ff'::bytea
      ELSE
        pg_catalog.substr(pg_catalog.decode(pg_catalog.substr(logo, 24, 16), 'base64'), 1, 4) = '\x52494646'::bytea
        AND pg_catalog.substr(pg_catalog.decode(pg_catalog.substr(logo, 24, 16), 'base64'), 9, 4) = '\x57454250'::bytea
    END
  ),
  accent text CHECK (accent IS NULL OR accent ~ '^#[0-9a-f]{6}$'),
  hide_crove boolean NOT NULL DEFAULT false,
  updated_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, id)
);
SELECT crove_kernel.apply_tenant_rls('crove_social.report_branding');

CREATE OR REPLACE FUNCTION crove_social.report_brand(p_org uuid)
RETURNS jsonb LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT pg_catalog.jsonb_build_object('name', b.display_name, 'logo', b.logo, 'accent', b.accent, 'hideCrove', b.hide_crove)
  FROM crove_social.report_branding b
  WHERE b.org_id = p_org
  ORDER BY b.created_at, b.id
  LIMIT 1
$$;
REVOKE ALL ON FUNCTION crove_social.report_brand(uuid) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;

-- Same body as 20261026053000, plus brand.
CREATE OR REPLACE FUNCTION crove_social.report_link_view(p_token text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_link crove_social.report_link;
  v_prev_start timestamptz;
BEGIN
  -- 32 random bytes, base64url without padding (newReportToken in modules/social).
  IF p_token IS NULL OR p_token !~ '^[A-Za-z0-9_-]{43}$' THEN
    RETURN NULL;
  END IF;
  SELECT l.* INTO v_link FROM crove_social.report_link l
  WHERE l.token_sha256 = pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_token, 'UTF8')), 'hex');
  IF v_link.id IS NULL OR v_link.revoked_at IS NOT NULL OR v_link.expires_at <= pg_catalog.now() THEN
    RETURN NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM crove_kernel.tenant t WHERE t.org_id = v_link.org_id AND t.status = 'active') THEN
    RETURN NULL;
  END IF;
  -- The period of the same length just before the link's, by its exact length in seconds: an interval with days in
  -- it would be taken in the session's time zone, so daylight saving could shift the start.
  v_prev_start := v_link.period_start - pg_catalog.make_interval(secs => EXTRACT(epoch FROM v_link.period_end - v_link.period_start)::double precision);
  RETURN (
    WITH p AS (
      SELECT true AS cur, v_link.period_start AS ps, v_link.period_end AS pe
      UNION ALL
      SELECT false, v_prev_start, v_link.period_start
    ),
    v AS (
      -- What went out in each period on the link's channels, with the latest real counts of each.
      SELECT p.cur, p.ps, p.pe, x.*
      FROM p CROSS JOIN LATERAL (
        SELECT v.id, v.provider, v.channel_connection_id AS conn, coalesce(v.body, p2.body) AS body, v.published_at, v.external_url,
               coalesce(s.metrics, '{}'::jsonb) AS metrics
        FROM crove_social.post_variant v
        JOIN crove_social.post p2 ON p2.org_id = v.org_id AND p2.id = v.post_id
        LEFT JOIN LATERAL (
          SELECT m.metrics FROM crove_social.metric_snapshot m
          WHERE m.org_id = v.org_id AND m.variant_id = v.id
          ORDER BY (m.metrics = '{}'::jsonb), m.captured_at DESC LIMIT 1
        ) s ON true
        WHERE v.org_id = v_link.org_id AND v.status = 'published'
          AND v.published_at >= p.ps AND v.published_at < p.pe
          AND (pg_catalog.cardinality(v_link.connection_ids) = 0 OR v.channel_connection_id = ANY (v_link.connection_ids))
        ORDER BY v.published_at DESC
        LIMIT 5000
      ) x
    ),
    n AS (
      -- The counts Crove knows (METRIC_NAMES of packages/channel), as numbers; anything else a snapshot holds is left out.
      SELECT v.cur, v.id, v.conn, e.key, (e.value #>> '{}')::numeric AS value
      FROM v, pg_catalog.jsonb_each(v.metrics) e
      WHERE pg_catalog.jsonb_typeof(e.value) = 'number'
        AND e.key IN ('impressions', 'reach', 'reactions', 'comments', 'shares', 'saves', 'clicks', 'views')
      UNION ALL
      -- The clicks on Crove's short links (#706) of what went out, every revision of it, on the days (UTC) whose midday is
      -- in its period (clicks are kept by UTC day; a period is in the org's own zone). Not part of a post's score: a
      -- channel's own clicks may count the same people. A post that went out with a link nobody clicked shows 0.
      SELECT v.cur, v.id, v.conn, 'linkClicks', coalesce(pg_catalog.sum(k.clicks), 0)::numeric
      FROM v
      JOIN crove_social.short_link l ON l.org_id = v_link.org_id AND l.variant_id = v.id
      LEFT JOIN crove_social.short_link_click k ON k.org_id = l.org_id AND k.short_link_id = l.id
        AND (k.day + time '12:00') AT TIME ZONE 'UTC' >= v.ps
        AND (k.day + time '12:00') AT TIME ZONE 'UTC' < v.pe
      GROUP BY v.cur, v.id, v.conn
    ),
    score AS (
      SELECT v.id, coalesce(pg_catalog.sum(n.value) FILTER (WHERE n.key IN ('reactions', 'comments', 'shares', 'saves', 'clicks')), 0) AS engagement,
             coalesce(pg_catalog.sum(n.value) FILTER (WHERE n.key IN ('views', 'impressions', 'reach')), 0) AS seen
      FROM v LEFT JOIN n ON n.cur AND n.id = v.id
      WHERE v.cur
      GROUP BY v.id
    ),
    per_channel AS (
      -- Every channel with posts in either period, so the channels add up to both periods' totals.
      SELECT v.conn, pg_catalog.count(*) FILTER (WHERE v.cur) AS posts, pg_catalog.count(*) FILTER (WHERE NOT v.cur) AS prev_posts FROM v GROUP BY v.conn
    )
    SELECT pg_catalog.jsonb_build_object(
      'org', (SELECT t.name FROM crove_kernel.tenant t WHERE t.org_id = v_link.org_id),
      -- The white-label branding of the link's own org (#1053), or null.
      'brand', crove_social.report_brand(v_link.org_id),
      'title', v_link.title,
      'periodStart', v_link.period_start,
      'periodEnd', v_link.period_end,
      'expiresAt', v_link.expires_at,
      'posts', (SELECT pg_catalog.count(*) FROM v WHERE v.cur),
      'totals', coalesce((SELECT pg_catalog.jsonb_object_agg(t.key, t.total) FROM (SELECT n.key, pg_catalog.sum(n.value) AS total FROM n WHERE n.cur GROUP BY n.key) t), '{}'::jsonb),
      'previous', pg_catalog.jsonb_build_object(
        'periodStart', v_prev_start,
        'periodEnd', v_link.period_start,
        'posts', (SELECT pg_catalog.count(*) FROM v WHERE NOT v.cur),
        'totals', coalesce((SELECT pg_catalog.jsonb_object_agg(t.key, t.total) FROM (SELECT n.key, pg_catalog.sum(n.value) AS total FROM n WHERE NOT n.cur GROUP BY n.key) t), '{}'::jsonb)
      ),
      'channels', coalesce((
        SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'channel', c.display_name,
          'provider', c.provider,
          'posts', pc.posts,
          'totals', coalesce((SELECT pg_catalog.jsonb_object_agg(t.key, t.total) FROM (SELECT n.key, pg_catalog.sum(n.value) AS total FROM n WHERE n.cur AND n.conn = pc.conn GROUP BY n.key) t), '{}'::jsonb),
          'previous', pg_catalog.jsonb_build_object(
            'posts', pc.prev_posts,
            'totals', coalesce((SELECT pg_catalog.jsonb_object_agg(t.key, t.total) FROM (SELECT n.key, pg_catalog.sum(n.value) AS total FROM n WHERE NOT n.cur AND n.conn = pc.conn GROUP BY n.key) t), '{}'::jsonb)
          )
        ) ORDER BY pc.posts DESC, pc.prev_posts DESC, c.display_name)
        FROM per_channel pc
        JOIN crove_kernel.channel_connection c ON c.org_id = v_link.org_id AND c.id = pc.conn
      ), '[]'::jsonb),
      'top', coalesce((
        SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'channel', c.display_name,
          'provider', v.provider,
          'excerpt', pg_catalog.left(pg_catalog.btrim(pg_catalog.regexp_replace(v.body, '\s+', ' ', 'g')), 200),
          'publishedAt', v.published_at,
          'url', CASE WHEN v.external_url ~ '^https://' THEN v.external_url END,
          'metrics', coalesce((SELECT pg_catalog.jsonb_object_agg(n.key, n.value) FROM n WHERE n.cur AND n.id = v.id), '{}'::jsonb)
        ) ORDER BY s.engagement DESC, s.seen DESC, v.published_at DESC)
        FROM (SELECT * FROM score ORDER BY engagement DESC, seen DESC LIMIT 10) s
        JOIN v ON v.cur AND v.id = s.id
        JOIN crove_kernel.channel_connection c ON c.org_id = v_link.org_id AND c.id = v.conn
      ), '[]'::jsonb)
    )
  );
END $$;
REVOKE ALL ON FUNCTION crove_social.report_link_view(text) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_social.report_link_view(text) TO crove_app;

-- Same body as 20261023233000, plus brand on both kinds of page.
CREATE OR REPLACE FUNCTION crove_social.review_link_view(p_token text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_link crove_social.review_link;
  v_post crove_social.post;
BEGIN
  v_link := crove_social.review_link_by_token(p_token, false);
  IF v_link.id IS NULL THEN
    RETURN NULL;
  END IF;
  IF v_link.kind = 'plan' THEN
    -- The plan page, with the white-label branding of the link's own org (#1053), or null.
    RETURN crove_social.review_plan_page(v_link) || pg_catalog.jsonb_build_object('brand', crove_social.report_brand(v_link.org_id));
  END IF;
  SELECT p.* INTO v_post FROM crove_social.post p WHERE p.org_id = v_link.org_id AND p.id = v_link.post_id;
  RETURN pg_catalog.jsonb_build_object(
    'org', (SELECT t.name FROM crove_kernel.tenant t WHERE t.org_id = v_link.org_id),
    -- The white-label branding of the link's own org (#1053), or null.
    'brand', crove_social.report_brand(v_link.org_id),
    'expiresAt', v_link.expires_at,
    'changed', crove_social.review_content_key(v_link.org_id, v_link.post_id) <> v_link.content_key,
    'channels', coalesce((
      SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'provider', v.provider,
        'channel', c.display_name,
        'status', v.status,
        'body', CASE WHEN v.content_frozen THEN coalesce(v.body, '') ELSE coalesce(v.body, v_post.body) END,
        'title', CASE WHEN v.content_frozen THEN v.title ELSE coalesce(v.title, v_post.title) END,
        'linkUrl', CASE WHEN v.content_frozen THEN v.link_url ELSE coalesce(v.link_url, v_post.link_url) END,
        'mediaCount', CASE WHEN pg_catalog.jsonb_typeof(v.media) = 'array' THEN pg_catalog.jsonb_array_length(v.media)
          ELSE (SELECT pg_catalog.count(*)::int FROM crove_social.post_media m WHERE m.org_id = v.org_id AND m.post_id = v.post_id) END
      ) ORDER BY v.position, v.id)
      FROM crove_social.post_variant v
      JOIN crove_kernel.channel_connection c ON c.org_id = v.org_id AND c.id = v.channel_connection_id
      WHERE v.org_id = v_link.org_id AND v.post_id = v_link.post_id AND v.status <> 'cancelled'
    ), '[]'::jsonb),
    'feedback', coalesce((
      SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('name', f.reviewer_name, 'verdict', f.verdict, 'body', f.body, 'at', f.created_at) ORDER BY f.created_at DESC)
      FROM (SELECT * FROM crove_social.review_feedback f0 WHERE f0.org_id = v_link.org_id AND f0.link_id = v_link.id ORDER BY f0.created_at DESC LIMIT 50) f
    ), '[]'::jsonb)
  );
END $$;
REVOKE ALL ON FUNCTION crove_social.review_link_view(text) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_social.review_link_view(text) TO crove_app;

-- The org purge (#1024) deletes crove_social.report_branding with the org's other Social rows (#1053). The function
-- is copied verbatim from 20261028130000_crove_kernel_org_purge.sql, with only this table added to v_social;
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
    'crove_social.short_link', 'crove_social.snippet', 'crove_social.watermark', 'crove_social.report_branding'];
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
