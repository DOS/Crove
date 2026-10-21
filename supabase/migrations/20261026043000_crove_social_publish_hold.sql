-- Crove Social: a hold on all of an org's publishing, for a crisis or a mourning day (issue #946). Idempotent; applied
-- files stay untouched.
--
-- crove_social.publish_hold   an owner or admin holds every post of the org (social.publishing.hold, R2, audited with
--                             the reason) and later lets them go again (social.publishing.release). The live hold is
--                             the row with released_at null; released rows stay as the history of holds. The commands
--                             keep at most one live hold per org under a per-org advisory lock, and the publish
--                             commands take the same lock shared, so nothing of the org is begun once a hold commits.
--                             No unique index: a released row and a live one of the same org are both normal.
-- notification kind publishing_hold   the team is told when a hold starts and when it ends.
-- crove_social.publish_due    skips a held org's scheduled variants, its variants whose worker died mid-call, and its
--                             status checks, so a held org's due posts never fill the scan's limit for every other org
--                             and nothing of it is posted: an Instagram or Threads status check posts the container it
--                             finds processed. Reconciles go on: they only ask the platform. Same arguments and columns
--                             as before.
-- crove_social.evergreen_due  skips held orgs, so no evergreen reposts pile up for review during a hold.
SET LOCAL lock_timeout = '2s';

CREATE TABLE IF NOT EXISTS crove_social.publish_hold (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 500 AND reason = btrim(reason)),
  held_by uuid NOT NULL,
  held_at timestamptz NOT NULL DEFAULT now(),
  released_by uuid,
  released_at timestamptz,
  PRIMARY KEY (org_id, id),
  CONSTRAINT publish_hold_released_check CHECK ((released_at IS NULL) = (released_by IS NULL)),
  -- Both times come from the database clock (the commands leave held_at to its default and set released_at to now()),
  -- never from the clocks of two app instances.
  CONSTRAINT publish_hold_order_check CHECK (released_at IS NULL OR released_at >= held_at)
);
-- The publish path and the banner look up the live hold of an org.
CREATE INDEX IF NOT EXISTS publish_hold_live_idx ON crove_social.publish_hold (org_id) WHERE released_at IS NULL;
SELECT crove_kernel.apply_tenant_rls('crove_social.publish_hold');
-- A hold is history once released: only its release is written later, and no row is deleted.
REVOKE UPDATE, DELETE ON crove_social.publish_hold FROM crove_tenant;
GRANT UPDATE (released_by, released_at) ON crove_social.publish_hold TO crove_tenant;

-- The new kind. NOT VALID: added without scanning the tables under their exclusive lock; validated below.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['notification', 'notification_mute'] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_constraint
      WHERE conrelid = pg_catalog.format('crove_social.%I', t)::regclass AND conname = t || '_kind_check'
        AND pg_catalog.pg_get_constraintdef(oid) LIKE '%publishing_hold%'
    ) THEN
      EXECUTE pg_catalog.format('ALTER TABLE crove_social.%I DROP CONSTRAINT IF EXISTS %I', t, t || '_kind_check');
      EXECUTE pg_catalog.format(
        'ALTER TABLE crove_social.%I ADD CONSTRAINT %I CHECK (kind IN (''review_requested'', ''decided'', ''failed'', ''needs_attention'', ''channel_expired'', ''comment'', ''client_answer'', ''assigned'', ''review_reminder'', ''feed_paused'', ''mention'', ''publishing_hold'')) NOT VALID',
        t, t || '_kind_check');
    END IF;
  END LOOP;
END $$;
ALTER TABLE crove_social.notification VALIDATE CONSTRAINT notification_kind_check;
ALTER TABLE crove_social.notification_mute VALIDATE CONSTRAINT notification_mute_kind_check;

-- The worker's publish scan (20261019040000), with held orgs left out of the three kinds of work that may send
-- something: a due scheduled variant, a status check (Instagram's and Threads' post the processed container; the
-- channels are STATUS_PUBLISHES in modules/social/src/domain/channels.ts, but the scan skips every held status check
-- rather than repeat that list here: the others only record a post already submitted, and run after the release), and
-- a variant whose worker died mid-call (its resume may call again).
CREATE OR REPLACE FUNCTION crove_social.publish_due(p_limit int, p_stale_seconds int, p_providers text[])
RETURNS TABLE (org_id uuid, variant_id uuid, provider text, status text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  WITH lim AS (SELECT LEAST(GREATEST(p_limit, 1), 1000) AS n),
  live AS NOT MATERIALIZED (
    SELECT v.*
    FROM crove_social.post_variant v
    JOIN crove_kernel.tenant t ON t.org_id = v.org_id AND t.status = 'active'
    WHERE v.provider = ANY (p_providers)
      AND v.status IN ('scheduled', 'processing', 'ambiguous', 'publishing', 'paused')
  ),
  held AS NOT MATERIALIZED (
    SELECT DISTINCT h.org_id FROM crove_social.publish_hold h WHERE h.released_at IS NULL
  )
  (SELECT v.org_id, v.id, v.provider, v.status
   FROM live v
   WHERE v.status = 'scheduled' AND coalesce(v.error_retry_at, v.scheduled_at, v.queue_slot_at) <= pg_catalog.now()
     AND NOT (v.error_retry_at IS NULL AND v.scheduled_at IS NULL AND EXISTS (
       SELECT 1 FROM crove_social.queue q
       WHERE q.org_id = v.org_id AND q.channel_connection_id = v.channel_connection_id AND q.paused))
     AND v.org_id NOT IN (SELECT org_id FROM held)
   ORDER BY coalesce(v.error_retry_at, v.scheduled_at, v.queue_slot_at)
   LIMIT (SELECT n FROM lim))
  UNION ALL
  (SELECT v.org_id, v.id, v.provider, v.status
   FROM live v
   WHERE v.status = 'processing' AND v.next_check_at <= pg_catalog.now()
     AND v.org_id NOT IN (SELECT org_id FROM held)
   ORDER BY v.next_check_at
   LIMIT (SELECT n FROM lim))
  UNION ALL
  (SELECT v.org_id, v.id, v.provider, v.status
   FROM live v
   WHERE (v.status = 'ambiguous' AND v.updated_at < pg_catalog.now() - pg_catalog.make_interval(mins => 1))
      OR (v.status = 'publishing' AND v.updated_at < pg_catalog.now() - pg_catalog.make_interval(secs => GREATEST(p_stale_seconds, 60))
          AND v.org_id NOT IN (SELECT org_id FROM held))
   ORDER BY v.updated_at
   LIMIT (SELECT n FROM lim))
  UNION ALL
  (SELECT v.org_id, v.id, v.provider, v.status
   FROM live v
   JOIN crove_kernel.channel_connection c ON c.org_id = v.org_id AND c.id = v.channel_connection_id
   WHERE v.status = 'paused' AND c.status = 'active' AND c.updated_at IS DISTINCT FROM v.paused_connection_version
   ORDER BY v.updated_at
   LIMIT (SELECT n FROM lim))
$$;

REVOKE ALL ON FUNCTION crove_social.publish_due(int, int, text[]) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_social.publish_due(int, int, text[]) TO crove_worker;

-- The evergreen scan (20261019190000), with held orgs left out.
CREATE OR REPLACE FUNCTION crove_social.evergreen_due(p_limit int)
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
  -- The same order within an hour of UTC (two runs agree, whatever their session time zone), another one the next.
  ORDER BY pg_catalog.md5(p.id::text || pg_catalog.to_char(pg_catalog.date_trunc('hour', pg_catalog.timezone('UTC', pg_catalog.now())), 'YYYYMMDDHH24')), p.id
  LIMIT LEAST(GREATEST(p_limit, 1), 500)
$$;

REVOKE ALL ON FUNCTION crove_social.evergreen_due(int) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_social.evergreen_due(int) TO crove_worker;
