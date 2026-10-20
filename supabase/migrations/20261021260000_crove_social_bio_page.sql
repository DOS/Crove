-- An org's link-in-bio page (issue #707). Idempotent; applied files stay untouched.
--
-- crove_social.bio_page        one page per org, at PUBLIC_URL/b/<slug> once published: a title, a short about, an
--                              avatar from the media library, up to 12 buttons (label and link) and, if chosen, a grid
--                              of the org's recent published image posts. Owners and admins edit it; a new slug frees
--                              the old one at once.
-- crove_social.bio_click       a day's clicks (UTC) on one of a page's buttons or posts. Only bio_page_go writes them:
--                              nothing of the visitor is kept.
-- crove_social.bio_page_view   for a published page of an active org: what the page shows (no button link, no file
--                              key, no member), by slug.
-- crove_social.bio_page_go     a button's or a shown post's link, and one more click of the day.
-- crove_social.bio_page_file   where the page's avatar or a shown post's image is stored, for the kernel to send it;
--                              any other file of the org is nothing.
SET LOCAL lock_timeout = '2s';

CREATE TABLE IF NOT EXISTS crove_social.bio_page (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  slug text NOT NULL CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$'),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 100),
  about text CHECK (about IS NULL OR length(about) BETWEEN 1 AND 300),
  avatar_file_id uuid,
  -- [{label, url}], checked by the command: 1 to 60 characters, an http(s) link of at most 2,000.
  buttons jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(buttons) = 'array' AND jsonb_array_length(buttons) <= 12 AND pg_column_size(buttons) <= 65536),
  show_posts boolean NOT NULL DEFAULT true,
  published boolean NOT NULL DEFAULT false,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, id),
  CONSTRAINT bio_page_one UNIQUE (org_id)
);
-- Slugs are looked up without an org (the public page), so they are unique across orgs.
CREATE UNIQUE INDEX IF NOT EXISTS bio_page_slug_uq ON crove_social.bio_page (slug);
SELECT crove_kernel.apply_tenant_rls('crove_social.bio_page');

CREATE TABLE IF NOT EXISTS crove_social.bio_click (
  org_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  page_id uuid NOT NULL,
  -- button:<index> or post:<post id>.
  target text NOT NULL CHECK (target ~ '^(button:[0-9]{1,2}|post:[0-9a-f-]{36})$'),
  day date NOT NULL,
  clicks bigint NOT NULL DEFAULT 0 CHECK (clicks >= 0),
  PRIMARY KEY (org_id, id),
  CONSTRAINT bio_click_day_uq UNIQUE (org_id, page_id, target, day),
  CONSTRAINT bio_click_page_fk FOREIGN KEY (org_id, page_id) REFERENCES crove_social.bio_page (org_id, id) ON DELETE CASCADE
);
SELECT crove_kernel.apply_tenant_rls('crove_social.bio_click');
REVOKE INSERT, UPDATE, DELETE ON crove_social.bio_click FROM crove_tenant;

-- The posts a page shows: the org's 12 newest posts with a channel published and an image of their own, newest first,
-- each with its first image and the link a click opens (the post's link, or where a channel shows it).
CREATE OR REPLACE FUNCTION crove_social.bio_page_posts(p_org uuid)
RETURNS TABLE (post_id uuid, file_id uuid, excerpt text, link text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT p.id, m.file_id, left(regexp_replace(coalesce(nullif(p.title, ''), p.body), '\s+', ' ', 'g'), 140),
         coalesce(
           CASE WHEN p.link_url ~ '^https?://' THEN p.link_url END,
           (SELECT v.external_url FROM crove_social.post_variant v WHERE v.org_id = p.org_id AND v.post_id = p.id AND v.status = 'published' AND v.external_url ~ '^https?://' ORDER BY v.published_at DESC LIMIT 1)
         )
  FROM crove_social.post p
  JOIN LATERAL (
    SELECT pm.file_id FROM crove_social.post_media pm JOIN crove_kernel.file f ON f.org_id = pm.org_id AND f.id = pm.file_id
    WHERE pm.org_id = p.org_id AND pm.post_id = p.id AND f.content_type IN ('image/jpeg', 'image/png', 'image/webp')
    ORDER BY pm.position LIMIT 1
  ) m ON true
  WHERE p.org_id = p_org
    AND EXISTS (SELECT 1 FROM crove_social.post_variant v WHERE v.org_id = p.org_id AND v.post_id = p.id AND v.status = 'published')
  ORDER BY (SELECT max(v.published_at) FROM crove_social.post_variant v WHERE v.org_id = p.org_id AND v.post_id = p.id AND v.status = 'published') DESC NULLS LAST, p.id
  LIMIT 12
$$;
REVOKE ALL ON FUNCTION crove_social.bio_page_posts(uuid) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;

-- A published page of an active org, by slug: title, about, whether it has an avatar, the buttons' labels, and the
-- posts it shows (their image's id, text and whether they open a link).
CREATE OR REPLACE FUNCTION crove_social.bio_page_view(p_slug text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_page crove_social.bio_page;
BEGIN
  IF p_slug IS NULL OR p_slug !~ '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$' THEN
    RETURN NULL;
  END IF;
  SELECT b.* INTO v_page FROM crove_social.bio_page b JOIN crove_kernel.tenant t ON t.org_id = b.org_id AND t.status = 'active'
  WHERE b.slug = p_slug AND b.published;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  RETURN jsonb_build_object(
    'title', v_page.title,
    'about', v_page.about,
    'avatar', v_page.avatar_file_id IS NOT NULL,
    'avatarId', v_page.avatar_file_id,
    'buttons', coalesce((SELECT jsonb_agg(jsonb_build_object('label', b.value->>'label') ORDER BY b.ordinality) FROM jsonb_array_elements(v_page.buttons) WITH ORDINALITY b), '[]'::jsonb),
    'posts', CASE WHEN v_page.show_posts THEN coalesce((
      SELECT jsonb_agg(jsonb_build_object('postId', x.post_id, 'fileId', x.file_id, 'excerpt', x.excerpt, 'linked', x.link IS NOT NULL))
      FROM crove_social.bio_page_posts(v_page.org_id) x), '[]'::jsonb) ELSE '[]'::jsonb END
  );
END $$;
REVOKE ALL ON FUNCTION crove_social.bio_page_view(text) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_social.bio_page_view(text) TO crove_app;

-- The link behind a button (button:<i>) or a shown post (post:<id>) of a published page, and, with p_count, one more
-- click of the day. NULL for anything else.
CREATE OR REPLACE FUNCTION crove_social.bio_page_go(p_slug text, p_target text, p_count boolean)
RETURNS text LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_page crove_social.bio_page;
  v_url text;
BEGIN
  IF p_slug IS NULL OR p_slug !~ '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$' OR p_target IS NULL OR p_target !~ '^(button:[0-9]{1,2}|post:[0-9a-f-]{36})$' THEN
    RETURN NULL;
  END IF;
  SELECT b.* INTO v_page FROM crove_social.bio_page b JOIN crove_kernel.tenant t ON t.org_id = b.org_id AND t.status = 'active'
  WHERE b.slug = p_slug AND b.published;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  IF p_target LIKE 'button:%' THEN
    v_url := v_page.buttons -> (substr(p_target, 8)::int) ->> 'url';
  ELSIF v_page.show_posts THEN
    SELECT x.link INTO v_url FROM crove_social.bio_page_posts(v_page.org_id) x WHERE x.post_id::text = substr(p_target, 6);
  END IF;
  IF v_url IS NULL OR v_url !~ '^https?://' THEN
    RETURN NULL;
  END IF;
  IF coalesce(p_count, false) THEN
    INSERT INTO crove_social.bio_click (org_id, page_id, target, day, clicks)
    VALUES (v_page.org_id, v_page.id, p_target, (pg_catalog.now() AT TIME ZONE 'UTC')::date, 1)
    ON CONFLICT (org_id, page_id, target, day) DO UPDATE SET clicks = crove_social.bio_click.clicks + 1;
  END IF;
  RETURN v_url;
END $$;
REVOKE ALL ON FUNCTION crove_social.bio_page_go(text, text, boolean) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_social.bio_page_go(text, text, boolean) TO crove_app;

-- Where a file the published page shows is stored (its avatar, or the image of a post it shows); nothing for any other.
CREATE OR REPLACE FUNCTION crove_social.bio_page_file(p_slug text, p_file uuid)
RETURNS TABLE (storage_key text, generation text, sha256 text, content_type text, size_bytes bigint)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_page crove_social.bio_page;
BEGIN
  IF p_slug IS NULL OR p_slug !~ '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$' OR p_file IS NULL THEN
    RETURN;
  END IF;
  SELECT b.* INTO v_page FROM crove_social.bio_page b JOIN crove_kernel.tenant t ON t.org_id = b.org_id AND t.status = 'active'
  WHERE b.slug = p_slug AND b.published;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  IF p_file IS DISTINCT FROM v_page.avatar_file_id
     AND NOT (v_page.show_posts AND EXISTS (SELECT 1 FROM crove_social.bio_page_posts(v_page.org_id) x WHERE x.file_id = p_file)) THEN
    RETURN;
  END IF;
  RETURN QUERY
    SELECT f.storage_key, f.generation, f.sha256, f.content_type, f.size_bytes::bigint FROM crove_kernel.file f
    WHERE f.org_id = v_page.org_id AND f.id = p_file AND f.content_type IN ('image/jpeg', 'image/png', 'image/webp');
END $$;
REVOKE ALL ON FUNCTION crove_social.bio_page_file(text, uuid) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_social.bio_page_file(text, uuid) TO crove_app;
