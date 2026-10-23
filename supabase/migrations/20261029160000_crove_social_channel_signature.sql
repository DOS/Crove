-- A default signature per channel (issue #1190). Idempotent; applied files stay untouched.
--
-- crove_social.channel_policy.signature  the block a channel's new posts end with (hotline, address, shop link, brand
--                                        hashtags): plain text of 1 to 500 characters, or null for none. A channel
--                                        added to a post copies it into the variant's settings (settings.signature),
--                                        so changing it later never alters a post already written or approved. No
--                                        new grant: owners and admins write it through social.channel.set_signature,
--                                        as the channel's other policy settings.
SET LOCAL lock_timeout = '2s';

ALTER TABLE crove_social.channel_policy ADD COLUMN IF NOT EXISTS signature text
  CONSTRAINT channel_policy_signature_length CHECK (signature IS NULL OR pg_catalog.char_length(signature) BETWEEN 1 AND 500);

-- The client review link (#1190) shows each channel's signature, so a client approves the text that is sent: the
-- variant's settings.signature when it is a text, else null (none, or left off with false). The page appends it to the
-- body as effectiveContent does. review_content_key is unchanged: each variant's content_hash is of the text with it.
-- Both functions are copied verbatim, with only the 'signature' field added after 'body': review_plan_page from
-- 20261023233000_crove_social_plan_review_link.sql, review_link_view from 20261028150000_crove_social_report_branding.sql.
CREATE OR REPLACE FUNCTION crove_social.review_plan_page(p_link crove_social.review_link)
RETURNS jsonb LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT pg_catalog.jsonb_build_object(
    'kind', 'plan',
    'org', (SELECT t.name FROM crove_kernel.tenant t WHERE t.org_id = p_link.org_id),
    'expiresAt', p_link.expires_at,
    'from', p_link.plan_from,
    'to', p_link.plan_to,
    'posts', coalesce((
      SELECT pg_catalog.jsonb_agg(x.item ORDER BY x.at NULLS LAST, x.position)
      FROM (
        SELECT lp.position, CASE WHEN p.status = 'cancelled' THEN NULL ELSE w.at END AS at,
          CASE WHEN p.status = 'cancelled' THEN pg_catalog.jsonb_build_object('id', p.id, 'gone', true)
          ELSE pg_catalog.jsonb_build_object(
            'id', p.id,
            'gone', false,
            'at', w.at,
            'changed', crove_social.review_content_key(p.org_id, p.id) <> lp.content_key,
            'channels', coalesce((
              SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                'provider', v.provider,
                'channel', c.display_name,
                'status', v.status,
                'body', CASE WHEN v.content_frozen THEN coalesce(v.body, '') ELSE coalesce(v.body, p.body) END,
                'signature', CASE WHEN pg_catalog.jsonb_typeof(v.settings->'signature') = 'string' THEN v.settings->>'signature' END,
                'title', CASE WHEN v.content_frozen THEN v.title ELSE coalesce(v.title, p.title) END,
                'linkUrl', CASE WHEN v.content_frozen THEN v.link_url ELSE coalesce(v.link_url, p.link_url) END,
                -- A channel's own files when it has them, else the post's (as review_link_media).
                'media', CASE WHEN pg_catalog.jsonb_typeof(v.media) = 'array' THEN coalesce((
                    SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('id', f.id, 'type', f.content_type) ORDER BY e.n)
                    FROM pg_catalog.jsonb_array_elements(v.media) WITH ORDINALITY e(item, n)
                    JOIN crove_kernel.file f ON f.org_id = v.org_id AND f.id = CASE WHEN (e.item->>'fileId') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN (e.item->>'fileId')::uuid END
                  ), '[]'::jsonb)
                  ELSE coalesce((
                    SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('id', f.id, 'type', f.content_type) ORDER BY m.position)
                    FROM crove_social.post_media m
                    JOIN crove_kernel.file f ON f.org_id = m.org_id AND f.id = m.file_id
                    WHERE m.org_id = v.org_id AND m.post_id = v.post_id
                  ), '[]'::jsonb) END
              ) ORDER BY v.position, v.id)
              FROM crove_social.post_variant v
              JOIN crove_kernel.channel_connection c ON c.org_id = v.org_id AND c.id = v.channel_connection_id
              WHERE v.org_id = p.org_id AND v.post_id = p.id AND v.status <> 'cancelled'
            ), '[]'::jsonb),
            'answers', (SELECT pg_catalog.count(*)::int FROM crove_social.review_feedback f
                        WHERE f.org_id = lp.org_id AND f.link_id = lp.link_id AND f.post_id = lp.post_id),
            'feedback', coalesce((
              SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('name', f.reviewer_name, 'verdict', f.verdict, 'body', f.body, 'at', f.created_at) ORDER BY f.created_at DESC)
              FROM (SELECT * FROM crove_social.review_feedback f0
                    WHERE f0.org_id = lp.org_id AND f0.link_id = lp.link_id AND f0.post_id = lp.post_id
                    ORDER BY f0.created_at DESC LIMIT 10) f
            ), '[]'::jsonb)
          ) END AS item
        FROM crove_social.review_link_post lp
        JOIN crove_social.post p ON p.org_id = lp.org_id AND p.id = lp.post_id
        -- When the post goes out (or went out): its earliest live channel, else the post's own time.
        CROSS JOIN LATERAL (
          SELECT coalesce(pg_catalog.min(CASE WHEN v.status IN ('published', 'removed') THEN v.published_at
                                              ELSE coalesce(v.queue_slot_at, v.scheduled_at, p.scheduled_at) END), p.scheduled_at) AS at
          FROM crove_social.post_variant v
          WHERE v.org_id = p.org_id AND v.post_id = p.id AND v.status <> 'cancelled'
        ) w
        WHERE lp.org_id = p_link.org_id AND lp.link_id = p_link.id
      ) x
    ), '[]'::jsonb)
  )
$$;
REVOKE ALL ON FUNCTION crove_social.review_plan_page(crove_social.review_link) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;

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
        'signature', CASE WHEN pg_catalog.jsonb_typeof(v.settings->'signature') = 'string' THEN v.settings->>'signature' END,
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
