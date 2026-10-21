-- Crove kernel: in-app notifications for every module (issue #671), starting with finance work: a proposal waiting for
-- my approval, a file that failed to read, a bank import or a tax-portal check that needs a look, a period whose VAT
-- return is due and that is not locked yet. Social keeps its own (crove_social.notification, #637) until it moves
-- here. Idempotent.
--
-- notification       something for one member to see. Only system commands write it, through notifyMembers()
--                    (packages/kernel/src/notifications.ts), from an outbox event or a sweep: once per member and
--                    dedupe_key, never for the person who acted, and only for members who have not turned the kind
--                    off. A restrictive policy on top of the tenant one shows each member only their own; the system
--                    context, which writes them, sees the org's, and an agent context sees none (and the agent write
--                    guard refuses its writes). Members change only read_at. Read ones go after 30 days, any after 90.
--                    kind is '<module>.<kind>' (kernel.approval_waiting, finance.bank_attention): each module names
--                    its own, so a new kind needs no migration. subject_type and subject_id name what it is about
--                    (a proposal, a file, a bank import, a portal list); detail holds the few words the line shows.
-- notification_mute  a kind of notification a member turned off; notifyMembers() skips that member for that kind.
--
-- crove_finance.period_close_due   the active orgs after a cursor, with their VAT filing period and how far their
--                                   books are locked, for the hourly sweep that tells owners and admins when a VAT
--                                   return is near and its period is still open. Worker only.
SET LOCAL lock_timeout = '2s';

CREATE TABLE IF NOT EXISTS crove_kernel.notification (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  user_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind ~ '^[a-z]+\.[a-z0-9_]+$' AND pg_catalog.length(kind) <= 64),
  -- What makes it one notification: a member gets each key once (a proposal, a file, a period).
  dedupe_key text NOT NULL CHECK (pg_catalog.length(dedupe_key) BETWEEN 1 AND 200),
  -- The outbox event it comes from, when one did.
  event_id uuid,
  subject_type text CHECK (subject_type IS NULL OR subject_type ~ '^[a-z]+\.[a-z_]+$'),
  subject_id uuid,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(detail) = 'object' AND pg_column_size(detail) <= 2048),
  created_at timestamptz NOT NULL DEFAULT now(),
  read_at timestamptz,
  PRIMARY KEY (org_id, id),
  CONSTRAINT notification_once UNIQUE (org_id, user_id, dedupe_key)
);
CREATE INDEX IF NOT EXISTS notification_user_idx ON crove_kernel.notification (org_id, user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS notification_unread_idx ON crove_kernel.notification (org_id, user_id) WHERE read_at IS NULL;
SELECT crove_kernel.apply_tenant_rls('crove_kernel.notification');
REVOKE UPDATE ON crove_kernel.notification FROM crove_tenant;
GRANT UPDATE (read_at) ON crove_kernel.notification TO crove_tenant;
DROP POLICY IF EXISTS own_notification ON crove_kernel.notification;
-- Each context function is wrapped in a subquery, as the tenant policy is, so it runs once per statement.
CREATE POLICY own_notification ON crove_kernel.notification AS RESTRICTIVE FOR ALL TO crove_tenant
  USING (user_id = (SELECT crove_kernel.ctx_user_id()) OR ((SELECT crove_kernel.ctx_user_id()) IS NULL AND (SELECT crove_kernel.ctx_agent_id()) IS NULL))
  WITH CHECK (user_id = (SELECT crove_kernel.ctx_user_id()) OR ((SELECT crove_kernel.ctx_user_id()) IS NULL AND (SELECT crove_kernel.ctx_agent_id()) IS NULL));
-- An open app re-reads its own notifications when one arrives or is read elsewhere (ids only, as every hint).
DROP TRIGGER IF EXISTS stream_hint ON crove_kernel.notification;
CREATE TRIGGER stream_hint AFTER INSERT OR UPDATE ON crove_kernel.notification
  FOR EACH ROW EXECUTE FUNCTION crove_kernel.stream_notify('notification', 'id');

CREATE TABLE IF NOT EXISTS crove_kernel.notification_mute (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind ~ '^[a-z]+\.[a-z0-9_]+$' AND pg_catalog.length(kind) <= 64),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, user_id, kind)
);
SELECT crove_kernel.apply_tenant_rls('crove_kernel.notification_mute');
REVOKE UPDATE ON crove_kernel.notification_mute FROM crove_tenant;
DROP POLICY IF EXISTS own_notification_mute ON crove_kernel.notification_mute;
CREATE POLICY own_notification_mute ON crove_kernel.notification_mute AS RESTRICTIVE FOR ALL TO crove_tenant
  USING (user_id = (SELECT crove_kernel.ctx_user_id()) OR ((SELECT crove_kernel.ctx_user_id()) IS NULL AND (SELECT crove_kernel.ctx_agent_id()) IS NULL))
  WITH CHECK (user_id = (SELECT crove_kernel.ctx_user_id()) OR ((SELECT crove_kernel.ctx_user_id()) IS NULL AND (SELECT crove_kernel.ctx_agent_id()) IS NULL));

-- The worker's queue for the dispatch: one job per event (singleton key <org>:<event>). create_queue skips a queue
-- that exists.
SELECT crove_jobs.create_queue('kernel-notify', '{"policy":"standard"}'::jsonb);

CREATE OR REPLACE FUNCTION crove_finance.period_close_due(p_after uuid, p_limit int)
RETURNS TABLE (org_id uuid, vat_filing_period text, locked_through date)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT t.org_id, t.vat_filing_period, l.locked_through
  FROM crove_kernel.tenant t
  LEFT JOIN crove_finance.period_lock l ON l.org_id = t.org_id
  WHERE t.status = 'active'
    AND t.org_id > coalesce(p_after, '00000000-0000-0000-0000-000000000000'::uuid)
  ORDER BY t.org_id
  LIMIT LEAST(GREATEST(p_limit, 1), 500)
$$;
REVOKE ALL ON FUNCTION crove_finance.period_close_due(uuid, int) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_finance.period_close_due(uuid, int) TO crove_worker;
