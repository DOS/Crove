-- Crove Social: the team answers a client's comment on the review link (issue #1301, folding in #930). Idempotent;
-- applied files stay untouched.
--
-- crove_social.review_feedback  gains one team reply per client answer: reply_body (plain text of 1 to 2,000
--                               characters, as the client's own comment), replied_by (the member) and replied_at, all
--                               three set or all three null. Members and above write them through
--                               social.review.reply, so crove_tenant may update these three columns and nothing else
--                               (a column grant); review_feedback_reply_guard refuses a change to the client's own
--                               fields whoever makes it, and a reply in another member's name. A reply is a column of
--                               the answer, never a row: the link's answer caps and the client's verdict count rows
--                               and verdicts only, so they are unchanged.
-- crove_social.review_link_post crove_tenant loses INSERT (#930): a plan's posts are frozen when the link is made, and
--                               review_plan_posts_add, the one path that adds them, fills only a live plan link of the
--                               caller's org that has no posts yet, for the owner or admin who made it.
--
-- review_plan_page(link)        sends each post's body once (#930): the post carries it, and a channel's body is null
--                               when it shows the post's body, its own text otherwise; each answer carries the team's
--                               reply ({ body, at } or null). Copied verbatim from
--                               20261029160000_crove_social_channel_signature.sql with only those changes.
-- review_link_view(token)       each answer carries the team's reply ({ body, at } or null). Copied verbatim from
--                               20261029160000_crove_social_channel_signature.sql with only that change.
-- The pages sign a reply with the org's name or its report branding's (#1053); no member's name or id leaves.
SET LOCAL lock_timeout = '2s';

ALTER TABLE crove_social.review_feedback ADD COLUMN IF NOT EXISTS reply_body text;
ALTER TABLE crove_social.review_feedback ADD COLUMN IF NOT EXISTS replied_by uuid;
ALTER TABLE crove_social.review_feedback ADD COLUMN IF NOT EXISTS replied_at timestamptz;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conrelid = 'crove_social.review_feedback'::regclass AND conname = 'review_feedback_reply_length') THEN
    ALTER TABLE crove_social.review_feedback ADD CONSTRAINT review_feedback_reply_length
      CHECK (reply_body IS NULL OR pg_catalog.char_length(reply_body) BETWEEN 1 AND 2000);
  END IF;
  -- A reply has its text, its author and its time, or none of them.
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conrelid = 'crove_social.review_feedback'::regclass AND conname = 'review_feedback_reply_all') THEN
    ALTER TABLE crove_social.review_feedback ADD CONSTRAINT review_feedback_reply_all
      CHECK ((reply_body IS NULL) = (replied_by IS NULL) AND (reply_body IS NULL) = (replied_at IS NULL));
  END IF;
END $$;

-- Members read what clients said and write the team's reply; only the review definers add rows.
GRANT UPDATE (reply_body, replied_by, replied_at) ON crove_social.review_feedback TO crove_tenant;

-- The client's own fields never change, whoever updates the row (the column grant already keeps crove_tenant to the
-- reply), and a reply set or changed names the member of the context as its author.
CREATE OR REPLACE FUNCTION crove_social.review_feedback_reply_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF (NEW.org_id, NEW.id, NEW.link_id, NEW.post_id, NEW.reviewer_name, NEW.verdict, NEW.body, NEW.changed, NEW.created_at)
     IS DISTINCT FROM (OLD.org_id, OLD.id, OLD.link_id, OLD.post_id, OLD.reviewer_name, OLD.verdict, OLD.body, OLD.changed, OLD.created_at) THEN
    RAISE EXCEPTION 'REVIEW_FEEDBACK_CLIENT_FIELDS' USING ERRCODE = '42501';
  END IF;
  IF NEW.reply_body IS NOT NULL
     AND (NEW.reply_body, NEW.replied_by, NEW.replied_at) IS DISTINCT FROM (OLD.reply_body, OLD.replied_by, OLD.replied_at)
     AND NEW.replied_by IS DISTINCT FROM crove_kernel.ctx_user_id() THEN
    RAISE EXCEPTION 'REVIEW_REPLY_AUTHOR' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION crove_social.review_feedback_reply_guard() FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
DROP TRIGGER IF EXISTS review_feedback_reply_guard ON crove_social.review_feedback;
CREATE TRIGGER review_feedback_reply_guard BEFORE UPDATE ON crove_social.review_feedback
  FOR EACH ROW EXECUTE FUNCTION crove_social.review_feedback_reply_guard();

-- #930: a plan's posts are frozen, so the tenant role adds none; social.review_link.create_plan fills a new link
-- through review_plan_posts_add below.
REVOKE INSERT ON crove_social.review_link_post FROM crove_tenant;

-- Fills a plan link made in this command with its posts, in the order given, each with its content key now. Raises
-- NO_CONTEXT (42501) without an org context, REVIEW_PLAN_FORBIDDEN (42501) for an actor that is not an owner or admin
-- of the org or not the link's maker, REVIEW_PLAN_INVALID (22023) for an empty, oversized or repeating list, a link
-- that is not a live plan link of the org, or a post that is not a live post of the org, and REVIEW_PLAN_FROZEN (55000)
-- when the link has its posts already.
CREATE OR REPLACE FUNCTION crove_social.review_plan_posts_add(p_link uuid, p_posts uuid[])
RETURNS integer LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
  v_user uuid := crove_kernel.ctx_user_id();
  v_link crove_social.review_link;
  v_n integer;
BEGIN
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'NO_CONTEXT' USING ERRCODE = '42501';
  END IF;
  IF crove_kernel.ctx_actor_type() IS DISTINCT FROM 'user' OR v_user IS NULL OR NOT EXISTS (
    SELECT 1 FROM crove_kernel.tenant_member m WHERE m.org_id = v_org AND m.user_id = v_user AND m.role IN ('owner', 'admin')
  ) THEN
    RAISE EXCEPTION 'REVIEW_PLAN_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  v_n := coalesce(pg_catalog.cardinality(p_posts), 0);
  IF v_n NOT BETWEEN 1 AND 50 OR pg_catalog.array_position(p_posts, NULL) IS NOT NULL
     OR (SELECT pg_catalog.count(DISTINCT x) FROM pg_catalog.unnest(p_posts) x) <> v_n THEN
    RAISE EXCEPTION 'REVIEW_PLAN_INVALID' USING ERRCODE = '22023';
  END IF;
  SELECT l.* INTO v_link FROM crove_social.review_link l WHERE l.org_id = v_org AND l.id = p_link FOR UPDATE;
  IF v_link.id IS NULL OR v_link.kind <> 'plan' OR v_link.revoked_at IS NOT NULL OR v_link.expires_at <= pg_catalog.now() THEN
    RAISE EXCEPTION 'REVIEW_PLAN_INVALID' USING ERRCODE = '22023';
  END IF;
  IF v_link.created_by <> v_user THEN
    RAISE EXCEPTION 'REVIEW_PLAN_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  IF EXISTS (SELECT 1 FROM crove_social.review_link_post lp WHERE lp.org_id = v_org AND lp.link_id = p_link) THEN
    RAISE EXCEPTION 'REVIEW_PLAN_FROZEN' USING ERRCODE = '55000';
  END IF;
  IF (SELECT pg_catalog.count(*) FROM crove_social.post p WHERE p.org_id = v_org AND p.id = ANY (p_posts) AND p.status <> 'cancelled') <> v_n THEN
    RAISE EXCEPTION 'REVIEW_PLAN_INVALID' USING ERRCODE = '22023';
  END IF;
  INSERT INTO crove_social.review_link_post (org_id, link_id, post_id, position, content_key)
  SELECT v_org, p_link, x.id, (x.n - 1)::smallint, crove_social.review_content_key(v_org, x.id)
  FROM pg_catalog.unnest(p_posts) WITH ORDINALITY AS x(id, n);
  RETURN v_n;
END $$;
REVOKE ALL ON FUNCTION crove_social.review_plan_posts_add(uuid, uuid[]) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_social.review_plan_posts_add(uuid, uuid[]) TO crove_tenant;

-- Copied verbatim from 20261029160000_crove_social_channel_signature.sql, but each post's body is sent once (the
-- post's 'body'; a channel's 'body' is null when it shows the post's body), and each answer has the team's 'reply'.
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
            -- The post's body, once (#930); a channel that shows it says null.
            'body', p.body,
            'channels', coalesce((
              SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                'provider', v.provider,
                'channel', c.display_name,
                'status', v.status,
                'body', CASE WHEN (CASE WHEN v.content_frozen THEN coalesce(v.body, '') ELSE coalesce(v.body, p.body) END) IS DISTINCT FROM p.body
                             THEN CASE WHEN v.content_frozen THEN coalesce(v.body, '') ELSE coalesce(v.body, p.body) END END,
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
              SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('name', f.reviewer_name, 'verdict', f.verdict, 'body', f.body, 'at', f.created_at,
                -- The team's reply (#1301), signed by the page with the org's name: no member's name or id.
                'reply', CASE WHEN f.reply_body IS NOT NULL THEN pg_catalog.jsonb_build_object('body', f.reply_body, 'at', f.replied_at) END) ORDER BY f.created_at DESC)
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

-- Copied verbatim from 20261029160000_crove_social_channel_signature.sql, but each answer has the team's 'reply'.
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
      SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('name', f.reviewer_name, 'verdict', f.verdict, 'body', f.body, 'at', f.created_at,
        -- The team's reply (#1301), signed by the page with the org's name: no member's name or id.
        'reply', CASE WHEN f.reply_body IS NOT NULL THEN pg_catalog.jsonb_build_object('body', f.reply_body, 'at', f.replied_at) END) ORDER BY f.created_at DESC)
      FROM (SELECT * FROM crove_social.review_feedback f0 WHERE f0.org_id = v_link.org_id AND f0.link_id = v_link.id ORDER BY f0.created_at DESC LIMIT 50) f
    ), '[]'::jsonb)
  );
END $$;
REVOKE ALL ON FUNCTION crove_social.review_link_view(text) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_social.review_link_view(text) TO crove_app;
