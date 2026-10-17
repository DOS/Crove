-- Publishing exactly once (Social plan §3.4, step S4, issue #234).
--
-- 1. crove_kernel.external_call: the ledger of visible calls to outside services. A job writes a call's row in state
--    'started' and commits before it makes the call, so a crash between the call and its result leaves a row that says
--    the call may have gone through. The next run then reconciles or hands it to a human instead of calling again.
--    One row per deterministic key (social.publish:<variant>:<revision>:<attempt>:<step>); Finance connectors reuse it.
--    Tenant roles read and insert rows and update only their outcome columns; nothing deletes one, and a call that has
--    its outcome never changes again (guard trigger).
-- 2. crove_social.publish_due: the worker's scan, across orgs, of variants with publishing work to do. It returns ids
--    only; each job re-reads its variant in a kernel transaction under RLS.
-- 3. The publish queues, one per channel provider (SOCIAL_PUBLISH_QUEUES in apps/kernel/src/jobs-schema.ts).

-- ---------------------------------------------------------------------------
-- 1. External call ledger
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS crove_kernel.external_call (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  key text NOT NULL CHECK (length(key) BETWEEN 1 AND 500),
  -- Who made the call (a module, or kernel) and to which service (a channel provider).
  module text NOT NULL CHECK (module ~ '^[a-z][a-z0-9_]{0,31}$'),
  target text NOT NULL CHECK (target ~ '^[a-z][a-z0-9_]{0,31}$'),
  step text NOT NULL CHECK (step ~ '^[a-z][a-z0-9_]{0,31}$'),
  -- How the step behaves when repeated (modules/social/src/domain/publish.ts): decides what a run that meets a
  -- 'started' or 'ambiguous' row may do.
  retry_safety text NOT NULL CHECK (retry_safety IN ('safe', 'idempotent', 'reconcile_only', 'never')),
  -- The content the call carried (for a publish, the variant's content hash), to match it when reconciling.
  request_hash text CHECK (request_hash IS NULL OR request_hash ~ '^sha256:[0-9a-f]{64}$'),
  state text NOT NULL DEFAULT 'started' CHECK (state IN ('started', 'succeeded', 'failed', 'ambiguous')),
  -- How many times the call was made under this key (only a safe or idempotent step is made again).
  calls integer NOT NULL DEFAULT 1 CHECK (calls BETWEEN 1 AND 1000),
  external_ref text CHECK (external_ref IS NULL OR length(external_ref) <= 500),
  error_kind text CHECK (error_kind IS NULL OR error_kind IN ('token_expired', 'permission', 'bad_request', 'rate_limited', 'transient', 'unknown')),
  error_code text CHECK (error_code IS NULL OR length(error_code) <= 200),
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, id),
  CONSTRAINT external_call_key_uq UNIQUE (org_id, key),
  CONSTRAINT external_call_finished CHECK ((state IN ('succeeded', 'failed')) = (finished_at IS NOT NULL))
);

SELECT crove_kernel.apply_tenant_rls('crove_kernel.external_call', true);
GRANT UPDATE (state, calls, external_ref, error_kind, error_code, finished_at, updated_at) ON crove_kernel.external_call TO crove_tenant;

-- A call starts as 'started' and moves forward only: started -> started (made again: calls grows), succeeded, failed or
-- ambiguous; ambiguous -> started (made again), succeeded or failed. A call with its outcome never changes, and
-- nothing that names the call (key, target, step, safety, request) changes after the insert.
CREATE OR REPLACE FUNCTION crove_kernel.external_call_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'started' OR NEW.calls <> 1 OR NEW.finished_at IS NOT NULL THEN
      RAISE EXCEPTION 'EXTERNAL_CALL_INSERT: a call is recorded as started, before it is made' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.org_id IS DISTINCT FROM OLD.org_id OR NEW.id IS DISTINCT FROM OLD.id OR NEW.key IS DISTINCT FROM OLD.key
     OR NEW.module IS DISTINCT FROM OLD.module OR NEW.target IS DISTINCT FROM OLD.target OR NEW.step IS DISTINCT FROM OLD.step
     OR NEW.retry_safety IS DISTINCT FROM OLD.retry_safety OR NEW.request_hash IS DISTINCT FROM OLD.request_hash
     OR NEW.started_at IS DISTINCT FROM OLD.started_at THEN
    RAISE EXCEPTION 'EXTERNAL_CALL_IMMUTABLE: what names a call never changes' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW IS NOT DISTINCT FROM OLD THEN
    RETURN NEW;
  END IF;
  IF OLD.state IN ('succeeded', 'failed') THEN
    RAISE EXCEPTION 'EXTERNAL_CALL_FINISHED: a call with its outcome never changes' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.calls < OLD.calls OR (NEW.state = 'started' AND OLD.state = 'ambiguous' AND NEW.calls = OLD.calls) THEN
    RAISE EXCEPTION 'EXTERNAL_CALL_CALLS: a call made again counts once more' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS external_call_guard ON crove_kernel.external_call;
CREATE TRIGGER external_call_guard BEFORE INSERT OR UPDATE ON crove_kernel.external_call
  FOR EACH ROW EXECUTE FUNCTION crove_kernel.external_call_guard();

REVOKE ALL ON FUNCTION crove_kernel.external_call_guard() FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;

-- ---------------------------------------------------------------------------
-- 2. Variants with publishing work, for the worker
-- ---------------------------------------------------------------------------
-- When a scheduled variant is due: a retry time set by a rate limit or a transient failure comes first, then its own
-- time, then its queue slot.
CREATE INDEX IF NOT EXISTS post_variant_due_idx ON crove_social.post_variant ((coalesce(error_retry_at, scheduled_at, queue_slot_at)))
  WHERE status = 'scheduled';
CREATE INDEX IF NOT EXISTS post_variant_publish_work_idx ON crove_social.post_variant (status, updated_at)
  WHERE status IN ('publishing', 'processing', 'ambiguous', 'paused');

-- Work items, oldest first within each kind:
-- - scheduled and due (a variant waiting in a paused queue is skipped until the queue is resumed);
-- - processing, whose status check is due (two-phase platforms);
-- - ambiguous for a minute: the platform has had time to show the post, so the reconcile asks it;
-- - publishing for p_stale_seconds: the worker that started it died between the call and the result;
-- - paused on a channel that was reconnected after the pause.
-- Only orgs that are active. Ids only.
CREATE OR REPLACE FUNCTION crove_social.publish_due(p_limit int, p_stale_seconds int DEFAULT 600)
RETURNS TABLE (org_id uuid, variant_id uuid, provider text, status text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  WITH lim AS (SELECT LEAST(GREATEST(p_limit, 1), 1000) AS n),
  due AS (
    (SELECT v.org_id, v.id, v.provider, v.status
     FROM crove_social.post_variant v
     WHERE v.status = 'scheduled' AND coalesce(v.error_retry_at, v.scheduled_at, v.queue_slot_at) <= pg_catalog.now()
       AND NOT (v.error_retry_at IS NULL AND v.scheduled_at IS NULL AND EXISTS (
         SELECT 1 FROM crove_social.queue q
         WHERE q.org_id = v.org_id AND q.channel_connection_id = v.channel_connection_id AND q.paused))
     ORDER BY coalesce(v.error_retry_at, v.scheduled_at, v.queue_slot_at)
     LIMIT (SELECT n FROM lim))
    UNION ALL
    (SELECT v.org_id, v.id, v.provider, v.status
     FROM crove_social.post_variant v
     WHERE v.status = 'processing' AND v.next_check_at <= pg_catalog.now()
     ORDER BY v.next_check_at
     LIMIT (SELECT n FROM lim))
    UNION ALL
    (SELECT v.org_id, v.id, v.provider, v.status
     FROM crove_social.post_variant v
     WHERE (v.status = 'ambiguous' AND v.updated_at < pg_catalog.now() - pg_catalog.make_interval(mins => 1))
        OR (v.status = 'publishing' AND v.updated_at < pg_catalog.now() - pg_catalog.make_interval(secs => GREATEST(p_stale_seconds, 60)))
     ORDER BY v.updated_at
     LIMIT (SELECT n FROM lim))
    UNION ALL
    (SELECT v.org_id, v.id, v.provider, v.status
     FROM crove_social.post_variant v
     JOIN crove_kernel.channel_connection c ON c.org_id = v.org_id AND c.id = v.channel_connection_id
     WHERE v.status = 'paused' AND c.status = 'active' AND c.updated_at > v.updated_at
     ORDER BY v.updated_at
     LIMIT (SELECT n FROM lim))
  )
  SELECT d.org_id, d.id, d.provider, d.status
  FROM due d
  JOIN crove_kernel.tenant t ON t.org_id = d.org_id AND t.status = 'active'
  LIMIT (SELECT n FROM lim)
$$;

REVOKE ALL ON FUNCTION crove_social.publish_due(int, int) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_social.publish_due(int, int) TO crove_worker;

-- ---------------------------------------------------------------------------
-- 3. Publish queues
-- ---------------------------------------------------------------------------
-- 'stately': one queued and one active job per variant (singleton key <org>:<variant>); an active job is retried after
-- 300 seconds. create_queue skips a queue that exists.
SELECT crove_jobs.create_queue(q, '{"policy":"stately","expireInSeconds":300}'::jsonb) FROM unnest(ARRAY['social-publish-sandbox', 'social-publish-facebook_page', 'social-publish-instagram', 'social-publish-zalo_oa', 'social-publish-tiktok', 'social-publish-youtube', 'social-publish-threads', 'social-publish-linkedin', 'social-publish-x', 'social-publish-bluesky']) AS q;
