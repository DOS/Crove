-- Crove Social: recurring posts on a fixed weekday and time (issue #979). Idempotent; applied files stay untouched.
--
-- crove_social.post.recurrence            the series rule of a post, or null: every 1 to 4 weeks, on chosen weekdays
--                                         (0 = Sunday ... 6 = Saturday), at a local "HH:mm" in the post's time zone,
--                                         until a local date and/or for a number of copies (each null: no end). Set
--                                         and cleared by social.post.recurrence_set / recurrence_clear; the CHECK
--                                         below refuses any other shape, and never errors on a malformed one.
-- crove_social.post.recurrence_count      copies made in the current run of the series (the rule's "times").
-- crove_social.post.recurrence_last_at    the occurrence the last copy was made for: the series' phase and the point
--                                         the next occurrence is counted from (the original's first publish before
--                                         the first copy). A person moving a copy's time does not move the series.
-- crove_social.post.recurrence_next_at    the next occurrence as social.recurring.next last computed it, a lower
--                                         bound the scan reads (null: not computed yet). Only the commands write it.
-- crove_social.post.recurrence_source_id  on a copy, the series post it was made for. A copy is never a series, and
--                                         a series post is never evergreen (two kinds of repeat on one post would
--                                         each hold the other's copies back).
-- crove_social.recurring_due              the worker's scan, across active orgs that are not held (#946), of series
--                                         posts that went out, with no copy still open (any channel of it not yet
--                                         published, failed, cancelled or removed), whose next occurrence is unknown
--                                         or within 7 days. Ids only; the command decides under the post's lock.
SET LOCAL lock_timeout = '2s';

ALTER TABLE crove_social.post ADD COLUMN IF NOT EXISTS recurrence jsonb;
ALTER TABLE crove_social.post ADD COLUMN IF NOT EXISTS recurrence_count int NOT NULL DEFAULT 0;
ALTER TABLE crove_social.post ADD COLUMN IF NOT EXISTS recurrence_last_at timestamptz;
ALTER TABLE crove_social.post ADD COLUMN IF NOT EXISTS recurrence_next_at timestamptz;
ALTER TABLE crove_social.post ADD COLUMN IF NOT EXISTS recurrence_source_id uuid;

-- The rule's shape. Each step only reads what the steps before it proved, so no value makes the check itself fail
-- (a cast of a string, a date that does not exist); the handler turns anything unforeseen into a refusal as well.
-- The CHECK runs it as the role that writes the row, so crove_tenant (and the definer owner, its member) executes it;
-- it reads nothing but its argument.
CREATE OR REPLACE FUNCTION crove_social.recurrence_valid(r jsonb)
RETURNS boolean
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  d jsonb;
  y int;
  m int;
  dd int;
BEGIN
  IF r IS NULL THEN
    RETURN true;
  END IF;
  IF pg_catalog.jsonb_typeof(r) <> 'object' THEN
    RETURN false;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.jsonb_object_keys(r) k WHERE k NOT IN ('everyWeeks', 'weekdays', 'time', 'until', 'times')) THEN
    RETURN false;
  END IF;
  -- everyWeeks: a whole number 1 to 4 (jsonb prints a whole number without a fraction or exponent).
  IF pg_catalog.jsonb_typeof(r -> 'everyWeeks') IS DISTINCT FROM 'number' OR (r -> 'everyWeeks')::text !~ '^[1-4]$' THEN
    RETURN false;
  END IF;
  -- weekdays: 1 to 7 different whole numbers 0 to 6.
  IF pg_catalog.jsonb_typeof(r -> 'weekdays') IS DISTINCT FROM 'array' THEN
    RETURN false;
  END IF;
  IF pg_catalog.jsonb_array_length(r -> 'weekdays') NOT BETWEEN 1 AND 7 THEN
    RETURN false;
  END IF;
  FOR d IN SELECT e FROM pg_catalog.jsonb_array_elements(r -> 'weekdays') e LOOP
    IF pg_catalog.jsonb_typeof(d) <> 'number' OR d::text !~ '^[0-6]$' THEN
      RETURN false;
    END IF;
  END LOOP;
  IF (SELECT count(DISTINCT e::text) FROM pg_catalog.jsonb_array_elements(r -> 'weekdays') e) <> pg_catalog.jsonb_array_length(r -> 'weekdays') THEN
    RETURN false;
  END IF;
  -- time: "HH:mm", 00:00 to 23:59.
  IF pg_catalog.jsonb_typeof(r -> 'time') IS DISTINCT FROM 'string' OR (r ->> 'time') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' THEN
    RETURN false;
  END IF;
  -- until: absent, null or a date "YYYY-MM-DD" that exists (checked by building it from its first day of the month).
  IF coalesce(pg_catalog.jsonb_typeof(r -> 'until'), 'null') <> 'null' THEN
    IF pg_catalog.jsonb_typeof(r -> 'until') <> 'string' THEN
      RETURN false;
    END IF;
    IF (r ->> 'until') !~ '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$' THEN
      RETURN false;
    END IF;
    y := pg_catalog.substr(r ->> 'until', 1, 4)::int;
    m := pg_catalog.substr(r ->> 'until', 6, 2)::int;
    dd := pg_catalog.substr(r ->> 'until', 9, 2)::int;
    IF y < 2000 OR pg_catalog.date_part('month', pg_catalog.make_date(y, m, 1) + (dd - 1)) <> m THEN
      RETURN false;
    END IF;
  END IF;
  -- times: absent, null or a whole number 1 to 500.
  IF coalesce(pg_catalog.jsonb_typeof(r -> 'times'), 'null') <> 'null' THEN
    IF pg_catalog.jsonb_typeof(r -> 'times') <> 'number' OR (r -> 'times')::text !~ '^[1-9][0-9]{0,2}$' THEN
      RETURN false;
    END IF;
    IF (r -> 'times')::text::int > 500 THEN
      RETURN false;
    END IF;
  END IF;
  RETURN true;
EXCEPTION WHEN OTHERS THEN
  RETURN false;
END $$;

REVOKE ALL ON FUNCTION crove_social.recurrence_valid(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crove_social.recurrence_valid(jsonb) TO crove_tenant;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conrelid = 'crove_social.post'::regclass AND conname = 'post_recurrence_shape') THEN
    ALTER TABLE crove_social.post ADD CONSTRAINT post_recurrence_shape CHECK (crove_social.recurrence_valid(recurrence));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conrelid = 'crove_social.post'::regclass AND conname = 'post_recurrence_count_check') THEN
    ALTER TABLE crove_social.post ADD CONSTRAINT post_recurrence_count_check CHECK (recurrence_count >= 0);
  END IF;
  -- A copy is never a series itself, and a series is never evergreen as well.
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conrelid = 'crove_social.post'::regclass AND conname = 'post_recurrence_kind_check') THEN
    ALTER TABLE crove_social.post ADD CONSTRAINT post_recurrence_kind_check CHECK (recurrence IS NULL OR (recurrence_source_id IS NULL AND evergreen_days IS NULL));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conrelid = 'crove_social.post'::regclass AND conname = 'post_recurrence_source_fk') THEN
    ALTER TABLE crove_social.post ADD CONSTRAINT post_recurrence_source_fk FOREIGN KEY (org_id, recurrence_source_id) REFERENCES crove_social.post (org_id, id);
  END IF;
END $$;
-- The copies of a series (the open-copy check), and the series posts the scan walks.
CREATE INDEX IF NOT EXISTS post_recurrence_source_idx ON crove_social.post (org_id, recurrence_source_id) WHERE recurrence_source_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS post_recurrence_idx ON crove_social.post (org_id) WHERE recurrence IS NOT NULL;

-- The worker's scan. The horizon (7 days) is RECURRING_HORIZON_MS in modules/social/src/recurring.ts.
CREATE OR REPLACE FUNCTION crove_social.recurring_due(p_limit int)
RETURNS TABLE (org_id uuid, post_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT p.org_id, p.id
  FROM crove_social.post p
  JOIN crove_kernel.tenant t ON t.org_id = p.org_id AND t.status = 'active'
  WHERE p.recurrence IS NOT NULL
    AND (p.recurrence_next_at IS NULL OR p.recurrence_next_at <= pg_catalog.now() + pg_catalog.make_interval(days => 7))
    -- The series starts once the post went out on a channel: a copy repeats what went out.
    AND EXISTS (
      SELECT 1 FROM crove_social.post_variant v WHERE v.org_id = p.org_id AND v.post_id = p.id AND v.status = 'published'
    )
    -- A copy still on its way (in review, scheduled, publishing, rejected, needing a person) holds the next one back.
    AND NOT EXISTS (
      SELECT 1 FROM crove_social.post c
      JOIN crove_social.post_variant cv ON cv.org_id = c.org_id AND cv.post_id = c.id
      WHERE c.org_id = p.org_id AND c.recurrence_source_id = p.id AND cv.status NOT IN ('published', 'failed', 'cancelled', 'removed')
    )
    AND NOT EXISTS (SELECT 1 FROM crove_social.publish_hold h WHERE h.org_id = p.org_id AND h.released_at IS NULL)
  -- The same order within an hour of UTC, another one the next (as evergreen_due, #402): a post whose copy fails every
  -- time cannot keep the others out of the limit.
  ORDER BY pg_catalog.md5(p.id::text || pg_catalog.to_char(pg_catalog.date_trunc('hour', pg_catalog.timezone('UTC', pg_catalog.now())), 'YYYYMMDDHH24')), p.id
  LIMIT LEAST(GREATEST(p_limit, 1), 500)
$$;

REVOKE ALL ON FUNCTION crove_social.recurring_due(int) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_social.recurring_due(int) TO crove_worker;
