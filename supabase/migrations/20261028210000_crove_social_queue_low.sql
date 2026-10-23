-- Crove Social: tell the team when a channel's queue runs low (issue #1079). Idempotent; applied files stay untouched.
--
-- crove_social.queue.low_days        warn when one of the queue's posting days in the next N days (1 to 30) has no post
--                                    waiting in its slots; null (the default): no warning. Set by owners and admins
--                                    through social.queue.set.
-- crove_social.queue.low_alerted_at  the dip marker: the worker's check (social.queue.check_low) sets it when it tells the
--                                    team, with a conditional update so two checks never both tell it, and clears it when
--                                    every posting day ahead has a post again. So the team is told once per dip.
-- notification kind queue_low         in the app and by email, and a member can turn it off like the other kinds.
-- crove_social.queue_low_due          the worker's scan, a page at a time, of queues with low_days set that are not
--                                     paused, on an active channel of an active org not under a publishing hold (#946).
--                                     It only names the queues; the check runs in each org's system context.
SET LOCAL lock_timeout = '2s';

ALTER TABLE crove_social.queue ADD COLUMN IF NOT EXISTS low_days integer CONSTRAINT queue_low_days_check CHECK (low_days BETWEEN 1 AND 30);
ALTER TABLE crove_social.queue ADD COLUMN IF NOT EXISTS low_alerted_at timestamptz;

-- The new kind. NOT VALID: added without scanning the tables under their exclusive lock; validated below. The list is
-- the one of 20261026051000_crove_social_publish_hold.sql with queue_low added.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['notification', 'notification_mute'] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_constraint
      WHERE conrelid = pg_catalog.format('crove_social.%I', t)::regclass AND conname = t || '_kind_check'
        AND pg_catalog.pg_get_constraintdef(oid) LIKE '%queue_low%'
    ) THEN
      EXECUTE pg_catalog.format('ALTER TABLE crove_social.%I DROP CONSTRAINT IF EXISTS %I', t, t || '_kind_check');
      EXECUTE pg_catalog.format(
        'ALTER TABLE crove_social.%I ADD CONSTRAINT %I CHECK (kind IN (''review_requested'', ''decided'', ''failed'', ''needs_attention'', ''channel_expired'', ''comment'', ''client_answer'', ''assigned'', ''review_reminder'', ''feed_paused'', ''mention'', ''publishing_hold'', ''queue_low'')) NOT VALID',
        t, t || '_kind_check');
    END IF;
  END LOOP;
END $$;
ALTER TABLE crove_social.notification VALIDATE CONSTRAINT notification_kind_check;
ALTER TABLE crove_social.notification_mute VALIDATE CONSTRAINT notification_mute_kind_check;

-- Queues the low check looks at, in (org_id, id) order after the given one, so the sweep pages through all of them and
-- no queue waits behind a full first page.
CREATE OR REPLACE FUNCTION crove_social.queue_low_due(p_after_org uuid, p_after_id uuid, p_limit int)
RETURNS TABLE (org_id uuid, queue_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT q.org_id, q.id
  FROM crove_social.queue q
  JOIN crove_kernel.tenant t ON t.org_id = q.org_id AND t.status = 'active'
  JOIN crove_kernel.channel_connection c ON c.org_id = q.org_id AND c.id = q.channel_connection_id AND c.status = 'active'
  WHERE q.low_days IS NOT NULL
    AND NOT q.paused
    AND NOT EXISTS (SELECT 1 FROM crove_social.publish_hold h WHERE h.org_id = q.org_id AND h.released_at IS NULL)
    AND (q.org_id, q.id) > (coalesce(p_after_org, '00000000-0000-0000-0000-000000000000'::uuid), coalesce(p_after_id, '00000000-0000-0000-0000-000000000000'::uuid))
  ORDER BY q.org_id, q.id
  LIMIT LEAST(GREATEST(p_limit, 1), 500)
$$;
REVOKE ALL ON FUNCTION crove_social.queue_low_due(uuid, uuid, int) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_social.queue_low_due(uuid, uuid, int) TO crove_worker;
