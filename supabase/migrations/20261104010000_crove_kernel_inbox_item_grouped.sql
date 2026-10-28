-- Dead-letter Inbox items are grouped per queue and day, old ones are pruned, and a dismissal names the context's own
-- user (issue #1747, from the review of #1738). Idempotent; applied files stay untouched.
--
-- Grouping. kernel.job.dead_letter raised one item per failed job (key job:<id>), so an org job that kept failing
-- raised an item per failure without limit. It now keys the item queue:<queue>:<day in Vietnam> and counts further
-- failures of that queue and day on the open item (detail.failures, with the latest job's id, retries and time): an
-- owner sees "this work failed N times that day" once, and a new day, or a failure after the item was dismissed,
-- raises a new one. The key is unique among open items only (inbox_item_open_once replaces inbox_item_once), so a
-- dismissed item never swallows later failures of its day. Items raised before keep their job:<id> keys.
--
-- Updates. The system context may now update detail (the count) of an open item, through a column grant; the guard
-- trigger keeps every other context off detail, keeps the system off the dismissal columns and off dismissed items,
-- and keeps the key, kind, org and raise time fixed for everyone.
--
-- Dismissal. dismissed_by is tied to the context's user by the RESTRICTIVE update policy inbox_item_dismiss: a row
-- may be left with no dismissal or one by ctx_user_id(), never by another user (the system context has none, so it
-- dismisses nothing). The CHECK pairing dismissed_at and dismissed_by stays.
--
-- Pruning. A dismissed item goes 30 days after its dismissal, and any item 90 days after it was raised, as read and
-- unread notifications do (NOTIFICATION_READ_KEEP_DAYS, NOTIFICATION_KEEP_DAYS): an owner who never looks still keeps
-- three months of failures, and the failed jobs themselves stay where the prober counts them. The worker's daily
-- retention run asks crove_kernel.inbox_item_prune_due for the active orgs with such items (worker login only, outside
-- every context) and runs kernel.inbox.prune in each org's system context; tenant roles may now delete, but the
-- RESTRICTIVE policy inbox_item_prune lets only the system context do it.
SET LOCAL lock_timeout = '2s';

ALTER TABLE crove_kernel.inbox_item DROP CONSTRAINT IF EXISTS inbox_item_once;
CREATE UNIQUE INDEX IF NOT EXISTS inbox_item_open_once ON crove_kernel.inbox_item (org_id, kind, dedupe_key) WHERE dismissed_at IS NULL;
-- The pruning sweep's two cut-offs, across orgs.
CREATE INDEX IF NOT EXISTS inbox_item_dismissed_idx ON crove_kernel.inbox_item (dismissed_at) WHERE dismissed_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS inbox_item_raised_idx ON crove_kernel.inbox_item (raised_at);

GRANT UPDATE (detail) ON crove_kernel.inbox_item TO crove_tenant;
GRANT DELETE ON crove_kernel.inbox_item TO crove_tenant;

-- Each context function is wrapped in a subquery, as the tenant policy is, so it runs once per statement.
DROP POLICY IF EXISTS inbox_item_dismiss ON crove_kernel.inbox_item;
CREATE POLICY inbox_item_dismiss ON crove_kernel.inbox_item AS RESTRICTIVE FOR UPDATE TO crove_tenant
  USING (true)
  WITH CHECK (dismissed_by IS NULL OR dismissed_by = (SELECT crove_kernel.ctx_user_id()));
DROP POLICY IF EXISTS inbox_item_prune ON crove_kernel.inbox_item;
CREATE POLICY inbox_item_prune ON crove_kernel.inbox_item AS RESTRICTIVE FOR DELETE TO crove_tenant
  USING ((SELECT crove_kernel.ctx_actor_type()) = 'system');

CREATE OR REPLACE FUNCTION crove_kernel.inbox_item_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.org_id IS DISTINCT FROM OLD.org_id OR NEW.id IS DISTINCT FROM OLD.id OR NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.dedupe_key IS DISTINCT FROM OLD.dedupe_key OR NEW.raised_at IS DISTINCT FROM OLD.raised_at THEN
    RAISE EXCEPTION 'INBOX_ITEM_FIXED' USING ERRCODE = '42501';
  END IF;
  IF crove_kernel.ctx_actor_type() IS NOT DISTINCT FROM 'system' THEN
    -- The system counts another failure on an open item; it dismisses nothing and leaves a dismissed item alone.
    IF OLD.dismissed_at IS NOT NULL OR NEW.dismissed_at IS DISTINCT FROM OLD.dismissed_at
       OR NEW.dismissed_by IS DISTINCT FROM OLD.dismissed_by THEN
      RAISE EXCEPTION 'INBOX_ITEM_SYSTEM_COUNTS_ONLY' USING ERRCODE = '42501';
    END IF;
  ELSIF NEW.detail IS DISTINCT FROM OLD.detail THEN
    RAISE EXCEPTION 'INBOX_ITEM_DETAIL_SYSTEM_ONLY' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION crove_kernel.inbox_item_guard() FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
DROP TRIGGER IF EXISTS b_guard ON crove_kernel.inbox_item;
CREATE TRIGGER b_guard BEFORE UPDATE ON crove_kernel.inbox_item
  FOR EACH ROW EXECUTE FUNCTION crove_kernel.inbox_item_guard();

-- The active orgs with an item dismissed before p_dismissed_before or raised before p_raised_before, for the daily
-- prune (worker login only, and outside every context: an org's or an agent's context on the worker login gets
-- nothing of other orgs). Returns ids only.
CREATE OR REPLACE FUNCTION crove_kernel.inbox_item_prune_due(p_dismissed_before timestamptz, p_raised_before timestamptz, p_limit integer)
RETURNS TABLE (org_id uuid) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NOT pg_catalog.pg_has_role(SESSION_USER, 'crove_worker', 'MEMBER') OR crove_kernel.ctx_actor_type() IS NOT NULL THEN
    RAISE EXCEPTION 'INBOX_ITEM_WORKER_ONLY' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY SELECT DISTINCT i.org_id FROM crove_kernel.inbox_item i
    JOIN crove_kernel.tenant t ON t.org_id = i.org_id AND t.status = 'active'
    WHERE i.dismissed_at < p_dismissed_before OR i.raised_at < p_raised_before
    ORDER BY 1 LIMIT LEAST(GREATEST(p_limit, 1), 1000);
END $$;
REVOKE ALL ON FUNCTION crove_kernel.inbox_item_prune_due(timestamptz, timestamptz, integer) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_kernel.inbox_item_prune_due(timestamptz, timestamptz, integer) TO crove_worker;
