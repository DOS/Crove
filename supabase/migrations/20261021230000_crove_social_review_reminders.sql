-- Reminders for posts waiting for review (issue #703). Idempotent; applied files stay untouched.
--
-- crove_social.post_variant.review_since         when the variant last went into review; null while it is not in
--                                                review. Set by a trigger on every change of status, never by a
--                                                command, so a reminder's clock cannot be moved.
-- crove_social.post_variant.reminded_waiting_at  when the reviewers were reminded that it has waited 24 hours;
-- crove_social.post_variant.reminded_due_at      when they were reminded that its time is less than 24 hours away.
--                                                Both are cleared when it goes into review again, so each reminder
--                                                goes once per round of review.
-- crove_social.channel_policy.review_reminders   whether the channel's reviewers get these reminders (on by default;
--                                                a channel without a policy row gets them).
-- notification kind 'review_reminder'            the in-app item a reminder becomes.
-- crove_social.review_reminders_due              the worker's scan, across orgs, of posts with a reminder due. It
--                                                returns ids only.
SET LOCAL lock_timeout = '2s';

ALTER TABLE crove_social.post_variant ADD COLUMN IF NOT EXISTS review_since timestamptz;
ALTER TABLE crove_social.post_variant ADD COLUMN IF NOT EXISTS reminded_waiting_at timestamptz;
ALTER TABLE crove_social.post_variant ADD COLUMN IF NOT EXISTS reminded_due_at timestamptz;
ALTER TABLE crove_social.channel_policy ADD COLUMN IF NOT EXISTS review_reminders boolean NOT NULL DEFAULT true;

-- The variants in review now started their round when this runs: their reminders count from here.
UPDATE crove_social.post_variant SET review_since = now() WHERE status = 'in_review' AND review_since IS NULL;

CREATE OR REPLACE FUNCTION crove_social.post_variant_review_clock() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' OR NEW.status IS DISTINCT FROM OLD.status THEN
    IF NEW.status = 'in_review' THEN
      NEW.review_since := pg_catalog.now();
    ELSE
      NEW.review_since := NULL;
    END IF;
    NEW.reminded_waiting_at := NULL;
    NEW.reminded_due_at := NULL;
  ELSE
    NEW.review_since := OLD.review_since;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION crove_social.post_variant_review_clock() FROM PUBLIC;
DROP TRIGGER IF EXISTS review_clock ON crove_social.post_variant;
CREATE TRIGGER review_clock BEFORE INSERT OR UPDATE ON crove_social.post_variant
  FOR EACH ROW EXECUTE FUNCTION crove_social.post_variant_review_clock();

CREATE INDEX IF NOT EXISTS post_variant_in_review_idx ON crove_social.post_variant (review_since) WHERE status = 'in_review';

-- The new kind. NOT VALID: added without scanning the tables under their exclusive lock; validated below.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['notification', 'notification_mute'] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_constraint
      WHERE conrelid = pg_catalog.format('crove_social.%I', t)::regclass AND conname = t || '_kind_check'
        AND pg_catalog.pg_get_constraintdef(oid) LIKE '%review_reminder%'
    ) THEN
      EXECUTE pg_catalog.format('ALTER TABLE crove_social.%I DROP CONSTRAINT IF EXISTS %I', t, t || '_kind_check');
      EXECUTE pg_catalog.format(
        'ALTER TABLE crove_social.%I ADD CONSTRAINT %I CHECK (kind IN (''review_requested'', ''decided'', ''failed'', ''needs_attention'', ''channel_expired'', ''comment'', ''client_answer'', ''assigned'', ''review_reminder'')) NOT VALID',
        t, t || '_kind_check');
    END IF;
  END LOOP;
END $$;
ALTER TABLE crove_social.notification VALIDATE CONSTRAINT notification_kind_check;
ALTER TABLE crove_social.notification_mute VALIDATE CONSTRAINT notification_mute_kind_check;

-- Posts of active orgs with a variant in review on a channel that takes reminders, and a reminder not sent yet: it
-- has waited 24 hours, or its time is less than 24 hours away and was more than 24 hours away when it went into
-- review (otherwise the review request itself came inside that window). Oldest first.
CREATE OR REPLACE FUNCTION crove_social.review_reminders_due(p_limit int)
RETURNS TABLE (org_id uuid, post_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT v.org_id, v.post_id
  FROM crove_social.post_variant v
  JOIN crove_social.post p ON p.org_id = v.org_id AND p.id = v.post_id
  JOIN crove_kernel.tenant t ON t.org_id = v.org_id AND t.status = 'active'
  LEFT JOIN crove_social.channel_policy cp ON cp.org_id = v.org_id AND cp.channel_connection_id = v.channel_connection_id
  WHERE v.status = 'in_review'
    AND v.review_since IS NOT NULL
    AND coalesce(cp.review_reminders, true)
    AND (
      (v.reminded_waiting_at IS NULL AND v.review_since <= pg_catalog.now() - interval '24 hours')
      OR (
        v.reminded_due_at IS NULL
        AND coalesce(v.queue_slot_at, v.scheduled_at, p.scheduled_at) > pg_catalog.now()
        AND coalesce(v.queue_slot_at, v.scheduled_at, p.scheduled_at) <= pg_catalog.now() + interval '24 hours'
        AND v.review_since < coalesce(v.queue_slot_at, v.scheduled_at, p.scheduled_at) - interval '24 hours'
      )
    )
  GROUP BY v.org_id, v.post_id
  ORDER BY min(v.review_since), v.org_id, v.post_id
  LIMIT LEAST(GREATEST(p_limit, 1), 1000)
$$;
REVOKE ALL ON FUNCTION crove_social.review_reminders_due(int) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_social.review_reminders_due(int) TO crove_worker;
