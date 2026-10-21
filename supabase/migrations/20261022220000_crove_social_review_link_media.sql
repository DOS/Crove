-- Crove Social: the post's images and video on the client review page (issue #624, from the review of #621). Idempotent.
--
-- review_link_media(token)          for a valid link: each channel's files, in the order review_link_view lists the
--                                   channels (position, id), as [[{ id, type }], ...]: a channel's own files when it
--                                   has them, else the post's. Ids and content types only.
-- review_link_file(token, file id)  for a valid link and a file one of its post's channels shows: where its bytes are
--                                   (storage key, generation, sha256), its type, size and name; NULL otherwise. The
--                                   API reads and checks the bytes; nothing else of the org comes back.
-- Only crove_app (the API login role, which serves the public review page) may execute them, as for the view.
SET LOCAL lock_timeout = '2s';

CREATE OR REPLACE FUNCTION crove_social.review_link_media(p_token text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_link crove_social.review_link;
BEGIN
  v_link := crove_social.review_link_by_token(p_token, false);
  IF v_link.id IS NULL THEN
    RETURN NULL;
  END IF;
  RETURN coalesce((
    SELECT pg_catalog.jsonb_agg(
      CASE WHEN pg_catalog.jsonb_typeof(v.media) = 'array' THEN coalesce((
        SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('id', f.id, 'type', f.content_type) ORDER BY x.n)
        FROM pg_catalog.jsonb_array_elements(v.media) WITH ORDINALITY x(e, n)
        -- Compared as uuids, so the join uses the file's key; an entry that is no uuid matches nothing.
        JOIN crove_kernel.file f ON f.org_id = v.org_id AND f.id = CASE WHEN (x.e->>'fileId') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN (x.e->>'fileId')::uuid END
      ), '[]'::jsonb)
      ELSE coalesce((
        SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('id', f.id, 'type', f.content_type) ORDER BY m.position)
        FROM crove_social.post_media m
        JOIN crove_kernel.file f ON f.org_id = m.org_id AND f.id = m.file_id
        WHERE m.org_id = v.org_id AND m.post_id = v.post_id
      ), '[]'::jsonb) END
      ORDER BY v.position, v.id)
    FROM crove_social.post_variant v
    JOIN crove_kernel.channel_connection c ON c.org_id = v.org_id AND c.id = v.channel_connection_id
    WHERE v.org_id = v_link.org_id AND v.post_id = v_link.post_id AND v.status <> 'cancelled'
  ), '[]'::jsonb);
END $$;
REVOKE ALL ON FUNCTION crove_social.review_link_media(text) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_social.review_link_media(text) TO crove_app;

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
  -- Only a file a live channel of the link's post shows: its own files, or the post's for a channel without them.
  IF NOT EXISTS (
    SELECT 1 FROM crove_social.post_variant v
    WHERE v.org_id = v_link.org_id AND v.post_id = v_link.post_id AND v.status <> 'cancelled'
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
