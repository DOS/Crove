-- Crove Social: the posting calendar as a feed for Google Calendar or Outlook (issue #862). Idempotent.
--
-- calendar_feed  an org's subscription address: the SHA-256 of its token (the secret is only in the address the
--                creator copies), who made it and when, and its revocation. An org has at most one live feed; owners
--                and admins make a new one (which revokes the old) and revoke it through commands. Nothing else about
--                a feed changes.
--
-- calendar_feed_events(token)  for a live feed of an active org (well-formed token, not revoked): the org's slug and
--                              name and what goes out or went out from 30 days back to 60 days ahead, at most 1000
--                              channel posts, each with its time, channel, status and a short title; NULL otherwise.
--                              No full text, no people, no ids but the post's and the channel post's.
-- Only crove_app (the API login role, which serves GET /cal/<token>.ics) may execute it.
SET LOCAL lock_timeout = '2s';

CREATE TABLE IF NOT EXISTS crove_social.calendar_feed (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  token_sha256 text NOT NULL CONSTRAINT calendar_feed_token_format CHECK (token_sha256 ~ '^[0-9a-f]{64}$'),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  revoked_by uuid,
  PRIMARY KEY (org_id, id),
  CONSTRAINT calendar_feed_token_uq UNIQUE (token_sha256),
  CONSTRAINT calendar_feed_revoked CHECK ((revoked_at IS NULL) = (revoked_by IS NULL))
);
-- One live feed per org.
CREATE UNIQUE INDEX IF NOT EXISTS calendar_feed_live_uq ON crove_social.calendar_feed (org_id) WHERE revoked_at IS NULL;
SELECT crove_kernel.apply_tenant_rls('crove_social.calendar_feed');
REVOKE UPDATE, DELETE ON crove_social.calendar_feed FROM crove_tenant;
GRANT UPDATE (revoked_at, revoked_by) ON crove_social.calendar_feed TO crove_tenant;

CREATE OR REPLACE FUNCTION crove_social.calendar_feed_events(p_token text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_feed crove_social.calendar_feed;
  v_tenant crove_kernel.tenant;
BEGIN
  -- 32 random bytes, base64url without padding (newReportToken in modules/social).
  IF p_token IS NULL OR p_token !~ '^[A-Za-z0-9_-]{43}$' THEN
    RETURN NULL;
  END IF;
  SELECT f.* INTO v_feed FROM crove_social.calendar_feed f
  WHERE f.token_sha256 = pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_token, 'UTF8')), 'hex');
  IF v_feed.id IS NULL OR v_feed.revoked_at IS NOT NULL THEN
    RETURN NULL;
  END IF;
  SELECT t.* INTO v_tenant FROM crove_kernel.tenant t WHERE t.org_id = v_feed.org_id AND t.status = 'active';
  IF v_tenant.org_id IS NULL THEN
    RETURN NULL;
  END IF;
  RETURN (
    WITH v AS (
      -- Scheduled (at a time or in a queue slot) and published channel posts, with their effective title and text:
      -- history (content_frozen) keeps its own, NULL then meaning none.
      SELECT v.id, v.post_id, v.provider, v.status,
             CASE WHEN v.status = 'published' THEN coalesce(v.published_at, v.queue_slot_at, v.scheduled_at) ELSE coalesce(v.queue_slot_at, v.scheduled_at) END AS at,
             CASE WHEN v.content_frozen THEN v.title ELSE coalesce(v.title, p.title) END AS title,
             CASE WHEN v.content_frozen THEN coalesce(v.body, '') ELSE coalesce(v.body, p.body) END AS body
      FROM crove_social.post_variant v
      JOIN crove_social.post p ON p.org_id = v.org_id AND p.id = v.post_id
      WHERE v.org_id = v_feed.org_id AND v.status IN ('scheduled', 'published')
    ),
    e AS (
      SELECT v.id, v.post_id, v.provider, v.status, v.at,
             -- The title, else the text's first line, on one line and at most 100 characters.
             pg_catalog.btrim(pg_catalog.left(pg_catalog.btrim(pg_catalog.regexp_replace(coalesce(
               nullif(pg_catalog.btrim(v.title), ''),
               pg_catalog.split_part(pg_catalog.btrim(v.body, E' \t\r\n'), E'\n', 1)
             ), '\s+', ' ', 'g')), 100)) AS title
      FROM v
      WHERE v.at >= pg_catalog.now() - interval '30 days' AND v.at < pg_catalog.now() + interval '60 days'
      ORDER BY v.at, v.id
      LIMIT 1000
    )
    SELECT pg_catalog.jsonb_build_object(
      'slug', v_tenant.slug,
      'name', v_tenant.name,
      'events', coalesce((
        SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'id', e.id,
          'postId', e.post_id,
          'provider', e.provider,
          'at', e.at,
          'status', e.status,
          'title', e.title
        ) ORDER BY e.at, e.id)
        FROM e
      ), '[]'::jsonb)
    )
  );
END $$;
REVOKE ALL ON FUNCTION crove_social.calendar_feed_events(text) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_social.calendar_feed_events(text) TO crove_app;
