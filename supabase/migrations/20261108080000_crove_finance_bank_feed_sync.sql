-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove finance (issue #2044 part 2b, ADR-0039 point 2): bank feeds sync in the worker. Idempotent; applied files stay
-- untouched.
--
-- crove_finance.bank_feed_listed_account: the accounts a bank feed connection reaches, as the worker last listed them
-- with the connection's credential (the API seals a login and never opens it, ADR-0025). Owners and admins map one of
-- these to a bank account (finance.bank_feed.map refuses an account the connection does not list). Org-wide like the
-- connection itself: the name of a bank account, no entity's books.
-- The queue finance-bank-feed-sync runs a connection's sync: list its accounts, then pull each mapped one since its
-- cursor (finance.bank_feed.record_pull stores the lines and moves the cursor in one transaction).
-- crove_finance.bank_feeds_due(limit): the active bank feed connections of active orgs, for the worker's daily pull;
-- the worker login's alone.
SET LOCAL lock_timeout = '2s';

CREATE TABLE IF NOT EXISTS crove_finance.bank_feed_listed_account (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  channel_connection_id uuid NOT NULL,
  external_account_id text NOT NULL CHECK (pg_catalog.length(external_account_id) BETWEEN 1 AND 200),
  display_name text NOT NULL CHECK (pg_catalog.length(display_name) BETWEEN 1 AND 200),
  listed_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (org_id, id),
  CONSTRAINT bank_feed_listed_account_uq UNIQUE (org_id, channel_connection_id, external_account_id),
  CONSTRAINT bank_feed_listed_account_connection_fk FOREIGN KEY (org_id, channel_connection_id) REFERENCES crove_kernel.channel_connection (org_id, id)
);
SELECT crove_kernel.apply_tenant_rls('crove_finance.bank_feed_listed_account');
-- A listing is replaced row by row: a new name and when it was seen; an account the provider no longer lists is deleted.
REVOKE UPDATE ON crove_finance.bank_feed_listed_account FROM crove_tenant;
GRANT UPDATE (display_name, listed_at) ON crove_finance.bank_feed_listed_account TO crove_tenant;

SELECT crove_jobs.create_queue('finance-bank-feed-sync', '{"policy":"standard","deadLetter":"kernel-job.dlq"}'::jsonb);

CREATE OR REPLACE FUNCTION crove_finance.bank_feeds_due(p_limit int)
RETURNS TABLE (org_id uuid, connection_id uuid, provider text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT c.org_id, c.id, c.provider
  FROM crove_kernel.channel_connection c
  JOIN crove_kernel.tenant t ON t.org_id = c.org_id AND t.status = 'active'
  WHERE c.status = 'active' AND c.provider LIKE 'bank\_%'
  ORDER BY c.org_id, c.id
  LIMIT LEAST(GREATEST(p_limit, 1), 1000)
$$;
REVOKE ALL ON FUNCTION crove_finance.bank_feeds_due(int) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_finance.bank_feeds_due(int) TO crove_worker;
