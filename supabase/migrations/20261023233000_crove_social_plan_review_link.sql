-- Crove Social: one client review link for a content plan (issue #902). Idempotent.
--
-- A review link covered one post (#589). A plan link covers several: the posts an owner or admin picked (at most 50),
-- or those going out in a date range on the chosen channels, frozen into a set of posts when the link is made, so a
-- post added later never joins it. The client walks through the posts on one page and answers each; an answer is the
-- same answer a single-post link records: a review_feedback row of that post and the social.review.answered event, so
-- the client approval step (#770), the notifications and the review inbox settle that post alone, as before.
-- Revocation, expiry, the rate limits of the public page and the member-revoke rule (#625) are the link's, as before,
-- and the database keeps only the SHA-256 of its token.
--
-- review_link       gains kind: 'post' (every link so far, post_id set, unchanged) or 'plan' (post_id NULL). A plan
--                   made from a range keeps it (plan_from, plan_to) for the team's list.
-- review_link_post  the posts of a plan link, in the order they were scheduled when it was made (position), each with
--                   its content key then (review_content_key), so the page and the client approval know when one
--                   changed since. Written once by social.review_link.create_plan; nothing updates or deletes a row.
-- review_feedback   its foreign key named the link's single post. It now names the link and the post separately, and a
--                   trigger checks the post is the link's: its post, or one of its plan's.
--
-- review_link_view(token)                           a plan link answers the plan (review_plan_page below); a
--                                                   single-post link answers as before.
-- review_plan_page(link)                            each post in schedule order, as each channel shows it with its
--                                                   files' ids and types, and its answers through this link; only
--                                                   { id, gone: true } for a post cancelled since. Called only from
--                                                   review_link_view.
-- review_plan_feedback_add(token, post, name, ...)  records one client answer on one live post of a live plan link, at
--                                                   most 20 per post; NULL for a dead link; 55000 for a post cancelled
--                                                   since; 22023 for a post not in the plan.
-- review_feedback_add(token, ...)                   refuses a plan link (22023: its answers name a post); otherwise the
--                                                   body of 20261021140000.
-- review_link_file(token, file)                     also serves the files of a plan's live posts.
-- review_link_media(token) is unchanged: the plan page carries its files' ids itself, so for a plan link it answers [].
-- Only crove_app (the API login role, which serves the public review page) may execute the token functions.
SET LOCAL lock_timeout = '2s';

ALTER TABLE crove_social.review_link ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'post';
ALTER TABLE crove_social.review_link ADD COLUMN IF NOT EXISTS plan_from timestamptz;
ALTER TABLE crove_social.review_link ADD COLUMN IF NOT EXISTS plan_to timestamptz;
ALTER TABLE crove_social.review_link ALTER COLUMN post_id DROP NOT NULL;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conrelid = 'crove_social.review_link'::regclass AND conname = 'review_link_kind_values') THEN
    ALTER TABLE crove_social.review_link ADD CONSTRAINT review_link_kind_values CHECK (kind IN ('post', 'plan'));
  END IF;
  -- A single-post link names its post; a plan link names none (its posts are in review_link_post).
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conrelid = 'crove_social.review_link'::regclass AND conname = 'review_link_kind_post') THEN
    ALTER TABLE crove_social.review_link ADD CONSTRAINT review_link_kind_post CHECK ((kind = 'post') = (post_id IS NOT NULL));
  END IF;
  -- The range a plan was made from: both ends or neither, at most 93 days, on plan links only.
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conrelid = 'crove_social.review_link'::regclass AND conname = 'review_link_plan_range') THEN
    ALTER TABLE crove_social.review_link ADD CONSTRAINT review_link_plan_range CHECK (
      (plan_from IS NULL AND plan_to IS NULL)
      OR (kind = 'plan' AND plan_from IS NOT NULL AND plan_to > plan_from AND plan_to <= plan_from + interval '93 days'));
  END IF;
END $$;
-- The org's plan links, newest first (the team's list, and the cap on live ones).
CREATE INDEX IF NOT EXISTS review_link_kind_idx ON crove_social.review_link (org_id, kind, created_at DESC);

CREATE TABLE IF NOT EXISTS crove_social.review_link_post (
  org_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  link_id uuid NOT NULL,
  post_id uuid NOT NULL,
  position smallint NOT NULL CHECK (position BETWEEN 0 AND 49),
  content_key text NOT NULL DEFAULT '' CHECK (length(content_key) <= 64),
  PRIMARY KEY (org_id, id),
  CONSTRAINT review_link_post_member_uq UNIQUE (org_id, link_id, post_id),
  CONSTRAINT review_link_post_link_fk FOREIGN KEY (org_id, link_id) REFERENCES crove_social.review_link (org_id, id) ON DELETE CASCADE,
  CONSTRAINT review_link_post_post_fk FOREIGN KEY (org_id, post_id) REFERENCES crove_social.post (org_id, id) ON DELETE CASCADE
);
-- The plan links a post is in (the post's review card, the client's standing answer).
CREATE INDEX IF NOT EXISTS review_link_post_by_post_idx ON crove_social.review_link_post (org_id, post_id);
-- Members read a plan's posts; the create command adds them once, and nothing changes them after.
SELECT crove_kernel.apply_tenant_rls('crove_social.review_link_post', true);

-- The feedback's link and post, each on its own: a plan link's feedback names one of its posts, not the link's.
ALTER TABLE crove_social.review_feedback DROP CONSTRAINT IF EXISTS review_feedback_link_fk;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conrelid = 'crove_social.review_feedback'::regclass AND conname = 'review_feedback_of_link_fk') THEN
    ALTER TABLE crove_social.review_feedback ADD CONSTRAINT review_feedback_of_link_fk
      FOREIGN KEY (org_id, link_id) REFERENCES crove_social.review_link (org_id, id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conrelid = 'crove_social.review_feedback'::regclass AND conname = 'review_feedback_of_post_fk') THEN
    ALTER TABLE crove_social.review_feedback ADD CONSTRAINT review_feedback_of_post_fk
      FOREIGN KEY (org_id, post_id) REFERENCES crove_social.post (org_id, id) ON DELETE CASCADE;
  END IF;
END $$;

-- What the dropped foreign key held, for both kinds: the feedback's post is its link's post, or one of its plan's.
CREATE OR REPLACE FUNCTION crove_social.review_feedback_in_link() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM crove_social.review_link l WHERE l.org_id = NEW.org_id AND l.id = NEW.link_id AND l.post_id = NEW.post_id)
     AND NOT EXISTS (SELECT 1 FROM crove_social.review_link_post lp WHERE lp.org_id = NEW.org_id AND lp.link_id = NEW.link_id AND lp.post_id = NEW.post_id) THEN
    RAISE EXCEPTION 'review feedback names a post its link does not cover' USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION crove_social.review_feedback_in_link() FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
DROP TRIGGER IF EXISTS review_feedback_in_link ON crove_social.review_feedback;
CREATE TRIGGER review_feedback_in_link BEFORE INSERT OR UPDATE OF org_id, link_id, post_id ON crove_social.review_feedback
  FOR EACH ROW EXECUTE FUNCTION crove_social.review_feedback_in_link();

-- The plan page of a live plan link (review_link_view checked the token). Nothing else of the org: no ids of people,
-- no post outside the plan, the files' ids and types only.
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

-- Same body as 20261021020000 for a single-post link; a plan link answers its plan.
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
    RETURN crove_social.review_plan_page(v_link);
  END IF;
  SELECT p.* INTO v_post FROM crove_social.post p WHERE p.org_id = v_link.org_id AND p.id = v_link.post_id;
  RETURN pg_catalog.jsonb_build_object(
    'org', (SELECT t.name FROM crove_kernel.tenant t WHERE t.org_id = v_link.org_id),
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

-- Same body as 20261021140000, but a plan link's answers name a post (review_plan_feedback_add).
CREATE OR REPLACE FUNCTION crove_social.review_feedback_add(p_token text, p_name text, p_verdict text, p_body text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_link crove_social.review_link;
  v_name text := pg_catalog.btrim(coalesce(p_name, ''));
  v_body text := nullif(pg_catalog.btrim(coalesce(p_body, '')), '');
  v_id uuid;
  v_event uuid;
BEGIN
  IF pg_catalog.length(v_name) NOT BETWEEN 1 AND 100 OR p_verdict IS NULL OR p_verdict NOT IN ('approved', 'changes_requested', 'comment')
     OR (v_body IS NOT NULL AND pg_catalog.length(v_body) > 2000) OR (p_verdict = 'comment' AND v_body IS NULL) THEN
    RAISE EXCEPTION 'invalid review feedback' USING ERRCODE = '22023';
  END IF;
  -- Locked, so the cap below holds against answers sent at the same time.
  v_link := crove_social.review_link_by_token(p_token, true);
  IF v_link.id IS NULL THEN
    RETURN NULL;
  END IF;
  IF v_link.kind = 'plan' THEN
    RAISE EXCEPTION 'a plan link takes an answer per post' USING ERRCODE = '22023';
  END IF;
  IF (SELECT pg_catalog.count(*) FROM crove_social.review_feedback f WHERE f.org_id = v_link.org_id AND f.link_id = v_link.id) >= 100 THEN
    RAISE EXCEPTION 'review link answer limit reached' USING ERRCODE = '54000';
  END IF;
  INSERT INTO crove_social.review_feedback (org_id, link_id, post_id, reviewer_name, verdict, body, changed)
  VALUES (v_link.org_id, v_link.id, v_link.post_id, v_name, p_verdict, v_body,
          crove_social.review_content_key(v_link.org_id, v_link.post_id) <> v_link.content_key)
  RETURNING id INTO v_id;
  INSERT INTO crove_kernel.outbox_event (org_id, type, payload, actor_type)
  VALUES (v_link.org_id, 'social.review.answered', pg_catalog.jsonb_build_object('post_id', v_link.post_id, 'feedback_id', v_id), 'system')
  RETURNING id INTO v_event;
  INSERT INTO crove_kernel.outbox_pending (org_id, event_id) VALUES (v_link.org_id, v_event);
  PERFORM pg_catalog.pg_notify('crove_outbox', '');
  RETURN pg_catalog.jsonb_build_object('recorded', true);
END $$;
REVOKE ALL ON FUNCTION crove_social.review_feedback_add(text, text, text, text) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_social.review_feedback_add(text, text, text, text) TO crove_app;

-- One client answer on one post of a plan link: the same row, event and checks as review_feedback_add, for that post.
CREATE OR REPLACE FUNCTION crove_social.review_plan_feedback_add(p_token text, p_post uuid, p_name text, p_verdict text, p_body text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_link crove_social.review_link;
  v_item crove_social.review_link_post;
  v_status text;
  v_name text := pg_catalog.btrim(coalesce(p_name, ''));
  v_body text := nullif(pg_catalog.btrim(coalesce(p_body, '')), '');
  v_id uuid;
  v_event uuid;
BEGIN
  IF pg_catalog.length(v_name) NOT BETWEEN 1 AND 100 OR p_verdict IS NULL OR p_verdict NOT IN ('approved', 'changes_requested', 'comment')
     OR (v_body IS NOT NULL AND pg_catalog.length(v_body) > 2000) OR (p_verdict = 'comment' AND v_body IS NULL) THEN
    RAISE EXCEPTION 'invalid review feedback' USING ERRCODE = '22023';
  END IF;
  -- Locked, so the cap below holds against answers sent at the same time.
  v_link := crove_social.review_link_by_token(p_token, true);
  IF v_link.id IS NULL THEN
    RETURN NULL;
  END IF;
  IF v_link.kind <> 'plan' OR p_post IS NULL THEN
    RAISE EXCEPTION 'not a post of this plan' USING ERRCODE = '22023';
  END IF;
  SELECT lp.* INTO v_item FROM crove_social.review_link_post lp WHERE lp.org_id = v_link.org_id AND lp.link_id = v_link.id AND lp.post_id = p_post;
  IF v_item.id IS NULL THEN
    RAISE EXCEPTION 'not a post of this plan' USING ERRCODE = '22023';
  END IF;
  SELECT p.status INTO v_status FROM crove_social.post p WHERE p.org_id = v_link.org_id AND p.id = p_post;
  IF v_status IS NULL OR v_status = 'cancelled' THEN
    RAISE EXCEPTION 'this post is no longer in the plan' USING ERRCODE = '55000';
  END IF;
  IF (SELECT pg_catalog.count(*) FROM crove_social.review_feedback f WHERE f.org_id = v_link.org_id AND f.link_id = v_link.id AND f.post_id = p_post) >= 20 THEN
    RAISE EXCEPTION 'review link answer limit reached' USING ERRCODE = '54000';
  END IF;
  INSERT INTO crove_social.review_feedback (org_id, link_id, post_id, reviewer_name, verdict, body, changed)
  VALUES (v_link.org_id, v_link.id, p_post, v_name, p_verdict, v_body,
          crove_social.review_content_key(v_link.org_id, p_post) <> v_item.content_key)
  RETURNING id INTO v_id;
  INSERT INTO crove_kernel.outbox_event (org_id, type, payload, actor_type)
  VALUES (v_link.org_id, 'social.review.answered', pg_catalog.jsonb_build_object('post_id', p_post, 'feedback_id', v_id), 'system')
  RETURNING id INTO v_event;
  INSERT INTO crove_kernel.outbox_pending (org_id, event_id) VALUES (v_link.org_id, v_event);
  PERFORM pg_catalog.pg_notify('crove_outbox', '');
  RETURN pg_catalog.jsonb_build_object('recorded', true);
END $$;
REVOKE ALL ON FUNCTION crove_social.review_plan_feedback_add(text, uuid, text, text, text) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_social.review_plan_feedback_add(text, uuid, text, text, text) TO crove_app;

-- Same body as 20261022220000, but the posts a link shows are its post or its plan's live posts.
CREATE OR REPLACE FUNCTION crove_social.review_link_file(p_token text, p_file uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_link crove_social.review_link;
  v_file crove_kernel.file;
BEGIN
  v_link := crove_social.review_link_by_token(p_token, false);
  IF v_link.id IS NULL OR p_file IS NULL THEN
    RETURN NULL;
  END IF;
  -- Only a file a live channel of one of the link's posts shows: its own files, or the post's for a channel without them.
  IF NOT EXISTS (
    SELECT 1 FROM crove_social.post_variant v
    WHERE v.org_id = v_link.org_id AND v.status <> 'cancelled'
      AND v.post_id IN (
        SELECT v_link.post_id WHERE v_link.kind = 'post'
        UNION ALL
        SELECT lp.post_id FROM crove_social.review_link_post lp
        JOIN crove_social.post p ON p.org_id = lp.org_id AND p.id = lp.post_id
        WHERE v_link.kind = 'plan' AND lp.org_id = v_link.org_id AND lp.link_id = v_link.id AND p.status <> 'cancelled'
      )
      AND (
        (pg_catalog.jsonb_typeof(v.media) = 'array' AND v.media @> pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('fileId', p_file::text)))
        OR (pg_catalog.jsonb_typeof(v.media) IS DISTINCT FROM 'array' AND EXISTS (
          SELECT 1 FROM crove_social.post_media m WHERE m.org_id = v.org_id AND m.post_id = v.post_id AND m.file_id = p_file))
      )
  ) THEN
    RETURN NULL;
  END IF;
  SELECT f.* INTO v_file FROM crove_kernel.file f WHERE f.org_id = v_link.org_id AND f.id = p_file;
  IF v_file.id IS NULL THEN
    RETURN NULL;
  END IF;
  RETURN pg_catalog.jsonb_build_object(
    'key', v_file.storage_key, 'generation', v_file.generation, 'sha256', v_file.sha256,
    'type', v_file.content_type, 'size', v_file.size_bytes, 'filename', v_file.filename);
END $$;
REVOKE ALL ON FUNCTION crove_social.review_link_file(text, uuid) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_social.review_link_file(text, uuid) TO crove_app;
