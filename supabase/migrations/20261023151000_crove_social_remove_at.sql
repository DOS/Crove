-- Crove Social: taking a post down at a set time (issue #861). Idempotent; applied files stay untouched.
--
-- crove_social.remove_at_of        a variant's planned takedown (settings.removeAt) as a time, or NULL when it has
--                                  none or it is not a full ISO 8601 time with Z or an offset (the pattern the
--                                  module's removeAtOf accepts). It never raises, so a malformed value written by an
--                                  old client cannot stop the scan.
-- crove_social.remove_due          the worker's scan, across active orgs, of published variants whose planned takedown
--                                  has come and nobody asked to remove yet, on the providers the worker can remove
--                                  from. The time must fit the time the post really went out, which a rate limit, a
--                                  paused channel or a queue edit can move: at least 5 minutes after it (the module's
--                                  REMOVE_AT_MIN_GAP_MS) and within the provider's window (p_windows, seconds, beside
--                                  p_providers; the module's REMOVE_WINDOW_MS, Telegram 48 hours), never more than a
--                                  year (REMOVE_AT_MAX_MS) whatever the caller says. A post outside that stays up. Ids
--                                  only; the worker then runs social.remove.schedule for each, which checks it again.
-- post_variant_remove_at_idx       the published variants that carry a planned takedown and were never asked to come
--                                  down, by the time they went out. A variant leaves it once asked for or removed; one
--                                  whose time never fits (a late publish, a malformed value) stays in it, but the scan
--                                  reads only the last year of it, since no takedown can come later than a year after
--                                  its post, so the rows it reads stay bounded by a year of published posts.
SET LOCAL lock_timeout = '2s';

CREATE OR REPLACE FUNCTION crove_social.remove_at_of(p_settings jsonb)
RETURNS timestamptz
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v text := p_settings ->> 'removeAt';
BEGIN
  IF v IS NULL OR v !~ '^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d(:[0-5]\d(\.\d{1,3})?)?(Z|[+-](0\d|1[0-4]):[0-5]\d)$' THEN
    RETURN NULL;
  END IF;
  RETURN v::timestamptz;
EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow OR invalid_time_zone_displacement_value THEN
  -- A day the calendar does not have (31 February).
  RETURN NULL;
END $$;

-- Only the scan below uses it, as its owner.
REVOKE ALL ON FUNCTION crove_social.remove_at_of(jsonb) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;

CREATE INDEX IF NOT EXISTS post_variant_remove_at_idx ON crove_social.post_variant (published_at)
  WHERE status = 'published' AND remove_requested_at IS NULL AND external_post_id IS NOT NULL AND settings ? 'removeAt';

DROP FUNCTION IF EXISTS crove_social.remove_due(int, text[]);
CREATE OR REPLACE FUNCTION crove_social.remove_due(p_limit int, p_providers text[], p_windows int[])
RETURNS TABLE (org_id uuid, variant_id uuid, provider text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT d.org_id, d.id, d.provider
  FROM (
    SELECT v.org_id, v.id, v.provider, v.published_at, crove_social.remove_at_of(v.settings) AS remove_at,
           -- A missing or negative window reads as none, then the year bounds it.
           LEAST(pg_catalog.make_interval(secs => GREATEST(coalesce(w.seconds, 31536000), 0)), pg_catalog.make_interval(secs => 31536000)) AS max_after
    FROM crove_social.post_variant v
    JOIN ROWS FROM (pg_catalog.unnest(p_providers), pg_catalog.unnest(p_windows)) AS w(provider, seconds) ON w.provider = v.provider
    JOIN crove_kernel.tenant t ON t.org_id = v.org_id AND t.status = 'active'
    WHERE v.status = 'published' AND v.remove_requested_at IS NULL AND v.external_post_id IS NOT NULL AND v.settings ? 'removeAt'
      AND v.published_at >= pg_catalog.now() - pg_catalog.make_interval(secs => 31536000)
  ) d
  WHERE d.remove_at <= pg_catalog.now()
    AND d.remove_at >= d.published_at + pg_catalog.make_interval(mins => 5)
    AND d.remove_at <= d.published_at + d.max_after
  ORDER BY d.remove_at, d.id
  LIMIT LEAST(GREATEST(p_limit, 1), 1000)
$$;

REVOKE ALL ON FUNCTION crove_social.remove_due(int, text[], int[]) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_social.remove_due(int, text[], int[]) TO crove_worker;