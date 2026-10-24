-- Crove Social: text variations that rotate across evergreen reposts and recurring copies (issue #1260), and the
-- recurring series follow-ups of #1001. Idempotent; applied files stay untouched.
--
-- crove_social.post.text_variations      up to 5 other texts of an evergreen or series post, in order, each
--                                        { "text": 1 to 100,000 characters with something besides white space,
--                                        "ai": whether AI wrote it (#583) }, no text twice. Each evergreen repost
--                                        (#393) or recurring copy (#979) takes the next one in turn as its text, so
--                                        X and LinkedIn, which refuse a repeated text (#1156), get a new one. Set by
--                                        social.post.set_text_variations; the CHECK below refuses any other shape and
--                                        never errors on a malformed one. [] (the default): copies repeat the text
--                                        that went out, as before.
-- crove_social.post.text_variation_next  the position of the variation the next copy takes, moved on by the command
--                                        that makes the copy, under the post's lock, in the copy's transaction;
--                                        always a position of the list (0 when it is empty).
-- crove_social.evergreen_due,            take the ids the sweep already tried in this pass (p_skip), so the sweep
-- crove_social.recurring_due             asks again until the list is empty: a post or series that only waits (its
--                                        channels expired) can no longer fill the limit and keep another org's out
--                                        (#1001). The single-argument versions are dropped.
-- crove_social.recurring_due             also lists a series whose original was taken down on every channel (none
--                                        published, one removed), so social.recurring.next ends it with that reason
--                                        rather than leaving it set and silent (#1001).
--
-- The new columns follow the post's other columns: crove_tenant reads and writes the table through its row-level
-- security (table privileges from apply_tenant_rls; no column grant on crove_social.post).
SET LOCAL lock_timeout = '2s';

ALTER TABLE crove_social.post ADD COLUMN IF NOT EXISTS text_variations jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE crove_social.post ADD COLUMN IF NOT EXISTS text_variation_next smallint NOT NULL DEFAULT 0;

-- The list's shape. Each step only reads what the steps before it proved, so no value makes the check itself fail; the
-- handler turns anything unforeseen into a refusal as well. Run by the CHECK as the role that writes the row, so
-- crove_tenant (and the definer owner, its member) executes it; it reads nothing but its argument.
CREATE OR REPLACE FUNCTION crove_social.text_variations_valid(v jsonb)
RETURNS boolean
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  e jsonb;
BEGIN
  IF v IS NULL OR pg_catalog.jsonb_typeof(v) <> 'array' THEN
    RETURN false;
  END IF;
  IF pg_catalog.jsonb_array_length(v) > 5 THEN
    RETURN false;
  END IF;
  FOR e IN SELECT x FROM pg_catalog.jsonb_array_elements(v) x LOOP
    IF pg_catalog.jsonb_typeof(e) <> 'object' THEN
      RETURN false;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_catalog.jsonb_object_keys(e) k WHERE k NOT IN ('text', 'ai')) THEN
      RETURN false;
    END IF;
    IF pg_catalog.jsonb_typeof(e -> 'text') IS DISTINCT FROM 'string' OR pg_catalog.jsonb_typeof(e -> 'ai') IS DISTINCT FROM 'boolean' THEN
      RETURN false;
    END IF;
    IF pg_catalog.length(e ->> 'text') NOT BETWEEN 1 AND 100000 OR (e ->> 'text') !~ '[^[:space:]]' THEN
      RETURN false;
    END IF;
  END LOOP;
  IF (SELECT count(DISTINCT x ->> 'text') FROM pg_catalog.jsonb_array_elements(v) x) <> pg_catalog.jsonb_array_length(v) THEN
    RETURN false;
  END IF;
  RETURN true;
EXCEPTION WHEN OTHERS THEN
  RETURN false;
END $$;

REVOKE ALL ON FUNCTION crove_social.text_variations_valid(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crove_social.text_variations_valid(jsonb) TO crove_tenant;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conrelid = 'crove_social.post'::regclass AND conname = 'post_text_variations_shape') THEN
    ALTER TABLE crove_social.post ADD CONSTRAINT post_text_variations_shape CHECK (crove_social.text_variations_valid(text_variations));
  END IF;
  -- The cursor names a variation of the list (0 for an empty one). A list of another shape fails the check above; this
  -- one never errors on it.
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conrelid = 'crove_social.post'::regclass AND conname = 'post_text_variation_next_check') THEN
    ALTER TABLE crove_social.post ADD CONSTRAINT post_text_variation_next_check CHECK (
      text_variation_next >= 0
      AND CASE WHEN pg_catalog.jsonb_typeof(text_variations) = 'array' THEN text_variation_next < GREATEST(pg_catalog.jsonb_array_length(text_variations), 1) ELSE false END
    );
  END IF;
END $$;

-- The evergreen scan of 20261026051000_crove_social_publish_hold.sql, with the ids already tried in this pass left out.
DROP FUNCTION IF EXISTS crove_social.evergreen_due(int);
CREATE OR REPLACE FUNCTION crove_social.evergreen_due(p_limit int, p_skip uuid[])
RETURNS TABLE (org_id uuid, post_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT p.org_id, p.id
  FROM crove_social.post p
  JOIN crove_kernel.tenant t ON t.org_id = p.org_id AND t.status = 'active'
  CROSS JOIN LATERAL (
    SELECT max(v.published_at) AS at FROM crove_social.post_variant v WHERE v.org_id = p.org_id AND v.post_id = p.id AND v.status = 'published'
  ) pub
  CROSS JOIN LATERAL (
    SELECT max(r.created_at) AS at FROM crove_social.post r WHERE r.org_id = p.org_id AND r.repost_of = p.id
  ) rep
  WHERE p.evergreen_days IS NOT NULL
    AND p.status IN ('published', 'partially_published')
    AND pub.at IS NOT NULL
    AND GREATEST(pub.at, coalesce(rep.at, pub.at)) < pg_catalog.now() - pg_catalog.make_interval(days => p.evergreen_days)
    -- A repost still on its way (draft, in review, scheduled, publishing) waits for a person; no second one meanwhile.
    AND NOT EXISTS (
      SELECT 1 FROM crove_social.post r
      WHERE r.org_id = p.org_id AND r.repost_of = p.id AND r.status NOT IN ('published', 'partially_published', 'failed', 'cancelled')
    )
    AND NOT EXISTS (SELECT 1 FROM crove_social.publish_hold h WHERE h.org_id = p.org_id AND h.released_at IS NULL)
    AND p.id <> ALL (coalesce(p_skip, '{}'::uuid[]))
  -- The same order within an hour of UTC (two runs agree, whatever their session time zone), another one the next.
  ORDER BY pg_catalog.md5(p.id::text || pg_catalog.to_char(pg_catalog.date_trunc('hour', pg_catalog.timezone('UTC', pg_catalog.now())), 'YYYYMMDDHH24')), p.id
  LIMIT LEAST(GREATEST(p_limit, 1), 500)
$$;

REVOKE ALL ON FUNCTION crove_social.evergreen_due(int, uuid[]) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_social.evergreen_due(int, uuid[]) TO crove_worker;

-- The recurring scan of 20261027220000_crove_social_recurring.sql, with the ids already tried in this pass left out,
-- and listing a series taken down on every channel so the command ends it. The horizon (7 days) is
-- RECURRING_HORIZON_MS in modules/social/src/recurring.ts.
DROP FUNCTION IF EXISTS crove_social.recurring_due(int);
CREATE OR REPLACE FUNCTION crove_social.recurring_due(p_limit int, p_skip uuid[])
RETURNS TABLE (org_id uuid, post_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT p.org_id, p.id
  FROM crove_social.post p
  JOIN crove_kernel.tenant t ON t.org_id = p.org_id AND t.status = 'active'
  WHERE p.recurrence IS NOT NULL
    AND (p.recurrence_next_at IS NULL OR p.recurrence_next_at <= pg_catalog.now() + pg_catalog.make_interval(days => 7))
    -- The series starts once the post went out on a channel: a copy repeats what went out. One taken down since on
    -- every channel is listed too, for the command to end.
    AND EXISTS (
      SELECT 1 FROM crove_social.post_variant v WHERE v.org_id = p.org_id AND v.post_id = p.id AND v.status IN ('published', 'removed')
    )
    -- A copy still on its way (in review, scheduled, publishing, rejected, needing a person) holds the next one back.
    AND NOT EXISTS (
      SELECT 1 FROM crove_social.post c
      JOIN crove_social.post_variant cv ON cv.org_id = c.org_id AND cv.post_id = c.id
      WHERE c.org_id = p.org_id AND c.recurrence_source_id = p.id AND cv.status NOT IN ('published', 'failed', 'cancelled', 'removed')
    )
    AND NOT EXISTS (SELECT 1 FROM crove_social.publish_hold h WHERE h.org_id = p.org_id AND h.released_at IS NULL)
    AND p.id <> ALL (coalesce(p_skip, '{}'::uuid[]))
  -- The same order within an hour of UTC (as evergreen_due, #402): a post whose copy fails every time cannot keep the
  -- others out of the limit.
  ORDER BY pg_catalog.md5(p.id::text || pg_catalog.to_char(pg_catalog.date_trunc('hour', pg_catalog.timezone('UTC', pg_catalog.now())), 'YYYYMMDDHH24')), p.id
  LIMIT LEAST(GREATEST(p_limit, 1), 500)
$$;

REVOKE ALL ON FUNCTION crove_social.recurring_due(int, uuid[]) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_social.recurring_due(int, uuid[]) TO crove_worker;
