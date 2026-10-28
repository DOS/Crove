-- Crove kernel (issue #1720, plan §4.9 "pg-boss contract"): the Inbox item kernel.job.dead_lettered, raised in its own
-- org for a job that failed its last retry (the dead letter queue is the previous migration). Idempotent; applied files
-- stay untouched.
--
-- crove_kernel.inbox_item  an Inbox item the system raised: one row per org, kind and key (here kind
--                          kernel.job.dead_lettered, key job:<id of the failed job>), with a small detail object (the
--                          queue name, the job id and how many retries it had; never the job's data or its error).
--                          Only a system context raises one (the worker's command kernel.job.dead_letter); owners and
--                          admins read and dismiss them (kernel.inbox.raised, kernel.inbox.dismiss). Tenant roles update
--                          only the dismissal columns and delete none.
SET LOCAL lock_timeout = '2s';

CREATE TABLE IF NOT EXISTS crove_kernel.inbox_item (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  kind text NOT NULL CHECK (kind IN ('kernel.job.dead_lettered')),
  -- What makes it one item: an org gets each key of a kind once (the failed job's id).
  dedupe_key text NOT NULL CHECK (pg_catalog.length(dedupe_key) BETWEEN 1 AND 200),
  detail jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (pg_catalog.jsonb_typeof(detail) = 'object' AND pg_catalog.pg_column_size(detail) <= 1024),
  raised_at timestamptz NOT NULL DEFAULT now(),
  dismissed_at timestamptz,
  dismissed_by uuid,
  PRIMARY KEY (org_id, id),
  CONSTRAINT inbox_item_once UNIQUE (org_id, kind, dedupe_key),
  CONSTRAINT inbox_item_dismissed CHECK ((dismissed_at IS NULL) = (dismissed_by IS NULL))
);
CREATE INDEX IF NOT EXISTS inbox_item_open_idx ON crove_kernel.inbox_item (org_id, raised_at DESC) WHERE dismissed_at IS NULL;
SELECT crove_kernel.apply_tenant_rls('crove_kernel.inbox_item');
REVOKE UPDATE, DELETE ON crove_kernel.inbox_item FROM crove_tenant;
GRANT UPDATE (dismissed_at, dismissed_by) ON crove_kernel.inbox_item TO crove_tenant;
-- Only the system raises items: a member context cannot make one up. Wrapped in a subquery, as the tenant policy is,
-- so it runs once per statement.
DROP POLICY IF EXISTS inbox_item_raise ON crove_kernel.inbox_item;
CREATE POLICY inbox_item_raise ON crove_kernel.inbox_item AS RESTRICTIVE FOR INSERT TO crove_tenant
  WITH CHECK ((SELECT crove_kernel.ctx_actor_type()) = 'system');
