-- Crove Social: client review links (issue #589). Idempotent.
--
-- An agency sends a client a link (often over Zalo) to see a post as each channel will show it and say "Approved",
-- "Needs changes" or leave a comment, without an account. The client's word is a signal recorded on the post for the
-- team; it is never one of the approvals a channel needs to publish (the team still approves).
--
-- review_link      one link of a post: the SHA-256 of its token (the secret is only in the URL the creator copies,
--                  after the # so it never reaches a server log), its expiry (at most 30 days), its revocation, and the
--                  content key of the post when it was made, so the page can say that the post changed since.
--                  Owners and admins make and revoke links through commands; nothing else about a link changes.
-- review_feedback  what a client said through a link, with the name they typed. Only review_feedback_add() adds rows
--                  (for whoever holds the token); members read them.
--
-- review_content_key(org, post)    the hash of the post's channels and their content hashes: changes when content does.
-- review_link_view(token)          for a valid link (well-formed token, not revoked, not expired, active org): the
--                                  post as each channel shows it and the link's feedback, as JSON; NULL otherwise.
--                                  Nothing else of the org: no ids of people, no other post, no files.
-- review_feedback_add(token, ...)  records one client answer on a valid link, at most 100 per link; NULL otherwise.
-- Only crove_app (the API login role, which serves the public review page) may execute the two token functions.
SET LOCAL lock_timeout = '2s';

CREATE TABLE IF NOT EXISTS crove_social.review_link (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  post_id uuid NOT NULL,
  token_sha256 text NOT NULL CONSTRAINT review_link_token_format CHECK (token_sha256 ~ '^[0-9a-f]{64}$'),
  content_key text NOT NULL DEFAULT '' CHECK (length(content_key) <= 64),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  revoked_by uuid,
  PRIMARY KEY (org_id, id),
  CONSTRAINT review_link_token_uq UNIQUE (token_sha256),
  CONSTRAINT review_link_post_uq UNIQUE (org_id, id, post_id),
  CONSTRAINT review_link_post_fk FOREIGN KEY (org_id, post_id) REFERENCES crove_social.post (org_id, id) ON DELETE CASCADE,
  CONSTRAINT review_link_expiry CHECK (expires_at > created_at AND expires_at <= created_at + interval '31 days'),
  CONSTRAINT review_link_revoked CHECK ((revoked_at IS NULL) = (revoked_by IS NULL))
);
CREATE INDEX IF NOT EXISTS review_link_post_idx ON crove_social.review_link (org_id, post_id, created_at DESC);
SELECT crove_kernel.apply_tenant_rls('crove_social.review_link');
REVOKE UPDATE, DELETE ON crove_social.review_link FROM crove_tenant;
GRANT UPDATE (revoked_at, revoked_by) ON crove_social.review_link TO crove_tenant;

CREATE TABLE IF NOT EXISTS crove_social.review_feedback (
  org_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  link_id uuid NOT NULL,
  post_id uuid NOT NULL,
  reviewer_name text NOT NULL CHECK (length(reviewer_name) BETWEEN 1 AND 100),
  verdict text NOT NULL CHECK (verdict IN ('approved', 'changes_requested', 'comment')),
  body text CHECK (body IS NULL OR length(body) BETWEEN 1 AND 2000),
  -- The post had changed since the link was made when the client answered.
  changed boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, id),
  CONSTRAINT review_feedback_link_fk FOREIGN KEY (org_id, link_id, post_id) REFERENCES crove_social.review_link (org_id, id, post_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS review_feedback_post_idx ON crove_social.review_feedback (org_id, post_id, created_at DESC);
CREATE INDEX IF NOT EXISTS review_feedback_link_idx ON crove_social.review_feedback (org_id, link_id);
SELECT crove_kernel.apply_tenant_rls('crove_social.review_feedback');
-- Members read what clients said; only review_feedback_add() writes it.
REVOKE INSERT, UPDATE, DELETE ON crove_social.review_feedback FROM crove_tenant;

CREATE OR REPLACE FUNCTION crove_social.review_content_key(p_org uuid, p_post uuid)
RETURNS text LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
    coalesce(pg_catalog.string_agg(v.id::text || ':' || v.content_hash, ',' ORDER BY v.id), ''), 'UTF8')), 'hex')
  FROM crove_social.post_variant v
  WHERE v.org_id = p_org AND v.post_id = p_post AND v.status <> 'cancelled'
$$;
REVOKE ALL ON FUNCTION crove_social.review_content_key(uuid, uuid) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_social.review_content_key(uuid, uuid) TO crove_tenant;

-- The live link a token names, or nothing: a malformed token, an unknown, revoked or expired link, or a closed org.
-- Called only from the two definers below (it runs as their owner); nobody may execute it directly.
CREATE OR REPLACE FUNCTION crove_social.review_link_by_token(p_token text, p_lock boolean)
RETURNS crove_social.review_link LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_link crove_social.review_link;
BEGIN
  -- 32 random bytes, base64url without padding (newReviewToken in modules/social).
  IF p_token IS NULL OR p_token !~ '^[A-Za-z0-9_-]{43}$' THEN
    RETURN NULL;
  END IF;
  IF p_lock THEN
    SELECT l.* INTO v_link FROM crove_social.review_link l
    WHERE l.token_sha256 = pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_token, 'UTF8')), 'hex')
    FOR UPDATE;
  ELSE
    SELECT l.* INTO v_link FROM crove_social.review_link l
    WHERE l.token_sha256 = pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_token, 'UTF8')), 'hex');
  END IF;
  IF v_link.id IS NULL OR v_link.revoked_at IS NOT NULL OR v_link.expires_at <= pg_catalog.now() THEN
    RETURN NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM crove_kernel.tenant t WHERE t.org_id = v_link.org_id AND t.status = 'active') THEN
    RETURN NULL;
  END IF;
  RETURN v_link;
END $$;
REVOKE ALL ON FUNCTION crove_social.review_link_by_token(text, boolean) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;

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

CREATE OR REPLACE FUNCTION crove_social.review_feedback_add(p_token text, p_name text, p_verdict text, p_body text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_link crove_social.review_link;
  v_name text := pg_catalog.btrim(coalesce(p_name, ''));
  v_body text := nullif(pg_catalog.btrim(coalesce(p_body, '')), '');
  v_id uuid;
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
  IF (SELECT pg_catalog.count(*) FROM crove_social.review_feedback f WHERE f.org_id = v_link.org_id AND f.link_id = v_link.id) >= 100 THEN
    RAISE EXCEPTION 'review link answer limit reached' USING ERRCODE = '54000';
  END IF;
  INSERT INTO crove_social.review_feedback (org_id, link_id, post_id, reviewer_name, verdict, body, changed)
  VALUES (v_link.org_id, v_link.id, v_link.post_id, v_name, p_verdict, v_body,
          crove_social.review_content_key(v_link.org_id, v_link.post_id) <> v_link.content_key)
  RETURNING id INTO v_id;
  RETURN pg_catalog.jsonb_build_object('recorded', true);
END $$;
REVOKE ALL ON FUNCTION crove_social.review_feedback_add(text, text, text, text) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_social.review_feedback_add(text, text, text, text) TO crove_app;
